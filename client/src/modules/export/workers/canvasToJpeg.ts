/** Canvas/OffscreenCanvas → JPEG bytes (main-thread fallback path). */
export type CanvasSource = OffscreenCanvas | HTMLCanvasElement

export async function encodeCanvasToJpeg(source: CanvasSource, quality: number): Promise<Uint8Array> {
  const safeQuality = Math.max(0.1, Math.min(1, quality))
  if (typeof OffscreenCanvas !== 'undefined' && source instanceof OffscreenCanvas) {
    const blob = await source.convertToBlob({ type: 'image/jpeg', quality: safeQuality })
    return new Uint8Array(await blob.arrayBuffer())
  }
  if (typeof HTMLCanvasElement === 'undefined' || !(source instanceof HTMLCanvasElement)) {
    throw new Error('Unsupported export canvas implementation')
  }
  const blob = await new Promise<Blob | null>((resolve) => source.toBlob(resolve, 'image/jpeg', safeQuality))
  if (!blob) throw new Error('Canvas JPEG encoding returned no data')
  return new Uint8Array(await blob.arrayBuffer())
}
