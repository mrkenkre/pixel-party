// Local change (party-20 branch): 20-player rooms. Rooms of up to 12 must score exactly as upstream.
import { describe, expect, test } from 'bun:test'
import { fitsPlayers, MAX_ROOM_PLAYERS, MINIGAMES, playableGames } from '@pp/shared'
import { Room } from '../entities/Room'
import { awardPoints, awardTableFor, BIG_ROOM_AWARD_TABLE, DEFAULT_AWARD_TABLE } from './scoring'

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`)

describe('20-player rooms', () => {
  test('room ceiling is 20', () => {
    expect(MAX_ROOM_PLAYERS).toBe(20)
    const room = Room.create('ABCD', MAX_ROOM_PLAYERS)
    expect(room.isFull).toBe(false)
  })

  test('rooms up to 12 keep the upstream award table', () => {
    for (let n = 1; n <= 12; n++) expect(awardTableFor(n)).toBe(DEFAULT_AWARD_TABLE)
    const pts = awardPoints({ placements: ids(12) }, awardTableFor(12))
    expect(pts.get('p0')).toBe(10)
    expect(pts.get('p11')).toBe(0)
  })

  test('a 20-player round: places 12-19 still score 1, only last scores 0', () => {
    expect(BIG_ROOM_AWARD_TABLE).toHaveLength(20)
    const pts = awardPoints({ placements: ids(20) }, awardTableFor(20))
    expect(pts.get('p0')).toBe(10)
    for (let i = 11; i <= 18; i++) expect(pts.get(`p${i}`)).toBe(1)
    expect(pts.get('p19')).toBe(0)
  })

  test('there are games to play with 13-20 players', () => {
    for (let n = 13; n <= 20; n++) {
      const all = MINIGAMES.map((g) => g.id)
      expect(playableGames(all, n).length).toBeGreaterThan(0)
    }
    expect(fitsPlayers('button-masher', 20)).toBe(true)
  })

  test('crowded arena and racing games keep the limit of 12; 47 games allow 20', () => {
    const crowded = ['sumo-push', 'sumo-ice', 'micro-race', 'rally-stage', 'speed-circuit'].concat([
      'bomber-express',
      'asteroids',
      'brawl',
    ])
    for (const id of crowded) {
      expect(fitsPlayers(id, 12)).toBe(true)
      expect(fitsPlayers(id, 13)).toBe(false)
    }
    expect(MINIGAMES.filter((g) => g.players.max === 20)).toHaveLength(47)
    expect(MINIGAMES.filter((g) => g.players.max === 12)).toHaveLength(8)
  })
})
