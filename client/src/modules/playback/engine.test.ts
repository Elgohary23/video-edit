import { describe, expect, it } from 'vitest'
import {
  PAUSED_SEEK_TOLERANCE_MS,
  SCRUB_STEP_MS,
  VIDEO_SYNC_TOLERANCE_MS,
  planTransport,
  previewPlayheadMs,
  scrubBounds,
  scrubValueToMs,
  type TransportInput,
} from './engine'
import type { Clip } from '../timeline/engine'

const clip = (id: string, srcStartMs: number, srcEndMs: number, videoId?: string): Clip => ({
  id,
  srcStartMs,
  srcEndMs,
  zoom: 1,
  ...(videoId !== undefined ? { videoId } : {}),
})

function transport(overrides: Partial<TransportInput> = {}): TransportInput {
  return {
    clips: [clip('c1', 0, 10_000, 'v1')],
    playheadMs: 0,
    playing: false,
    kind: 'video',
    sourceUrl: 'blob:v1',
    videoUrl: 'blob:v1',
    videoTimeMs: 0,
    videoReady: true,
    videoSeeking: false,
    deltaMs: 16,
    ...overrides,
  }
}

describe('scrubBounds', () => {
  it('spans zero to the full timeline width', () => {
    expect(scrubBounds(48_000)).toEqual({ min: 0, max: 48_000 })
    expect(scrubBounds(48_023)).toEqual({ min: 0, max: 48_023 })
  })

  it('keeps a non-degenerate range when the timeline is empty', () => {
    expect(scrubBounds(0)).toEqual({ min: 0, max: 1 })
    expect(scrubBounds(-5)).toEqual({ min: 0, max: 1 })
  })
})

describe('scrubValueToMs', () => {
  it('rounds raw slider emits to whole milliseconds', () => {
    expect(scrubValueToMs(1234.6, 5000)).toBe(1235)
  })

  it('clamps above the end when bounds shrink (task: delete trailing clip)', () => {
    expect(scrubValueToMs(2800, 1000)).toBe(1000)
  })

  it('clamps negative drift to the start', () => {
    expect(scrubValueToMs(-40, 5000)).toBe(0)
  })

  it('maps non-finite noise to the start', () => {
    expect(scrubValueToMs(Number.NaN, 5000)).toBe(0)
  })

  it('keeps the advertised step constant in lockstep with bounds', () => {
    expect(SCRUB_STEP_MS).toBeGreaterThan(0)
  })
})

describe('previewPlayheadMs', () => {
  it('keeps the sampled instant inside the exclusive timeline end', () => {
    expect(previewPlayheadMs(0, 5000)).toBe(0)
    expect(previewPlayheadMs(2500, 5000)).toBe(2500)
    expect(previewPlayheadMs(5000, 5000)).toBeLessThan(5000)
    expect(previewPlayheadMs(5000, 5000)).toBeCloseTo(4999.999, 3)
  })

  it('clamps negative values and an empty timeline to zero', () => {
    expect(previewPlayheadMs(-20, 5000)).toBe(0)
    expect(previewPlayheadMs(100, 0)).toBe(0)
    expect(previewPlayheadMs(Number.NaN, 5000)).toBe(0)
  })
})

