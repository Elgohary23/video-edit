import { describe, expect, it } from 'vitest'
import { clampRect, defaultRect, hitTest, MIN_PROP_SIZE, moveRect, resizeRect, type NormalizedRect } from './engine'

const square: NormalizedRect = { x: 0.3, y: 0.3, w: 0.4, h: 0.4 }

describe('clampRect', () => {
  it('enforces minimum size and bounds', () => {
    expect(clampRect({ x: 0.99, y: 0.99, w: 5, h: 5 })).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    expect(clampRect({ x: 0, y: 0, w: 0.001, h: 0.001 })).toEqual({
      x: 0,
      y: 0,
      w: MIN_PROP_SIZE,
      h: MIN_PROP_SIZE,
    })
    expect(clampRect({ x: -0.5, y: -0.5, w: 0.4, h: 0.4 })).toEqual({ x: 0, y: 0, w: 0.4, h: 0.4 })
  })
})

describe('moveRect', () => {
  it('moves and clamps to the canvas', () => {
    expect(moveRect(square, 0.5, 0)).toEqual({ x: 0.6, y: 0.3, w: 0.4, h: 0.4 })
    expect(moveRect(square, 1.2, -1)).toEqual({ x: 0.6, y: 0, w: 0.4, h: 0.4 })
  })
})

describe('resizeRect', () => {
  const expectRect = (rect: NormalizedRect, x: number, y: number, w: number, h: number) => {
    expect(rect.x).toBeCloseTo(x, 6)
    expect(rect.y).toBeCloseTo(y, 6)
    expect(rect.w).toBeCloseTo(w, 6)
    expect(rect.h).toBeCloseTo(h, 6)
  }

  it('se grows along the drag with opposite corner anchored', () => {
    expectRect(resizeRect(square, 'se', 0.1, -0.1, 1), 0.3, 0.3, 0.5, 0.5)
  })
  it('nw keeps the bottom-right corner fixed', () => {
    expectRect(resizeRect(square, 'nw', 0.1, 0.1, 1), 0.4, 0.4, 0.3, 0.3)
  })
  it('aspect keeps the shape on corner drags', () => {
    // square prop, aspect 2 (w=2h): drag se by dx 0.1 → h = 0.5/2
    const rect = resizeRect(square, 'se', 0.1, 0, 2)
    expect(rect.w).toBeCloseTo(0.5, 6)
    expect(rect.h).toBeCloseTo(0.25, 6)
  })
  it('clamps growth against the anchored corner, not the origin', () => {
    // se can only grow to the canvas right/bottom edges
    expectRect(resizeRect(square, 'se', 5, 5, 1), 0.3, 0.3, 0.7, 0.7)
  })
  it('clamps inward drags to minimum size, bottom-right stays fixed', () => {
    expectRect(resizeRect(square, 'nw', 0.6, 0.6), 0.68, 0.68, MIN_PROP_SIZE, MIN_PROP_SIZE)
  })
})

describe('hitTest', () => {
  it('reports corner handles within the grab radius', () => {
    expect(hitTest(square, 0.3, 0.3, 0.03)).toEqual({ kind: 'handle', handle: 'nw' })
    expect(hitTest(square, 0.7, 0.7, 0.03)).toEqual({ kind: 'handle', handle: 'se' })
  })
  it('reports body hits and misses', () => {
    expect(hitTest(square, 0.5, 0.5, 0.03)).toEqual({ kind: 'body' })
    expect(hitTest(square, 0.1, 0.1, 0.03)).toBeNull()
    expect(hitTest(square, 0.75, 0.75, 0.03)).toBeNull() // outside, beyond radius
  })
})

describe('defaultRect', () => {
  it('centers a 30%-wide prop using the asset aspect', () => {
    expect(defaultRect(2)).toEqual({ x: 0.35, y: 0.425, w: 0.3, h: 0.15 })
    expect(defaultRect(0.5)).toEqual({ x: 0.35, y: 0.2, w: 0.3, h: 0.6 })
  })
})
