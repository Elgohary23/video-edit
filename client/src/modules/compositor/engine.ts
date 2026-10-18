/**
 * 2D canvas compositor — the PRD's "Light 2D Canvas Render Pipeline (CPU)".
 * Pure draw math (`computeCropRect`, `computePropRect`) is unit-tested with
 * plain numbers; `drawFrame` only orchestrates calls on a Canvas2D context.
 */

import { timelineToSource, type Clip } from '../timeline/engine'
import type { MotionTransform } from '../motion/engine'
import type { NormalizedRect } from '../props/engine'

/** The video element (or test double) we sample for the current frame. */
export interface VideoSource {
  el: CanvasImageSource
  width: number
  height: number
  ready: boolean
}

export interface PropFrame {
  image: CanvasImageSource
  rect: NormalizedRect
  transform: MotionTransform
}

export interface CompositorSettings {
  clips: Clip[]
  playheadMs: number
  blurEnabled: boolean
  blurPx: number
  /** null → render empty black frame */
  video: VideoSource | null
  /** props visible at `playheadMs`, transforms pre-resolved */
  activeProps: PropFrame[]
}

export interface CropRect {
  sx: number
  sy: number
  sw: number
  sh: number
}

/**
 * Source-space crop that cover-fits the video into the canvas, then punches
 * in by `zoom` (centered). Fractional offsets keep zoom mathematically exact.
 */
export function computeCropRect(videoW: number, videoH: number, canvasW: number, canvasH: number, zoom: number): CropRect {
  const safeZoom = Math.max(0.01, zoom)
  const aspectVideo = videoW / videoH
  const aspectCanvas = canvasW / canvasH

  // cover: fill canvas, cropping the overflowing axis
  let cropW: number
  let cropH: number
  if (aspectVideo > aspectCanvas) {
    cropH = videoH
    cropW = videoH * aspectCanvas
  } else {
    cropW = videoW
    cropH = videoW / aspectCanvas
  }

  cropW = Math.min(videoW, cropW / safeZoom)
  cropH = Math.min(videoH, cropH / safeZoom)

  const sxOffset = (videoW - cropW) / 2
  const syOffset = (videoH - cropH) / 2
  return { sx: sxOffset, sy: syOffset, sw: cropW, sh: cropH }
}

export interface PropDestRect {
  x: number
  y: number
  w: number
  h: number
  alpha: number
}

/**
 * Where to draw a prop on the canvas this frame.
 * `offsetX/offsetY` in the motion transform are fractions of the transformed
 * prop's own (zoomed) size; rect coords are normalized canvas fractions.
 */
export function computePropRect(rect: NormalizedRect, canvasW: number, canvasH: number, transform: MotionTransform): PropDestRect {
  const w = rect.w * canvasW * transform.scale
  const h = rect.h * canvasH * transform.scale
  const centerX = (rect.x + rect.w / 2 + transform.offsetX * rect.w * transform.scale) * canvasW
  const centerY = (rect.y + rect.h / 2 + transform.offsetY * rect.h * transform.scale) * canvasH
  return { x: centerX - w / 2, y: centerY - h / 2, w, h, alpha: transform.opacity }
}

function shouldBlur(settings: CompositorSettings): boolean {
  return settings.blurEnabled && settings.activeProps.length > 0
}

/** Render one composited frame. Mutates only the passed context. */
export function drawFrame(ctx: CanvasRenderingContext2D, canvasW: number, canvasH: number, settings: CompositorSettings): void {
  ctx.clearRect(0, 0, canvasW, canvasH)

  const videoReady = settings.video?.ready === true
  if (videoReady && settings.clips.length > 0) {
    const placed = timelineToSource(settings.clips, settings.playheadMs)
    if (placed) {
      const wasFiltered = shouldBlur(settings)
      if (wasFiltered) {
        ctx.filter = `blur(${settings.blurPx}px)`
      }
      const crop = computeCropRect(settings.video!.width, settings.video!.height, canvasW, canvasH, placed.clip.zoom)
      ctx.drawImage(
        settings.video!.el,
        crop.sx,
        crop.sy,
        crop.sw,
        crop.sh,
        0,
        0,
        canvasW,
        canvasH,
      )
      if (wasFiltered) {
        ctx.filter = 'none'
      }
    }
  }

  for (const prop of settings.activeProps) {
    const dest = computePropRect(prop.rect, canvasW, canvasH, prop.transform)
    if (dest.w <= 0 || dest.h <= 0 || dest.alpha <= 0) continue
    ctx.globalAlpha = dest.alpha
    ctx.drawImage(prop.image, dest.x, dest.y, dest.w, dest.h)
    ctx.globalAlpha = 1
  }
}
