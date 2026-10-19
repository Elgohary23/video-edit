import { describe, expect, it } from 'vitest'
import { normalizeExportSettings } from '../settings'
import {
  chunkEncodeTimeoutMs,
  codecContainer,
  concatArgs,
  exportFileName,
  frameFileName,
  framePattern,
  outputMimeType,
  segmentEncodeArgs,
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
    expect(segmentFileName(3, h264)).toBe('segment-0003.mp4')
  })
})

describe('segmentEncodeArgs', () => {
  it('builds an H.264/AAC segment with fast concatenation parameters', () => {
    const args = segmentEncodeArgs(h264, 0, 120, true)
    expect(args.slice(0, 4)).toEqual(['-framerate', '30', '-i', framePattern(0)])
    expect(args).toContain('libx264')
    expect(args).toContain('aac')
    expect(args).toContain('-crf')
    expect(args[args.length - 1]).toBe('segment-0000.mp4')
    expect(args).toContain('120')
  })

  it('uses an explicit bitrate when configured', () => {
    const args = segmentEncodeArgs(normalizeExportSettings({ bitrate: 6000 }), 0, 10, false)
    expect(args).toContain('-b:v')
    expect(args).toContain('6000k')
    expect(args).toContain('-an')
  })

  it('builds a VP9/Opus WebM segment', () => {
    const args = segmentEncodeArgs(normalizeExportSettings({ codec: 'vp9' }), 1, 30, true)
    expect(args).toContain('libvpx-vp9')
    expect(args).toContain('libopus')
    expect(args[args.length - 1]).toBe('segment-0001.webm')
  })

  it('tags HEVC output for QuickTime compatibility', () => {
    const args = segmentEncodeArgs(normalizeExportSettings({ codec: 'h265' }), 0, 30, false)
    expect(args).toContain('libx265')
    expect(args).toContain('hvc1')
  })
})

describe('concatArgs', () => {
  it('streams the concat list losslessly with faststart for MP4', () => {
    const args = concatArgs(h264)
    expect(args.slice(0, 6)).toEqual(['-f', 'concat', '-safe', '0', '-i', 'concat-list.txt'])
    expect(args).toContain('-c')
    expect(args).toContain('copy')
    expect(args).toContain('+faststart')
    expect(args[args.length - 1]).toBe('final-output.mp4')
  })
  it('does not add faststart for WebM', () => {
    expect(concatArgs(normalizeExportSettings({ codec: 'vp9' }))).not.toContain('+faststart')
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
