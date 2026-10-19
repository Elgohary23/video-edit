/**
 * FFmpeg argument builders and export file naming.
 *
 * Pure functions only: unit tests assert the exact argument vectors without
 * constructing FFmpeg or touching a browser.
 */
import type { ExportCodec, ExportSettings } from '../types'
import { qualityProfile } from '../settings'

export type ExportContainer = 'mp4' | 'webm'

export function codecContainer(codec: ExportCodec): ExportContainer {
  return codec === 'vp9' ? 'webm' : 'mp4'
}

export function outputExtension(codec: ExportCodec): string {
  return codecContainer(codec) === 'webm' ? 'webm' : 'mp4'
}

export function outputMimeType(codec: ExportCodec): string {
  return codec === 'vp9' ? 'video/webm' : 'video/mp4'
}

/** Suggested on-disk filename for a saved edit. */
export function exportFileName(projectName: string, codec: ExportCodec = 'h264'): string {
  const cleaned = projectName
    .trim()
    .replace(/\.[^.]+$/, '')
    .replace(/[^\w-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${cleaned.length > 0 ? cleaned : 'cut'}-export.${outputExtension(codec)}`
}

/** Unique per-chunk frame file (root of FFmpeg's MEMFS). */
export function frameFileName(chunkIndex: number, localFrameIndex: number): string {
  const chunk = String(chunkIndex).padStart(4, '0')
  const frame = String(localFrameIndex + 1).padStart(6, '0')
  return `frame-${chunk}-${frame}.jpg`
}

/** image2 sequence pattern matching `frameFileName`. */
export function framePattern(chunkIndex: number): string {
  return `frame-${String(chunkIndex).padStart(4, '0')}-%06d.jpg`
}

export function audioFileName(chunkIndex: number): string {
  return `audio-${String(chunkIndex).padStart(4, '0')}.wav`
}

export function segmentFileName(chunkIndex: number, settings: ExportSettings): string {
  return `segment-${String(chunkIndex).padStart(4, '0')}.${outputExtension(settings.codec)}`
}

export function concatListName(): string {
  return 'concat-list.txt'
}

export function finalFileName(settings: ExportSettings): string {
  return `final-output.${outputExtension(settings.codec)}`
}

function videoCodecArgs(settings: ExportSettings): string[] {
  const profile = qualityProfile(settings.quality)
  if (settings.codec === 'vp9') {
    return [
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'good',
      '-cpu-used',
      String(profile.cpuUsed),
      '-row-mt',
      '1',
      ...(settings.bitrate === null
        ? ['-crf', String(profile.crf), '-b:v', '0']
        : ['-b:v', `${settings.bitrate}k`]),
    ]
  }

  const isHevc = settings.codec === 'h265'
  return [
    '-c:v',
    isHevc ? 'libx265' : 'libx264',
    '-preset',
    profile.preset,
    ...(isHevc
      ? settings.bitrate === null
        ? ['-crf', String(profile.crf + 2)]
        : ['-b:v', `${settings.bitrate}k`]
      : settings.bitrate === null
        ? ['-crf', String(profile.crf)]
        : ['-b:v', `${settings.bitrate}k`]),
    ...(isHevc ? ['-tag:v', 'hvc1', '-x265-params', 'log-level=error'] : []),
  ]
}

function audioCodecArgs(settings: ExportSettings): string[] {
  return settings.codec === 'vp9'
    ? ['-c:a', 'libopus', '-b:a', `${settings.audioBitrate}k`, '-ar', '48000', '-ac', '2']
    : ['-c:a', 'aac', '-b:a', `${settings.audioBitrate}k`, '-ar', '48000', '-ac', '2']
}

/** Output-side encoding options shared by segments and callers/tests. */
export function segmentEncodingOptions(
  settings: ExportSettings,
  frameCount: number,
  hasAudio: boolean,
): string[] {
  return [
    ...videoCodecArgs(settings),
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(settings.fps),
    '-g',
    String(Math.max(1, Math.round(settings.fps * 2))),
    '-frames:v',
    String(frameCount),
    ...(hasAudio ? [...audioCodecArgs(settings), '-shortest'] : ['-an']),
  ]
}

/**
 * Encode one frame-sequence chunk. Segments are encoded with identical
 * parameters so the final pass can concatenate them with `-c copy`.
 */
export function segmentEncodeArgs(
  settings: ExportSettings,
  chunkIndex: number,
  frameCount: number,
  hasAudio: boolean,
): string[] {
  return [
    '-framerate',
    String(settings.fps),
    '-i',
    framePattern(chunkIndex),
    ...(hasAudio ? ['-i', audioFileName(chunkIndex)] : []),
    ...segmentEncodingOptions(settings, frameCount, hasAudio),
    segmentFileName(chunkIndex, settings),
  ]
}

/** Losslessly join the encoded chunks into the deliverable. */
export function concatArgs(settings: ExportSettings): string[] {
  return [
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatListName(),
    '-c',
    'copy',
    ...(codecContainer(settings.codec) === 'mp4' ? ['-movflags', '+faststart'] : []),
    finalFileName(settings),
  ]
}

/**
 * Guard rail: a chunk must never sit in the encoder forever. Slower presets
 * get a proportionally larger budget, with a generous floor for wasm startup.
 */
export function chunkEncodeTimeoutMs(settings: ExportSettings, frameCount: number): number {
  const outputSeconds = frameCount / Math.max(1, settings.fps)
  const perSecondBudget = settings.quality === 'ultra' ? 120_000 : settings.quality === 'high' ? 60_000 : 30_000
  return Math.max(180_000, Math.ceil(outputSeconds * perSecondBudget))
}

export function concatTimeoutMs(): number {
  return 300_000
}
