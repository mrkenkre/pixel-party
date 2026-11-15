import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { AVATARS, PLAYER_COLORS, type ServerMsg } from '@pp/shared'

// The game socket end to end: seat reclaiming (REJOIN), start refusals, and what a hostile or broken
// client may send without taking the server down.
process.env.ALLOWED_ORIGINS = 'http://test.local'

const { CreateRoomUseCase } = await import('../src/application/use-cases/CreateRoomUseCase')
const { JoinRoomUseCase } = await import('../src/application/use-cases/JoinRoomUseCase')
const { CryptoIdGenerator } = await import('../src/infrastructure/driven/id/CryptoIdGenerator')
const { SeededRandom } = await import('../src/infrastructure/driven/random/SeededRandom')
const { SystemClock } = await import('../src/infrastructure/driven/time/SystemClock')
const { startGameServer } = await import('../src/infrastructure/driving/ws/GameSocket')
const { LiveRooms } = await import('../src/infrastructure/live/LiveRooms')
const { createLogger } = await import('../src/infrastructure/observability/logger')
const { createMetrics } = await import('../src/infrastructure/observability/metrics')

type Server = ReturnType<typeof startGameServer>
let server: Server

beforeAll(() => {
  const clock = new SystemClock()
  const ids = new CryptoIdGenerator()
  const rooms = new LiveRooms(ids, 4, 10, clock, false)
  server = startGameServer({
    rooms,
    createRoom: new CreateRoomUseCase(rooms),
    joinRoom: new JoinRoomUseCase(rooms, ids),
    clock,
    random: new SeededRandom(1),
    sessionConfig: {
      introMs: 50,
      roundResultMs: 50,
      scoreboardMs: 50,
      tickHz: 20,
      snapshotEveryNTicks: 3,
      defaultDurationMs: 1000,
      baseSeed: 1,
      handicap: { enabled: false, maxBonusPct: 0.2 },
    },
    logger: { ...createLogger(), info: () => {} },
    metrics: createMetrics(),
    roomIdleTimeoutSec: 900,
    port: 0,
  })
})

afterAll(() => {
  server.stopLoop()
  server.stop(true)
})

interface Client {
  ws: WebSocket
  msgs: ServerMsg[]
  next: (type: ServerMsg['type']) => Promise<ServerMsg>
  closed: Promise<void>
}

function connect(code: string): Promise<Client> {
  const ws = new WebSocket(`ws://localhost:${server.port}/ws?room=${code}`, {
    // @ts-expect-error Bun's WebSocket accepts request headers (the typings only know protocols)
    headers: { Origin: 'http://test.local' },
  })
  const msgs: ServerMsg[] = []
  const waiters: { type: ServerMsg['type']; resolve: (m: ServerMsg) => void }[] = []
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as ServerMsg
    msgs.push(m)
    for (const w of [...waiters]) {
      if (w.type === m.type) {
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve(m)
      }
    }
  }
  const closed = new Promise<void>((resolve) => {
    ws.onclose = () => resolve()
  })
  const next = (type: ServerMsg['type']) =>
    new Promise<ServerMsg>((resolve) => waiters.push({ type, resolve }))
  return new Promise((resolve) => {
    ws.onopen = () => resolve({ ws, msgs, next, closed })
  })
}

async function createRoom(): Promise<string> {
  const res = await fetch(`http://localhost:${server.port}/api/rooms`, { method: 'POST' })
  return ((await res.json()) as { code: string }).code
}

async function join(code: string, name: string): Promise<{ client: Client; welcome: ServerMsg }> {
  const client = await connect(code)
  client.ws.send(JSON.stringify({ type: 'JOIN', name, color: '#29d3f2', avatar: 'owl' }))
  return { client, welcome: await client.next('WELCOME') }
}

const healthy = async (): Promise<boolean> =>
  (await fetch(`http://localhost:${server.port}/api/health`)).ok

// A browser reload opens the new socket and REJOINs before the server has processed the old socket's
// close. That late close must not drop (lobby) or mark offline (mid-session) the reclaimed seat.
describe('REJOIN while the previous socket is still open (page reload race)', () => {
  test('keeps the reclaimed seat and closes the superseded socket', async () => {
    const code = await createRoom()
    const host = await connect(code)
    host.ws.send(JSON.stringify({ type: 'JOIN', name: 'Host', color: '#ff3e7f', avatar: 'cat' }))
    await host.next('WELCOME')

    const a = await connect(code)
    a.ws.send(JSON.stringify({ type: 'JOIN', name: 'Ada', color: '#29d3f2', avatar: 'owl' }))
    const welcome = await a.next('WELCOME')
    if (welcome.type !== 'WELCOME') throw new Error('no welcome')

    // The "reloaded page" reclaims the seat while socket A is still connected.
    const b = await connect(code)
    b.ws.send(
      JSON.stringify({ type: 'REJOIN', playerId: welcome.playerId, token: welcome.rejoinToken }),
    )
    await b.next('WELCOME')
    await a.closed // the server closes the superseded socket…

    // …and its close must not have removed / disconnected the seat now held by socket B.
    b.ws.send(JSON.stringify({ type: 'SET_READY', ready: true }))
    const lobby = await b.next('LOBBY_STATE')
    if (lobby.type !== 'LOBBY_STATE') throw new Error('no lobby')
    const seat = lobby.players.find((p) => p.id === welcome.playerId)
    expect(seat?.connected).toBe(true)
    expect(seat?.ready).toBe(true)
    expect(lobby.players).toHaveLength(2)

    host.ws.close()
    b.ws.close()
  })
})

