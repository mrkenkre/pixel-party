import type { ClientMsg, PlayerDto, ServerMsg } from '@pp/shared'
import { cleanName, MINIGAMES_BY_ID, PROTOCOL_VERSION, TEAM_IDS } from '@pp/shared'
import type { Clock } from '../../../application/ports/Clock'
import type { LiveRoomRegistry } from '../../../application/ports/LiveRoomRegistry'
import type { Publisher } from '../../../application/ports/Publisher'
import type { SessionConfig } from '../../../application/session/SessionEngine'
import { SessionManager } from '../../../application/session/SessionManager'
import type { CreateRoomUseCase } from '../../../application/use-cases/CreateRoomUseCase'
import type { JoinRoomUseCase } from '../../../application/use-cases/JoinRoomUseCase'
import { config } from '../../../config'
import type { Player } from '../../../domain/entities/Player'
import type { Room } from '../../../domain/entities/Room'
import type { Random } from '../../../domain/ports/Random'
import { playableLineup } from '../../../domain/services/lineup'
import { balancedTeams, smallerTeam } from '../../../domain/services/teamAssignment'
import { reapIdleRooms } from '../../live/roomSweeper'
import type { Logger } from '../../observability/logger'
import type { Metrics } from '../../observability/metrics'
import { withinBase } from '../http/basePath'
import { handleHttp } from '../http/httpRoutes'
import type { StaticSite } from '../http/staticSite'
import { buildSimulationLoop } from './simulationLoop'
import { isValidClientMsg } from './validate'

// Identity is resolved server-side and attached here — never client-asserted. `roomCode` comes from the
// upgrade URL; `playerId`/`isHost` are set once the JOIN intent runs. `connId` is a per-socket nonce.
export interface SocketData {
  roomCode: string
  connId: string
  playerId?: string
  isHost: boolean
  // A WATCH socket (fork extra): subscribed to the room topic, never holds a seat.
  watcher?: boolean
}

// Watchers per room (TVs/laptops showing the game); far above any real need, low enough to bound load.
export const MAX_WATCHERS = 10

// The socket surface the game core needs. Bun's ServerWebSocket fits it as-is; the Cloudflare
// Worker build (apps/worker) wraps a Durable Object WebSocket in the same shape.
export interface GameWs {
  data: SocketData
  send(msg: string): unknown
  close(): void
  subscribe(topic: string): void
}

export const roomTopic = (code: string): string => `room:${code}`
export const playerTopic = (id: string): string => `player:${id}`

export interface GameSocketDeps {
  rooms: LiveRoomRegistry
  createRoom: CreateRoomUseCase
  joinRoom: JoinRoomUseCase
  clock: Clock
  random: Random
  sessionConfig: SessionConfig
  logger: Logger
  metrics: Metrics
  roomIdleTimeoutSec: number
  port?: number
  // Party mode: the production client build, served from this same port (null/absent in dev, where
  // the Angular dev server serves the client).
  site?: StaticSite | null
}

// A page this server served (party mode) talks to its own origin: the WS Origin matches the Host.
function isSameOrigin(req: Request, origin: string): boolean {
  try {
    return new URL(origin).host === req.headers.get('host')
  } catch {
    return false
  }
}

type LobbyStateMsg = Extract<ServerMsg, { type: 'LOBBY_STATE' }>

const warnedUnknownIntents = new Set<string>()

function toPlayerDto(p: Player): PlayerDto {
  return {
    id: p.id,
    name: p.name,
    color: p.color,
    avatar: p.avatar,
    ready: p.ready,
    connected: p.connected,
    team: p.team,
    touch: p.touch || undefined,
  }
}

// True when the configured line-up includes a team-format game (drives team assignment + lobby UI).
function lineupUsesTeams(room: Room): boolean {
  return room.minigameIds.some((id) => MINIGAMES_BY_ID.get(id)?.format === 'team')
}

function lobbyState(room: Room): LobbyStateMsg {
  return {
    type: 'LOBBY_STATE',
    phase: room.phase,
    players: room.list().map(toPlayerDto),
    hostId: room.hostId ?? '',
    minigameIds: [...room.minigameIds],
    rounds: room.rounds,
    usesTeams: lineupUsesTeams(room),
    handicap: room.handicap,
  }
}

