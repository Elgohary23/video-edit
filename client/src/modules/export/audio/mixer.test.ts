import { describe, expect, it } from 'vitest'
import type { ExportAudioMixdown } from '../types'
import { mixAudioChunk, normalizationGain, type AudioMixSegment } from './mixer'

function constantSource(value: number, durationMs: number, sampleRate = 1000): ExportAudioMixdown {
  const samples = new Float32Array(Math.round((durationMs * sampleRate) / 1000)).fill(value)
  return { samples, sampleRate, durationMs }
}

function segment(source: ExportAudioMixdown, timelineStartMs = 0, sourceStartMs = 0, timelineEndMs = 1000): AudioMixSegment {
  return { timelineStartMs, timelineEndMs, sourceStartMs, source }
}

describe('mixAudioChunk', () => {
  it('returns the requested chunk length of silence with no segments', () => {
    const mixed = mixAudioChunk([], 0, 250, { targetSampleRate: 1000, channels: 2, fadeMs: 0 })
    expect(mixed.channels).toHaveLength(2)
    expect(mixed.channels[0]).toHaveLength(250)
    expect(mixed.channels[0].every((sample) => sample === 0)).toBe(true)
    expect(mixed.peak).toBe(0)
  })

  it('places a clip sample-accurately inside the chunk', () => {
    const mixed = mixAudioChunk([segment(constantSource(0.5, 1000))], 0, 200, {
      targetSampleRate: 1000,
      channels: 1,
      fadeMs: 0,
    })
    expect(mixed.channels[0][0]).toBeCloseTo(0.5, 6)
    expect(mixed.channels[0][199]).toBeCloseTo(0.5, 6)
  })

  it('offsets a clip that starts mid-chunk and leaves leading silence', () => {
    const mixed = mixAudioChunk([segment(constantSource(1, 1000), 100, 0, 1100)], 0, 300, {
      targetSampleRate: 1000,
      channels: 1,
      fadeMs: 0,
    })
    expect(mixed.channels[0][99]).toBe(0)
    expect(mixed.channels[0][100]).toBeCloseTo(1, 6)
  })

  it('applies a global gain (peak normalization)', () => {
    const mixed = mixAudioChunk([segment(constantSource(1, 1000))], 0, 100, {
      targetSampleRate: 1000,
      channels: 1,
      fadeMs: 0,
      gain: 0.5,
    })
    expect(mixed.channels[0][10]).toBeCloseTo(0.5, 6)
    expect(mixed.peak).toBeCloseTo(0.5, 6)
  })

  it('fades in and out so cuts do not click', () => {
    const mixed = mixAudioChunk([segment(constantSource(1, 1000), 0, 0, 100)], 0, 100, {
      targetSampleRate: 1000,
      channels: 1,
      fadeMs: 10,
    })
    expect(mixed.channels[0][0]).toBe(0)
    expect(mixed.channels[0][5]).toBeCloseTo(0.5, 6)
    expect(mixed.channels[0][95]).toBeCloseTo(0.5, 6)
    expect(mixed.channels[0][99]).toBeLessThan(0.2)
  })

  it('resamples linearly when source and target rates differ', () => {
    const source: ExportAudioMixdown = {
      samples: new Float32Array([0, 1, 0, -1, 0]),
      sampleRate: 1000,
      durationMs: 5,
    }
    const mixed = mixAudioChunk([segment(source, 0, 0, 5)], 0, 5, {
      targetSampleRate: 2000,
      channels: 1,
      fadeMs: 0,
    })
    // 2 kHz output samples every 0.5 ms; past the last source sample the
    // interpolator clamps to it: 0, 0.5, 1, 0.5, 0, -0.5, -1, -0.5, 0, 0
    expect(Array.from(mixed.channels[0]).map((value) => Math.round(value * 10) / 10)).toEqual([
      0, 0.5, 1, 0.5, 0, -0.5, -1, -0.5, 0, 0,
    ])
  })

  it('sums overlapping segments (future multi-track support)', () => {
    const mixed = mixAudioChunk(
      [segment(constantSource(0.3, 1000)), segment(constantSource(0.2, 1000))],
      0,
      100,
      { targetSampleRate: 1000, channels: 1, fadeMs: 0 },
    )
    expect(mixed.channels[0][50]).toBeCloseTo(0.5, 6)
  })
})

