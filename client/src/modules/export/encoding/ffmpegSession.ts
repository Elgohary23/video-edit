/**
 * FFmpeg lifecycle adapter.
 *
 * Owns a single cached instance, logs, progress subscriptions, abort
 * handling, and virtual-filesystem cleanup. Terminating the session also
 * drops the module cache so the next export starts from a clean worker.
 */
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { toBlobURL } from '@ffmpeg/util'
import { ExportError } from '../utils/errors'
import type { FileLedger } from './fileLedger'

/**
 * FFmpeg core location.
 *
 * Must be the ESM build: @ffmpeg/ffmpeg ≥0.12.15 always spawns a *module*
 * worker, and that worker dynamically imports the core (`import()`), so the
 * core has to expose an ESM default export. The UMD build exports nothing as
 * a module, which surfaces as "failed to import ffmpeg-core.js".
 */
export const CORE_BASE_URL = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm'

export interface FfmpegLogEvent {
  type: string
  message: string
}

export interface FfmpegProgressEvent {
  progress: number
  time: number
}

export interface FfmpegLike {
  loaded?: boolean
  load: (config: { coreURL?: string; wasmURL?: string }, options?: { signal?: AbortSignal }) => Promise<unknown>
  writeFile: (name: string, data: Uint8Array | string, options?: { signal?: AbortSignal }) => Promise<unknown>
  readFile: (name: string, options?: { signal?: AbortSignal }) => Promise<Uint8Array | string>
  deleteFile: (name: string, options?: { signal?: AbortSignal }) => Promise<unknown>
  exec: (args: string[], timeout?: number, options?: { signal?: AbortSignal }) => Promise<number>
  on: {
    (event: 'log', callback: (event: FfmpegLogEvent) => void): void
    (event: 'progress', callback: (event: FfmpegProgressEvent) => void): void
  }
  off: {
    (event: 'log', callback: (event: FfmpegLogEvent) => void): void
    (event: 'progress', callback: (event: FfmpegProgressEvent) => void): void
  }
  terminate: () => void
}

export interface FfmpegSessionOptions {
  loader?: (options: { baseUrl: string }) => Promise<{ coreURL: string; wasmURL: string }>
  baseUrl?: string
  ctor?: () => FFmpeg
}

let loadPromise: Promise<FFmpeg> | null = null
let sessionPromise: Promise<FFmpegSession> | null = null

/**
 * Load (and cache) a single FFmpeg.wasm instance.
 * `loader`/`ctor` are injectable for tests — @ffmpeg/ffmpeg cannot be
 * *constructed* under vitest (it hard-rejects node environments at import).
 */
export function loadFfmpeg(
  loader: FfmpegSessionOptions['loader'] = async ({ baseUrl }) => {
    const [coreURL, wasmURL] = await Promise.all([
      toBlobURL(`${baseUrl}/ffmpeg-core.js`, 'text/javascript'),
      toBlobURL(`${baseUrl}/ffmpeg-core.wasm`, 'application/wasm'),
    ])
    return { coreURL, wasmURL }
  },
  baseUrl = CORE_BASE_URL,
  ctor: () => FFmpeg = () => new FFmpeg(),
): Promise<FFmpeg> {
  if (!loadPromise) {
    const pending = (async () => {
      const ffmpeg = ctor()
      try {
        const { coreURL, wasmURL } = await loader({ baseUrl })
        await ffmpeg.load({ coreURL, wasmURL })
        return ffmpeg
      } catch (error) {
        // A failed load must not leak the worker that `ctor` just spawned.
        try {
          ffmpeg.terminate()
        } catch {
          // already gone
        }
        throw error
      }
    })()
    loadPromise = pending
    pending.catch(() => {
      // A failed core download must not poison the cache forever.
      if (loadPromise === pending) loadPromise = null
    })
  }
  return loadPromise
}

/** Test hook / cancellation hook: drop the cached instance. */
export function resetFfmpegCache(): void {
  loadPromise = null
  sessionPromise = null
}

