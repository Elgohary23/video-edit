import { describe, expect, it } from 'vitest'
import type { Clip } from '../../timeline/engine'
import type { ExportVideoSource } from '../types'
import {
  chunkFrameCount,
  exportAudioSampleCount,
  frameTimeMs,
  placementAt,
  planAudioPcmChunks,
  planAudioSegments,
  planChunks,
  planClips,
  planPreservesAlpha,
  resolveClipSourceId,
  totalFramesFor,
} from './timelinePlan'
import { sampleAtFrame } from '../audio/pcm'

const clip = (id: string, srcStartMs: number, srcEndMs: number, videoId?: string): Clip => ({
  id,
  srcStartMs,
  srcEndMs,
  zoom: 1,
  ...(videoId !== undefined ? { videoId } : {}),
})

const source = (id: string, mixdown: ExportVideoSource['mixdown'] = null, kind: ExportVideoSource['kind'] = 'video'): ExportVideoSource => ({
  id,
  url: `blob:${id}`,
  kind,
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

  it('never attaches audio to image clips, even if a mixdown is present', () => {
    const mixdown = { samples: new Float32Array([0.5]), sampleRate: 48_000, durationMs: 1 }
    const sources = [source('img', mixdown, 'image'), source('v1', mixdown, 'video')]
    const planned = planClips(
      [clip('still', 0, 3000, 'img'), clip('take', 0, 1000, 'v1')],
      sources,
      'v1',
    )
    const segments = planAudioSegments(planned, sources)
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ timelineStartMs: 3000, timelineEndMs: 4000 })
  })
})

describe('zero-length windows (cut sanitization)', () => {
  it('skips empty clips so they cannot insert a blank timeline instant', () => {
    const planned = planClips(
      [clip('a', 0, 1000), clip('empty', 500, 500), clip('b', 2000, 2500)],
      [source('v1')],
      'v1',
    )
    expect(planned.map((entry) => [entry.startMs, entry.endMs])).toEqual([
      [0, 1000],
      [1000, 1500],
    ])
    expect(placementAt(planned, 500)?.planned.clip.id).toBe('a')
    expect(placementAt(planned, 1000)?.planned.clip.id).toBe('b')
    expect(placementAt(planned, 1500)).toBeNull()
  })
})

describe('placementAt binary search', () => {
  it('matches the linear timeline mapping around every boundary', () => {
    const clips = Array.from({ length: 500 }, (_, index) =>
      clip(`c${index}`, index * 100, index * 100 + 100),
    )
    const planned = planClips(clips, [source('v1')], 'v1')
    for (const index of [0, 1, 137, 498, 499]) {
      const start = index * 100
      expect(placementAt(planned, start)?.planned.clip.id).toBe(`c${index}`)
      expect(placementAt(planned, start + 50)?.srcMs).toBe(index * 100 + 50)
      if (index < 499) {
        expect(placementAt(planned, start + 99.999)?.planned.clip.id).toBe(`c${index}`)
        expect(placementAt(planned, start + 100)?.planned.clip.id).toBe(`c${index + 1}`)
      }
    }
    expect(placementAt(planned, 50_000)).toBeNull()
  })
})

describe('planAudioPcmChunks', () => {
  it('lays every chunk boundary on the absolute frame grid', () => {
    const chunks = planChunks(60, 30, 20)
    const pcm = planAudioPcmChunks(chunks, 30, 48_000)
    expect(pcm.map((chunk) => chunk.startSample)).toEqual([0, 32_000, 64_000])
    expect(pcm.map((chunk) => chunk.sampleCount)).toEqual([32_000, 32_000, 32_000])
    expect(pcm.map((chunk) => chunk.startByte)).toEqual([0, 64_000, 128_000])
  })

  it('does not accumulate rounding drift over a ten-minute export', () => {
    // 23.976 fps is deliberately not sample-aligned at chunk boundaries.
    const fps = 23.976
    const totalFrames = 14_386 // 10 minutes rounded up to a whole frame
    const chunks = planChunks(totalFrames, fps, 7)
    const pcm = planAudioPcmChunks(chunks, fps, 48_000)
    const totalSamples = exportAudioSampleCount(totalFrames, fps, 48_000)

    // Telescoping absolute boundaries must equal the exact output length.
    expect(pcm.reduce((sum, chunk) => sum + chunk.sampleCount, 0)).toBe(totalSamples)
    expect(totalSamples).toBe(28_800_801)
    expect(pcm.at(-1)?.endSample).toBe(totalSamples)
    for (const index of [1, 57, 999, chunks.length - 1]) {
      expect(pcm[index].startSample).toBe(sampleAtFrame(chunks[index].startFrame, fps, 48_000))
    }
  })

  it('uses the frame grid for a partial final frame, not the raw timeline', () => {
    // 1001ms @ 30fps → 31 frames (30.03 frames rounded up) → 1033.33ms.
    const totalFrames = totalFramesFor(1001, 30)
    const chunks = planChunks(totalFrames, 30, 10)
    const pcm = planAudioPcmChunks(chunks, 30, 48_000)
    expect(pcm.at(-1)?.endSample).toBe(sampleAtFrame(31, 30, 48_000))
    expect(exportAudioSampleCount(totalFrames, 30, 48_000)).toBe(49_600)
  })
})

describe('planPreservesAlpha', () => {
  it('is enabled only for VP9 timelines that contain a still image', () => {
    const imageSources = [source('img', null, 'image')]
    const withImage = planClips([clip('still', 0, 3000, 'img')], imageSources, 'img')
    expect(planPreservesAlpha(withImage, imageSources, 'vp9')).toBe(true)
    expect(planPreservesAlpha(withImage, imageSources, 'h264')).toBe(false)
    expect(planPreservesAlpha(withImage, imageSources, 'h265')).toBe(false)

    const videoSources = [source('v1', null, 'video')]
    const videoOnly = planClips([clip('take', 0, 3000, 'v1')], videoSources, 'v1')
    expect(planPreservesAlpha(videoOnly, videoSources, 'vp9')).toBe(false)
  })

  it('ignores image assets that contribute no planned clip', () => {
    const sources = [source('v1', null, 'video'), source('unused', null, 'image')]
    const planned = planClips([clip('take', 0, 1000, 'v1')], sources, 'v1')
    expect(planPreservesAlpha(planned, sources, 'vp9')).toBe(false)
  })
})