describe('normalizationGain', () => {
  it('returns 1 when the material already fits', () => {
    expect(normalizationGain([constantSource(0.5, 10)])).toBe(1)
  })
  it('attenuates material that would clip', () => {
    expect(normalizationGain([constantSource(2, 10)])).toBeCloseTo(0.475, 6)
  })
})

describe('mixAudioChunk absolute sample grid', () => {
  /** Ramp source so we can see exactly which source instant a chunk sampled. */
  function rampSource(durationMs: number, sampleRate = 1000): ExportAudioMixdown {
    const samples = new Float32Array(Math.round((durationMs * sampleRate) / 1000))
    for (let i = 0; i < samples.length; i++) samples[i] = i / samples.length
    return { samples, sampleRate, durationMs }
  }

  const baseSource = rampSource(2000)
  const baseSegment: AudioMixSegment = {
    timelineStartMs: 0,
    timelineEndMs: 2000,
    sourceStartMs: 0,
    source: baseSource,
  }

  it('continues a source exactly where the previous chunk stopped', () => {
    const full = mixAudioChunk([baseSegment], 0, 2000, {
      targetSampleRate: 1000,
      channels: 1,
      fadeMs: 0,
    })
    const second = mixAudioChunk([baseSegment], 1000, 2000, {
      targetSampleRate: 1000,
      channels: 1,
      fadeMs: 0,
      startSample: 1000,
      lengthSamples: 1000,
    })
    expect(second.channels[0][0]).toBeCloseTo(full.channels[0][1000], 9)
    expect(second.channels[0][999]).toBeCloseTo(full.channels[0][1999], 9)
  })

  it('derives timeline time from the absolute output sample, not the local index', () => {
    const source = rampSource(2000)
    const segment: AudioMixSegment = {
      timelineStartMs: 0,
      timelineEndMs: 2000,
      sourceStartMs: 0,
      source,
    }
    const second = mixAudioChunk([segment], 1000, 2000, {
      targetSampleRate: 1000,
      channels: 1,
      fadeMs: 0,
      startSample: 1000,
      lengthSamples: 1000,
    })
    // A local-index bug would restart at source sample 0 (value 0).
    expect(second.channels[0][0]).toBeCloseTo(1000 / source.samples.length, 9)
    expect(second.channels[0][0]).toBeGreaterThan(0)
  })

  it('respects a source offset when the clip starts mid-chunk', () => {
    const source = rampSource(2000)
    const mixed = mixAudioChunk(
      [{ timelineStartMs: 500, timelineEndMs: 1500, sourceStartMs: 1200, source }],
      500,
      1500,
      { targetSampleRate: 1000, channels: 1, fadeMs: 0, startSample: 500, lengthSamples: 1000 },
    )
    // At timeline 500 → source 1200ms → ramp value 1200/2000.
    expect(mixed.channels[0][0]).toBeCloseTo(1200 / source.samples.length, 6)
    expect(mixed.channels[0][1]).toBeCloseTo(1201 / source.samples.length, 6)
  })

  it('uses lengthSamples instead of the chunk duration when they disagree', () => {
    const mixed = mixAudioChunk([baseSegment], 0, 1000, {
      targetSampleRate: 1000,
      channels: 2,
      fadeMs: 0,
      startSample: 0,
      lengthSamples: 500,
    })
    expect(mixed.channels[0]).toHaveLength(500)
    expect(mixed.channels[1]).toHaveLength(500)
  })

  it('keeps chunk boundaries gapless across a long run', () => {
    const chunks: Float32Array[] = []
    const chunkSamples = 333 // deliberately not a divisor of the timeline
    for (let start = 0; start < 2000; start += chunkSamples) {
      const length = Math.min(chunkSamples, 2000 - start)
      const mixed = mixAudioChunk([baseSegment], start, start + length, {
        targetSampleRate: 1000,
        channels: 1,
        fadeMs: 0,
        startSample: start,
        lengthSamples: length,
      })
      chunks.push(mixed.channels[0])
    }
    const joined = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
    let offset = 0
    for (const chunk of chunks) {
      joined.set(chunk, offset)
      offset += chunk.length
    }
    const full = mixAudioChunk([baseSegment], 0, 2000, {
      targetSampleRate: 1000,
      channels: 1,
      fadeMs: 0,
    })
    expect(joined).toEqual(full.channels[0])
  })
})
