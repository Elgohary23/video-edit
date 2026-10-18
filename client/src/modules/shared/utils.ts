/** Shared class-string builder (clsx-lite). */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/** Clamp a number to [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Map a device-rect event to normalized [0,1] coordinates of the target rect.
 * x/y relative to the element, not the viewport.
 */
export function toNormalized(e: { clientX: number; clientY: number }, rect: DOMRect): { x: number; y: number } {
  const x = rect.width === 0 ? 0 : clamp((e.clientX - rect.left) / rect.width, 0, 1)
  const y = rect.height === 0 ? 0 : clamp((e.clientY - rect.top) / rect.height, 0, 1)
  return { x, y }
}

/** Format milliseconds as mm:ss.d (e.g. 01:23.4). */
export function formatTimecode(ms: number): string {
  const safe = Math.max(0, ms)
  const totalSeconds = Math.floor(safe / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  const tenth = Math.floor((safe % 1000) / 100)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(tenth)}`
}
