import { describe, expect, it } from 'vitest'
import type { Clip } from '../../timeline/engine'
import type { ExportVideoSource } from '../types'
import {
  chunkFrameCount,
  frameTimeMs,
  placementAt,
  planAudioSegments,
  planChunks,
  planClips,
  resolveClipSourceId,
  totalFramesFor,
} from './timelinePlan'

const clip = (id: string, srcStartMs: number, srcEndMs: number, videoId?: string): Clip => ({
  id,
  srcStartMs,
  srcEndMs,
  zoom: 1,
  ...(videoId !== undefined ? { videoId } : {}),
})

const source = (id: string, mixdown: ExportVideoSource['mixdown'] = null): ExportVideoSource => ({
  id,
  url: `blob:${id}`,
  mixdown,
})

describe('resolveClipSourceId', () => {
  it('uses the clip video id when it still exists', () => {
    expect(resolveClipSourceId(clip('c', 0, 100, 'v2'), [source('v1'), source('v2')], 'v1')).toBe('v2')
  })
  it('falls back to the active source for legacy/dangling clips', () => {
    expect(resolveClipSourceId(clip('c', 0, 100), [source('v1')], 'v1')).toBe('v1')
    expect(resolveClipSourceId(clip('c', 0, 100, 'gone'), [source('v1')], 'v1')).toBe('v1')
  })
})

describe('planClips', () => {
  it('lays clips end to end on the timeline', () => {
    const planned = planClips([clip('a', 0, 1000), clip('b', 2000, 2500)], [source('v1')], 'v1')
    expect(planned.map((entry) => [entry.startMs, entry.endMs])).toEqual([
      [0, 1000],
      [1000, 1500],
    ])
    expect(planned[1].sourceId).toBe('v1')
  })
})

describe('totalFramesFor / frameTimeMs', () => {
  it('rounds up so the final partial frame is included', () => {
    expect(totalFramesFor(1000, 30)).toBe(30)
    expect(totalFramesFor(1001, 30)).toBe(31)
    expect(totalFramesFor(0, 30)).toBe(0)
  })
  it('maps frame indices onto the frame grid', () => {
    expect(frameTimeMs(0, 25)).toBe(0)
    expect(frameTimeMs(25, 25)).toBe(1000)
  })
})

describe('placementAt', () => {
  const planned = planClips([clip('a', 500, 1500), clip('b', 0, 500)], [source('v1')], 'v1')
  it('maps timeline time into source time for the active clip', () => {
    expect(placementAt(planned, 0)).toMatchObject({ srcMs: 500 })
    expect(placementAt(planned, 999)).toMatchObject({ srcMs: 1499 })
  })
  it('switches to the next clip at the boundary and misses after the end', () => {
    const next = placementAt(planned, 1000)
    expect(next?.planned.clip.id).toBe('b')
    expect(next?.srcMs).toBe(0)
    expect(placementAt(planned, 1500)).toBeNull()
  })
})

describe('chunkFrameCount', () => {
  it('bounds 4K frame chunks well below a full timeline', () => {
    expect(chunkFrameCount(2160, 3840, 30)).toBeLessThanOrEqual(50)
    expect(chunkFrameCount(720, 1280, 30)).toBeLessThanOrEqual(180)
  })
  it('never returns less than one frame', () => {
    expect(chunkFrameCount(7680, 7680, 120)).toBeGreaterThanOrEqual(1)
  })
})

describe('planChunks', () => {
  it('splits frames into contiguous, half-open chunks', () => {
    const chunks = planChunks(120, 30, 50)
    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toMatchObject({ startFrame: 0, endFrame: 50, startMs: 0 })
    expect(chunks[1]).toMatchObject({ startFrame: 50, endFrame: 100 })
    expect(chunks[2]).toMatchObject({ startFrame: 100, endFrame: 120 })
    expect(chunks[2].endMs).toBeCloseTo((120 / 30) * 1000, 6)
  })
})

describe('planAudioSegments', () => {
  it('keeps only clips whose source has decoded audio', () => {
    const mixdown = { samples: new Float32Array([0.1, 0.2]), sampleRate: 48_000, durationMs: 1 }
    const planned = planClips([clip('a', 0, 1000, 'v1'), clip('b', 0, 1000, 'v2')], [source('v1', mixdown), source('v2')], 'v1')
    const segments = planAudioSegments(planned, [source('v1', mixdown), source('v2')])
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ timelineStartMs: 0, timelineEndMs: 1000, sourceStartMs: 0 })
  })
})
