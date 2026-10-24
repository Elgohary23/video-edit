/**
 * Low-resolution blurred backdrop used behind letterboxed video.
 *
 * Drawing the full frame with `ctx.filter = 'blur(20px)'` every frame is one
 * of the most expensive Canvas2D operations (especially in software-rendered
 * browsers). Rendering the source into a 1/8-size scratch canvas and letting
 * the GPU/compositor upscale it produces the same soft-bars look for a
 * fraction of the fill-rate cost.
 */
export type BackdropCanvas = OffscreenCanvas | HTMLCanvasElement
export type BackdropContext = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

export interface BackdropRenderer {
  readonly canvas: BackdropCanvas
  draw(source: CanvasImageSource): void
  dispose(): void
}

const DOWNSCALE = 8

export function createBackdropRenderer(width: number, height: number): BackdropRenderer | null {
  const w = Math.max(16, Math.round(width / DOWNSCALE))
  const h = Math.max(16, Math.round(height / DOWNSCALE))

  let canvas: BackdropCanvas | null = null
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(w, h)
  } else if (typeof document !== 'undefined') {
    const element = document.createElement('canvas')
    element.width = w
    element.height = h
    canvas = element
  }
  if (!canvas) return null

  let ctx: BackdropContext | null = null
  try {
    ctx = canvas.getContext('2d') as BackdropContext | null
  } catch {
    // Some embedding/test environments expose a canvas without 2D support;
    // callers fall back to the compositor's non-backdrop path.
    return null
  }
  if (!ctx) return null

  return {
    canvas,
    draw(source: CanvasImageSource) {
      // `filter` is cheap at this size; it is the full-size blur that hurts.
      ctx.filter = 'blur(1.5px)'
      ctx.drawImage(source, 0, 0, w, h)
      ctx.filter = 'none'
    },
    dispose() {
      canvas.width = 1
      canvas.height = 1
    },
  }
}
