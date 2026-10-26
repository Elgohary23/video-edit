import { describe, expect, it } from 'vitest'
import { shortcutPreventsDefault, transportShortcutFor, type ShortcutContext } from './shortcuts'

function ctx(overrides: Partial<ShortcutContext> = {}): ShortcutContext {
  return {
    shift: false,
    repeat: false,
    ctrl: false,
    meta: false,
    alt: false,
    editable: false,
    hasTimeline: true,
    ...overrides,
  }
}

describe('transportShortcutFor', () => {
  it('maps frame steps and one-second jumps', () => {
    expect(transportShortcutFor(',', ctx())).toEqual({ kind: 'step-frames', frames: -1 })
    expect(transportShortcutFor('.', ctx())).toEqual({ kind: 'step-frames', frames: 1 })
    expect(transportShortcutFor('ArrowLeft', ctx())).toEqual({ kind: 'step-frames', frames: -1 })
    expect(transportShortcutFor('ArrowRight', ctx())).toEqual({ kind: 'step-frames', frames: 1 })
    expect(transportShortcutFor('ArrowLeft', ctx({ shift: true }))).toEqual({ kind: 'step-seconds', seconds: -1 })
    expect(transportShortcutFor('ArrowRight', ctx({ shift: true }))).toEqual({ kind: 'step-seconds', seconds: 1 })
  })

  it('maps Home/End and J/K/L transport keys', () => {
    expect(transportShortcutFor('Home', ctx())).toEqual({ kind: 'seek-edge', edge: 'start' })
    expect(transportShortcutFor('End', ctx())).toEqual({ kind: 'seek-edge', edge: 'end' })
    expect(transportShortcutFor('j', ctx())).toEqual({ kind: 'reverse-shuttle' })
    expect(transportShortcutFor('K', ctx())).toEqual({ kind: 'pause' })
    expect(transportShortcutFor('l', ctx())).toEqual({ kind: 'play' })
  })

  it('maps loop marking, toggling, and clearing', () => {
    expect(transportShortcutFor('i', ctx())).toEqual({ kind: 'loop-in' })
    expect(transportShortcutFor('O', ctx())).toEqual({ kind: 'loop-out' })
    expect(transportShortcutFor('p', ctx())).toEqual({ kind: 'toggle-loop' })
    expect(transportShortcutFor('P', ctx({ shift: true }))).toEqual({ kind: 'clear-loop' })
  })

  it('keeps editable fields and OS shortcuts native', () => {
    expect(transportShortcutFor('.', ctx({ editable: true }))).toBeNull()
    expect(transportShortcutFor('ArrowLeft', ctx({ ctrl: true }))).toBeNull()
    expect(transportShortcutFor('l', ctx({ meta: true }))).toBeNull()
    expect(transportShortcutFor('j', ctx({ alt: true }))).toBeNull()
    expect(transportShortcutFor('.', ctx({ hasTimeline: false }))).toBeNull()
  })

  it('ignores key repeat for one-shot transport commands but allows held steps', () => {
    expect(transportShortcutFor('l', ctx({ repeat: true }))).toBeNull()
    expect(transportShortcutFor('p', ctx({ repeat: true }))).toBeNull()
    expect(transportShortcutFor('.', ctx({ repeat: true }))).toEqual({ kind: 'step-frames', frames: 1 })
  })

  it('prevents page scroll only for navigation keys', () => {
    expect(shortcutPreventsDefault({ kind: 'step-frames', frames: 1 })).toBe(true)
    expect(shortcutPreventsDefault({ kind: 'step-seconds', seconds: 1 })).toBe(true)
    expect(shortcutPreventsDefault({ kind: 'seek-edge', edge: 'end' })).toBe(true)
    expect(shortcutPreventsDefault({ kind: 'play' })).toBe(false)
  })
})
