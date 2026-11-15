import { Injectable, inject, NgZone } from '@angular/core'
import type { ClientMsg, ServerMsg } from '@pp/shared'
import { PROTOCOL_VERSION } from '@pp/shared'
import { BehaviorSubject, Subject } from 'rxjs'
import { socketUrl } from './app-url'

// Owns the raw WebSocket. Angular components/feature services consume state$; Phaser reads it through
// GameClient. The socket handlers run OUTSIDE the Angular zone (the round feature boots Phaser +
// connect() inside runOutsideAngular so Phaser's rAF never drives change detection); every emission
// re-enters via zone.run so change detection fires per message, not per frame.
@Injectable({ providedIn: 'root' })
export class GameSocketService {
  private ws?: WebSocket
  private readonly zone = inject(NgZone)

  readonly state$ = new Subject<ServerMsg>()
  readonly connected$ = new Subject<boolean>()
  readonly reconnecting$ = new BehaviorSubject<boolean>(false)

  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private intentionalClose = false
  private protocolMismatch = false
  private lastUrl = ''

  private _playerId?: string
  private _rejoinToken?: string
  get playerId(): string | undefined {
    return this._playerId
  }
  // The seat's secret from WELCOME; REJOIN must carry it.
  get rejoinToken(): string | undefined {
    return this._rejoinToken
  }

  // Seed a known seat (from sessionStorage) so the first frame after connect is a REJOIN, not a JOIN.
  restoreIdentity(playerId: string, rejoinToken: string): void {
    this._playerId = playerId
    this._rejoinToken = rejoinToken
  }

  // Drop the identity so the next connect re-JOINs fresh (used when a REJOIN is refused).
  resetIdentity(): void {
    this._playerId = undefined
    this._rejoinToken = undefined
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  // Connect to a specific room. Identity (playerId/isHost) is resolved server-side after JOIN.
  connect(roomCode: string): void {
    this.lastUrl = `${socketUrl('ws')}?room=${encodeURIComponent(roomCode)}`
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.intentionalClose = false
    this.protocolMismatch = false
    this.open()
  }

  // Fork extra: phones (iOS Safari above all) suspend a backgrounded page, and its socket can come back
  // looking OPEN while the server long since dropped it: taps go nowhere and onclose never fires. So
  // after the page was hidden for a few seconds, or the network comes back, open a fresh socket at once
  // (the room store REJOINs on it; the server closes the old one).
  private hiddenAt = 0
  private watchingLifecycle = false
  private watchLifecycle(): void {
    if (this.watchingLifecycle || typeof document === 'undefined') return
    this.watchingLifecycle = true
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.hiddenAt = Date.now()
      else if (this.hiddenAt && Date.now() - this.hiddenAt > 3000) this.reconnectNow()
    })
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) this.reconnectNow()
    })
    window.addEventListener('online', () => this.reconnectNow())
  }

  private reconnectNow(): void {
    this.hiddenAt = 0
    if (!this.lastUrl || this.intentionalClose || this.protocolMismatch) return
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    const old = this.ws
    if (old) {
      // Detach first, so the old socket's late close doesn't schedule a second reconnect.
      old.onopen = old.onclose = old.onmessage = null
      try {
        old.close()
      } catch {}
    }
    this.reconnectAttempts = 0
    this.zone.run(() => this.reconnecting$.next(true))
    this.open()
  }

  private open(): void {
    this.watchLifecycle()
    this.ws = new WebSocket(this.lastUrl)

    this.ws.onopen = () => {
      this.reconnectAttempts = 0
      this.zone.run(() => {
        this.connected$.next(true)
        this.reconnecting$.next(false)
      })
    }
    this.ws.onclose = () => {
      this.zone.run(() => this.connected$.next(false))
      if (this.intentionalClose || this.protocolMismatch) {
        this.zone.run(() => this.reconnecting$.next(false))
        return
      }
      // Bounded exponential backoff; scheduled OUTSIDE zone.run so the timer never ticks CD.
      // Capped at 5 s (fork): a player mid-round can't sit out half a game waiting for a retry.
      const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 5_000)
      this.reconnectAttempts++
      this.zone.run(() => this.reconnecting$.next(true))
      this.reconnectTimer = setTimeout(() => this.open(), delay)
    }
    this.ws.onmessage = (e) => {
      let msg: ServerMsg
      try {
        msg = JSON.parse(e.data) as ServerMsg
      } catch {
        console.warn('[net] dropped malformed server frame')
        return
      }
      if (msg.type === 'WELCOME') {
        this._playerId = msg.playerId
        this._rejoinToken = msg.rejoinToken
      }
      if (msg.type === 'WELCOME' || msg.type === 'WATCHING') {
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          this.protocolMismatch = true
          console.warn(
            `[net] protocol mismatch (server v${msg.protocolVersion}, client v${PROTOCOL_VERSION}) — please refresh`,
          )
        }
      }
      this.zone.run(() => this.state$.next(msg))
    }
  }

  send(msg: ClientMsg): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(msg))
    return true
  }

  disconnect(): void {
    this.intentionalClose = true
    this.ws?.close()
  }
}
