import { describe, expect, it } from 'vitest'
import { cn, clamp, toNormalized, formatTimecode } from './utils'

describe('cn', () => {
  it('joins defined class strings, skipping falsy parts', () => {
    expect(cn('a', false, undefined, 'b', null, 'c')).toBe('a b c')
  })
  it('returns empty string when everything is falsy', () => {
    expect(cn(false, '', null)).toBe('')
  })
})

describe('clamp', () => {
  it('keeps values within bounds', () => {
    expect(clamp(0.5, 0, 1)).toBe(0.5)
    expect(clamp(-1, 0, 1)).toBe(0)
    expect(clamp(2, 0, 1)).toBe(1)
  })
})

describe('toNormalized', () => {
  const rect = { left: 100, top: 50, width: 200, height: 100 } as DOMRect
  it('converts client coords to [0,1] rect space', () => {
    expect(toNormalized({ clientX: 100, clientY: 50 }, rect)).toEqual({ x: 0, y: 0 })
    expect(toNormalized({ clientX: 200, clientY: 100 }, rect)).toEqual({ x: 0.5, y: 0.5 })
  })
  it('clamps outside the rect', () => {
    expect(toNormalized({ clientX: 500, clientY: -10 }, rect)).toEqual({ x: 1, y: 0 })
  })
})

describe('formatTimecode', () => {
  it('formats mm:ss.d', () => {
    expect(formatTimecode(0)).toBe('00:00.0')
    expect(formatTimecode(65400)).toBe('01:05.4')
    expect(formatTimecode(-5)).toBe('00:00.0')
  })
})