// The transport-neutral game core: every intent handler, the session manager, the simulation loop and
// the idle sweeper. `publish(topic, data)` fans a frame out to the sockets subscribed to a topic (Bun's
// server.publish, or the Durable Object's own fan-out on Cloudflare).
export function createGameCore(
  deps: GameSocketDeps,
  publish: (topic: string, data: string) => void,
) {
  let manager: SessionManager

  const send = (ws: GameWs, msg: ServerMsg): void => {
    ws.send(JSON.stringify(msg))
  }

  const broadcastLobby = (room: Room): void => {
    publish(roomTopic(room.code), JSON.stringify(lobbyState(room)))
  }

  // Counters plus live gauges the counters can't hold (active rooms, running sessions).
  const metricsSnapshot = (): Record<string, number> => ({
    ...deps.metrics.snapshot(),
    active_rooms: deps.rooms.list().length,
    running_sessions: manager.runningCount,
  })

  // Keep team assignment in sync with the line-up: a balanced split appears when a team game is added
  // (and none is set yet); teams are cleared when the line-up drops back to FFA-only.
  const ensureTeams = (room: Room): void => {
    if (!lineupUsesTeams(room)) {
      if (room.hasTeams) room.clearTeams()
      return
    }
    if (!room.hasTeams && room.list().length > 0) {
      room.setTeams(
        balancedTeams(
          room.list().map((p) => p.id),
          deps.random,
        ),
      )
    }
  }

  // The socket currently holding each seat. A page reload opens the new socket (and REJOINs) before
  // the old socket's close has been processed; without this, that late close would drop the seat the
  // new socket just reclaimed (lobby) or mark it offline and move the host role away (mid-session).
  const seatSockets = new Map<string, GameWs>()
  const claimSeat = (ws: GameWs, playerId: string): void => {
    const prev = seatSockets.get(playerId)
    seatSockets.set(playerId, ws)
    if (prev && prev !== ws) {
      // Detach the superseded socket first, so its close can no longer touch the seat.
      prev.data.playerId = undefined
      prev.close()
    }
  }

  // JOIN mints identity: run the use case, attach the resolved id/host flag, subscribe, then WELCOME.
  // WATCH: follow the room without a seat (fork extra). Subscribe to the room topic, then replay what
  // a reconnecting player would get (lobby state, plus the running round if any).
  const watchers = new Map<string, number>()
  const handleWatch = (ws: GameWs): void => {
    if (ws.data.playerId || ws.data.watcher) return
    const room = deps.rooms.get(ws.data.roomCode)
    if (!room) {
      send(ws, { type: 'JOIN_REJECTED', reason: 'room_not_found' })
      ws.close()
      return
    }
    const count = watchers.get(room.code) ?? 0
    if (count >= MAX_WATCHERS) {
      send(ws, { type: 'JOIN_REJECTED', reason: 'watchers_full' })
      ws.close()
      return
    }
    watchers.set(room.code, count + 1)
    ws.data.watcher = true
    ws.subscribe(roomTopic(room.code))
    deps.logger.info('watcher_joined', { room: room.code, watchers: count + 1 })
    send(ws, { type: 'WATCHING', protocolVersion: PROTOCOL_VERSION, roomCode: room.code })
    send(ws, lobbyState(room))
    for (const m of manager.resumeMessages(room.code)) send(ws, m)
  }

  // A closed room's watchers (if any) are told, so their screen doesn't freeze on the last frame.
  const closeForWatchers = (code: string): void => {
    if (!watchers.has(code)) return
    publish(roomTopic(code), JSON.stringify({ type: 'ERROR', reason: 'room_closed' }))
  }

  const handleJoin = (ws: GameWs, msg: Extract<ClientMsg, { type: 'JOIN' }>): void => {
    if (ws.data.playerId || ws.data.watcher) return // already joined (or watching) on this socket
    // Fork extra: mid-session, a JOIN under the name of a seat that has dropped takes that seat back
    // (score included). A phone that lost its tab (reopened the link, scanned the QR again, switched
    // browser) has no rejoin token, so its name is all it has. Never a connected seat: nobody is kicked.
    const live = deps.rooms.get(ws.data.roomCode)
    if (live && live.phase !== 'lobby') {
      const name = cleanName(msg.name).toLowerCase()
      const seat = live.list().find((p) => !p.connected && p.name.toLowerCase() === name)
      if (seat) {
        deps.logger.info('seat_reclaimed_by_name', { room: live.code, playerId: seat.id })
        handleRejoin(ws, { type: 'REJOIN', playerId: seat.id, token: seat.rejoinToken })
        return
      }
    }
    const result = deps.joinRoom.execute({
      code: ws.data.roomCode,
      name: msg.name,
      color: msg.color,
      avatar: msg.avatar,
      touch: msg.touch === true,
    })
    if (!result.ok) {
      send(ws, { type: 'JOIN_REJECTED', reason: result.reason })
      deps.logger.info('join_rejected', { room: ws.data.roomCode, reason: result.reason })
      ws.close()
      return
    }
    ws.data.playerId = result.playerId
    ws.data.isHost = result.isHost
    claimSeat(ws, result.playerId)
    ws.subscribe(roomTopic(ws.data.roomCode))
    ws.subscribe(playerTopic(result.playerId))
    deps.metrics.inc('players_joined')
    deps.logger.info('player_joined', {
      room: ws.data.roomCode,
      playerId: result.playerId,
      host: result.isHost,
    })
    send(ws, {
      type: 'WELCOME',
      protocolVersion: PROTOCOL_VERSION,
      playerId: result.playerId,
      roomCode: ws.data.roomCode,
      isHost: result.isHost,
      rejoinToken: result.rejoinToken,
    })
    const room = deps.rooms.get(ws.data.roomCode)
    if (room) {
      // Team line-up: slot the newcomer into the smaller team without reshuffling everyone else.
      if (lineupUsesTeams(room)) {
        const p = room.get(result.playerId)
        if (p && !p.team) p.setTeam(smallerTeam(room.teamCounts(), deps.random))
      }
      broadcastLobby(room)
    }
  }

  // REJOIN reclaims an existing seat after a socket drop: re-attach the id, mark it connected, then
  // replay the current session state to this one socket so its screen is restored.
  const handleRejoin = (ws: GameWs, msg: Extract<ClientMsg, { type: 'REJOIN' }>): void => {
    if (ws.data.playerId || ws.data.watcher) return
    const room = deps.rooms.get(ws.data.roomCode)
    const player = room?.get(msg.playerId)
    // A wrong token is answered like a gone seat: ids are public, so only the seat's own client (which
    // got the token in its WELCOME) may reclaim it.
    if (!room || !player || player.rejoinToken !== msg.token) {
      // Seat is gone (e.g. dropped from the lobby). Tell the client so it can fall back to a fresh JOIN.
      send(ws, { type: 'ACK', intent: 'REJOIN', ok: false, reason: 'unknown_player' })
      return
    }
    ws.data.playerId = player.id
    ws.data.isHost = room.isHost(player.id)
    claimSeat(ws, player.id)
    player.setConnected(true)
    ws.subscribe(roomTopic(ws.data.roomCode))
    ws.subscribe(playerTopic(player.id))
    deps.metrics.inc('rejoins')
    deps.logger.info('player_rejoined', { room: ws.data.roomCode, playerId: player.id })
    send(ws, {
      type: 'WELCOME',
      protocolVersion: PROTOCOL_VERSION,
      playerId: player.id,
      roomCode: ws.data.roomCode,
      isHost: ws.data.isHost,
      rejoinToken: player.rejoinToken,
    })
    broadcastLobby(room)
    for (const m of manager.resumeMessages(room.code)) send(ws, m)
  }

  const handleSetReady = (ws: GameWs, msg: Extract<ClientMsg, { type: 'SET_READY' }>): void => {
    const room = deps.rooms.get(ws.data.roomCode)
    const player = ws.data.playerId ? room?.get(ws.data.playerId) : undefined
    if (!room || !player) return
    player.setReady(msg.ready)
    broadcastLobby(room)
  }

  const handleHostConfig = (ws: GameWs, msg: Extract<ClientMsg, { type: 'HOST_CONFIG' }>): void => {
    const room = deps.rooms.get(ws.data.roomCode)
    if (!room || !ws.data.playerId || !room.isHost(ws.data.playerId)) {
      send(ws, { type: 'ACK', intent: 'HOST_CONFIG', ok: false, reason: 'not_host' })
      return
    }
    // Domain refinement at the boundary: keep only known distinct games and clamp the round count. With
    // no-repeat sessions a game never plays twice, so rounds is capped at the number of distinct games.
    const ids = [...new Set(msg.minigameIds.filter((id) => MINIGAMES_BY_ID.has(id)))]
    const cap = ids.length > 0 ? Math.min(20, ids.length) : 20
    const rounds = Math.max(1, Math.min(cap, Math.floor(msg.rounds) || 1))
    room.configure(ids, rounds, msg.handicap ?? room.handicap)
    ensureTeams(room)
    broadcastLobby(room)
  }

  const handleSetTeam = (ws: GameWs, msg: Extract<ClientMsg, { type: 'SET_TEAM' }>): void => {
    const room = deps.rooms.get(ws.data.roomCode)
    if (!room || !ws.data.playerId || !room.isHost(ws.data.playerId)) {
      send(ws, { type: 'ACK', intent: 'SET_TEAM', ok: false, reason: 'not_host' })
      return
    }
    const target = room.get(msg.playerId)
    if (!target || !(TEAM_IDS as readonly string[]).includes(msg.team)) {
      send(ws, { type: 'ACK', intent: 'SET_TEAM', ok: false, reason: 'invalid' })
      return
    }
    target.setTeam(msg.team)
    broadcastLobby(room)
  }

  const handleShuffleTeams = (ws: GameWs): void => {
    const room = deps.rooms.get(ws.data.roomCode)
    if (!room || !ws.data.playerId || !room.isHost(ws.data.playerId)) {
      send(ws, { type: 'ACK', intent: 'SHUFFLE_TEAMS', ok: false, reason: 'not_host' })
      return
    }
    room.setTeams(
      balancedTeams(
        room.list().map((p) => p.id),
        deps.random,
      ),
    )
    broadcastLobby(room)
  }

  const handleStartSession = (ws: GameWs): void => {
    const room = deps.rooms.get(ws.data.roomCode)
    if (!room || !ws.data.playerId || !room.isHost(ws.data.playerId)) {
      send(ws, { type: 'ACK', intent: 'START_SESSION', ok: false, reason: 'not_host' })
      return
    }
    if (room.phase !== 'lobby' || manager.isRunning(room.code)) {
      send(ws, { type: 'ACK', intent: 'START_SESSION', ok: false, reason: 'already_started' })
      return
    }
    // A line-up where no game fits the room (headcount, empty team — D27/D28) would silently fall back
    // to a default game.
    if (room.minigameIds.length > 0 && playableLineup(room).length === 0) {
      send(ws, { type: 'ACK', intent: 'START_SESSION', ok: false, reason: 'no_games_fit' })
      return
    }
    // The engine drives the round loop and sets the room phase; it publishes ROUND_INTRO immediately.
    manager.start(room)
    deps.metrics.inc('sessions_started')
    deps.logger.info('session_started', {
      room: room.code,
      games: [...room.minigameIds],
      rounds: room.rounds,
      players: room.list().length,
    })
    send(ws, { type: 'ACK', intent: 'START_SESSION', ok: true })
  }

  // Host-only: after FINAL_RANKING, send the room back to the lobby with the same roster/line-up/
  // handicap so the host can re-pick or reuse the line-up and start again via the normal START_SESSION
  // flow. The finished engine is already gone (SessionManager drops it once isFinished), so a fresh
  // START_SESSION naturally starts scoreless — the only reset needed here is the room's phase.
  const handlePlayAgain = (ws: GameWs): void => {
    const room = deps.rooms.get(ws.data.roomCode)
    if (!room || !ws.data.playerId || !room.isHost(ws.data.playerId)) {
      send(ws, { type: 'ACK', intent: 'PLAY_AGAIN', ok: false, reason: 'not_host' })
      return
    }
    if (room.phase !== 'final') {
      send(ws, { type: 'ACK', intent: 'PLAY_AGAIN', ok: false, reason: 'not_finished' })
      return
    }
    room.setPhase('lobby')
    for (const p of room.list()) p.setReady(false)
    deps.logger.info('play_again', { room: room.code })
    broadcastLobby(room)
    send(ws, { type: 'ACK', intent: 'PLAY_AGAIN', ok: true })
  }

  // Host-only: skip the round in progress (a misbehaving game shouldn't hold the whole room).
  const handleSkipRound = (ws: GameWs): void => {
    const room = deps.rooms.get(ws.data.roomCode)
    if (!room || !ws.data.playerId || !room.isHost(ws.data.playerId)) {
      send(ws, { type: 'ACK', intent: 'SKIP_ROUND', ok: false, reason: 'not_host' })
      return
    }
    if (!manager.skip(room.code, ws.data.playerId)) {
      send(ws, { type: 'ACK', intent: 'SKIP_ROUND', ok: false, reason: 'no_round' })
      return
    }
    deps.metrics.inc('rounds_skipped')
    deps.logger.info('round_skipped', { room: room.code, by: ws.data.playerId })
    send(ws, { type: 'ACK', intent: 'SKIP_ROUND', ok: true })
  }

  const handleTransferHost = (
    ws: GameWs,
    msg: Extract<ClientMsg, { type: 'TRANSFER_HOST' }>,
  ): void => {
    const room = deps.rooms.get(ws.data.roomCode)
    if (!room || !ws.data.playerId || !room.isHost(ws.data.playerId)) {
      send(ws, { type: 'ACK', intent: 'TRANSFER_HOST', ok: false, reason: 'not_host' })
      return
    }
    if (!room.transferHost(msg.playerId)) {
      send(ws, { type: 'ACK', intent: 'TRANSFER_HOST', ok: false, reason: 'unknown_player' })
      return
    }
    deps.metrics.inc('host_transfers')
    deps.logger.info('host_transferred', {
      room: room.code,
      from: ws.data.playerId,
      to: msg.playerId,
    })
    broadcastLobby(room)
  }

  const handleKick = (ws: GameWs, msg: Extract<ClientMsg, { type: 'KICK_PLAYER' }>): void => {
    const room = deps.rooms.get(ws.data.roomCode)
    if (!room || !ws.data.playerId || !room.isHost(ws.data.playerId)) {
      send(ws, { type: 'ACK', intent: 'KICK_PLAYER', ok: false, reason: 'not_host' })
      return
    }
    if (msg.playerId === ws.data.playerId || !room.get(msg.playerId)) {
      send(ws, { type: 'ACK', intent: 'KICK_PLAYER', ok: false, reason: 'unknown_player' })
      return
    }
    // Notify the kicked seat over its own topic (it may still be listening), then drop it from the
    // roster. Their client returns to the entry screen; if they re-enter the code they can rejoin —
    // this is a "remove now", not a ban (no accounts/ban list in Phase 1).
    publish(playerTopic(msg.playerId), JSON.stringify({ type: 'KICKED' } satisfies ServerMsg))
    room.remove(msg.playerId)
    deps.metrics.inc('kicks')
    deps.logger.info('player_kicked', {
      room: room.code,
      by: ws.data.playerId,
      playerId: msg.playerId,
    })
    broadcastLobby(room)
  }

  const handleMinigameInput = (
    ws: GameWs,
    msg: Extract<ClientMsg, { type: 'MINIGAME_INPUT' }>,
  ): void => {
    if (!ws.data.playerId) return
    manager.input(ws.data.roomCode, ws.data.playerId, msg.input)
  }

  const dispatch = (ws: GameWs, msg: ClientMsg): void => {
    // Any inbound intent keeps the room alive against the idle sweeper.
    deps.rooms.get(ws.data.roomCode)?.touch(deps.clock.now())
    deps.metrics.inc('messages')
    switch (msg.type) {
      case 'JOIN':
        handleJoin(ws, msg)
        break
      case 'REJOIN':
        handleRejoin(ws, msg)
        break
      case 'WATCH':
        handleWatch(ws)
        break
      case 'SET_READY':
        handleSetReady(ws, msg)
        break
      case 'HOST_CONFIG':
        handleHostConfig(ws, msg)
        break
      case 'SET_TEAM':
        handleSetTeam(ws, msg)
        break
      case 'SHUFFLE_TEAMS':
        handleShuffleTeams(ws)
        break
      case 'TRANSFER_HOST':
        handleTransferHost(ws, msg)
        break
      case 'KICK_PLAYER':
        handleKick(ws, msg)
        break
      case 'START_SESSION':
        handleStartSession(ws)
        break
      case 'PLAY_AGAIN':
        handlePlayAgain(ws)
        break
      case 'SKIP_ROUND':
        handleSkipRound(ws)
        break
      case 'MINIGAME_INPUT':
        handleMinigameInput(ws, msg)
        break
      case 'LEAVE':
        ws.close()
        break
      default: {
        const type = (msg as { type: string }).type
        if (!warnedUnknownIntents.has(type)) {
          warnedUnknownIntents.add(type)
          console.warn(`[ws] unknown intent type: ${type}`)
        }
      }
    }
  }

  const teardown = (ws: GameWs): void => {
    if (ws.data.watcher) {
      const left = (watchers.get(ws.data.roomCode) ?? 1) - 1
      if (left > 0) watchers.set(ws.data.roomCode, left)
      else watchers.delete(ws.data.roomCode)
      return
    }
    // Only the socket that currently holds the seat may release it (see seatSockets).
    if (!ws.data.playerId || seatSockets.get(ws.data.playerId) !== ws) return
    seatSockets.delete(ws.data.playerId)
    const room = deps.rooms.get(ws.data.roomCode)
    if (!room) return
    const player = room.get(ws.data.playerId)
    deps.metrics.inc('disconnects')
    // During a live session keep the seat (and its score) so the player can rejoin; only mark it
    // disconnected. Tear the room down once nobody is left connected.
    if (manager.isRunning(room.code) && player) {
      player.setConnected(false)
      if (!room.hasConnectedPlayers) {
        manager.stop(room.code)
        deps.rooms.remove(room.code)
        closeForWatchers(room.code)
        deps.logger.info('room_closed', { room: room.code, reason: 'all_disconnected' })
        return
      }
      // If the host is the one that dropped, hand the role to a still-connected member.
      const newHost = room.reassignHostIfDisconnected()
      if (newHost)
        deps.logger.info('host_transferred', { room: room.code, to: newHost, reason: 'disconnect' })
      broadcastLobby(room)
      return
    }
    room.remove(ws.data.playerId)
    deps.logger.info('player_left', { room: room.code, playerId: ws.data.playerId })
    if (room.isEmpty) {
      manager.stop(room.code)
      deps.rooms.remove(room.code)
      closeForWatchers(room.code)
      deps.logger.info('room_closed', { room: room.code, reason: 'empty' })
      return
    }
    broadcastLobby(room)
  }

  // Last line of defence for everything a client can trigger: an exception in a handler is logged and
  // answered, never allowed to take the process (and every room in it) down.
  const guard = (where: string, fn: () => void): void => {
    try {
      fn()
    } catch (err) {
      deps.metrics.inc('errors')
      deps.logger.error('handler_failed', {
        where,
        error: String(err),
        stack: (err as Error)?.stack,
      })
    }
  }

  // One inbound frame: parse, validate, dispatch (a bad frame is answered, never thrown).
  const message = (ws: GameWs, raw: string | { toString(): string }): void => {
    let parsed: unknown
    try {
      parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
    } catch {
      deps.metrics.inc('errors')
      send(ws, { type: 'ERROR', reason: 'malformed message' })
      return
    }
    if (!isValidClientMsg(parsed)) {
      deps.metrics.inc('errors')
      send(ws, { type: 'ERROR', reason: 'malformed message' })
      return
    }
    const msg = parsed
    guard(`message:${msg.type}`, () => dispatch(ws, msg))
  }

  const close = (ws: GameWs): void => {
    guard('close', () => teardown(ws))
  }

  const publisher: Publisher = {
    toRoom(code, msg) {
      publish(roomTopic(code), JSON.stringify(msg))
    },
  }
  manager = new SessionManager(
    publisher,
    deps.clock,
    deps.random,
    deps.sessionConfig,
    (room, where, err) => {
      deps.metrics.inc('errors')
      deps.logger.error('session_failed', {
        room,
        where,
        error: String(err),
        stack: (err as Error)?.stack,
      })
    },
  )
  const loop = buildSimulationLoop(manager, deps.sessionConfig.tickHz)

  // Idle-room reaper: sweep on a coarse interval (min of the idle window and 60 s) so abandoned lobbies
  // and never-joined rooms don't leak in the in-memory store. Notifies any lingering listener, then
  // drops the room.
  const idleMs = deps.roomIdleTimeoutSec * 1000
  const sweepTimer = setInterval(
    () =>
      guard('sweep', () => {
        const reaped = reapIdleRooms({
          rooms: deps.rooms,
          manager,
          now: deps.clock.now(),
          idleMs,
          onReap: (code) => {
            publish(roomTopic(code), JSON.stringify({ type: 'ERROR', reason: 'room_closed' }))
            deps.logger.info('room_reaped', { room: code })
          },
        })
        if (reaped.length) deps.metrics.inc('rooms_reaped', reaped.length)
      }),
    Math.min(idleMs, 60_000),
  )

  return {
    message,
    close,
    metricsSnapshot,
    // Exposed for a clean shutdown (tests / signal handling).
    stop: () => {
      loop.stop()
      clearInterval(sweepTimer)
    },
  }
}

