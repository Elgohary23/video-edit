import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COMPLETE_OUTPUT_NAME,
  RECORDED_INPUT_NAME,
  exportFileName,
  loadFfmpeg,
  pickRecorderMimeType,
  resetFfmpegCache,
  transcodeArgs,
  transcodeToMp4,
} from './engine'

describe('transcodeArgs', () => {
  it('webm → H.264 MP4 with default names', () => {
    const args = transcodeArgs()
    expect(args.slice(0, 2)).toEqual(['-i', RECORDED_INPUT_NAME])
    expect(args[args.length - 1]).toBe(COMPLETE_OUTPUT_NAME)
    expect(args).toContain('libx264')
    expect(args).toContain('aac')
    expect(args).toContain('+faststart')
  })
  it('accepts custom names', () => {
    expect(transcodeArgs('in.mkv', 'out.mp4')).toContain('in.mkv')
  })
})

describe('exportFileName', () => {
  it('sanitizes the project name for a file name', () => {
    expect(exportFileName('My Cool Edit!')).toBe('My-Cool-Edit-export.mp4')
    expect(exportFileName('  ')).toBe('cut-export.mp4')
  })
})

describe('pickRecorderMimeType', () => {
  it('returns the first supported type in priority order', () => {
    const pick = pickRecorderMimeType.bind(null, (m) => m === 'video/webm;codecs=vp8,opus' || m === 'video/webm')
    expect(pick()).toBe('video/webm;codecs=vp8,opus')
  })
  it('null when the browser supports nothing', () => {
    expect(pickRecorderMimeType(() => false)).toBeNull()
  })
})

describe('transcodeToMp4 with a stub FFmpeg', () => {
  afterEach(() => {
    resetFfmpegCache()
  })

  function stubFfmpeg(exitCode = 0) {
    const ffmpeg = {
      writeFile: vi.fn(async (_name: string, _data: Uint8Array) => undefined),
      exec: vi.fn(async () => exitCode),
      readFile: vi.fn(async () => new Uint8Array([1, 2, 3, 4])),
    }
    allStubs.push(ffmpeg)
    return { ffmpeg: ffmpeg as unknown as import('@ffmpeg/ffmpeg').FFmpeg, fns: ffmpeg }
  }

  const allStubs: Array<Record<string, ReturnType<typeof vi.fn>>> = []

  it('runs write → exec → read phases and yields an mp4 blob', async () => {
    const phases: string[] = []
    const { ffmpeg, fns } = stubFfmpeg()
    const result = await transcodeToMp4(new Blob(['take']), (p) => phases.push(p), ffmpeg)
    expect(phases).toEqual(['loading-core', 'writing', 'transcoding', 'done'])
    expect(result.blob.type).toBe('video/mp4')
    expect(result.blob.size).toBe(4)
    expect(fns.writeFile).toHaveBeenCalledWith(RECORDED_INPUT_NAME, expect.anything())
    expect(fns.readFile).toHaveBeenCalledWith(COMPLETE_OUTPUT_NAME)
  })

  it('throws (and never reaches done) when ffmpeg exits non-zero', async () => {
    const phases: string[] = []
    const { ffmpeg, fns } = stubFfmpeg(1)
    await expect(transcodeToMp4(new Blob([]), (p) => phases.push(p), ffmpeg)).rejects.toThrow('ffmpeg exited with code 1')
    expect(phases).toEqual(['loading-core', 'writing', 'transcoding'])
    expect(fns.readFile).not.toHaveBeenCalled()
  })

  it('caches the FFmpeg instance across calls', async () => {
    let loads = 0
    const stub = {
      load: vi.fn(async () => {
        loads += 1
      }),
    } as unknown as import('@ffmpeg/ffmpeg').FFmpeg
    const first = await loadFfmpeg(async () => ({ coreURL: 'c', wasmURL: 'w' }), 'https://base', () => stub)
    const second = await loadFfmpeg(
      async () => {
        throw new Error('second load attempted')
      },
      'https://base',
      () => {
        throw new Error('second construction attempted')
      },
    )
    expect(second).toBe(first)
    expect(stub.load).toHaveBeenCalledTimes(1)
  })
})
