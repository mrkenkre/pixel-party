// Pixel Party on Cloudflare Workers.
//
// - The Worker serves the client build (static assets), /api, /ws and the leaderboard.
// - Each room is one Durable Object (RoomDO, named by the room code). It runs the very same game core
//   as the Bun server (createGameCore: intent handlers, session engine, 20 Hz loop, idle sweeper);
//   only the socket transport differs. Room state stays in memory, as on the Bun server: when the
//   room empties it is gone.
// - ScoresDO is a single Durable Object holding the leaderboard (wins/games/points per name), the
//   Workers counterpart of the Pi's pp-hook.js.

import { DurableObject } from 'cloudflare:workers'
import { APP_VERSION } from '@pp/shared'
import type { SessionConfig } from '../../server/src/application/session/SessionEngine'
import { CreateRoomUseCase } from '../../server/src/application/use-cases/CreateRoomUseCase'
import { JoinRoomUseCase } from '../../server/src/application/use-cases/JoinRoomUseCase'
import { config } from '../../server/src/config'
import { CryptoIdGenerator } from '../../server/src/infrastructure/driven/id/CryptoIdGenerator'
import { SeededRandom } from '../../server/src/infrastructure/driven/random/SeededRandom'
import { SystemClock } from '../../server/src/infrastructure/driven/time/SystemClock'
import {
  createGameCore,
  type GameWs,
  type SocketData,
} from '../../server/src/infrastructure/driving/ws/GameSocket'
import { LiveRooms } from '../../server/src/infrastructure/live/LiveRooms'
import { createLogger } from '../../server/src/infrastructure/observability/logger'
import { createMetrics } from '../../server/src/infrastructure/observability/metrics'

interface Env {
  ROOMS: DurableObjectNamespace<RoomDO>
  SCORES: DurableObjectNamespace<ScoresDO>
  ASSETS: Fetcher
  INTRO_SECONDS?: string
  ENGLISH_ONLY?: string
}

// Same alphabet as CryptoIdGenerator (no 0/O/1/I).
const ROOM_CODE = /^[A-HJ-NP-Z2-9]{3,8}$/
const MAX_FRAME = 64 * 1024 // like the Bun server's maxPayloadLength
const KEEPALIVE_MS = 25_000 // keeps quiet lobby sockets open through the edge
const UNUSED_ROOM_MS = 4 * 60_000 // a room nobody is connected to is dropped after this; longer
// than the lobby away grace (LOBBY_AWAY_GRACE_MS) so a host sharing the link keeps the room

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

// ---------------------------------------------------------------------------------------------------
// Room: one Durable Object per room code.

// LiveRooms mints its own code; here the code is the Durable Object's name, so hand that one back.
class FixedCodeIds extends CryptoIdGenerator {
  constructor(private readonly code: string) {
    super()
  }
  override roomCode(): string {
    return this.code
  }
}

type Sock = GameWs & { topics: Set<string> }
type Core = ReturnType<typeof createGameCore>

export class RoomDO extends DurableObject<Env> {
  private code = ''
  private core?: Core
  private rooms?: LiveRooms
  private readonly sockets = new Set<Sock>()
  private timer?: ReturnType<typeof setInterval>
  private lastSocketAt = 0

  private boot(code: string): void {
    if (this.core) return
    this.code = code
    const clock = new SystemClock()
    const seed = crypto.getRandomValues(new Uint32Array(1))[0] ?? 1
    const ids = new FixedCodeIds(code)
    const rooms = new LiveRooms(
      ids,
      code.length,
      config.roomMaxPlayers,
      clock,
      config.handicapEnabled,
    )
    const introSec = Number(this.env.INTRO_SECONDS)
    const sessionConfig: SessionConfig = {
      introMs: introSec >= 1 && introSec <= 120 ? Math.round(introSec * 1000) : 5000,
      roundResultMs: 4000,
      scoreboardMs: 4000,
      roundEndGraceMs: 1500,
      tickHz: config.tickHz,
      snapshotEveryNTicks: config.snapshotEveryNTicks,
      defaultDurationMs: 10_000,
      baseSeed: seed,
      handicap: { enabled: config.handicapEnabled, maxBonusPct: config.handicapMaxBonusPct },
    }
    this.rooms = rooms
    this.core = createGameCore(
      {
        rooms,
        createRoom: new CreateRoomUseCase(rooms),
        joinRoom: new JoinRoomUseCase(rooms, ids),
        clock,
        random: new SeededRandom(seed),
        sessionConfig,
        logger: createLogger(),
        metrics: createMetrics(),
        roomIdleTimeoutSec: config.roomIdleTimeoutSec,
      },
      (topic, data) => this.publish(topic, data),
    )
    this.lastSocketAt = Date.now()
    this.timer = setInterval(() => this.housekeeping(), KEEPALIVE_MS)
  }

  // Stop the loops so the object can be evicted; the room (if any) is dropped with it.
  private shutdown(): void {
    this.core?.stop()
    if (this.timer) clearInterval(this.timer)
    this.core = undefined
    this.rooms = undefined
    this.timer = undefined
  }

