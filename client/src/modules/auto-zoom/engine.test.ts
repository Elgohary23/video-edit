import { describe, expect, it } from 'vitest'
import { BASE_SCALE, PUNCH_SCALE, alternatingZoom, applyAutoZoom } from './engine'

describe('alternatingZoom', () => {
  it('alternates base and punch-in per PRD (100% / 115%)', () => {
    expect([0, 1, 2, 3].map(alternatingZoom)).toEqual([BASE_SCALE, PUNCH_SCALE, BASE_SCALE, PUNCH_SCALE])
    expect(BASE_SCALE).toBe(1)
    expect(PUNCH_SCALE).toBe(1.15)
  })
})

describe('applyAutoZoom', () => {
  it('assigns zoom by position, immutably', () => {
    const clips = [
      { id: 'a', zoom: 1 },
      { id: 'b', zoom: 1 },
      { id: 'c', zoom: 1 },
    ]
    const out = applyAutoZoom(clips)
    expect(out.map((c) => c.zoom)).toEqual([1, 1.15, 1])
    expect(clips.every((c) => c.zoom === 1)).toBe(true)
  })
  it('re-running after a split re-frames the new ordering', () => {
    const split = [
      { id: 'a-L', zoom: 1 },
      { id: 'a-R', zoom: 1 },
      { id: 'b', zoom: 1 },
    ]
    expect(applyAutoZoom(split).map((c) => c.zoom)).toEqual([1, 1.15, 1])
  })
})