describe('START_SESSION with a line-up that does not fit the headcount (D27)', () => {
  test('is refused instead of falling back to a default game', async () => {
    const code = await createRoom()
    const host = await connect(code)
    host.ws.send(JSON.stringify({ type: 'JOIN', name: 'Solo', color: '#ff3e7f', avatar: 'cat' }))
    await host.next('WELCOME')

    // A duel needs a second player, so a solo host has nothing to play.
    host.ws.send(
      JSON.stringify({ type: 'HOST_CONFIG', minigameIds: ['sink-the-fleet'], rounds: 1 }),
    )
    await host.next('LOBBY_STATE')
    host.ws.send(JSON.stringify({ type: 'START_SESSION' }))
    const ack = await host.next('ACK')
    expect(ack).toMatchObject({ intent: 'START_SESSION', ok: false, reason: 'no_games_fit' })

    host.ws.close()
  })
})

describe('REJOIN needs the seat token', () => {
  test("another player can't take a seat with its public id", async () => {
    const code = await createRoom()
    const { client: host, welcome } = await join(code, 'Host')
    if (welcome.type !== 'WELCOME') throw new Error('no welcome')
    const { client: rival } = await join(code, 'Rival')
    // The rival sees the host's id in every LOBBY_STATE, but not its token.
    const thief = await connect(code)
    thief.ws.send(JSON.stringify({ type: 'REJOIN', playerId: welcome.playerId, token: 'guess' }))
    const ack = await thief.next('ACK')
    expect(ack).toMatchObject({ intent: 'REJOIN', ok: false })
    expect(host.ws.readyState).toBe(WebSocket.OPEN)
    for (const c of [host, rival, thief]) c.ws.close()
  })
})

describe('hostile messages never take the server down', () => {
  test('a null game input is refused as malformed', async () => {
    const code = await createRoom()
    const { client: host } = await join(code, 'Host')
    host.ws.send(JSON.stringify({ type: 'HOST_CONFIG', minigameIds: ['pang'], rounds: 1 }))
    await host.next('LOBBY_STATE')
    host.ws.send(JSON.stringify({ type: 'START_SESSION' }))
    await host.next('ROUND_STATE')
    host.ws.send(JSON.stringify({ type: 'MINIGAME_INPUT', input: null }))
    expect(await host.next('ERROR')).toMatchObject({ reason: 'malformed message' })
    expect(await healthy()).toBe(true)
    host.ws.close()
  })

  test('a blank or invisible name is rejected; a long one is cut', async () => {
    const code = await createRoom()
    const blank = await connect(code)
    blank.ws.send(JSON.stringify({ type: 'JOIN', name: ' \u200b ', color: '#fff', avatar: 'cat' }))
    expect(await blank.next('JOIN_REJECTED')).toMatchObject({ reason: 'invalid_name' })
    expect(await healthy()).toBe(true)

    const long = await connect(code)
    long.ws.send(
      JSON.stringify({ type: 'JOIN', name: 'Z'.repeat(5000), color: 'url(x)', avatar: 'dragon' }),
    )
    const lobby = await long.next('LOBBY_STATE')
    if (lobby.type !== 'LOBBY_STATE') throw new Error('no lobby')
    const [seat] = lobby.players
    expect(seat?.name).toBe('Z'.repeat(16))
    expect(seat?.color).toBe(PLAYER_COLORS[0])
    expect(seat?.avatar).toBe(AVATARS[0])
    long.ws.close()
  })
})

// Fork extra (party-20): a phone that lost its tab mid-game has no rejoin token; its name gets the
// dropped seat back. A connected seat is never taken.
describe('JOIN by name mid-session', () => {
  test('reclaims a dropped seat, never a connected one', async () => {
    const code = await createRoom()
    const { client: host } = await join(code, 'Host')
    const { client: ada, welcome } = await join(code, 'Ada')
    if (welcome.type !== 'WELCOME') throw new Error('no welcome')
    const { client: bob } = await join(code, 'Bob')
    host.ws.send(JSON.stringify({ type: 'HOST_CONFIG', minigameIds: ['button-masher'], rounds: 1 }))
    const intro = host.next('ROUND_INTRO')
    host.ws.send(JSON.stringify({ type: 'START_SESSION' }))
    await intro

    // Bob is still connected: someone else using his name is turned away.
    const imposter = await connect(code)
    imposter.ws.send(JSON.stringify({ type: 'JOIN', name: 'bob', color: '#ff3e7f', avatar: 'cat' }))
    expect(await imposter.next('JOIN_REJECTED')).toMatchObject({ reason: 'session_in_progress' })
    expect(bob.ws.readyState).toBe(WebSocket.OPEN)

    // Ada's phone drops; a fresh tab joining as "Ada" gets her seat (same id) back.
    ada.ws.close()
    await Bun.sleep(100)
    const back = await connect(code)
    back.ws.send(JSON.stringify({ type: 'JOIN', name: ' ada ', color: '#ff3e7f', avatar: 'cat' }))
    const again = await back.next('WELCOME')
    expect(again).toMatchObject({ playerId: welcome.playerId })
    for (const c of [host, bob, back, imposter]) c.ws.close()
  })
})