  private housekeeping(): void {
    const gone = !this.rooms?.get(this.code)
    // A closed room may still have watch-only screens (TVs) open: they were told (room_closed), now
    // let them go so a forgotten TV doesn't keep this object running.
    if (gone) {
      for (const s of [...this.sockets]) s.close()
      this.shutdown()
      return
    }
    for (const s of this.sockets) s.send('{"type":"KEEPALIVE"}')
    if (this.sockets.size > 0) this.lastSocketAt = Date.now()
    if (this.sockets.size === 0 && Date.now() - this.lastSocketAt > UNUSED_ROOM_MS) this.shutdown()
  }

  private publish(topic: string, data: string): void {
    for (const s of this.sockets) if (s.topics.has(topic)) s.send(data)
    if (data.startsWith('{"type":"FINAL_RANKING"')) this.recordFinal(data)
  }

  private recordFinal(data: string): void {
    try {
      const msg = JSON.parse(data) as {
        scores?: { playerId: string; points: number; rank: number }[]
      }
      const room = this.rooms?.get(this.code)
      if (!room || !Array.isArray(msg.scores)) return
      const players = msg.scores.map((s) => ({
        name:
          String(room.get(s.playerId)?.name ?? 'Player')
            .trim()
            .slice(0, 24) || 'Player',
        points: Number(s.points) || 0,
        rank: Number(s.rank) || 0,
      }))
      const board = this.env.SCORES.get(this.env.SCORES.idFromName('board'))
      this.ctx.waitUntil(board.record(this.code, players).catch(() => {}))
    } catch {
      // The leaderboard is a nice-to-have: never let it disturb the game.
    }
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const code = (url.searchParams.get('code') ?? url.searchParams.get('room') ?? '').toUpperCase()
    if (!ROOM_CODE.test(code)) return json({ error: 'bad_code' }, 400)

    if (url.pathname === '/init') {
      this.boot(code)
      if (this.rooms?.get(code)) return json({ error: 'taken' }, 409)
      this.rooms?.create()
      this.lastSocketAt = Date.now()
      return json({ code }, 201)
    }

    const room = this.rooms?.get(code)
    if (url.pathname === '/info') {
      return json({ exists: !!room, phase: room?.phase ?? null }, room ? 200 : 404)
    }

    // WebSocket upgrade (forwarded by the Worker after its origin check).
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket')
      return json({ error: 'not_found' }, 404)
    if (!room || !this.core) return new Response('Room not found', { status: 404 })
    const core = this.core
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    server.accept()
    let closed = false
    const sock: Sock = {
      data: { roomCode: code, connId: crypto.randomUUID(), isHost: false } satisfies SocketData,
      topics: new Set(),
      send: (m) => {
        try {
          server.send(m)
        } catch {
          // socket already gone; its close event does the cleanup
        }
      },
      // Bun runs the close handler after ws.close(); do the same here, once.
      close: () => {
        try {
          server.close(1000, 'closed')
        } catch {}
        queueMicrotask(done)
      },
      subscribe: (t) => {
        sock.topics.add(t)
      },
    }
    const done = (): void => {
      if (closed) return
      closed = true
      this.sockets.delete(sock)
      this.lastSocketAt = Date.now()
      core.close(sock)
    }
    this.sockets.add(sock)
    this.lastSocketAt = Date.now()
    server.addEventListener('message', (e) => {
      if (closed) return
      const raw = typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data)
      if (raw.length > MAX_FRAME) return sock.close()
      core.message(sock, raw)
    })
    server.addEventListener('close', done)
    server.addEventListener('error', done)
    return new Response(null, { status: 101, webSocket: client })
  }
}

// ---------------------------------------------------------------------------------------------------
// Leaderboard: one Durable Object, same data shape as the Pi's scores.json.

type Board = {
  version: 1
  players: Record<
    string,
    { name: string; games: number; wins: number; points: number; last: string }
  >
  games: { at: string; room: string; players: { name: string; points: number; rank: number }[] }[]
}
const MAX_GAMES = 200

export class ScoresDO extends DurableObject<Env> {
  async board(): Promise<Board> {
    return (await this.ctx.storage.get<Board>('board')) ?? { version: 1, players: {}, games: [] }
  }

  async record(
    room: string,
    players: { name: string; points: number; rank: number }[],
  ): Promise<void> {
    if (players.length < 2) return // solo test runs are not a leaderboard
    const board = await this.board()
    const at = new Date().toISOString()
    board.games.unshift({ at, room, players })
    board.games.length = Math.min(board.games.length, MAX_GAMES)
    for (const p of players) {
      const k = p.name.toLowerCase()
      board.players[k] ??= { name: p.name, games: 0, wins: 0, points: 0, last: at }
      const e = board.players[k]
      e.name = p.name
      e.games += 1
      if (p.rank === 1) e.wins += 1
      e.points += p.points
      e.last = at
    }
    await this.ctx.storage.put('board', board)
  }
}

