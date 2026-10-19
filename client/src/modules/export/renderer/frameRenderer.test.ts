import { describe, expect, it } from 'vitest'
import { activePropFrames } from './frameRenderer'
import type { ExportProp } from '../types'

const prop: ExportProp = {
  id: 'p1',
  src: 'blob:overlay',
  rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
  range: { startMs: 100, endMs: 200 },
  preset: 'none',
}

const images = new Map<string, CanvasImageSource>([['p1', {} as CanvasImageSource]])

describe('activePropFrames', () => {
  it('includes props inside the half-open visibility window', () => {
    expect(activePropFrames([prop], images, 100)).toHaveLength(1)
    expect(activePropFrames([prop], images, 150)).toHaveLength(1)
    expect(activePropFrames([prop], images, 199)).toHaveLength(1)
  })

  it('excludes props before and at the end of their range', () => {
    expect(activePropFrames([prop], images, 99)).toHaveLength(0)
    expect(activePropFrames([prop], images, 200)).toHaveLength(0)
  })

  it('skips props whose image failed to load', () => {
    expect(activePropFrames([prop], new Map(), 150)).toHaveLength(0)
  })

  it('passes the placed rect through unchanged', () => {
    const frame = activePropFrames([prop], images, 150)[0]
    expect(frame.rect).toEqual(prop.rect)
    expect(frame.image).toBe(images.get('p1'))
  })
})
