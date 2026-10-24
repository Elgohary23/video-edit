/**
 * Offline export orchestrator.
 *
 * High-level flow:
 *   normalize settings → load FFmpeg/media → for each frame chunk:
 *     render frames → mix its audio slice into one global PCM buffer →
 *     encode a standalone video-only segment
 *   → losslessly concatenate segments and mux the PCM track ONCE → return a Blob.
 *
 * Why audio is handled only at the end:
 *   every AAC/Opus encode carries encoder priming/padding. Encoding audio per
 *   chunk and concatenating the streams accumulates that delay, which shows up
 *   as increasing lip-sync drift. One continuous raw PCM track has no priming
 *   and is encoded exactly once by the final mux pass.
 *
 * The renderer and encoder are injected, so this module has no DOM/FFmpeg
 * dependency and can be tested with fakes (including cancellation + cleanup).
 */
import type {
  ExportDependencies,
  ExportHooks,
  ExportJob,
  ExportProgress,
  ExportResult,
  ExportVideoSource,
  FrameRenderer,
  SegmentEncoder,
} from '../types'
import { ExportError, ExportCancelledError, codecSupportMessage, isAbortLike, toExportError } from '../utils/errors'
import { throwIfAborted, withRetry } from '../utils/async'
import { normalizeExportSettings } from '../settings'
import {
  chunkFrameCount,
  exportAudioSampleCount,
  exportDurationMs,
  planAudioPcmChunks,
  planAudioSegments,
  planChunks,
  planClips,
  planPreservesAlpha,
  totalFramesFor,
} from './timelinePlan'
import { computeOverallProgress, createProgressReporter, estimateRemainingMs } from './progress'
import { mixAudioChunk, normalizationGain } from '../audio/mixer'
import { encodePcm16Mono, pcm16ByteLength } from '../audio/pcm'
import { exportFileName, outputMimeType } from '../encoding/args'
import { defaultExportDependencies } from './defaultDependencies'
import { ResourceManager } from '../utils/resourceManager'

export const AUDIO_SAMPLE_RATE = 48_000

/**
 * How many frame files may be in flight at once. Rendering (seek + draw +
 * JPEG/PNG encode) and writing into FFmpeg's MEMFS both cross async worker
 * boundaries, so overlapping a few of them hides that latency without letting
 * raw frames pile up in memory.
 */
const MAX_PENDING_WRITES = 4

