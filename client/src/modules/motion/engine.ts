/**
 * Motion engine (PRD Feature 4) — ordered keyframe-style presets computed as
 * pure functions of `timelineMs`, so preview and export share one code path.
 *
 * Coordinate conventions:
 *   scale    — absolute framing multiplier of the prop's base size (1 = natural)
 *   offsetX/offsetY — offsets in fractions of *prop width/height* (normalized)
 *   all transforms are relative to the user's placed base rect/anchor
 */

export type MotionPresetName = 'pop-bounce' | 'slide-snap' | 'none'

export const MOTION_PRESET_NAMES: MotionPresetName[] = ['none', 'pop-bounce', 'slide-snap']

export interface MotionTransform {
  scale: number
  offsetX: number
  offsetY: number
  opacity: number
}

export const IDENTITY_TRANSFORM: MotionTransform = { scale: 1, offsetX: 0, offsetY: 0, opacity: 1 }
export const HIDDEN_TRANSFORM: MotionTransform = { scale: 1, offsetX: 0, offsetY: 0, opacity: 0 }

/* ── Easing curves ──────────────────────────────────────────────────────── */

export type EasingFn = (t: number) => number

export const clamp01 = (t: number) => Math.min(1, Math.max(0, t))

/** Overshooting "pop" — used by Pop & Bounce entry. */
export const easeOutBack: EasingFn = (t) => {
  const c1 = 1.70158
  const c3 = c1 + 1
  const x = clamp01(t)
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2)
}

/** Anticipation "wind-up" — used by Pop & Bounce exit. */
export const easeInBack: EasingFn = (t) => {
  const c1 = 1.70158
  const c3 = c1 + 1
  const x = clamp01(t)
  return c3 * x * x * x - c1 * x * x
}

export const easeOutCubic: EasingFn = (t) => {
  const x = clamp01(t)
  return 1 - Math.pow(1 - x, 3)
}

export const easeInCubic: EasingFn = (t) => {
  const x = clamp01(t)
  return x * x * x
}

/* ── Preset resolution ──────────────────────────────────────────────────── */

/** Entry/exit animation length: at most 600ms, at most 30% of the prop's span. */
export function transitionMs(spanMs: number): number {
  return Math.min(600, Math.max(0, spanMs * 0.3))
}

function interp(from: number, to: number, t: number): number {
  return from + (to - from) * t
}

/**
 * Motion transform for a prop with range [startMs, endMs] observed at `timelineMs`.
 * Times outside the range (or zero/negative span) resolve to hidden, though
 * callers normally skip drawing props entirely outside their range.
 */
export function resolveMotion(preset: MotionPresetName, timelineMs: number, startMs: number, endMs: number): MotionTransform {
  const span = endMs - startMs
  if (span <= 0 || timelineMs < startMs || timelineMs >= endMs) return HIDDEN_TRANSFORM
  if (preset === 'none') return IDENTITY_TRANSFORM

  const transition = transitionMs(span)
  const entryEnd = startMs + transition
  const exitStart = endMs - transition

  if (timelineMs < entryEnd && transition > 0) {
    const p = (timelineMs - startMs) / transition
    if (preset === 'pop-bounce') {
      const scale = interp(0, 1, easeOutBack(p))
      return { scale, offsetX: 0, offsetY: 0, opacity: Math.min(1, p * 2.5) }
    }
    // slide-snap slides in from the left, 40% of prop width
    const pEased = easeOutCubic(p)
    return { scale: 1, offsetX: interp(-0.4, 0, pEased), offsetY: 0, opacity: pEased }
  }

  if (timelineMs >= exitStart && transition > 0) {
    const p = (timelineMs - exitStart) / transition
    if (preset === 'pop-bounce') {
      const scale = interp(1, 0, easeInBack(p))
      return { scale, offsetX: 0, offsetY: 0, opacity: Math.min(1, (1 - p) * 2.5) }
    }
    const pEased = easeInCubic(p)
    return { scale: 1, offsetX: interp(0, 0.4, pEased), offsetY: 0, opacity: interp(1, 0, pEased) }
  }

  return IDENTITY_TRANSFORM
}
