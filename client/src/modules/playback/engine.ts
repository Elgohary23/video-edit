/**
 * Scrub-bar math shared between the floating ScrubberBar and any future
 * scan slider. Pure numbers only — no DOM — so vitest can run it anywhere.
 */

/** Slider granularity in ms; smooth enough to scrub phase-accurate previews. */
export const SCRUB_STEP_MS = 10

/** Native range-input bounds for scanning across a timeline of `totalMs`. */
export function scrubBounds(totalMs: number): { min: number; max: number } {
  return { min: 0, max: Math.max(1, Math.round(totalMs)) }
}

/** Clamp a raw slider emit to a valid timeline position (bounds shift when clips are deleted). */
export function scrubValueToMs(raw: number, totalMs: number): number {
  if (!Number.isFinite(raw)) return 0
  const safe = Math.round(raw)
  return Math.max(0, Math.min(safe, Math.round(totalMs)))
}
