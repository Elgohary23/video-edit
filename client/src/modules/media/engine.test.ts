import { describe, expect, it } from 'vitest'
import {
  isSupportedImageType,
  isSupportedVideoType,
  mediaKindOf,
  mixdownToMono,
  type AudioBufferLike,
} from './engine'

function fakeBuffer(channels: Float32Array[], sampleRate = 1000): AudioBufferLike {
  return {
    numberOfChannels: channels.length,
    sampleRate,
    length: channels[0]?.length ?? 0,
    getChannelData: (i: number) => channels[i],
  }
}

describe('mixdownToMono', () => {
  it('averages stereo into mono with correct duration', () => {
    const left = new Float32Array([0.6, 0.8, -0.6])
    const right = new Float32Array([0.4, 0.2, 0.2])
    const mix = mixdownToMono(fakeBuffer([left, right], 250))
    expect(mix.samples[0]).toBeCloseTo(0.5, 6)
    expect(mix.samples[1]).toBeCloseTo(0.5, 6)
    expect(mix.samples[2]).toBeCloseTo(-0.2, 6)
    expect(mix.sampleRate).toBe(250)
    expect(mix.durationMs).toBeCloseTo(12, 6) // 3 samples @250Hz
  })
  it('passes through single-channel buffers without copying cost', () => {
    const only = new Float32Array([0.25])
    const mix = mixdownToMono(fakeBuffer([only], 8000))
    expect(mix.samples[0]).toBe(0.25)
    expect(mix.durationMs).toBeCloseTo(0.125, 9)
  })
  it('degenerates gracefully', () => {
    const mix = mixdownToMono(fakeBuffer([], 1000))
    expect(mix.samples.length).toBe(0)
    expect(mix.durationMs).toBe(0)
  })
})

describe('isSupportedVideoType', () => {
  it('accepts common video containers', () => {
    expect(isSupportedVideoType('video/mp4')).toBe(true)
    expect(isSupportedVideoType('video/webm;codecs=vp9')).toBe(true)
    expect(isSupportedVideoType('video/quicktime')).toBe(true)
  })
  it('rejects non-media types', () => {
    expect(isSupportedVideoType('image/png')).toBe(false)
    expect(isSupportedVideoType('audio/mpeg')).toBe(false)
    expect(isSupportedVideoType('vue/x-msvideo')).toBe(false)
  })
})

describe('isSupportedImageType', () => {
  it('accepts raster formats the canvas can decode', () => {
    expect(isSupportedImageType('image/png')).toBe(true)
    expect(isSupportedImageType('image/jpeg')).toBe(true)
    expect(isSupportedImageType('image/webp')).toBe(true)
  })
  it('rejects SVG (it taints the export canvas) and non-images', () => {
    expect(isSupportedImageType('image/svg+xml')).toBe(false)
    expect(isSupportedImageType('video/mp4')).toBe(false)
  })
  it('falls back to the filename only when the MIME type is missing', () => {
    expect(isSupportedImageType('', 'still.PNG')).toBe(true)
    expect(isSupportedImageType('', 'photo.jpeg')).toBe(true)
    expect(isSupportedImageType('application/octet-stream', 'still.png')).toBe(false)
  })
})

describe('mediaKindOf', () => {
  it('classifies PNG/JPEG imports as images', () => {
    expect(mediaKindOf('image/png', 'still.png')).toBe('image')
    expect(mediaKindOf('image/jpeg', 'photo.jpg')).toBe('image')
  })
  it('classifies video imports as video', () => {
    expect(mediaKindOf('video/mp4', 'take.mp4')).toBe('video')
    expect(mediaKindOf('video/webm', 'take.webm')).toBe('video')
  })
  it('recovers the kind from the extension when Windows omits the MIME type', () => {
    expect(mediaKindOf('', 'still.png')).toBe('image')
    expect(mediaKindOf('', 'take.MP4')).toBe('video')
    expect(mediaKindOf('', 'readme.txt')).toBeNull()
  })
  it('does not misclassify octet-stream video drops', () => {
    expect(mediaKindOf('application/octet-stream', 'take.mp4')).toBe('video')
  })
})
