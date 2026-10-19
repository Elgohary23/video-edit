/**
 * Export settings presets + normalization.
 *
 * All values are sanitized here so downstream engines can trust dimensions
 * (even pixel counts for H.264/HEVC), frame rate, and bitrate bounds.
 */
import type {
  ExportCodec,
  ExportQuality,
  ExportResolution,
  ExportSettings,
} from './types'

export interface QualityProfile {
  /** H.264/H.265 CRF. */
  crf: number
  /** x264/x265 preset. */
  preset: string
  /** VP9 `-cpu-used` value (lower = slower/better). */
  cpuUsed: number
  /** JPEG frame quality used while rasterizing. */
  jpegQuality: number
}

export const QUALITY_PROFILES: Record<ExportQuality, QualityProfile> = {
  draft: { crf: 30, preset: 'ultrafast', cpuUsed: 8, jpegQuality: 0.7 },
  standard: { crf: 24, preset: 'veryfast', cpuUsed: 5, jpegQuality: 0.82 },
  high: { crf: 20, preset: 'medium', cpuUsed: 2, jpegQuality: 0.9 },
  ultra: { crf: 16, preset: 'slow', cpuUsed: 0, jpegQuality: 0.95 },
}

export interface ResolutionPreset {
  width: number
  height: number
  label: string
}

/**
 * The editor composes a fixed 9:16 portrait frame, so resolution presets are
 * expressed in portrait orientation. Custom dimensions remain free-form.
 */
export const RESOLUTION_PRESETS: Record<Exclude<ExportResolution, 'custom'>, ResolutionPreset> = {
  '720p': { width: 720, height: 1280, label: '720p · 720×1280' },
  '1080p': { width: 1080, height: 1920, label: '1080p · 1080×1920' },
  '1440p': { width: 1440, height: 2560, label: '1440p · 1440×2560' },
  '4k': { width: 2160, height: 3840, label: '4K · 2160×3840' },
}

export const FRAME_RATE_PRESETS = [24, 30, 60, 120] as const

export const AUDIO_BITRATE_OPTIONS = [128, 192, 320] as const

export const CODEC_LABELS: Record<ExportCodec, string> = {
  h264: 'H.264 (MP4)',
  h265: 'H.265 / HEVC (MP4)',
  vp9: 'VP9 (WebM)',
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  quality: 'standard',
  resolution: '1080p',
  width: 1080,
  height: 1920,
  fps: 30,
  bitrate: null,
  codec: 'h264',
  audioBitrate: 192,
}

const QUALITIES: ExportQuality[] = ['draft', 'standard', 'high', 'ultra']
const RESOLUTIONS: ExportResolution[] = ['720p', '1080p', '1440p', '4k', 'custom']
const CODECS: ExportCodec[] = ['h264', 'h265', 'vp9']

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}

/** Round to the nearest even integer (H.264/HEVC chroma requirement). */
export function toEvenDimension(value: number, fallback: number): number {
  const safe = Number.isFinite(value) ? Math.round(value) : fallback
  const even = Math.round(safe / 2) * 2
  return Math.max(16, Math.min(7680, even))
}

export function normalizeFps(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_EXPORT_SETTINGS.fps
  return Math.max(1, Math.min(240, Math.round(value * 1000) / 1000))
}

export function normalizeBitrate(value: number | null): number | null {
  if (value === null) return null
  if (!Number.isFinite(value)) return null
  return Math.max(100, Math.min(200_000, Math.round(value)))
}

/**
 * Merge partial settings and resolve resolution presets. When a preset is
 * selected its dimensions always win over stale custom width/height fields.
 */
export function normalizeExportSettings(partial: Partial<ExportSettings> = {}): ExportSettings {
  const quality: ExportQuality = isOneOf(partial.quality, QUALITIES) ? partial.quality : DEFAULT_EXPORT_SETTINGS.quality
  const codec: ExportCodec = isOneOf(partial.codec, CODECS) ? partial.codec : DEFAULT_EXPORT_SETTINGS.codec
  const resolution: ExportResolution = isOneOf(partial.resolution, RESOLUTIONS)
    ? partial.resolution
    : DEFAULT_EXPORT_SETTINGS.resolution

  let width: number
  let height: number
  if (resolution === 'custom') {
    width = toEvenDimension(partial.width ?? DEFAULT_EXPORT_SETTINGS.width, DEFAULT_EXPORT_SETTINGS.width)
    height = toEvenDimension(partial.height ?? DEFAULT_EXPORT_SETTINGS.height, DEFAULT_EXPORT_SETTINGS.height)
  } else {
    const preset = RESOLUTION_PRESETS[resolution]
    width = preset.width
    height = preset.height
  }

  const audioBitrate = Number.isFinite(partial.audioBitrate)
    ? Math.max(64, Math.min(512, Math.round(partial.audioBitrate as number)))
    : DEFAULT_EXPORT_SETTINGS.audioBitrate

  return {
    quality,
    resolution,
    width,
    height,
    fps: normalizeFps(partial.fps ?? DEFAULT_EXPORT_SETTINGS.fps),
    bitrate: normalizeBitrate(partial.bitrate ?? null),
    codec,
    audioBitrate,
  }
}

/** Select a resolution preset while keeping custom dimensions when asked. */
export function applyResolution(settings: ExportSettings, resolution: ExportResolution): ExportSettings {
  return normalizeExportSettings({ ...settings, resolution })
}

export function qualityProfile(quality: ExportQuality): QualityProfile {
  return QUALITY_PROFILES[quality]
}

/** Human-readable frame rate (keeps fractional custom rates tidy). */
export function formatFps(fps: number): string {
  return Number.isInteger(fps) ? String(fps) : fps.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}
