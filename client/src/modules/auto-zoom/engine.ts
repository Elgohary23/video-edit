/**
 * Auto-zoom engine (PRD Feature 3): one click applies alternating framing so
 * adjacent clips never look monotone — even indexes stay at base scale, odd
 * indexes get the punch-in.
 */

export const BASE_SCALE = 1
export const PUNCH_SCALE = 1.15

export function alternatingZoom(index: number): number {
  return index % 2 === 0 ? BASE_SCALE : PUNCH_SCALE
}

/** Return a new timeline with zoom assigned per position. */
export function applyAutoZoom<T extends { zoom: number }>(clips: T[]): T[] {
  return clips.map((clip, i) => ({ ...clip, zoom: alternatingZoom(i) }))
}
