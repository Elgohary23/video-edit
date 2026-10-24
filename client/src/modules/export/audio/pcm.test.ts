import { describe, expect, it } from 'vitest'
import { encodePcm16Mono, pcm16ByteLength, sampleAtFrame, sampleCountForFrames } from './pcm'

describe('pcm16ByteLength', () => {
  it('is two bytes per mono sample', () => {
    expect(pcm16ByteLength(0)).toBe(0)
    expect(pcm16ByteLength(1)).toBe(2)
    expect(pcm16ByteLength(48_000)).toBe(96_000)
  })

  it('rounds fractional sample counts and never returns a negative length', () => {
    expect(pcm16ByteLength(10.4)).toBe(20)
    expect(pcm16ByteLength(-100)).toBe(0)
  })
})

describe('sampleAtFrame', () => {
  it('maps exact frame boundaries onto the absolute sample grid', () => {
    expect(sampleAtFrame(0, 30, 48_000)).toBe(0)
    expect(sampleAtFrame(30, 30, 48_000)).toBe(48_000)
    expect(sampleAtFrame(1, 30, 48_000)).toBe(1_600)
    expect(sampleAtFrame(50, 30, 48_000)).toBe(80_000)
  })

  it('rounds each instant independently (never accumulates)', () => {
    // 7 frames @ 23.976 is 291.958ms → 14013.999 samples → 14014.
    expect(sampleAtFrame(7, 23.976, 48_000)).toBe(Math.round((7 / 23.976) * 48_000))
    expect(sampleAtFrame(14, 23.976, 48_000)).toBe(Math.round((14 / 23.976) * 48_000))
    // Chunk sizes may differ by a sample, but all absolute boundaries telescope
    // back to the exact total instead of accumulating rounding error.
    let summed = 0
    for (let frame = 0; frame < 100; frame += 7) {
      summed += sampleAtFrame(Math.min(100, frame + 7), 23.976, 48_000) - sampleAtFrame(frame, 23.976, 48_000)
    }
    expect(summed).toBe(sampleCountForFrames(100, 23.976, 48_000))
  })

  it('degenerates safely for invalid fps/rate', () => {
    expect(sampleAtFrame(10, 0, 48_000)).toBe(0)
    expect(sampleAtFrame(10, 30, 0)).toBe(0)
    expect(sampleAtFrame(-10, 30, 48_000)).toBe(-16_000)
  })
})

describe('sampleCountForFrames', () => {
  it('derives the exact track length from the output frame count', () => {
    expect(sampleCountForFrames(0, 30, 48_000)).toBe(0)
    expect(sampleCountForFrames(60, 30, 48_000)).toBe(96_000)
    expect(sampleCountForFrames(31, 30, 48_000)).toBe(49_600)
  })
})

describe('encodePcm16Mono', () => {
  const read = (bytes: Uint8Array, index = 0): number =>
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt16(index * 2, true)

  it('converts samples to little-endian signed 16-bit', () => {
    const bytes = encodePcm16Mono(new Float32Array([0, 1, -1, 0.5]))
    expect(bytes.byteLength).toBe(8)
    expect(read(bytes, 0)).toBe(0)
    expect(read(bytes, 1)).toBe(0x7fff)
    expect(read(bytes, 2)).toBe(-0x8000)
    expect(read(bytes, 3)).toBe(Math.round(0.5 * 0x7fff))
  })

  it('clamps out-of-range values and silences NaN/Infinity', () => {
    const bytes = encodePcm16Mono(new Float32Array([2, -2, Number.NaN, Number.POSITIVE_INFINITY]))
    expect(read(bytes, 0)).toBe(0x7fff)
    expect(read(bytes, 1)).toBe(-0x8000)
    expect(read(bytes, 2)).toBe(0)
    expect(read(bytes, 3)).toBe(0)
  })

  it('writes into a preallocated buffer at an absolute byte offset without copying', () => {
    const target = new Uint8Array(16)
    target.fill(0x7f)
    const result = encodePcm16Mono(new Float32Array([0.25, -0.25]), target, 4)
    expect(result).toBe(target)
    expect(Array.from(target.slice(0, 4))).toEqual([0x7f, 0x7f, 0x7f, 0x7f])
    expect(read(target, 2)).toBe(Math.round(0.25 * 0x7fff))
    expect(read(target, 3)).toBe(Math.round(-0.25 * 0x8000))
    expect(Array.from(target.slice(8))).toEqual(new Array(8).fill(0x7f))
  })

  it('truncates to the available space instead of overrunning the target', () => {
    const target = new Uint8Array(4)
    const result = encodePcm16Mono(new Float32Array([0.1, 0.2, 0.3]), target, 2)
    expect(result.byteLength).toBe(4)
    expect(read(target, 1)).toBe(Math.round(0.1 * 0x7fff))
  })
})