// Fork extra (party-20): the host stops a game mid-way to start over with different people.
describe('END_SESSION', () => {
  test('host only; back to the lobby, dropped seats let go, new players can join', async () => {
    const code = await createRoom()
    const { client: host } = await join(code, 'Host')
    const { client: ada } = await join(code, 'Ada')
    const { client: bob } = await join(code, 'Bob')
    host.ws.send(JSON.stringify({ type: 'HOST_CONFIG', minigameIds: ['button-masher'], rounds: 1 }))
    const intro = host.next('ROUND_INTRO')
    host.ws.send(JSON.stringify({ type: 'START_SESSION' }))
    await intro

    // Not the host: refused, the game goes on.
    ada.ws.send(JSON.stringify({ type: 'END_SESSION' }))
    expect(await ada.next('ACK')).toMatchObject({
      intent: 'END_SESSION',
      ok: false,
      reason: 'not_host',
    })

    bob.ws.close() // Bob leaves mid-game; his seat is held…
    await Bun.sleep(100)
    const ended = ada.next('SESSION_ENDED')
    const lobby = ada.next('LOBBY_STATE')
    const ack = host.next('ACK')
    host.ws.send(JSON.stringify({ type: 'END_SESSION' }))
    expect(await ended).toMatchObject({ type: 'SESSION_ENDED' })
    const state = (await lobby) as Extract<ServerMsg, { type: 'LOBBY_STATE' }>
    expect(state.phase).toBe('lobby')
    expect(state.players.map((p) => p.name).sort()).toEqual(['Ada', 'Host']) // …until the game ends
    expect(await ack).toMatchObject({ intent: 'END_SESSION', ok: true })

    // A newcomer can join now, and a second END_SESSION has nothing to end.
    const { welcome } = await join(code, 'Cleo')
    expect(welcome.type).toBe('WELCOME')
    host.ws.send(JSON.stringify({ type: 'END_SESSION' }))
    expect(await host.next('ACK')).toMatchObject({ ok: false, reason: 'no_session' })
    for (const c of [host, ada]) c.ws.close()
  })
})

// Fork extra (party-20): a TV/laptop follows the room without a seat.
describe('WATCH (spectator screen)', () => {
  test('gets the room broadcasts without taking a seat', async () => {
    const code = await createRoom()
    const { client: host } = await join(code, 'Host')
    const tv = await connect(code)
    const lobby = tv.next('LOBBY_STATE')
    tv.ws.send(JSON.stringify({ type: 'WATCH' }))
    const watching = await tv.next('WATCHING')
    expect(watching).toMatchObject({ type: 'WATCHING', roomCode: code })
    const state = (await lobby) as Extract<ServerMsg, { type: 'LOBBY_STATE' }>
    expect(state.players.map((p) => p.name)).toEqual(['Host'])

    // A player joining later is broadcast to the watcher; the watcher is never listed.
    const roster = tv.next('LOBBY_STATE')
    const { client: guest } = await join(code, 'Guest')
    const after = (await roster) as Extract<ServerMsg, { type: 'LOBBY_STATE' }>
    expect(after.players.map((p) => p.name).sort()).toEqual(['Guest', 'Host'])

    // Intents from a watcher do nothing (no seat): it can't ready up or start the session.
    tv.ws.send(JSON.stringify({ type: 'START_SESSION' }))
    tv.ws.send(JSON.stringify({ type: 'SET_READY', ready: true }))
    tv.ws.send(JSON.stringify({ type: 'JOIN', name: 'Sneaky', color: '#ff3e7f', avatar: 'cat' }))
    await Bun.sleep(150)
    expect(tv.msgs.some((m) => m.type === 'WELCOME' || m.type === 'ROUND_INTRO')).toBe(false)

    // The round reaches the watcher too.
    const intro = tv.next('ROUND_INTRO')
    host.ws.send(JSON.stringify({ type: 'HOST_CONFIG', minigameIds: ['button-masher'], rounds: 1 }))
    host.ws.send(JSON.stringify({ type: 'START_SESSION' }))
    expect(await intro).toMatchObject({ type: 'ROUND_INTRO', minigameId: 'button-masher' })

    // Everyone leaves: the watcher hears the room is gone.
    const closedMsg = tv.next('ERROR')
    host.ws.close()
    guest.ws.close()
    expect(await closedMsg).toMatchObject({ reason: 'room_closed' })
    tv.ws.close()
    expect(await healthy()).toBe(true)
  })
})
