/**
 * Audio analysis domain engine — pure functions over Float32Array, intentionally
 * decoupled from AudioContext so analysis can be unit-tested headlessly.
 *
 * Pipeline (PRD Feature 1–2):
 *   samples → RMS dB envelope (per hop) → raw silence regions → duration filter
 *           → padding shrink → cut regions + keep segments.
 */

export interface SilenceConfig {
  /** Gain threshold in dB; hops at or below count as silent (default -35). */
  thresholdDb: number
  /** Silences shorter than this are not cut (default 300). */
  minSilenceMs: number
  /** Padding left/right around speech so word edges never clip (default 120). */
  paddingMs: number
}

export const DEFAULT_SILENCE_CONFIG: SilenceConfig = {
  thresholdDb: -35,
  minSilenceMs: 300,
  paddingMs: 120,
}

/** A half-open time range in milliseconds: [startMs, endMs). */
export interface Region {
  startMs: number
  endMs: number
}

/** dBFS floor for digital silence (log10(0) would be -Infinity). */
export const SILENCE_DB_FLOOR = -100

/** Convert linear amplitude RMS to dBFS, floored at -100. */
export function rmsToDb(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return SILENCE_DB_FLOOR
  const db = 20 * Math.log10(rms)
  return Math.max(db, SILENCE_DB_FLOOR)
}

export interface Envelope {
  hopMs: number
  /** dBFS per hop; index i covers [i*hopMs, (i+1)*hopMs). */
  db: Float32Array
  /** Max hop index (exclusive) — hops at/after this are muted tail. */
  length: number
}

/**
 * RMS envelope over the mixdown (mixed-to-mono) samples.
 * hopMs defaults to 10ms — coarse enough to be fast, fine enough for cuts.
 */
export function dbEnvelope(mixdown: Float32Array, sampleRate: number, hopMs = 10): Envelope {
  const hopSamples = Math.max(1, Math.round((sampleRate * hopMs) / 1000))
  const hops = Math.max(0, Math.ceil(mixdown.length / hopSamples))
  const db = new Float32Array(hops)

  for (let h = 0; h < hops; h++) {
    let sum = 0
    const start = h * hopSamples
    const end = Math.min(mixdown.length, start + hopSamples)
    for (let i = start; i < end; i++) {
      sum += mixdown[i] * mixdown[i]
    }
    db[h] = rmsToDb(Math.sqrt(sum / Math.max(1, end - start)))
  }

  return { hopMs, db, length: hops }
}

/** Runs of `db <= thresholdDb` lasting at least minSilenceMs, in hop-grid ms. */
export function detectRawSilenceRegions(env: Envelope, config: SilenceConfig): Region[] {
  const { db, hopMs, length } = env
  const minHops = Math.max(1, Math.ceil(config.minSilenceMs / hopMs))
  const regions: Region[] = []

  let runStart = -1
  for (let h = 0; h <= length; h++) {
    const isSilent = h < length && db[h] <= config.thresholdDb
    if (isSilent && runStart < 0) runStart = h
    if (!isSilent && runStart >= 0) {
      if (h - runStart >= minHops) regions.push({ startMs: runStart * hopMs, endMs: h * hopMs })
      runStart = -1
    }
  }
  return regions
}

/**
 * Shrink each region by paddingMs on both sides (padding protects speech edges).
 * Regions that collapse to ≤0 length are dropped. Clamped to [0, totalMs].
 */
export function applyPadding(regions: Region[], config: SilenceConfig, totalMs: number): Region[] {
  return regions
    .map((r) => ({
      startMs: Math.max(0, r.startMs + config.paddingMs),
      endMs: Math.min(totalMs, r.endMs - config.paddingMs),
    }))
    .filter((r) => r.endMs - r.startMs > 0)
}

/**
 * Complement of the cut regions — the vocal segments that remain on the
 * timeline. Returned in order, half-open, never overlapping.
 */
export function keepSegmentsFromRegions(cutRegions: Region[], totalMs: number): Region[] {
  const keep: Region[] = []
  let cursor = 0
  for (const region of cutRegions) {
    if (region.startMs > cursor) keep.push({ startMs: cursor, endMs: Math.min(region.startMs, totalMs) })
    cursor = Math.max(cursor, region.endMs)
  }
  if (cursor < totalMs) keep.push({ startMs: cursor, endMs: totalMs })
  return keep
}

export interface CutPlan {
  /** Actually-cut (padded) regions — render these red on the waveform. */
  cutRegions: Region[]
  /** Remaining vocal segments in source time. */
  keepSegments: Region[]
}

/** Full jump-cut plan for a decoded track. */
export function buildCutPlan(env: Envelope, totalDurationMs: number, config: SilenceConfig): CutPlan {
  const cutRegions = applyPadding(detectRawSilenceRegions(env, config), config, totalDurationMs)
  return { cutRegions, keepSegments: keepSegmentsFromRegions(cutRegions, totalDurationMs) }
}

/** Min/max peaks for waveform rendering, one pair per `buckets` count. */
export function computePeaks(mixdown: Float32Array, buckets: number): Array<{ min: number; max: number }> {
  if (buckets <= 0) return []
  const peaks: Array<{ min: number; max: number }> = []
  const bucketSize = Math.max(1, Math.floor(mixdown.length / buckets))
  for (let b = 0; b < buckets; b++) {
    const start = b * bucketSize
    const end = Math.min(mixdown.length, start + bucketSize)
    let min = 0
    let max = 0
    for (let i = start; i < end; i++) {
      const v = mixdown[i]
      if (v < min) min = v
      if (v > max) max = v
    }
    peaks.push({ min, max })
  }
  return peaks
}