describe('planTransport — the playhead is the single source of truth', () => {
  it('pauses when there is nothing to play', () => {
    expect(planTransport(transport({ clips: [] }))).toEqual({ action: 'pause-video' })
  })

  it('seeks a stale element to the playhead before it is allowed to play', () => {
    const plan = planTransport(
      transport({
        playheadMs: 3500,
        playing: true,
        // the element is still parked at the beginning after a scrub
        videoTimeMs: 0,
      }),
    )
    expect(plan).toEqual({ action: 'seek-video', url: 'blob:v1', srcMs: 3500 })
  })

  it('seeks when the playhead moved and the element follows another source', () => {
    const plan = planTransport(
      transport({ playheadMs: 120, videoUrl: 'blob:other', videoTimeMs: 120 }),
    )
    expect(plan).toEqual({ action: 'seek-video', url: 'blob:v1', srcMs: 120 })
  })

  it('starts exactly at a paused playhead once the element is in place', () => {
    expect(planTransport(transport({ playheadMs: 4200, videoTimeMs: 4200 }))).toEqual({
      action: 'pause-video',
    })
  })

  it('corrects a paused element that sits on the wrong frame', () => {
    const plan = planTransport(
      transport({
        playheadMs: 4200,
        videoTimeMs: 4200 + PAUSED_SEEK_TOLERANCE_MS + 1,
      }),
    )
    expect(plan).toEqual({ action: 'seek-video', url: 'blob:v1', srcMs: 4200 })
  })

  it('resumes from the paused location without jumping back to zero', () => {
    const paused = transport({ playheadMs: 4200, playing: false, videoTimeMs: 4200 })
    expect(planTransport(paused).action).toBe('pause-video')
    const resumed = planTransport({ ...paused, playing: true })
    expect(resumed).toEqual({ action: 'play-video', playheadMs: 4200 })
  })

  it('lets the media clock drive the playhead only while both are in sync', () => {
    const inSync = planTransport(
      transport({
        playheadMs: 5200,
        playing: true,
        videoTimeMs: 5200 + VIDEO_SYNC_TOLERANCE_MS - 1,
      }),
    )
    expect(inSync).toEqual({ action: 'play-video', playheadMs: 5200 + VIDEO_SYNC_TOLERANCE_MS - 1 })

    const drifted = planTransport(
      transport({ playheadMs: 5200, playing: true, videoTimeMs: 5000 }),
    )
    expect(drifted).toEqual({ action: 'seek-video', url: 'blob:v1', srcMs: 5200 })
  })

  it('maps a cut boundary into the following clip (no gap frame)', () => {
    const clips = [clip('a', 0, 1000, 'v1'), clip('b', 1000, 2000, 'v1')]
    expect(
      planTransport(transport({ clips, playheadMs: 1000, playing: true, videoTimeMs: 1000 })),
    ).toEqual({ action: 'play-video', playheadMs: 1000 })
    expect(
      planTransport(transport({ clips, playheadMs: 1500, playing: true, videoTimeMs: 1500 })),
    ).toEqual({ action: 'play-video', playheadMs: 1500 })
    // 999.9 is still the first clip (half-open windows); 1000 is the second.
    expect(
      planTransport(transport({ clips, playheadMs: 999.9, playing: true, videoTimeMs: 999.9 })),
    ).toEqual({ action: 'play-video', playheadMs: 999.9 })
  })

  it('advances to the next clip when the element reaches the out point', () => {
    const clips = [clip('a', 0, 1000, 'v1'), clip('b', 1000, 2000, 'v1')]
    const plan = planTransport(
      transport({ clips, playheadMs: 950, playing: true, videoTimeMs: 1000 }),
    )
    expect(plan).toEqual({ action: 'advance', playheadMs: 1000 })
  })

  it('finishes at the timeline end when the last clip reaches its out point', () => {
    const plan = planTransport(
      transport({ clips: [clip('a', 0, 1000, 'v1')], playheadMs: 950, playing: true, videoTimeMs: 1000 }),
    )
    expect(plan).toEqual({ action: 'finish', playheadMs: 1000 })
  })

  it('holds the last good frame while the element is seeking', () => {
    expect(
      planTransport(transport({ playheadMs: 2000, playing: true, videoTimeMs: 1990, videoSeeking: true })),
    ).toEqual({ action: 'hold' })
    expect(
      planTransport(transport({ playheadMs: 2000, playing: false, videoTimeMs: 1000, videoSeeking: true })),
    ).toEqual({ action: 'hold' })
  })

  it('waits for a not-yet-ready element instead of drawing it', () => {
    expect(
      planTransport(transport({ playheadMs: 500, videoReady: false, videoTimeMs: 500 })),
    ).toEqual({ action: 'seek-video', url: 'blob:v1', srcMs: 500 })
  })

  it('advances image clips on wall time', () => {
    const clips = [clip('img', 0, 3000, 'png')]
    expect(
      planTransport(
        transport({
          clips,
          playheadMs: 500,
          playing: true,
          kind: 'image',
          sourceUrl: null,
          videoUrl: null,
          videoTimeMs: 0,
          videoReady: false,
          deltaMs: 16,
        }),
      ),
    ).toEqual({ action: 'advance', playheadMs: 516 })
  })

  it('stops an image at its out point and rolls into the next clip', () => {
    const clips = [clip('img', 0, 1000, 'png'), clip('b', 1000, 2000, 'v1')]
    expect(
      planTransport(
        transport({
          clips,
          playheadMs: 995,
          playing: true,
          kind: 'image',
          sourceUrl: null,
          videoUrl: null,
          videoTimeMs: 0,
          videoReady: false,
          deltaMs: 16,
        }),
      ),
    ).toEqual({ action: 'advance', playheadMs: 1000 })
  })

  it('finishes image playback at the timeline end', () => {
    const plan = planTransport(
      transport({
        clips: [clip('img', 0, 1000, 'png')],
        playheadMs: 995,
        playing: true,
        kind: 'image',
        sourceUrl: null,
        videoUrl: null,
        videoTimeMs: 0,
        videoReady: false,
        deltaMs: 16,
      }),
    )
    expect(plan).toEqual({ action: 'finish', playheadMs: 1000 })
  })

  it('pauses an image preview when transport is not playing', () => {
    expect(
      planTransport(
        transport({
          clips: [clip('img', 0, 1000, 'png')],
          playheadMs: 500,
          playing: false,
          kind: 'image',
          sourceUrl: null,
          videoUrl: null,
          videoReady: false,
        }),
      ),
    ).toEqual({ action: 'pause-video' })
  })
})
