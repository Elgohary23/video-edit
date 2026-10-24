/**
 * Export-only prop asset loader. Images are decoded once, independent of the
 * preview's image cache, and released with the renderer lifecycle.
 */
import type { ExportProp } from '../types'
import { ExportError } from '../utils/errors'

const IMAGE_TIMEOUT_MS = 20_000

/**
 * Decode one image URL (props and image timeline assets share the same path).
 * `label` only affects the actionable error copy.
 */
export function loadImageAsset(
  src: string,
  signal?: AbortSignal,
  label = 'overlay image',
): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    let settled = false
    let timer: number | null = null

    const cleanup = () => {
      image.onload = null
      image.onerror = null
      signal?.removeEventListener('abort', onAbort)
      if (timer !== null) window.clearTimeout(timer)
    }
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }
    const onAbort = () => finish(() => reject(new DOMException('Aborted', 'AbortError')))
    const onError = () =>
      finish(() =>
        reject(
          new ExportError('ASSET_LOAD_FAILED', `Could not load ${label} ${src}`, {
            userMessage: 'Could not load an image for export. Re-import it and try again.',
          }),
        ),
      )

    image.onload = () => {
      // decode() guarantees the bitmap is ready before the first draw.
      if (typeof image.decode === 'function') {
        void image
          .decode()
          .then(() => finish(() => resolve(image)))
          .catch(() => finish(() => resolve(image)))
      } else {
        finish(() => resolve(image))
      }
    }
    image.onerror = onError
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = window.setTimeout(() => {
      finish(() =>
        reject(
          new ExportError('TIMEOUT', `Timed out loading ${label} ${src}`, {
            userMessage: 'Export timed out while loading an image.',
          }),
        ),
      )
    }, IMAGE_TIMEOUT_MS)
    image.src = src
  })
}

export function loadPropImage(src: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return loadImageAsset(src, signal, 'overlay image')
}

export async function loadPropImages(
  props: readonly ExportProp[],
  signal?: AbortSignal,
  onProgress?: (ratio: number) => void,
): Promise<Map<string, HTMLImageElement>> {
  const images = new Map<string, HTMLImageElement>()
  if (props.length === 0) return images
  let loaded = 0
  await Promise.all(
    props.map(async (prop) => {
      const image = await loadPropImage(prop.src, signal)
      images.set(prop.id, image)
      loaded++
      onProgress?.(loaded / props.length)
    }),
  )
  return images
}
