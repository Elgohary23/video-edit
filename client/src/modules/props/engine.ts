/**
 * Props domain engine (PRD Feature 4) — normalized placement math for PNG
 * overlays. All rects are fractions of the preview canvas in [0,1], so the
 * same math works at any preview size (responsive by construction).
 */

import { clamp } from '../shared/utils'

export interface NormalizedRect {
  x: number
  y: number
  w: number
  h: number
}

/** Corner resize handles (visual grab dots). */
export type Handle = 'nw' | 'ne' | 'sw' | 'se'

export const MIN_PROP_SIZE = 0.02

/** Clamp a rect inside the unit square, keeping it at least MIN_PROP_SIZE. */
export function clampRect(rect: NormalizedRect): NormalizedRect {
  const w = Math.min(Math.max(rect.w, MIN_PROP_SIZE), 1)
  const h = Math.min(Math.max(rect.h, MIN_PROP_SIZE), 1)
  return {
    w,
    h,
    x: Math.min(Math.max(rect.x, 0), 1 - w),
    y: Math.min(Math.max(rect.y, 0), 1 - h),
  }
}

/** Translate by normalized deltas, staying inside bounds. */
export function moveRect(rect: NormalizedRect, dx: number, dy: number): NormalizedRect {
  return clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy })
}

/**
 * Drag a corner handle by normalized deltas, keeping the diagonally opposite
 * corner anchored. When `aspect` (w/h) is provided the prop keeps its shape
 * while the dragged corner follows the dominant axis.
 */
export function resizeRect(rect: NormalizedRect, handle: Handle, dx: number, dy: number, aspect?: number): NormalizedRect {
  // Growth limits that keep the anchored corner inside the canvas
  const maxW = handle === 'se' || handle === 'ne' ? 1 - rect.x : rect.x + rect.w
  const maxH = handle === 'se' || handle === 'sw' ? 1 - rect.y : rect.y + rect.h

  // For nw/sw drags the width moves opposite the pointer; for ne/nw the height does
  const signX = handle === 'sw' || handle === 'nw' ? -1 : 1
  const signY = handle === 'ne' || handle === 'nw' ? -1 : 1

  let w = clamp(rect.w + signX * dx, MIN_PROP_SIZE, maxW)
  let h: number
  if (aspect === undefined) {
    h = clamp(rect.h + signY * dy, MIN_PROP_SIZE, maxH)
  } else {
    // keep shape; if height would exceed its limit, cap width accordingly
    w = Math.min(w, maxH * aspect)
    h = w / aspect
  }

  const x = handle === 'sw' || handle === 'nw' ? rect.x + rect.w - w : rect.x
  const y = handle === 'ne' || handle === 'nw' ? rect.y + rect.h - h : rect.y

  return { x: Math.min(Math.max(x, 0), 1 - w), y: Math.min(Math.max(y, 0), 1 - h), w, h }
}

export type HitTestResult = { kind: 'handle'; handle: Handle } | { kind: 'body' } | null

/** Which drag source the pointer is over: a corner handle (within radius), the body, or nothing. */
export function hitTest(rect: NormalizedRect, nx: number, ny: number, handleRadius = 0.03): HitTestResult {
  const corners: Array<{ handle: Handle; cx: number; cy: number }> = [
    { handle: 'nw', cx: rect.x, cy: rect.y },
    { handle: 'ne', cx: rect.x + rect.w, cy: rect.y },
    { handle: 'sw', cx: rect.x, cy: rect.y + rect.h },
    { handle: 'se', cx: rect.x + rect.w, cy: rect.y + rect.h },
  ]
  for (const corner of corners) {
    if (Math.abs(nx - corner.cx) <= handleRadius && Math.abs(ny - corner.cy) <= handleRadius) {
      return { kind: 'handle', handle: corner.handle }
    }
  }
  if (nx >= rect.x && nx <= rect.x + rect.w && ny >= rect.y && ny <= rect.y + rect.h) {
    return { kind: 'body' }
  }
  return null
}

/** Default placement for a new prop with native aspect w/h: 30% width, centered. */
export function defaultRect(aspect: number): NormalizedRect {
  const w = 0.3
  const h = Math.min(1, w / aspect)
  return clampRect({ x: 0.5 - w / 2, y: 0.5 - h / 2, w, h })
}