const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
function scoresPage(board: Board): string {
  const rows = Object.values(board.players)
    .sort((a, b) => b.wins - a.wins || b.points - a.points)
    .map(
      (p, i) =>
        `<tr><td>${i + 1}</td><td>${esc(p.name)}</td><td>${p.wins}</td><td>${p.games}</td><td>${p.points}</td><td>${esc(p.last.slice(0, 10))}</td></tr>`,
    )
    .join('')
  const games = board.games
    .slice(0, 20)
    .map(
      (g) =>
        `<li>${esc(new Date(g.at).toLocaleString('en-US', { timeZone: 'America/New_York' }))}: ${g.players.map((p) => `${p.rank}. ${esc(p.name)} (${p.points})`).join(', ')}</li>`,
    )
    .join('')
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pixel Party leaderboard</title>
<style>body{font:16px system-ui,sans-serif;background:#0d0e10;color:#e6e6e6;margin:0;padding:16px;max-width:720px}
a{color:#8ab4f8}table{border-collapse:collapse;width:100%}td,th{padding:6px 8px;border-bottom:1px solid #2a2c30;text-align:left}
th{color:#9aa0a6;font-weight:600}li{margin:4px 0;color:#c4c7c5}</style>
<h1>Pixel Party leaderboard</h1><p><a href="/">&larr; Play</a></p>
<table><tr><th>#</th><th>Player</th><th>Wins</th><th>Games</th><th>Points</th><th>Last played</th></tr>${rows || '<tr><td colspan="6">No finished games yet.</td></tr>'}</table>
<h2>Recent games</h2><ol>${games || '<li>None yet.</li>'}</ol>`
}

// ---------------------------------------------------------------------------------------------------
// Worker: routing, static client, security headers.

// Same policy as the Bun server's static site (staticSite.ts).
function securityHeaders(host: string): Record<string, string> {
  return {
    'content-security-policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "media-src 'self' blob:",
      `connect-src 'self' wss://${host}`,
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join('; '),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  }
}

// English only: hide the EN|ES toggle and pin pp_lang=en before the app's bundle runs (the CSP allows
// same-origin scripts only, hence a tiny script file rather than an inline one).
const ENGLISH_JS = "try{localStorage.setItem('pp_lang','en')}catch(e){}"
const ENGLISH_TAGS =
  '<style>app-language-toggle{display:none!important}</style><script src="/_pp/english.js"></script>'

const roomStub = (env: Env, code: string) => env.ROOMS.get(env.ROOMS.idFromName(code))

function randomCode(len: number): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('')
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname

    if (path === '/api/health')
      return json({ ok: true, version: APP_VERSION, runtime: 'cloudflare' })

    if (path === '/api/rooms' && req.method === 'POST') {
      for (let i = 0; i < 6; i++) {
        const code = randomCode(config.roomCodeLen)
        const r = await roomStub(env, code).fetch(`https://room/init?code=${code}`, {
          method: 'POST',
        })
        if (r.status === 201) return json({ code }, 201)
      }
      return json({ error: 'too_many_rooms' }, 503)
    }

    if (path.startsWith('/api/rooms/') && req.method === 'GET') {
      const code = path.slice('/api/rooms/'.length).toUpperCase()
      if (!ROOM_CODE.test(code)) return json({ exists: false, phase: null }, 404)
      return roomStub(env, code).fetch(`https://room/info?code=${code}`)
    }

    if (path.startsWith('/api/')) return json({ error: 'not_found' }, 404)

    if (path === '/ws') {
      // Same-origin only: the page this Worker served talks to its own host.
      const origin = req.headers.get('origin')
      let sameOrigin = false
      try {
        sameOrigin = !!origin && new URL(origin).host === url.host
      } catch {}
      if (!sameOrigin) return new Response('Forbidden origin', { status: 403 })
      const code = (url.searchParams.get('room') ?? '').toUpperCase()
      if (!ROOM_CODE.test(code)) return new Response('Room not found', { status: 404 })
      return roomStub(env, code).fetch(req)
    }

    if (path === '/_scores' || path === '/_scores.json') {
      const board = await env.SCORES.get(env.SCORES.idFromName('board')).board()
      if (path === '/_scores.json') return json(board)
      return new Response(scoresPage(board), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      })
    }

    const english = env.ENGLISH_ONLY === 'true'
    if (english && path === '/_pp/english.js') {
      return new Response(ENGLISH_JS, {
        headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' },
      })
    }

    // The client build. Unknown paths (/room/ABCD) get index.html (single-page-application mode).
    const asset = await env.ASSETS.fetch(req)
    const res = new Response(asset.body, asset)
    for (const [k, v] of Object.entries(securityHeaders(url.host))) res.headers.set(k, v)
    if (english && (res.headers.get('content-type') ?? '').includes('text/html')) {
      return new HTMLRewriter()
        .on('head', {
          element(e) {
            e.append(ENGLISH_TAGS, { html: true })
          },
        })
        .transform(res)
    }
    return res
  },
} satisfies ExportedHandler<Env>
