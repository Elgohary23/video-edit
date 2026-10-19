/**
 * Dedicated export drawing surface. It is never the preview canvas, so
 * window resizing, UI lag, and preview throttling cannot affect output.
 */
import { encodeCanvasToJpeg, type CanvasSource } from '../workers/canvasToJpeg'

export type Export2DContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export interface ExportSurface {
  readonly width: number
  readonly height: number
  readonly source: CanvasSource
  readonly ctx: Export2DContext
  encodeJpeg(quality: number): Promise<Uint8Array>
  dispose(): void
}

export function createExportSurface(width: number, height: number): ExportSurface {
  const w = Math.max(16, Math.round(width))
  const h = Math.max(16, Math.round(height))

  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('Could not acquire an OffscreenCanvas 2D context')
    return {
      width: w,
      height: h,
      source: canvas,
      ctx,
      encodeJpeg: (quality) => encodeCanvasToJpeg(canvas, quality),
      dispose: () => {
        canvas.width = 1
        canvas.height = 1
      },
    }
  }

  if (typeof document === 'undefined') {
    throw new Error('No canvas implementation is available for export')
  }
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('Could not acquire a 2D canvas context')
  return {
    width: w,
    height: h,
    source: canvas,
    ctx,
    encodeJpeg: (quality) => encodeCanvasToJpeg(canvas, quality),
    dispose: () => {
      // Release the backing bitmap eagerly; the element was never mounted.
      canvas.width = 1
      canvas.height = 1
    },
  }
}