export async function loadFFmpegSession(options: FfmpegSessionOptions = {}): Promise<FFmpegSession> {
  if (sessionPromise) {
    const existing = await sessionPromise
    if (!existing.terminated) return existing
    sessionPromise = null
  }
  const pending = loadFfmpeg(options.loader, options.baseUrl, options.ctor).then((ffmpeg) => {
    const session = new FFmpegSession(ffmpeg as unknown as FfmpegLike)
    session.onTerminate(resetFfmpegCache)
    return session
  })
  sessionPromise = pending
  pending.catch(() => {
    if (sessionPromise === pending) sessionPromise = null
  })
  return pending
}

export interface ExecOptions {
  signal?: AbortSignal
  timeout?: number
  onProgress?: (event: FfmpegProgressEvent) => void
}

export class FFmpegSession {
  readonly ffmpeg: FfmpegLike
  terminated = false
  private readonly logs: string[] = []
  private readonly maxLogs = 300
  private terminateCallback: (() => void) | null = null
  private readonly logListener: (event: FfmpegLogEvent) => void

  constructor(ffmpeg: FfmpegLike) {
    this.ffmpeg = ffmpeg
    this.logListener = ({ type, message }) => {
      this.logs.push(`${type}: ${message}`)
      if (this.logs.length > this.maxLogs) this.logs.splice(0, this.logs.length - this.maxLogs)
    }
    try {
      ffmpeg.on('log', this.logListener)
    } catch {
      // Minimal test doubles may not implement the event API.
    }
  }

  onTerminate(callback: () => void): void {
    this.terminateCallback = callback
  }

  clearLogs(): void {
    this.logs.length = 0
  }

  getLogs(): string[] {
    return [...this.logs]
  }

  async writeFile(name: string, data: Uint8Array | string, ledger?: FileLedger): Promise<void> {
    ledger?.track(name)
    await this.ffmpeg.writeFile(name, data)
  }

  async readFile(name: string): Promise<Uint8Array> {
    const data = await this.ffmpeg.readFile(name)
    if (typeof data === 'string') return new TextEncoder().encode(data)
    // Copy into a fresh buffer: FFmpeg transfers the original ArrayBuffer
    // when it crosses the worker boundary, and callers may retain the bytes.
    return new Uint8Array(data)
  }

  async deleteFile(name: string, ledger?: FileLedger): Promise<void> {
    try {
      await this.ffmpeg.deleteFile(name)
    } catch {
      // Missing files are already "clean"; cleanup is best-effort.
    } finally {
      ledger?.untrack(name)
    }
  }

  async exec(args: string[], options: ExecOptions = {}): Promise<number> {
    const listener = options.onProgress
    if (listener) this.ffmpeg.on('progress', listener)
    try {
      return await this.ffmpeg.exec(args, options.timeout ?? -1, { signal: options.signal })
    } finally {
      if (listener) {
        try {
          this.ffmpeg.off('progress', listener)
        } catch {
          // ignore minimal doubles
        }
      }
    }
  }

  /** Best-effort removal of every tracked virtual file. */
  async cleanup(ledger: FileLedger): Promise<void> {
    const names = ledger.all()
    // Bound the in-flight worker messages while still avoiding one round-trip
    // per file (which is measurable after thousands of frame files).
    for (let index = 0; index < names.length; index += 32) {
      await Promise.all(names.slice(index, index + 32).map((name) => this.deleteFile(name, ledger)))
    }
    ledger.clear()
  }

  terminate(): void {
    if (this.terminated) return
    this.terminated = true
    try {
      this.ffmpeg.terminate()
    } catch {
      // Worker may already be gone.
    }
    try {
      this.ffmpeg.off('log', this.logListener)
    } catch {
      // ignore
    }
    this.terminateCallback?.()
  }

  /** Non-zero FFmpeg exits become actionable errors with captured logs. */
  assertExit(exitCode: number, stage: string): void {
    if (exitCode === 0) return
    throw new ExportError('FFMPEG_EXEC_FAILED', `${stage} failed with FFmpeg exit code ${exitCode}`, {
      userMessage: `Export failed while ${stage.toLowerCase()}. See the browser console for details.`,
      logs: this.getLogs(),
    })
  }
}
