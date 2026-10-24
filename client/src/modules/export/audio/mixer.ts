/**
 * Deterministic offline audio mixer.
 *
 * The mixer works on sample indices, not wall-clock playback, so exported
 * audio is exactly aligned with the frame grid. It supports overlapping
 * segments (future multi-track), per-segment gain, micro-fades at cuts, and
 * source sample-rate conversion.
 */
import type { ExportAudioMixdown } from '../types'

export interface AudioMixSegment {
  timelineStartMs: number
  timelineEndMs: number
  sourceStartMs: number
  source: ExportAudioMixdown
  gain?: number
  fadeInMs?: number
  fadeOutMs?: number
}

export interface AudioMixOptions {
  targetSampleRate?: number
  channels?: number
  /** Global gain, normally from `normalizationGain`. */
  gain?: number
  fadeMs?: number
  /**
   * Absolute sample index of this chunk's first output sample. Supplying it
   * places every chunk on one global sample grid (instead of restarting at 0),
   * which is what keeps long exports free of cumulative A/V drift.
   */
  startSample?: number
  /** Exact output length in samples; overrides the ms-derived length. */
  lengthSamples?: number
}

export interface AudioMixResult {
  /** One Float32Array per channel, all the same length. */
  channels: Float32Array[]
  peak: number
}

export function mixAudioChunk(
  segments: readonly AudioMixSegment[],
  chunkStartMs: number,
  chunkEndMs: number,
  options: AudioMixOptions = {},
): AudioMixResult {
  const sampleRate = Math.max(1, Math.round(options.targetSampleRate ?? 48_000))
  const channels = Math.max(1, Math.min(8, Math.round(options.channels ?? 2)))
  const globalGain = Number.isFinite(options.gain) ? (options.gain as number) : 1
  const defaultFadeMs = Math.max(0, options.fadeMs ?? 5)
  const length = Math.max(
    0,
    Math.round(options.lengthSamples ?? ((chunkEndMs - chunkStartMs) * sampleRate) / 1000),
  )
  const startSample = Math.round(options.startSample ?? (chunkStartMs * sampleRate) / 1000)
  const output = Array.from({ length: channels }, () => new Float32Array(length))
  if (length === 0) return { channels: output, peak: 0 }

  let peak = 0
  for (const segment of segments) {
    const timelineStart = Math.max(chunkStartMs, segment.timelineStartMs)
    const timelineEnd = Math.min(chunkEndMs, segment.timelineEndMs)
    if (timelineEnd <= timelineStart) continue

    const source = segment.source
    if (source.samples.length === 0 || source.sampleRate <= 0) continue
    const sourceSpanMs = Math.max(0, source.durationMs)
    const segmentGain = (segment.gain ?? 1) * globalGain
    const fadeIn = Math.max(0, segment.fadeInMs ?? defaultFadeMs)
    const fadeOut = Math.max(0, segment.fadeOutMs ?? defaultFadeMs)
    const startOffsetSamples = Math.round(((timelineStart - chunkStartMs) * sampleRate) / 1000)
    const spanSamples = Math.max(0, Math.round(((timelineEnd - timelineStart) * sampleRate) / 1000))

    for (let i = 0; i < spanSamples; i++) {
      const outIndex = startOffsetSamples + i
      if (outIndex < 0 || outIndex >= length) continue
      // Derive time from the absolute output sample so chunk boundaries and
      // long exports never accumulate rounding drift.
      const timelineMs = ((startSample + outIndex) * 1000) / sampleRate
      const sourceMs = segment.sourceStartMs + (timelineMs - segment.timelineStartMs)
      if (sourceMs < 0 || sourceMs > sourceSpanMs) continue

      const position = (sourceMs * source.sampleRate) / 1000
      const base = Math.floor(position)
      if (base < 0 || base >= source.samples.length) continue
      const next = Math.min(source.samples.length - 1, base + 1)
      const fraction = position - base
      // Linear interpolation gives deterministic resampling for any
      // source/target rate ratio (44.1 kHz sources into a 48 kHz mix).
      const sample = source.samples[base] + (source.samples[next] - source.samples[base]) * fraction
      if (!Number.isFinite(sample)) continue

      const sinceStart = timelineMs - segment.timelineStartMs
      const untilEnd = segment.timelineEndMs - timelineMs
      const fade = Math.min(1, fadeIn > 0 ? sinceStart / fadeIn : 1, fadeOut > 0 ? untilEnd / fadeOut : 1)
      const value = sample * segmentGain * Math.max(0, fade)
      for (let channel = 0; channel < channels; channel++) {
        output[channel][outIndex] += value
      }
      const magnitude = Math.abs(value)
      if (magnitude > peak) peak = magnitude
    }
  }

  return { channels: output, peak }
}

/**
 * Peak normalization that only attenuates. Per-chunk normalization would
 * pump the gain at chunk boundaries, so the gain is computed once over every
 * source and applied globally.
 */
export function normalizationGain(mixdowns: readonly ExportAudioMixdown[], targetPeak = 0.95): number {
  let peak = 0
  for (const mixdown of mixdowns) {
    const samples = mixdown.samples
    for (let i = 0; i < samples.length; i++) {
      const magnitude = Math.abs(samples[i])
      if (magnitude > peak) peak = magnitude
      if (peak >= 1) break
    }
  }
  if (peak <= targetPeak || peak <= 0) return 1
  return targetPeak / peak
}
