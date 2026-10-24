/** Canvas/OffscreenCanvas → encoded image bytes (main-thread fallback path). */
import type { FrameImageFormat } from './frameEncoderProtocol'

export type CanvasSource = OffscreenCanvas | HTMLCanvasElement

const MIME: Record<FrameImageFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
}

export async function encodeCanvasToImage(
  source: CanvasSource,
  quality: number,
  format: FrameImageFormat = 'jpeg',
): Promise<Uint8Array> {
  const safeQuality = Math.max(0.1, Math.min(1, quality))
  const type = MIME[format]
  if (typeof OffscreenCanvas !== 'undefined' && source instanceof OffscreenCanvas) {
    const blob = await source.convertToBlob({ type, quality: safeQuality })
    return new Uint8Array(await blob.arrayBuffer())
  }
  if (typeof HTMLCanvasElement === 'undefined' || !(source instanceof HTMLCanvasElement)) {
    throw new Error('Unsupported export canvas implementation')
  }
  const blob = await new Promise<Blob | null>((resolve) => source.toBlob(resolve, type, safeQuality))
  if (!blob) throw new Error(`Canvas ${format.toUpperCase()} encoding returned no data`)
  return new Uint8Array(await blob.arrayBuffer())
}

/** Backwards-compatible JPEG helper. */
export function encodeCanvasToJpeg(source: CanvasSource, quality: number): Promise<Uint8Array> {
  return encodeCanvasToImage(source, quality, 'jpeg')
}