export async function runExport(job: ExportJob, hooks: ExportHooks = {}): Promise<ExportResult> {
  const settings = normalizeExportSettings(job.settings)
  const signal = job.signal
  const deps: ExportDependencies = { ...defaultExportDependencies, ...hooks.dependencies }
  const now = deps.now
  const startedAt = now()
  const logs: string[] = []
  const log = (line: string) => {
    const entry = `[export] ${line}`
    logs.push(entry)
    hooks.onLog?.(entry)
  }

  const durationMs = exportDurationMs(job.clips)
  if (!job.clips.length || durationMs <= 0) {
    throw new ExportError('NO_CLIPS', 'The timeline has no playable clips', {
      userMessage: 'Add a clip to the timeline before exporting.',
    })
  }

  const totalFrames = totalFramesFor(durationMs, settings.fps)
  if (totalFrames <= 0) {
    throw new ExportError('INVALID_SETTINGS', 'Export frame count resolved to zero', {
      userMessage: 'The export frame rate is invalid. Choose a different frame rate.',
    })
  }
  const chunks = planChunks(totalFrames, settings.fps, chunkFrameCount(settings.width, settings.height, settings.fps))
  const pcmChunks = planAudioPcmChunks(chunks, settings.fps, AUDIO_SAMPLE_RATE)
  const totalAudioSamples = exportAudioSampleCount(totalFrames, settings.fps, AUDIO_SAMPLE_RATE)

  // Alpha depends only on the clip/source plan, so it can be decided before
  // the (async) renderer/encoder start. VP9/WebM is the only container we write
  // that can carry an alpha channel; MP4 codecs flatten transparency to black.
  const initialPlan = planClips(job.clips, job.videos, job.activeVideoId)
  const preserveAlpha = planPreservesAlpha(initialPlan, job.videos, settings.codec)

  const reporter = createProgressReporter((progress) => hooks.onProgress?.(progress), 100, now)

  let stage: ExportProgress['stage'] = 'initializing'
  let detail = 'Preparing export…'
  let assetFraction = 0
  let chunkRenderFraction = 0
  let chunkEncodeFraction = 0
  let finalizeFraction = 0
  let framesRendered = 0
  let chunksCompleted = 0
  let renderStartedAt: number | null = null
  const encodeDurations: number[] = []
  let encodingSpeed: number | null = null

  const report = (force = false) => {
    const progress = computeOverallProgress({
      stage,
      chunksCompleted,
      totalChunks: chunks.length,
      chunkRenderFraction,
      chunkEncodeFraction,
      assetFraction,
      finalizeFraction,
    })
    const elapsedMs = Math.max(0, now() - startedAt)
    const renderFps =
      renderStartedAt !== null && framesRendered > 0
        ? framesRendered / Math.max(0.001, (now() - renderStartedAt) / 1000)
        : null
    const averageEncodeMs =
      encodeDurations.length > 0 ? encodeDurations.reduce((sum, value) => sum + value, 0) / encodeDurations.length : null
    const etaMs = estimateRemainingMs({
      progress,
      elapsedMs,
      renderFps,
      remainingFrames: Math.max(0, totalFrames - framesRendered),
      averageEncodeMs,
      remainingChunks: Math.max(0, chunks.length - chunksCompleted),
    })
    reporter.report(
      {
        stage,
        detail,
        progress,
        frame: framesRendered,
        totalFrames,
        etaMs,
        renderFps,
        encodingSpeed,
      },
      force,
    )
  }

  log(
    `settings ${settings.codec} ${settings.width}x${settings.height}@${settings.fps}, ` +
      `${totalFrames} frames in ${chunks.length} chunk(s)` +
      (preserveAlpha ? ', alpha PNG → yuva420p' : ''),
  )

  let renderer: FrameRenderer | null = null
  let encoder: SegmentEncoder | null = null
  let succeeded = false
  let encoderTerminated = false
  let abortListener: (() => void) | null = null

  // Single disposal path for every resource the job acquires. Runs on
  // success, failure, and cancellation alike (see the finally block).
  const resources = new ResourceManager()

  // Idempotent: abort listeners and the finally block may both fire, and a
  // double terminate would confuse a session that already reset its worker.
  const terminateEncoder = () => {
    if (encoderTerminated) return
    encoderTerminated = true
    try {
      encoder?.terminate()
    } catch {
      // already gone
    }
  }

  const attachAbort = () => {
    if (!encoder || !signal) return
    abortListener = terminateEncoder
    signal.addEventListener('abort', abortListener, { once: true })
    if (signal.aborted) abortListener()
  }

  try {
    report(true)
    stage = 'loading-assets'
    detail = 'Loading FFmpeg and media assets…'
    report(true)

    const audioPromise = resolveAudioSources(job, deps, signal)
    const encoderPromise = deps.createEncoder(settings, { signal, onLog: log, preserveAlpha })
    const rendererPromise = deps.createRenderer(job, settings, {
      signal,
      preserveAlpha,
      onAssetProgress: (ratio) => {
        assetFraction = Math.max(assetFraction, clamp01(ratio))
        report(true)
      },
    })

    const [audioResult, encoderResult, rendererResult] = await Promise.allSettled([
      audioPromise,
      encoderPromise,
      rendererPromise,
    ])
    // Register renderer before encoder so LIFO disposal releases FFmpeg
    // first (flush/cleanup or terminate), then the video elements + worker.
    if (rendererResult.status === 'fulfilled') {
      const instance = rendererResult.value
      renderer = instance
      resources.add('frame renderer', () => instance.dispose())
    }
    if (encoderResult.status === 'fulfilled') {
      const instance = encoderResult.value
      encoder = instance
      resources.add('ffmpeg encoder', () => (succeeded ? instance.cleanup() : terminateEncoder()))
    }
    attachAbort()

    const rejection = [audioResult, encoderResult, rendererResult].find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (rejection) throw rejection.reason
    if (!renderer || !encoder || audioResult.status !== 'fulfilled') {
      throw new ExportError('UNKNOWN', 'Export dependency initialization failed')
    }
    throwIfAborted(signal, () => new ExportCancelledError(collectLogs(logs, encoder)))

    const sources = audioResult.value
    const planned = planClips(job.clips, sources, job.activeVideoId)
    const audioSegments = planAudioSegments(planned, sources)
    const hasAudio = audioSegments.length > 0
    const mixdowns = [...new Set(audioSegments.map((segment) => segment.source))]
    const gain = normalizationGain(mixdowns)
    // One precisely sized mono PCM track for the whole export. Chunks fill it
    // at absolute sample offsets, so no boundary rounding can accumulate.
    const audioPcm = hasAudio ? new Uint8Array(pcm16ByteLength(totalAudioSamples)) : null
    log(
      hasAudio
        ? `audio ${audioSegments.length} segment(s), ${totalAudioSamples} samples @ ${AUDIO_SAMPLE_RATE}Hz (one PCM track)`
        : 'audio silent',
    )

    const segments: Uint8Array[] = []
    renderStartedAt = now()

    for (const chunk of chunks) {
      throwIfAborted(signal, () => new ExportCancelledError(collectLogs(logs, encoder)))
      const localFrames = chunk.endFrame - chunk.startFrame
      stage = 'rendering'
      detail = `Rendering frames ${chunk.startFrame + 1}–${chunk.endFrame}`
      chunkRenderFraction = 0
      report(true)

      try {
        const renderStarted = now()
        const pendingWrites: Promise<void>[] = []
        // Failures are re-thrown when the queue is awaited; attaching a catch
        // here only prevents an unhandled rejection while a write is queued.
        const enqueueWrite = (write: Promise<void>) => {
          write.catch(() => {})
          pendingWrites.push(write)
        }

        for (let frame = chunk.startFrame; frame < chunk.endFrame; frame++) {
          throwIfAborted(signal, () => new ExportCancelledError(collectLogs(logs, encoder)))
          const timelineMs = (frame / settings.fps) * 1000
          const bytes = await renderer.renderFrame(frame, timelineMs, signal)
          enqueueWrite(encoder.writeFrame(chunk.index, frame - chunk.startFrame, bytes))
          framesRendered++
          chunkRenderFraction = (frame - chunk.startFrame + 1) / localFrames
          report()
          if (pendingWrites.length >= MAX_PENDING_WRITES) {
            await pendingWrites.shift()
          }
        }
        while (pendingWrites.length > 0) await pendingWrites.shift()
        const renderMs = Math.max(0, now() - renderStarted)

        let audioMixMs = 0
        if (hasAudio && audioPcm) {
          stage = 'audio'
          detail = `Mixing audio · chunk ${chunk.index + 1} / ${chunks.length}`
          report(true)
          const pcmChunk = pcmChunks[chunk.index]
          const mixStarted = now()
          const mixed = mixAudioChunk(audioSegments, chunk.startMs, chunk.endMs, {
            targetSampleRate: AUDIO_SAMPLE_RATE,
            channels: 1,
            gain,
            startSample: pcmChunk.startSample,
            lengthSamples: pcmChunk.sampleCount,
          })
          encodePcm16Mono(mixed.channels[0], audioPcm, pcmChunk.startByte)
          audioMixMs = Math.max(0, now() - mixStarted)
        }

        stage = 'encoding'
        detail = `Encoding chunk ${chunk.index + 1} / ${chunks.length}`
        chunkEncodeFraction = 0
        report(true)
        const encodingStartedAt = now()
        const segment = await withRetry(
          () =>
            encoder!.encodeChunk(chunk.index, localFrames, signal, (ratio) => {
              chunkEncodeFraction = clamp01(ratio)
              report()
            }),
          {
            retries: 1,
            signal,
            onRetry: (error, attempt) => {
              log(`chunk ${chunk.index + 1} retry ${attempt}: ${error instanceof Error ? error.message : String(error)}`)
              detail = `Retrying chunk ${chunk.index + 1} / ${chunks.length}`
              report(true)
            },
          },
        )
        const encodeMs = Math.max(0, now() - encodingStartedAt)
        encodeDurations.push(encodeMs)
        const chunkDurationSeconds = localFrames / settings.fps
        encodingSpeed = encodeMs > 0 ? chunkDurationSeconds / (encodeMs / 1000) : null
        segments.push(segment)
        chunksCompleted++
        chunkRenderFraction = 1
        chunkEncodeFraction = 1
        const heapMb = currentHeapMb()
        log(
          `chunk ${chunk.index + 1}/${chunks.length} · render ${(renderMs / 1000).toFixed(1)}s ` +
            `(${localFrames}f) · audio ${(audioMixMs / 1000).toFixed(2)}s · ` +
            `encode ${(encodeMs / 1000).toFixed(1)}s ` +
            `(${Math.round(segment.byteLength / 1024)} KB${heapMb !== null ? `, heap ${heapMb} MB` : ''})`,
        )
        report(true)
      } finally {
        try {
          await encoder.discardChunk(chunk.index, localFrames)
        } catch (error) {
          log(`chunk ${chunk.index + 1} cleanup warning: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    throwIfAborted(signal, () => new ExportCancelledError(collectLogs(logs, encoder)))
    stage = 'finalizing'
    detail = `Joining ${segments.length} encoded segment(s) and muxing audio…`
    finalizeFraction = 0
    report(true)
    const finalizeStarted = now()
    const output = await encoder.concat(segments, audioPcm, signal, (ratio) => {
      finalizeFraction = clamp01(ratio)
      report()
    })
    const finalizeMs = Math.max(0, now() - finalizeStarted)
    segments.length = 0
    log(`final mux ${(finalizeMs / 1000).toFixed(1)}s${hasAudio ? ' (video copy + one AAC/Opus pass)' : ''}`)

    const blob = new Blob([output as unknown as BlobPart], { type: outputMimeType(settings.codec) })
    const result: ExportResult = {
      blob,
      filename: exportFileName(job.projectName, settings.codec),
      mimeType: outputMimeType(settings.codec),
      // Match what was actually encoded on the frame grid.
      durationMs: (totalFrames / settings.fps) * 1000,
      totalFrames,
      logs: collectLogs(logs, encoder),
    }
    succeeded = true
    stage = 'done'
    detail = 'Export complete'
    report(true)
    log(`done in ${Math.round((now() - startedAt) / 1000)}s`)
    return result
  } catch (error) {
    if (signal?.aborted || isAbortLike(error)) {
      throw new ExportCancelledError(collectLogs(logs, encoder))
    }
    const supportMessage = codecSupportMessage(collectLogs(logs, encoder))
    if (supportMessage) {
      throw new ExportError('CODEC_UNSUPPORTED', supportMessage, {
        userMessage: supportMessage,
        logs: collectLogs(logs, encoder),
      })
    }
    throw toExportError(error, collectLogs(logs, encoder))
  } finally {
    if (abortListener && signal) signal.removeEventListener('abort', abortListener)
    // Cancellation/failure terminates the wasm worker immediately (MEMFS dies
    // with it); success flushes MEMFS through per-file cleanup. Either way the
    // ResourceManager owns the release so nothing leaks on any exit path.
    await resources.disposeAll()
  }
}

async function resolveAudioSources(
  job: ExportJob,
  deps: ExportDependencies,
  signal?: AbortSignal,
): Promise<ExportVideoSource[]> {
  const resolved: ExportVideoSource[] = []
  for (const source of job.videos) {
    throwIfAborted(signal)
    // Stills never contribute audio; skip the fetch/decode entirely.
    if (source.kind === 'image') {
      resolved.push({ ...source, mixdown: null })
      continue
    }
    if (source.mixdown) {
      resolved.push(source)
      continue
    }
    const mixdown = await deps.decodeAudio(source.url, signal)
    resolved.push({ ...source, mixdown })
  }
  return resolved
}

function collectLogs(pipelineLogs: string[], encoder: SegmentEncoder | null): string[] {
  const encoderLogs = encoder?.logs() ?? []
  const combined = [...pipelineLogs, ...encoderLogs]
  return combined.length > 320 ? combined.slice(combined.length - 320) : combined
}

/** Telemetry hook: report the JS heap when the browser exposes it (Chromium). */
function currentHeapMb(): number | null {
  if (typeof performance === 'undefined') return null
  const perf = performance as Performance & { memory?: { usedJSHeapSize?: number } }
  const bytes = perf.memory?.usedJSHeapSize
  return typeof bytes === 'number' ? Math.round(bytes / 1_048_576) : null
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
}
