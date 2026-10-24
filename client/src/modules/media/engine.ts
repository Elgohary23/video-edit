/**
 * Media engine (PRD Feature 1) — pure helpers around decoded audio.
 * Decoding itself needs a live AudioContext, so it stays at the UI boundary;
 * everything here works on plain data and is unit-testable.
 */

export interface AudioBufferLike {
  numberOfChannels: number
  sampleRate: number
  length: number
  /** DOM API signature. */
  getChannelData(channel: number): Float32Array
}

export interface Mixdown {
  samples: Float32Array
  sampleRate: number
  durationMs: number
}

/** Average all channels into one mono track. */
export function mixdownToMono(buffer: AudioBufferLike): Mixdown {
  const { numberOfChannels, sampleRate, length } = buffer
  if (numberOfChannels <= 0 || length === 0) {
    return { samples: new Float32Array(0), sampleRate, durationMs: 0 }
  }
  if (numberOfChannels === 1) {
    const samples = new Float32Array(buffer.getChannelData(0))
    return { samples, sampleRate, durationMs: (length / sampleRate) * 1000 }
  }
  const samples = new Float32Array(length)
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < length; i++) {
      samples[i] += data[i] / numberOfChannels
    }
  }
  return { samples, sampleRate, durationMs: (length / sampleRate) * 1000 }
}

/** Media kinds the editor can place on the timeline. */
export type MediaKind = 'video' | 'image'

/** Accept only video types the preview/export pipeline handles. */
export function isSupportedVideoType(type: string): boolean {
  return /^(video\/|application\/octet-stream$)/.test(type) && type !== 'video/x-msvideo'
}

/**
 * Browsers report PNG as `image/png`; some OS drag sources omit the MIME type
 * entirely, so the filename extension is the fallback. Only raster formats
 * the canvas can decode are accepted (no SVG: it taints the export canvas).
 */
export function isSupportedImageType(type: string, name = ''): boolean {
  if (/^image\/(png|jpe?g|webp|gif|avif|bmp)$/i.test(type)) return true
  if (type !== '') return false
  return /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(name)
}

const VIDEO_EXTENSION = /\.(mp4|m4v|mov|webm|ogv|mkv|avi)$/i

/**
 * Classify an imported file as timeline media. Extension fallback only runs
 * when the OS drag source omitted the MIME type (common on Windows), and
 * images win because they are also valid `image/*` files.
 */
export function mediaKindOf(type: string, name = ''): MediaKind | null {
  if (isSupportedImageType(type, name)) return 'image'
  if (isSupportedVideoType(type)) return 'video'
  if (type === '' && VIDEO_EXTENSION.test(name)) return 'video'
  return null
}

export function describeVideo(name: string, durationMs: number): string {
  const seconds = Math.round(durationMs / 1000)
  return `${name} · ${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
