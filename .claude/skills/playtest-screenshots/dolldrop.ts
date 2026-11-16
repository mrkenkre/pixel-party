// dolldrop.ts: Freeze Doll on an Android-sized touch screen. Hold WALK, lose the "stop" message the
// moment the finger lifts (as on a reconnecting socket), then ask the server's own snapshots whether
// your runner is still moving. Must print "RESULT: OK". Guards the 300 ms move re-send (2026-11-16).
// Usage (party-mode server, restarted after each client build): BASE=http://127.0.0.1:3100 bun dolldrop.ts
// biome-ignore-all lint/suspicious/noExplicitAny: browser-side probes over window globals
import puppeteer from 'puppeteer-core'

const BASE = process.env.BASE ?? 'http://127.0.0.1:3100'
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--mute-audio'],
})
const { code } = await (
  await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { origin: BASE } })
).json()
const page = await browser.newPage()
await page.setViewport({
  width: 412,
  height: 915,
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 1,
})
await page.evaluateOnNewDocument(() => {
  const w = window as any
  const W = window.WebSocket
  w.__socks = []
  w.__sent = []
  w.__drop = false
  w.__me = ''
  w.__runner = null
  // biome-ignore lint/complexity/useArrowFunction: the page calls it with `new`
  w.WebSocket = function (...a: any[]) {
    const s = new (W as any)(...a)
    const send = s.send.bind(s)
    s.send = (d: string) => {
      const m = JSON.parse(d)
      if (m.type === 'MINIGAME_INPUT' && m.input?.kind === 'move') {
        if (w.__drop && m.input.mode === 'stop') {
          w.__drop = false
          w.__sent.push('stop(DROPPED)')
          return
        }
        w.__sent.push(m.input.mode)
      }
      send(d)
    }
    s.addEventListener('message', (e: MessageEvent) => {
      const m = JSON.parse(e.data)
      if (m.type === 'WELCOME') w.__me = m.playerId
      if (m.type === 'ROUND_STATE' && m.state?.runners) {
        const r = m.state.runners.find((x: any) => x.id === w.__me)
        if (r) w.__runner = { x: r.x, v: r.v, status: r.status, light: m.state.light }
      }
    })
    w.__socks.push(s)
    return s
  }
  w.WebSocket.prototype = W.prototype
  Object.assign(w.WebSocket, { OPEN: 1, CLOSED: 3, CONNECTING: 0, CLOSING: 2 })
})
await page.goto(`${BASE}/room/${code}?name=Host&color=%23ff3e7f&avatar=cat`, {
  waitUntil: 'networkidle2',
})
await Bun.sleep(1200)
// @ts-expect-error Bun headers
const bot = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?room=${code}`, {
  headers: { Origin: BASE },
})
await new Promise<void>((r) => {
  bot.onopen = () => {
    bot.send(JSON.stringify({ type: 'JOIN', name: 'Bot', color: '#29d3f2', avatar: 'dog' }))
    r()
  }
})
await Bun.sleep(500)
await page.evaluate(() =>
  (window as any).__socks
    .at(-1)
    .send(
      JSON.stringify({ type: 'HOST_CONFIG', minigameIds: ['freeze-doll'], rounds: 1, introSec: 5 }),
    ),
)
await Bun.sleep(600)
await page.evaluate(() =>
  document.querySelector<HTMLButtonElement>('app-lobby button.start')?.click(),
)
for (let i = 0; i < 40 && !(await page.$('canvas')); i++) await Bun.sleep(500)
const geo = await page.evaluate(() => {
  const c = document.querySelector('canvas') as HTMLCanvasElement
  const r = c.getBoundingClientRect()
  return { left: r.left, top: r.top, w: r.width, h: r.height, cw: c.width, ch: c.height }
})
const padW = Math.min(geo.cw - 16, 620),
  btnW = (padW - 10) / 2
const walk = {
  x: geo.left + (geo.cw / 2 - (btnW / 2 + 5)) * (geo.w / geo.cw),
  y: geo.top + (geo.ch - 52) * (geo.h / geo.ch),
}
const cdp = await page.createCDPSession()
const touch = (type: string, pts: { x: number; y: number }[]) =>
  cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: pts.map((p) => ({ ...p, id: 1 })),
  } as any)
const runner = () => page.evaluate(() => (window as any).__runner)

// Wait for green light so the runner is allowed to move.
for (let i = 0; i < 60; i++) {
  const r = await runner()
  if (r?.light === 'green' && r.status === 'racing') break
  await Bun.sleep(250)
}
await touch('touchStart', [walk])
await Bun.sleep(900)
const walking = await runner()
await page.evaluate(() => ((window as any).__drop = true))
await touch('touchEnd', [])
await Bun.sleep(1500)
const a = await runner()
await Bun.sleep(500)
const b = await runner()
const sent = await page.evaluate(() => (window as any).__sent.join(' > '))
console.log('while holding :', JSON.stringify(walking))
console.log('1.5 s after   :', JSON.stringify(a))
console.log('2.0 s after   :', JSON.stringify(b))
console.log('page sent     :', sent.length > 160 ? `${sent.slice(0, 160)}…` : sent)
const still = b && a && (b.x > a.x + 0.001 || b.v > 0.001)
console.log(
  still
    ? 'RESULT: STUCK - runner kept moving after the finger lifted'
    : 'RESULT: OK - runner stopped',
)
bot.close()
await browser.close()
process.exit(0)
