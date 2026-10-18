import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SILENCE_CONFIG,
  applyPadding,
  buildCutPlan,
  computePeaks,
  dbEnvelope,
  detectRawSilenceRegions,
  keepSegmentsFromRegions,
  rmsToDb,
} from './engine'

/** Sinusoid block, amplitude a. */
function tone(ms: number, amplitude: number, sampleRate = 1000, hz = 5): Float32Array {
  const n = Math.round((sampleRate * ms) / 1000)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRate)
  return out
}

function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((acc, p) => acc + p.length, 0)
  const out = new Float32Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

describe('rmsToDb', () => {
  it('full scale is 0 dB, silence is the -100 floor', () => {
    expect(rmsToDb(1)).toBeCloseTo(0, 5)
    expect(rmsToDb(0)).toBe(-100)
    expect(rmsToDb(0.5)).toBeGreaterThan(-100)
    // RMS inputs are magnitudes; a negative is misuse → treated as silence
    expect(rmsToDb(-0.5)).toBe(-100)
  })
})

describe('dbEnvelope', () => {
  it('one dB value per 10ms hop at 1kHz sample rate', () => {
    const env = dbEnvelope(tone(100, 1), 1000)
    expect(env.hopMs).toBe(10)
    expect(env.db).toHaveLength(10)
    expect(env.length).toBe(10)
    for (const db of env.db) expect(db).toBeGreaterThan(-20)
  })
})

describe('detectRawSilenceRegions', () => {
  it('finds a 500ms silent gap between speech', () => {
    // 1s speech (-10 dB RMS of tone @0.31), 0.5s near-silence, 1s speech
    const track = concat(tone(1000, 0.31), tone(500, 0.001), tone(1000, 0.31))
    const env = dbEnvelope(track, 1000)
    const regions = detectRawSilenceRegions(env, DEFAULT_SILENCE_CONFIG)
    expect(regions).toEqual([{ startMs: 1000, endMs: 1500 }])
  })

  it('ignores gaps shorter than minSilenceMs', () => {
    const track = concat(tone(1000, 0.31), tone(150, 0.001), tone(1000, 0.31))
    const env = dbEnvelope(track, 1000)
    expect(detectRawSilenceRegions(env, DEFAULT_SILENCE_CONFIG)).toEqual([])
  })

  it('matches regions at exact threshold level', () => {
    const track = concat(tone(1000, 0.31), tone(500, 0.018), tone(1000, 0.31))
    const env = dbEnvelope(track, 1000)
    // tone at 0.018 RMS ≈ -35dB → boundary is silent (<=)
    expect(detectRawSilenceRegions(env, DEFAULT_SILENCE_CONFIG)).toEqual([{ startMs: 1000, endMs: 1500 }])
  })

  it('detects silence at the start and end of the track', () => {
    const track = concat(tone(400, 0.001), tone(800, 0.31), tone(400, 0.001))
    const env = dbEnvelope(track, 1000)
    expect(detectRawSilenceRegions(env, DEFAULT_SILENCE_CONFIG)).toEqual([
      { startMs: 0, endMs: 400 },
      { startMs: 1200, endMs: 1600 },
    ])
  })
})

describe('applyPadding', () => {
  it('shrinks regions by padding on both sides', () => {
    const cfg = { ...DEFAULT_SILENCE_CONFIG, paddingMs: 120 }
    expect(applyPadding([{ startMs: 300, endMs: 800 }], cfg, 1500)).toEqual([{ startMs: 420, endMs: 680 }])
  })

  it('clamps to track bounds and drops vanishing regions', () => {
    const cfg = { ...DEFAULT_SILENCE_CONFIG, paddingMs: 250 }
    // 400ms silence minus 2×250ms padding leaves ≤0ms — nothing is cut
    expect(applyPadding([{ startMs: 0, endMs: 400 }], cfg, 1600)).toEqual([])
  })

  it('keeps regions that still have span after padding', () => {
    const cfg = { ...DEFAULT_SILENCE_CONFIG, paddingMs: 260 }
    expect(applyPadding([{ startMs: 100, endMs: 700 }], cfg, 1600)).toEqual([{ startMs: 360, endMs: 440 }])
  })
})

describe('keepSegmentsFromRegions', () => {
  it('returns the complement, head/tail/holes included', () => {
    const keep = keepSegmentsFromRegions(
      [
        { startMs: 0, endMs: 400 },
        { startMs: 1000, endMs: 1400 },
      ],
      2000,
    )
    expect(keep).toEqual([
      { startMs: 400, endMs: 1000 },
      { startMs: 1400, endMs: 2000 },
    ])
  })
  it('empty cuts keep everything', () => {
    expect(keepSegmentsFromRegions([], 2000)).toEqual([{ startMs: 0, endMs: 2000 }])
  })
})

describe('buildCutPlan', () => {
  const cfg: typeof DEFAULT_SILENCE_CONFIG = { thresholdDb: -35, minSilenceMs: 300, paddingMs: 120 }

  it('produces padded cut regions and matching keep segments', () => {
    const track = concat(tone(1000, 0.31), tone(500, 0.001), tone(1000, 0.31))
    const env = dbEnvelope(track, 1000)
    const plan = buildCutPlan(env, 2500, cfg)

    expect(plan.cutRegions).toEqual([{ startMs: 1120, endMs: 1380 }])
    expect(plan.keepSegments).toEqual([
      { startMs: 0, endMs: 1120 },
      { startMs: 1380, endMs: 2500 },
    ])
  })

  it('a silent track cuts everything below padding', () => {
    const env = dbEnvelope(tone(1000, 0.001), 1000)
    const plan = buildCutPlan(env, 1000, cfg)
    expect(plan.cutRegions).toEqual([{ startMs: 120, endMs: 880 }])
  })
})

describe('computePeaks', () => {
  it('min/max per bucket and zero-amp track yields silence', () => {
    // hz=50 → each bucket spans one full period, so min<0 and max>0 everywhere
    const track = tone(200, 1, 1000, 50)
    const peaks = computePeaks(track, 10)
    expect(peaks).toHaveLength(10)
    for (const p of peaks) {
      expect(p.max).toBeGreaterThan(0)
      expect(p.min).toBeLessThan(0)
    }

    const muted = computePeaks(new Float32Array(1000), 4)
    for (const p of muted) {
      expect(p.min).toBe(0)
      expect(p.max).toBe(0)
    }
  })
})
