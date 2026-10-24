/**
 * Rasterizes an ImageBitmap to JPEG/PNG bytes. Runs inside the frame-encoder
 * worker; keeping it separate makes the compression work measurable/testable.
 */
import type { FrameImageFormat } from './frameEncoderProtocol'

export async function encodeBitmapToImage(
  bitmap: ImageBitmap,
  quality: number,
  format: FrameImageFormat = 'jpeg',
): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('OffscreenCanvas 2D context is unavailable')
  ctx.drawImage(bitmap, 0, 0)
  const blob = await canvas.convertToBlob({
    type: format === 'png' ? 'image/png' : 'image/jpeg',
    quality: Math.max(0.1, Math.min(1, quality)),
  })
  return new Uint8Array(await blob.arrayBuffer())
}

/** Backwards-compatible JPEG helper. */
export function encodeBitmapToJpeg(bitmap: ImageBitmap, quality: number): Promise<Uint8Array> {
  return encodeBitmapToImage(bitmap, quality, 'jpeg')
}
