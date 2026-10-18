import { describe, expect, it } from 'vitest'
import { isSupportedVideoType, mixdownToMono, type AudioBufferLike } from './engine'

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
