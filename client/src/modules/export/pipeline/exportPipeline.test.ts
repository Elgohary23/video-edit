import { describe, expect, it, vi } from 'vitest'
import { runExport } from './exportPipeline'
import { normalizeExportSettings } from '../settings'
import type { ExportDependencies, ExportJob, ExportProgress } from '../types'
import { ExportCancelledError } from '../utils/errors'

function makeJob(signal: AbortSignal): ExportJob {
  const samples = new Float32Array(96_000).fill(0.5)
  return {
    projectName: 'My Project',
    clips: [{ id: 'c1', srcStartMs: 0, srcEndMs: 2000, zoom: 1, videoId: 'v1' }],
    videos: [
      {
        id: 'v1',
        url: 'blob:v1',
        kind: 'video',
        mixdown: { samples, sampleRate: 48_000, durationMs: 2000 },
      },
    ],
    activeVideoId: 'v1',
    props: [],
    blur: { enabled: false, px: 8 },
    fitMode: 'contain',
    settings: normalizeExportSettings({ resolution: 'custom', width: 2160, height: 3840, fps: 30, quality: 'draft' }),
    signal,
  }
}

interface DependencyOptions {
  preserveAlpha?: boolean
}

interface Fakes {
  deps: ExportDependencies
  renderer: {
    renderFrame: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
  }
  encoder: {
    writeFrame: ReturnType<typeof vi.fn>
    encodeChunk: ReturnType<typeof vi.fn>
    concat: ReturnType<typeof vi.fn>
    discardChunk: ReturnType<typeof vi.fn>
    cleanup: ReturnType<typeof vi.fn>
    terminate: ReturnType<typeof vi.fn>
  }
  rendererOptions: DependencyOptions[]
  encoderOptions: DependencyOptions[]
}

function makeFakes(overrides: { encodeChunk?: (chunkIndex: number) => Promise<Uint8Array> } = {}): Fakes {
  let clock = 0
  const renderer = {
    width: 2160,
    height: 3840,
    renderFrame: vi.fn(async () => new Uint8Array([1, 2, 3])),
    dispose: vi.fn(),
  }
  const encoder = {
    writeFrame: vi.fn(async () => {}),
    encodeChunk: vi.fn(
      async (
        chunkIndex: number,
        _frames: number,
        _signal: AbortSignal | undefined,
        onProgress: (ratio: number) => void,
      ): Promise<Uint8Array> => {
        if (overrides.encodeChunk) return overrides.encodeChunk(chunkIndex)
        onProgress(0.5)
        return new Uint8Array([9, 9, 9, 9])
      },
    ),
    concat: vi.fn(
      async (segments: Uint8Array[], _audioPcm: Uint8Array | null): Promise<Uint8Array> =>
        new Uint8Array([segments.length]),
    ),
    discardChunk: vi.fn(async () => {}),
    cleanup: vi.fn(async () => {}),
    terminate: vi.fn(),
    logs: () => [],
  }
  const rendererOptions: DependencyOptions[] = []
  const encoderOptions: DependencyOptions[] = []
  const deps: ExportDependencies = {
    createRenderer: async (_job, _settings, options) => {
      rendererOptions.push({ preserveAlpha: options.preserveAlpha })
      return renderer
    },
    createEncoder: async (_settings, options) => {
      encoderOptions.push({ preserveAlpha: options.preserveAlpha })
      return encoder
    },
    decodeAudio: async () => null,
    now: () => (clock += 1),
  }
  return { deps, renderer, encoder, rendererOptions, encoderOptions }
}

function pcmSamples(pcm: Uint8Array): Int16Array {
  return new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2))
}

