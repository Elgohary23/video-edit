import { describe, expect, it, vi } from 'vitest'
import { runExport } from './exportPipeline'
import { normalizeExportSettings } from '../settings'
import type { ExportDependencies, ExportJob, ExportProgress } from '../types'
import { ExportCancelledError } from '../utils/errors'

function makeJob(signal: AbortSignal): ExportJob {
  return {
    projectName: 'My Project',
    clips: [{ id: 'c1', srcStartMs: 0, srcEndMs: 2000, zoom: 1, videoId: 'v1' }],
    videos: [
      {
        id: 'v1',
        url: 'blob:v1',
        mixdown: { samples: new Float32Array(48_000).fill(0.1), sampleRate: 48_000, durationMs: 1000 },
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
    encodeChunk: vi.fn(async (chunkIndex: number, _frames: number, _audio: Uint8Array | null, _signal: AbortSignal | undefined, onProgress: (ratio: number) => void) => {
      if (overrides.encodeChunk) return overrides.encodeChunk(chunkIndex)
      onProgress(0.5)
      return new Uint8Array([9, 9, 9, 9])
    }),
    concat: vi.fn(async (segments: Uint8Array[]) => new Uint8Array([segments.length])),
    discardChunk: vi.fn(async () => {}),
    cleanup: vi.fn(async () => {}),
    terminate: vi.fn(),
    logs: () => [],
  }
  const deps: ExportDependencies = {
    createRenderer: async () => renderer,
    createEncoder: async () => encoder,
    decodeAudio: async () => null,
    now: () => (clock += 1),
  }
  return { deps, renderer, encoder }
}

describe('runExport', () => {
  it('renders every frame, encodes chunk segments, concatenates, and cleans up', async () => {
    const controller = new AbortController()
    const { deps, renderer, encoder } = makeFakes()
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

    // Decoded audio was fed to the encoder as a WAV payload.
    const audioArg = encoder.encodeChunk.mock.calls[0][2] as Uint8Array | null
    expect(audioArg).toBeInstanceOf(Uint8Array)
    expect(audioArg!.byteLength).toBeGreaterThan(44)

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
    expect(result.blob.size).toBe(1)
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
