/**
 * Pure keyboard map for transport review. Keeping the key rules here makes
 * the global listener in EditorProvider thin and lets the shortcut contract be
 * unit-tested without a DOM.
 */

export type TransportShortcut =
  | { kind: 'step-frames'; frames: number }
  | { kind: 'step-seconds'; seconds: number }
  | { kind: 'seek-edge'; edge: 'start' | 'end' }
  | { kind: 'play' }
  | { kind: 'pause' }
  | { kind: 'reverse-shuttle' }
  | { kind: 'loop-in' }
  | { kind: 'loop-out' }
  | { kind: 'toggle-loop' }
  | { kind: 'clear-loop' }

export interface ShortcutContext {
  shift: boolean
  repeat: boolean
  ctrl: boolean
  meta: boolean
  alt: boolean
  /** Focus is inside a text field/select/contenteditable. */
  editable: boolean
  hasTimeline: boolean
}

/**
 * Map one keydown to a transport command.
 *
 * Conventions:
 * - `,` / `.` and ← / → step one export frame; Shift+←/→ jumps one second.
 * - `J` starts a stepped reverse shuttle, `K` stops, `L` plays from park.
 * - `I` / `O` set the loop in/out (and enable the loop), `P` toggles it,
 *   Shift+P clears it.
 * - Editable controls and browser/OS modifier combinations keep their native
 *   meaning.
 */
export function transportShortcutFor(key: string, ctx: ShortcutContext): TransportShortcut | null {
  if (ctx.editable || ctx.ctrl || ctx.meta || ctx.alt || !ctx.hasTimeline) return null

  const lower = key.length === 1 ? key.toLowerCase() : key

  switch (lower) {
    case ',': {
      return { kind: 'step-frames', frames: -1 }
    }
    case '.': {
      return { kind: 'step-frames', frames: 1 }
    }
    case 'ArrowLeft': {
      return ctx.shift ? { kind: 'step-seconds', seconds: -1 } : { kind: 'step-frames', frames: -1 }
    }
    case 'ArrowRight': {
      return ctx.shift ? { kind: 'step-seconds', seconds: 1 } : { kind: 'step-frames', frames: 1 }
    }
    case 'Home':
      return { kind: 'seek-edge', edge: 'start' }
    case 'End':
      return { kind: 'seek-edge', edge: 'end' }
    case 'j':
      return ctx.repeat ? null : { kind: 'reverse-shuttle' }
    case 'k':
      return ctx.repeat ? null : { kind: 'pause' }
    case 'l':
      return ctx.repeat ? null : { kind: 'play' }
    case 'i':
      return ctx.repeat ? null : { kind: 'loop-in' }
    case 'o':
      return ctx.repeat ? null : { kind: 'loop-out' }
    case 'p':
      if (ctx.repeat) return null
      return ctx.shift ? { kind: 'clear-loop' } : { kind: 'toggle-loop' }
    default:
      return null
  }
}

/** Keys that should suppress page scrolling when the transport handles them. */
export function shortcutPreventsDefault(shortcut: TransportShortcut): boolean {
  return (
    shortcut.kind === 'step-frames' ||
    shortcut.kind === 'step-seconds' ||
    shortcut.kind === 'seek-edge'
  )
}
