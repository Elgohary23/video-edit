import { describe, expect, it } from 'vitest'
import { SCRUB_STEP_MS, scrubBounds, scrubValueToMs } from './engine'

describe('scrubBounds', () => {
  it('spans zero to the full timeline width', () => {
    expect(scrubBounds(48_000)).toEqual({ min: 0, max: 48_000 })
    expect(scrubBounds(48_023)).toEqual({ min: 0, max: 48_023 })
  })

  it('keeps a non-degenerate range when the timeline is empty', () => {
    expect(scrubBounds(0)).toEqual({ min: 0, max: 1 })
    expect(scrubBounds(-5)).toEqual({ min: 0, max: 1 })
  })
})

describe('scrubValueToMs', () => {
  it('rounds raw slider emits to whole milliseconds', () => {
    expect(scrubValueToMs(1234.6, 5000)).toBe(1235)
  })

  it('clamps above the end when bounds shrink (task: delete trailing clip)', () => {
    expect(scrubValueToMs(2800, 1000)).toBe(1000)
  })

  it('clamps negative drift to the start', () => {
    expect(scrubValueToMs(-40, 5000)).toBe(0)
  })

  it('maps non-finite noise to the start', () => {
    expect(scrubValueToMs(Number.NaN, 5000)).toBe(0)
  })

  it('keeps the advertised step constant in lockstep with bounds', () => {
    expect(SCRUB_STEP_MS).toBeGreaterThan(0)
  })
})
