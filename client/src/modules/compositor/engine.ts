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
  fitMode?: 'contain' | 'cover'
  rotation?: 0 | 90 | 180 | 270
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

export interface ContainRect {
  sx: number
  sy: number
  sw: number
  sh: number
  dx: number
  dy: number
  dw: number
  dh: number
}

/**
 * Computes source crop and destination placement that letterboxes or
 * pillarboxes the video within the canvas, preserving 100% of the frame.
 */
export function computeContainRect(
  videoW: number,
  videoH: number,
  canvasW: number,
  canvasH: number,
  zoom = 1,
): ContainRect {
  const safeZoom = Math.max(0.01, zoom)
  const safeVideoH = Math.max(1, videoH)
  const safeCanvasH = Math.max(1, canvasH)
  const aspectVideo = videoW / safeVideoH
  const aspectCanvas = canvasW / safeCanvasH

  let dw: number
  let dh: number
  if (aspectVideo > aspectCanvas) {
    dw = canvasW
    dh = canvasW / aspectVideo
  } else {
    dh = canvasH
    dw = canvasH * aspectVideo
  }

  const dx = (canvasW - dw) / 2
  const dy = (canvasH - dh) / 2

  const sw = Math.min(videoW, videoW / safeZoom)
  const sh = Math.min(videoH, videoH / safeZoom)
  const sx = (videoW - sw) / 2
  const sy = (videoH - sh) / 2

  return { sx, sy, sw, sh, dx, dy, dw, dh }
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

  // Apply rotation if needed
  if (settings.rotation && settings.rotation % 360 !== 0) {
    ctx.save()
    ctx.translate(canvasW / 2, canvasH / 2)
    ctx.rotate((settings.rotation * Math.PI) / 180)
    ctx.translate(-canvasW / 2, -canvasH / 2)
  }

  const videoReady = settings.video?.ready === true
  if (videoReady && settings.clips.length > 0) {
    const placed = timelineToSource(settings.clips, settings.playheadMs)
    if (placed) {
      const wasFiltered = shouldBlur(settings)
      if (wasFiltered) {
        ctx.filter = `blur(${settings.blurPx}px)`
      }

      if (settings.fitMode === 'contain') {
        const c = computeContainRect(settings.video!.width, settings.video!.height, canvasW, canvasH, placed.clip.zoom)
        // If letterboxed or pillarboxed, render a soft blurred backdrop to avoid harsh black borders
        if (c.dx > 0 || c.dy > 0) {
          ctx.filter = 'blur(20px) brightness(0.35)'
          ctx.drawImage(settings.video!.el, 0, 0, canvasW, canvasH)
          ctx.filter = wasFiltered ? `blur(${settings.blurPx}px)` : 'none'
        }
        ctx.drawImage(
          settings.video!.el,
          c.sx,
          c.sy,
          c.sw,
          c.sh,
          c.dx,
          c.dy,
          c.dw,
          c.dh,
        )
      } else {
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
      }

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
