import { describe, expect, it } from 'vitest'
import {
  appendClip,
  clipsFromKeepSegments,
  makeClipId,
  sourceToTimeline,
  splitClip,
  timelineDurationMs,
  timelineStartOfClip,
  timelineToSource,
  trimClip,
  type Clip,
} from './engine'

const base: Clip[] = [
  { id: 'clip-1', srcStartMs: 0, srcEndMs: 1120, zoom: 1 },
  { id: 'clip-2', srcStartMs: 1380, srcEndMs: 2500, zoom: 1 },
]

describe('clipsFromKeepSegments / timelineDurationMs', () => {
  it('creates base clips from keep segments', () => {
    const clips = clipsFromKeepSegments([
      { startMs: 0, endMs: 1120 },
      { startMs: 1380, endMs: 2500 },
    ])
    expect(clips.map((c) => c.id)).toEqual(['clip-1', 'clip-2'])
    expect(timelineDurationMs(clips)).toBe(2240)
  })
})

describe('timelineToSource', () => {
  it('maps timeline positions across the silence gap', () => {
    expect(timelineToSource(base, 0)).toEqual({ clip: base[0], clipIndex: 0, srcMs: 0 })
    // timeline 1000 → clip-1 (1000ms span) — still inside clip-1
    expect(timelineToSource(base, 1009)).toEqual({ clip: base[0], clipIndex: 0, srcMs: 1009 })
    // timeline 1120 = start of clip-2 → src is 1380 (skips the silence entirely)
    expect(timelineToSource(base, 1120)).toEqual({ clip: base[1], clipIndex: 1, srcMs: 1380 })
    expect(timelineToSource(base, 2239)).toEqual({ clip: base[1], clipIndex: 1, srcMs: 2499 })
  })
  it('past the end → null', () => {
    expect(timelineToSource(base, 2240)).toBeNull()
    expect(timelineToSource([], 0)).toBeNull()
  })
})

describe('sourceToTimeline', () => {
  it('inverts the mapping and rejects cut-out windows', () => {
    expect(sourceToTimeline(base, 960)).toBe(960)
    expect(sourceToTimeline(base, 1380)).toBe(1120)
    expect(sourceToTimeline(base, 1250)).toBeNull() // inside silence
    expect(sourceToTimeline([], 0)).toBeNull()
  })
})

describe('splitClip', () => {
  it('splits non-destructively, preserving window continuity', () => {
    const out = splitClip(base, 'clip-1', 500)!
    expect(out).toHaveLength(3)
    expect(out[0]).toMatchObject({ id: 'clip-1-L', srcStartMs: 0, srcEndMs: 500, zoom: 1 })
    expect(out[1]).toMatchObject({ id: 'clip-1-R', srcStartMs: 500, srcEndMs: 1120, zoom: 1 })
    expect(out[2]).toBe(base[1])
    // unchanged total duration and timeline mapping
    expect(timelineDurationMs(out)).toBe(2240)
    expect(timelineToSource(out, 1009)?.srcMs).toBe(1009)
  })
  it('nested splits keep unique ids', () => {
    const once = splitClip(base, 'clip-1', 400)!
    const twice = splitClip(once, 'clip-1-L', 200)!
    expect(twice.map((c) => c.id)).toEqual(['clip-1-L-L', 'clip-1-L-R', 'clip-1-R', 'clip-2'])
    expect(timelineDurationMs(twice)).toBe(2240)
  })
  it('rejects edge/out-of-range splits', () => {
    expect(splitClip(base, 'clip-1', 0)).toBeNull()
    expect(splitClip(base, 'clip-1', 1120)).toBeNull()
    expect(splitClip(base, 'clip-2', 100)).toBeNull() // timeline 100 lives in clip-1
    expect(splitClip(base, 'nope', 100)).toBeNull()
  })
  it('does not mutate the input array', () => {
    const snapshot = structuredClone(base)
    splitClip(base, 'clip-1', 500)
    expect(base).toEqual(snapshot)
  })
})

describe('trimClip', () => {
  it('trims inward only, immutably', () => {
    const out = trimClip(base, 'clip-2', 100, 80)!
    expect(out[1]).toEqual({ id: 'clip-2', srcStartMs: 1480, srcEndMs: 2420, zoom: 1 })
    expect(out[0]).toBe(base[0])
    expect(timelineDurationMs(out)).toBe(2060)
  })
  it('refuses to consume a clip entirely', () => {
    const out = trimClip(base, 'clip-1', 0, 1120)!
    expect(out).toEqual(base)
  })
})

describe('appendClip', () => {
  it('puts the new clip after every existing clip on the track', () => {
    const out = appendClip(base, { startMs: 0, endMs: 4000 }, 'vid-2', 'clip-x')
    expect(out).toHaveLength(3)
    expect(out[2]).toEqual({ id: 'clip-x', srcStartMs: 0, srcEndMs: 4000, zoom: 1, videoId: 'vid-2' })
    // the appended clip starts where the track previously ended
    expect(timelineStartOfClip(out, 2)).toBe(timelineDurationMs(base))
    expect(timelineDurationMs(out)).toBe(timelineDurationMs(base) + 4000)
  })
  it('different sources keep playing back-to-back via order alone', () => {
    const two = appendClip(appendClip([], { startMs: 50, endMs: 250 }, 'vid-1', 'a'), { startMs: 0, endMs: 900 }, 'vid-2', 'b')
    // first clip ends at timeline 200; clip b's source 0 continues the track
    expect(timelineToSource(two, 200)).toEqual({ clip: two[1], clipIndex: 1, srcMs: 0 })
  })
  it('omits videoId when not given (legacy active-source clip)', () => {
    const out = appendClip([], { startMs: 0, endMs: 100 })
    expect(out[0]).toEqual({ id: out[0].id, srcStartMs: 0, srcEndMs: 100, zoom: 1 })
    expect('videoId' in out[0]).toBe(false)
  })
  it('does not mutate the input array', () => {
    const snapshot = structuredClone(base)
    appendClip(base, { startMs: 0, endMs: 10 })
    expect(base).toEqual(snapshot)
  })
  it('generates unique ids when asked to', () => {
    const seen = new Set(Array.from({ length: 50 }, () => makeClipId()))
    expect(seen.size).toBe(50)
  })
})