describe('runExport', () => {
  it('renders every frame, encodes video-only chunks, and muxes one PCM track', async () => {
    const controller = new AbortController()
    const { deps, renderer, encoder, rendererOptions, encoderOptions } = makeFakes()
    const stages: ExportProgress['stage'][] = []
    const result = await runExport(makeJob(controller.signal), {
      dependencies: deps,
      onProgress: (progress) => stages.push(progress.stage),
    })

    // 2000ms @ 30fps = 60 frames; 4K chunks hold 50 frames → two segments.
    expect(renderer.renderFrame).toHaveBeenCalledTimes(60)
    expect(encoder.writeFrame).toHaveBeenCalledTimes(60)
    expect(encoder.encodeChunk).toHaveBeenCalledTimes(2)
    expect(encoder.discardChunk).toHaveBeenCalledTimes(2)
    expect(encoder.concat).toHaveBeenCalledTimes(1)
    expect(encoder.cleanup).toHaveBeenCalledTimes(1)
    expect(encoder.terminate).not.toHaveBeenCalled()
    expect(renderer.dispose).toHaveBeenCalledTimes(1)

    // Exactly 2s of mono 16-bit PCM at 48 kHz, independent of chunk count.
    const pcm = encoder.concat.mock.calls[0][1] as Uint8Array
    expect(pcm).toBeInstanceOf(Uint8Array)
    expect(pcm.byteLength).toBe(2 * 48_000 * 2)
    const samples = pcmSamples(pcm)
    // Sample 0 starts a deliberate click-suppressing micro-fade; measure just
    // after it to prove the segment was actually written to the PCM track.
    expect(samples[0]).toBe(0)
    expect(samples[480]).toBeGreaterThan(1_000)
    // Sample 80,000 is frame 50's exact boundary: the second chunk must be
    // filled at its absolute offset, not appended after a rounded chunk slice.
    expect(samples[80_000]).toBeGreaterThan(1_000)
    expect(samples[80_000 - 1]).toBeGreaterThan(1_000)
    expect(samples[80_000 + 1]).toBeGreaterThan(1_000)

    // Audio was never passed to a per-chunk encoder.
    expect(encoder.encodeChunk.mock.calls.every((call) => call.length === 4)).toBe(true)

    expect(rendererOptions[0].preserveAlpha).toBe(false)
    expect(encoderOptions[0].preserveAlpha).toBe(false)

    expect(stages).toContain('initializing')
    expect(stages).toContain('loading-assets')
    expect(stages).toContain('rendering')
    expect(stages).toContain('audio')
    expect(stages).toContain('encoding')
    expect(stages).toContain('finalizing')
    expect(stages.at(-1)).toBe('done')

    expect(result.filename).toBe('My-Project-export.mp4')
    expect(result.mimeType).toBe('video/mp4')
    expect(result.totalFrames).toBe(60)
    expect(result.durationMs).toBe(2000)
    expect(result.blob.size).toBe(1)
  })

  it('requests PNG alpha for VP9 image timelines only', async () => {
    const controller = new AbortController()
    const job = makeJob(controller.signal)
    job.clips = [{ id: 'still', srcStartMs: 0, srcEndMs: 1000, zoom: 1, videoId: 'img' }]
    job.videos = [{ id: 'img', url: 'blob:png', kind: 'image', durationMs: 1000, mixdown: null }]
    job.settings = normalizeExportSettings({ codec: 'vp9', resolution: 'custom', width: 320, height: 568, fps: 30 })
    const { deps, encoder, rendererOptions, encoderOptions } = makeFakes()
    const decodeAudio = vi.fn(async () => null)
    deps.decodeAudio = decodeAudio

    await runExport(job, { dependencies: deps })

    expect(decodeAudio).not.toHaveBeenCalled()
    expect(rendererOptions[0].preserveAlpha).toBe(true)
    expect(encoderOptions[0].preserveAlpha).toBe(true)
    expect(encoder.concat.mock.calls[0][1]).toBeNull()
  })

  it('flattens alpha to black for MP4 codecs', async () => {
    const controller = new AbortController()
    const job = makeJob(controller.signal)
    job.clips = [{ id: 'still', srcStartMs: 0, srcEndMs: 1000, zoom: 1, videoId: 'img' }]
    job.videos = [{ id: 'img', url: 'blob:png', kind: 'image', durationMs: 1000, mixdown: null }]
    const { deps, rendererOptions, encoderOptions } = makeFakes()

    await runExport(job, { dependencies: deps })

    expect(rendererOptions[0].preserveAlpha).toBe(false)
    expect(encoderOptions[0].preserveAlpha).toBe(false)
  })

  it('retries a failing chunk once, then terminates and disposes on failure', async () => {
    const controller = new AbortController()
    const { deps, renderer, encoder } = makeFakes({
      encodeChunk: () => Promise.reject(new Error('encoder crashed')),
    })
    await expect(runExport(makeJob(controller.signal), { dependencies: deps })).rejects.toMatchObject({
      code: 'UNKNOWN',
    })
    expect(encoder.encodeChunk).toHaveBeenCalledTimes(2)
    expect(encoder.cleanup).not.toHaveBeenCalled()
    expect(encoder.terminate).toHaveBeenCalledTimes(1)
    expect(renderer.dispose).toHaveBeenCalledTimes(1)
  })

  it('cancels promptly, terminates FFmpeg, and disposes the renderer', async () => {
    const controller = new AbortController()
    const { deps, renderer, encoder } = makeFakes()
    renderer.renderFrame.mockImplementationOnce(async () => {
      controller.abort()
      throw new DOMException('Aborted', 'AbortError')
    })

    await expect(runExport(makeJob(controller.signal), { dependencies: deps })).rejects.toBeInstanceOf(
      ExportCancelledError,
    )
    expect(encoder.terminate).toHaveBeenCalledTimes(1)
    expect(encoder.cleanup).not.toHaveBeenCalled()
    expect(renderer.dispose).toHaveBeenCalledTimes(1)
  })

  it('rejects an empty timeline before loading any resources', async () => {
    const controller = new AbortController()
    const { deps, encoder } = makeFakes()
    const job = makeJob(controller.signal)
    job.clips = []
    await expect(runExport(job, { dependencies: deps })).rejects.toMatchObject({ code: 'NO_CLIPS' })
    expect(encoder.writeFrame).not.toHaveBeenCalled()
  })
})
