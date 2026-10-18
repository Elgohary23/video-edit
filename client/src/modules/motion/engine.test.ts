import { describe, expect, it } from 'vitest'
import {
  easeInBack,
  easeInCubic,
  easeOutBack,
  easeOutCubic,
  IDENTITY_TRANSFORM,
  resolveMotion,
  transitionMs,
} from './engine'

describe('easings', () => {
  it('all curves start at 0 and end at 1', () => {
    const curves = [easeOutBack, easeInBack, easeOutCubic, easeInCubic]
    for (const curve of curves) {
      expect(curve(0)).toBeCloseTo(0, 6)
      expect(curve(1)).toBeCloseTo(1, 6)
    }
  })
  it('easeOutBack overshoots then settles (pop)', () => {
    expect(easeOutBack(0.6)).toBeGreaterThan(1)
  })
  it('easeInBack winds up below zero first (anticipation)', () => {
    expect(easeInBack(0.2)).toBeLessThan(0)
  })
  it('cubics are monotone and bounded', () => {
    for (let i = 0; i <= 10; i++) {
      const t = i / 10
      expect(easeOutCubic(t)).toBeGreaterThanOrEqual(0)
      expect(easeOutCubic(t)).toBeLessThanOrEqual(1)
      expect(easeInCubic(t)).toBeGreaterThanOrEqual(0)
      expect(easeInCubic(t)).toBeLessThanOrEqual(1)
    }
  })
})

describe('transitionMs', () => {
  it('caps at 600ms and 30% of span', () => {
    expect(transitionMs(5000)).toBe(600)
    expect(transitionMs(1000)).toBe(300)
    expect(transitionMs(10)).toBe(3)
  })
})

describe('resolveMotion', () => {
  const start = 1000
  const end = 4000 // span 3000 → transitions of 600ms each, stable middle 1800ms

  it('is hidden outside the range', () => {
    expect(resolveMotion('pop-bounce', 999, start, end)).toEqual({ scale: 1, offsetX: 0, offsetY: 0, opacity: 0 })
    expect(resolveMotion('pop-bounce', end + 1, start, end)).toEqual({ scale: 1, offsetX: 0, offsetY: 0, opacity: 0 })
  })
  it('"none" is identity inside the range', () => {
    expect(resolveMotion('none', 2000, start, end)).toEqual(IDENTITY_TRANSFORM)
  })

  describe('pop-bounce', () => {
    it('entry: grows from 0 with overshoot, settles at 1', () => {
      expect(resolveMotion('pop-bounce', start, start, end).opacity).toBe(0)
      expect(resolveMotion('pop-bounce', start, start, end).scale).toBeCloseTo(0, 6)
      const overshoot = resolveMotion('pop-bounce', start + 400, start, end)
      expect(overshoot.scale).toBeGreaterThan(1)
      // midpoint of range is stable
      const stable = resolveMotion('pop-bounce', start + end >> 1, start, end)
      expect(stable.scale).toBe(1)
      expect(stable.opacity).toBe(1)
      // last entry instant settles exactly at natural size
      const lastEntry = resolveMotion('pop-bounce', start + 599, start, end)
      expect(lastEntry.scale).toBeCloseTo(1, 4)
    })
    it('exit: winds up above 1 then shrinks to 0', () => {
      const firstExit = resolveMotion('pop-bounce', end - 600, start, end)
      const midWindUp = resolveMotion('pop-bounce', end - 600 + 180, start, end)
      expect(midWindUp.scale).toBeGreaterThan(1)
      expect(firstExit.opacity).toBe(1)
      // nearly at the end: fully deflated (easeInBack reaches 1 only outside the exclusive range)
      const nearEnd = resolveMotion('pop-bounce', end - 1, start, end)
      expect(nearEnd.scale).toBeLessThan(0.02)
      expect(nearEnd.opacity).toBeLessThan(0.01)
    })
  })

  describe('slide-snap', () => {
    it('entry: slides in from 40% left with fade, snaps to place', () => {
      const first = resolveMotion('slide-snap', start, start, end)
      expect(first.offsetX).toBeCloseTo(-0.4, 6)
      expect(first.opacity).toBeCloseTo(0, 6)
      const settled = resolveMotion('slide-snap', start + 599, start, end)
      expect(settled.offsetX).toBeCloseTo(0, 4)
      expect(settled.opacity).toBeCloseTo(1, 4)
      const stable = resolveMotion('slide-snap', 2000, start, end)
      expect(stable.offsetX).toBe(0)
      expect(stable.opacity).toBe(1)
    })
    it('exit: snaps out to the right, fully faded by the end', () => {
      const nearEnd = resolveMotion('slide-snap', end - 1, start, end)
      // easeInCubic(599/600) ≈ 0.9950 → 40% × 0.995, opacity ≈ 0.005
      expect(nearEnd.offsetX).toBeCloseTo(0.398, 3)
      expect(nearEnd.opacity).toBeLessThan(0.01)
      const stable = resolveMotion('slide-snap', end - 601, start, end)
      expect(stable.offsetX).toBe(0)
      expect(stable.opacity).toBe(1)
    })
  })

  it('short spans still produce complete motion', () => {
    // 1000ms span → 300ms transitions; near the very end the motion is deflated
    expect(resolveMotion('pop-bounce', 999, 0, 1000).scale).toBeLessThan(0.05)
  })
})