export function startGameServer(deps: GameSocketDeps) {
  // Assigned right after Bun.serve returns (synchronously, before any engine output can be published).
  let server: ReturnType<typeof Bun.serve<SocketData, never>>
  const core = createGameCore(deps, (topic, data) => {
    server.publish(topic, data)
  })
  const metricsSnapshot = core.metricsSnapshot

  server = Bun.serve<SocketData, never>({
    port: deps.port ?? config.port,
    // Production answers a failed request with a bare 500, not Bun's debug page (stack + source).
    development: config.isDevelopment,
    async fetch(req, srv) {
      const url = new URL(req.url)
      const base = config.basePath
      // `/pixel-party` → `/pixel-party/`: the page's relative URLs only resolve below the slash.
      if (base && url.pathname === base) {
        return new Response(null, { status: 308, headers: { location: `${base}/${url.search}` } })
      }
      const path = withinBase(url.pathname, base)

      if (path.startsWith('/api')) {
        return handleHttp(req, { ...deps, metricsSnapshot }, path)
      }

      if (path === '/ws') {
        // Origin allowlist (fail-closed): reject cross-origin upgrades. A missing Origin is a non-browser
        // client — exactly what the allowlist scrutinizes. In party mode the page we served is
        // same-origin and always welcome.
        const origin = req.headers.get('origin')
        const allowed =
          origin !== null &&
          (config.allowedOrigins.includes(origin) || (!!deps.site && isSameOrigin(req, origin)))
        if (!allowed) {
          return new Response('Forbidden origin', { status: 403 })
        }
        const code = (url.searchParams.get('room') ?? '').toUpperCase()
        if (!deps.rooms.get(code)) return new Response('Room not found', { status: 404 })

        const data: SocketData = { roomCode: code, connId: crypto.randomUUID(), isHost: false }
        if (srv.upgrade(req, { data })) return undefined
        return new Response('Upgrade failed', { status: 426 })
      }

      return deps.site?.serve(req, path) ?? new Response('Not found', { status: 404 })
    },
    websocket: {
      idleTimeout: config.wsIdleTimeoutSec,
      // The biggest legitimate frame (a full HOST_CONFIG) is ~2 KB; Bun's default would take 16 MB.
      maxPayloadLength: 64 * 1024,
      // Bun's automatic ping/pong keepalive. Without it, a connection with no application traffic for
      // `wsIdleTimeoutSec` (e.g. a player idling in the lobby, or reading a self-paced puzzle round)
      // gets force-closed as idle even though the player is still there.
      sendPings: true,
      open() {
        // Nothing to do until JOIN mints identity; the client sends JOIN as its first frame.
      },
      message(ws, raw) {
        core.message(ws, raw)
      },
      close(ws) {
        core.close(ws)
      },
    },
  })

  return Object.assign(server, { stopLoop: core.stop })
}

export type GameServerHandle = ReturnType<typeof startGameServer>
