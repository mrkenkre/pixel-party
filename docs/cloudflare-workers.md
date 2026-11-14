# Pixel Party on Cloudflare Workers (`cf-workers` branch)

This fork's `cf-workers` branch can also run Pixel Party on **Cloudflare Workers** (free plan), so a
party has a permanent `https://pixel-party.<your-subdomain>.workers.dev` link that works from anywhere,
without a home server, port forwarding or a tunnel. The Bun server and Docker image are unchanged and
still work exactly as before. Decision: D41 in [`implementation-decisions.md`](implementation-decisions.md).

## How it works

| Piece | Bun server (upstream) | Cloudflare Workers (`apps/worker`) |
|---|---|---|
| Game rules, session engine, 20 Hz loop, idle sweeper | `createGameCore` (`apps/server/.../ws/GameSocket.ts`) | **the same `createGameCore`** |
| WebSockets | `Bun.serve` topic pub/sub | one **Durable Object per room** (`RoomDO`, named by the room code) fans frames out to its sockets |
| Client (Angular + Phaser) | served by the Bun process | Workers **static assets** (single-page-app fallback) |
| `/api/health`, `POST /api/rooms`, `GET /api/rooms/:code` | `httpRoutes.ts` | the Worker (`apps/worker/src/index.ts`) |
| Leaderboard `/_scores`, `/_scores.json` | not part of upstream | `ScoresDO`, one Durable Object with SQLite storage |

- Rooms are still in memory only (D15): a room lives in its Durable Object while people are connected
  and disappears when it empties. A room nobody is connected to is dropped after 60 s.
- A WebSocket must come from the page the Worker served (same origin), like party mode.
- `INTRO_SECONDS` (instructions screen before each round, default 30 here) and `ENGLISH_ONLY` (hides the
  EN|ES toggle) are `[vars]` in `apps/worker/wrangler.toml`.
- The Worker sets the same Content-Security-Policy as the Bun server's static site.
- The server sends a tiny `{"type":"KEEPALIVE"}` frame every 25 s so quiet lobby sockets stay open;
  the client ignores message types it does not know.

## Deploy

One-time: a free Cloudflare account. Then, from the repo root:

```bash
bun install
bun run build:client                      # the client build the Worker serves
cd apps/worker
bunx wrangler login                       # opens the browser once to authorise this machine
bunx wrangler deploy                      # prints https://pixel-party.<subdomain>.workers.dev
```

Run the same two last commands again after pulling changes. To try it locally first:
`bunx wrangler dev` (http://127.0.0.1:8787, Cloudflare's runtime on your machine; phones on the same
Wi-Fi can't reach it, it is for testing).

## Free-plan budget

The Workers Free plan allows (per day) 100,000 Worker requests, 100,000 Durable Object requests and
13,000 GB-s of Durable Object duration ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
Incoming WebSocket messages count 20 to 1; outgoing ones are free.

- A running room keeps its Durable Object active: 2 hours ≈ 900 GB-s (128 MB), so about 28 room-hours
  a day.
- Requests: 20 phones loading the game ≈ 1,000; play ≈ 3–7 requests a second (20 players' taps / 20),
  so a 2-hour, 20-player party uses roughly 20,000–50,000 of the 100,000.
- When a daily limit is reached, Cloudflare answers with errors until the next day; the free plan
  never charges.

## Measured on Cloudflare (2026-11-14, from a home connection near Boston)

- 20 players (19 bots + a real phone-size browser), 7 minutes, 6 rounds: no disconnects, no errors,
  no snapshot gap over 1 s (longest 0.42 s).
- In-game round trip p50 23 ms, p95 44 ms, max 123 ms (the same Pi through a Cloudflare quick tunnel:
  ~33 ms typical, 1.25 s worst). Extra delay against the server's tick clock: p95 15 ms.
- Game loop at 50.0 ms per tick (target 50). Phone-size browser ~190 fps.
- Rejoin after a drop and the page-reload race behave as on the Bun server.

## Measured (local `wrangler dev`, 2026-11-14)

- 20 players (19 bots + a real phone-size browser) for 4 minutes: everyone joined, no disconnects, no
  errors; the client renders and plays as on the Bun server.
- Rejoin after a drop, and the page-reload race (new socket before the old one closes), behave as on
  the Bun server. A finished game lands on `/_scores`. A WebSocket from another origin gets 403.
- The local runtime's timer ran the game loop at ~51.7 ms per tick (target 50; the Pi's Bun server:
  50.2), i.e. rounds ~3% slower than real time. To re-check on Cloudflare itself after the first deploy.
