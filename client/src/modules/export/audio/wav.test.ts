import { describe, expect, it } from 'vitest'
import { encodeWav } from './wav'

function readAscii(view: DataView, offset: number, length: number): string {
  let text = ''
  for (let i = 0; i < length; i++) text += String.fromCharCode(view.getUint8(offset + i))
  return text
}

describe('encodeWav', () => {
  it('writes a valid 16-bit PCM stereo RIFF header', () => {
    const left = new Float32Array([0, 0.5, -0.5])
    const right = new Float32Array([1, -1, 0])
    const bytes = encodeWav([left, right], 48_000)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

    expect(readAscii(view, 0, 4)).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(36 + 3 * 2 * 2)
    expect(readAscii(view, 8, 4)).toBe('WAVE')
    expect(readAscii(view, 12, 4)).toBe('fmt ')
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(2) // channels
    expect(view.getUint32(24, true)).toBe(48_000)
    expect(view.getUint32(28, true)).toBe(48_000 * 2 * 2)
    expect(view.getUint16(34, true)).toBe(16) // bits per sample
    expect(readAscii(view, 36, 4)).toBe('data')
    expect(view.getUint32(40, true)).toBe(12)
    expect(bytes.byteLength).toBe(44 + 12)
  })

  it('interleaves channels and clamps out-of-range samples', () => {
    const left = new Float32Array([0.5, 5])
    const right = new Float32Array([-0.5, -5])
    const bytes = encodeWav([left, right], 1000)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(view.getInt16(44, true)).toBe(Math.round(0.5 * 0x7fff))
    expect(view.getInt16(46, true)).toBe(Math.round(-0.5 * 0x8000))
    expect(view.getInt16(48, true)).toBe(0x7fff)
    expect(view.getInt16(50, true)).toBe(-0x8000)
  })

  it('treats NaN samples as silence', () => {
    const bytes = encodeWav([new Float32Array([Number.NaN])], 1000)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(view.getInt16(44, true)).toBe(0)
  })
})
