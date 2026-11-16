import type { LiveRoomRegistry } from '../../application/ports/LiveRoomRegistry'
import type { SessionManager } from '../../application/session/SessionManager'

// Reap rooms with no activity for longer than idleMs — abandoned lobbies and rooms created but never
// joined (which otherwise linger forever in the in-memory store). A room running a live session is
// never reaped (it is active by definition; abandoned sessions are torn down on the last disconnect).
// Pure over its inputs (time is passed in) so it is unit-testable; the interval wiring lives in the
// WS server. Returns the codes reaped.
// Default idle window is 15 min, so a room with someone connected lasts 30 min without input.
export const CONNECTED_IDLE_FACTOR = 2

export function reapIdleRooms(params: {
  rooms: LiveRoomRegistry
  manager: SessionManager
  now: number
  idleMs: number
  onReap?: (code: string) => void
}): string[] {
  const { rooms, manager, now, idleMs, onReap } = params
  const reaped: string[] = []
  for (const room of rooms.list()) {
    if (manager.isRunning(room.code)) continue
    // Fork extra: people still connected (chatting on the final screen or in the lobby without
    // tapping anything) keep the room much longer; only a forgotten open tab is reaped after that.
    const limit = room.hasConnectedPlayers ? idleMs * CONNECTED_IDLE_FACTOR : idleMs
    if (now - room.lastActivityAt <= limit) continue
    onReap?.(room.code)
    manager.stop(room.code)
    rooms.remove(room.code)
    reaped.push(room.code)
  }
  return reaped
}
