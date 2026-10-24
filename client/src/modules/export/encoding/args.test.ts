import { describe, expect, it } from 'vitest'
import { normalizeExportSettings } from '../settings'
import {
  audioFileName,
  chunkEncodeTimeoutMs,
  codecContainer,
  concatArgs,
  exportFileName,
  frameFileName,
  framePattern,
  outputMimeType,
  segmentEncodeArgs,
  segmentEncodingOptions,
  segmentFileName,
} from './args'

const h264 = normalizeExportSettings({ resolution: '720p', fps: 30, quality: 'standard' })

describe('codec container helpers', () => {
  it('maps codecs to containers, extensions, and mime types', () => {
    expect(codecContainer('h264')).toBe('mp4')
    expect(codecContainer('vp9')).toBe('webm')
    expect(outputMimeType('h264')).toBe('video/mp4')
    expect(outputMimeType('vp9')).toBe('video/webm')
  })
})

describe('exportFileName', () => {
  it('sanitizes the project name and honors the codec extension', () => {
    expect(exportFileName('My Cool Edit!')).toBe('My-Cool-Edit-export.mp4')
    expect(exportFileName('My Cool Edit!', 'vp9')).toBe('My-Cool-Edit-export.webm')
    expect(exportFileName('  ')).toBe('cut-export.mp4')
    expect(exportFileName('take.mp4')).toBe('take-export.mp4')
  })
})

describe('frame/file naming', () => {
  it('zero-pads chunk and frame indices so image2 patterns match', () => {
    expect(frameFileName(3, 41)).toBe('frame-0003-000042.jpg')
    expect(framePattern(3)).toBe('frame-0003-%06d.jpg')
    expect(frameFileName(3, 41, 'png')).toBe('frame-0003-000042.png')
    expect(framePattern(3, 'png')).toBe('frame-0003-%06d.png')
    expect(segmentFileName(3, h264)).toBe('segment-0003.mp4')
    expect(audioFileName()).toBe('audio-mix.pcm')
  })
})

describe('segmentEncodeArgs', () => {
  it('builds a video-only H.264 segment (audio is muxed once at the end)', () => {
    const args = segmentEncodeArgs(h264, 0, 120)
    expect(args.slice(0, 4)).toEqual(['-framerate', '30', '-i', framePattern(0)])
    expect(args).toContain('libx264')
    expect(args).not.toContain('aac')
    expect(args).not.toContain('libopus')
    expect(args).toContain('-crf')
    expect(args).toContain('-an')
    expect(args[args.length - 1]).toBe('segment-0000.mp4')
    expect(args).toContain('120')
  })

  it('uses an explicit bitrate when configured', () => {
    const args = segmentEncodeArgs(normalizeExportSettings({ bitrate: 6000 }), 0, 10)
    expect(args).toContain('-b:v')
    expect(args).toContain('6000k')
    expect(args).toContain('-an')
  })

  it('builds a VP9 WebM segment without audio codecs', () => {
    const args = segmentEncodeArgs(normalizeExportSettings({ codec: 'vp9' }), 1, 30)
    expect(args).toContain('libvpx-vp9')
    expect(args).not.toContain('libopus')
    expect(args).toContain('yuv420p')
    expect(args[args.length - 1]).toBe('segment-0001.webm')
  })

  it('switches to PNG + yuva420p for alpha exports', () => {
    const args = segmentEncodeArgs(normalizeExportSettings({ codec: 'vp9' }), 0, 30, true)
    expect(args).toContain(framePattern(0, 'png'))
    expect(args).toContain('yuva420p')
    expect(args).toContain('-auto-alt-ref')
    expect(args).toContain('0')
    expect(args).not.toContain('yuv420p')
  })

  it('tags HEVC output for QuickTime compatibility', () => {
    const args = segmentEncodeArgs(normalizeExportSettings({ codec: 'h265' }), 0, 30)
    expect(args).toContain('libx265')
    expect(args).toContain('hvc1')
  })
})

describe('segmentEncodingOptions', () => {
  it('always disables per-segment audio and caps the frame count', () => {
    const args = segmentEncodingOptions(h264, 42)
    expect(args).toContain('-an')
    expect(args).toContain('-frames:v')
    expect(args).toContain('42')
    expect(args).not.toContain('aac')
  })
})

describe('concatArgs', () => {
  it('copies video losslessly and muxes the single PCM track once', () => {
    const args = concatArgs(h264, true)
    expect(args.slice(0, 6)).toEqual(['-f', 'concat', '-safe', '0', '-i', 'concat-list.txt'])
    expect(args.join(' ')).toContain('-f s16le -ar 48000 -ac 1 -i audio-mix.pcm')
    expect(args).toContain('-map')
    expect(args).toContain('0:v:0')
    expect(args).toContain('1:a:0')
    expect(args).toContain('aac')
    expect(args).toContain('copy')
    expect(args).toContain('+faststart')
    expect(args).toContain('-shortest')
    expect(args[args.length - 1]).toBe('final-output.mp4')
  })

  it('uses Opus for VP9/WebM audio and omits faststart', () => {
    const args = concatArgs(normalizeExportSettings({ codec: 'vp9' }), true)
    expect(args).toContain('libopus')
    expect(args).not.toContain('+faststart')
  })

  it('does not add an audio input when the timeline is silent', () => {
    const args = concatArgs(h264, false)
    expect(args).not.toContain('s16le')
    expect(args).not.toContain('audio-mix.pcm')
    expect(args).not.toContain('-shortest')
  })
})

describe('chunkEncodeTimeoutMs', () => {
  it('gives slower quality presets a larger budget', () => {
    const draft = chunkEncodeTimeoutMs(normalizeExportSettings({ quality: 'draft' }), 300)
    const ultra = chunkEncodeTimeoutMs(normalizeExportSettings({ quality: 'ultra' }), 300)
    expect(draft).toBeGreaterThanOrEqual(180_000)
    expect(ultra).toBeGreaterThan(draft)
  })
})
