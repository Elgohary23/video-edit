/**
 * Dedicated export video elements.
 *
 * One muted <video> per source, detached from the preview element and never
 * used for playback. Every seek is bounded by an abort signal + timeout and
 * verified against `readyState`, so a missing `seeked` event can never hang
 * an export forever.
 */
import type { ExportVideoSource } from '../types'
import { ExportError } from '../utils/errors'

const CONTAINER_ID = 'export-video-pool'
const METADATA_TIMEOUT_MS = 20_000
const SEEK_TIMEOUT_MS = 8_000
const SEEK_TOLERANCE_MS = 4

interface ElementEntry {
  element: HTMLVideoElement
  ready: Promise<void>
}

export class VideoPool {
  private readonly sources = new Map<string, ExportVideoSource>()
  private readonly elements = new Map<string, ElementEntry>()
  private container: HTMLDivElement | null = null
  private disposed = false

  constructor(sources: ExportVideoSource[]) {
    for (const source of sources) this.sources.set(source.id, source)
  }

  async preloadAll(signal?: AbortSignal, onProgress?: (ratio: number) => void): Promise<void> {
    const list = [...this.sources.values()]
    if (list.length === 0) return
    let loaded = 0
    await Promise.all(
      list.map(async (source) => {
        await this.ensure(source.id, signal)
        loaded++
        onProgress?.(loaded / list.length)
      }),
    )
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  }

  async seek(videoId: string, timeMs: number, signal?: AbortSignal): Promise<HTMLVideoElement> {
    const video = await this.ensure(videoId, signal)
    const durationMs = Number.isFinite(video.duration) ? video.duration * 1000 : Number.POSITIVE_INFINITY
    const targetMs = Math.max(0, Math.min(Number.isFinite(durationMs) ? durationMs - 1 : timeMs, timeMs))
    if (!video.seeking && video.readyState >= 2 && Math.abs(video.currentTime * 1000 - targetMs) <= SEEK_TOLERANCE_MS) {
      return video
    }

    let lastError: unknown = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.seekOnce(video, targetMs / 1000, signal, SEEK_TIMEOUT_MS + attempt * 4_000)
        return video
      } catch (error) {
        lastError = error
        if (signal?.aborted) throw error
      }
    }

    // Fallback recovery: use the nearest decoded frame when the browser
    // refuses to report an exact seek. This keeps long exports moving instead
    // of failing on a single flaky seek.
    if (video.readyState >= 2) {
      console.warn(
        `[export] seek fallback for ${videoId} at ${targetMs.toFixed(1)}ms (at ${(video.currentTime * 1000).toFixed(1)}ms)`,
      )
      return video
    }
    throw new ExportError('SEEK_TIMEOUT', `Video seek timed out for source ${videoId} at ${targetMs.toFixed(1)}ms`, {
      userMessage: 'Export stopped because the browser could not decode a video frame. Try a lower export resolution.',
      cause: lastError,
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const { element } of this.elements.values()) {
      try {
        element.pause()
        element.removeAttribute('src')
        element.load()
        element.remove()
      } catch {
        // Best-effort decoder release.
      }
    }
    this.elements.clear()
    this.container?.remove()
    this.container = null
  }

  private async ensure(videoId: string, signal?: AbortSignal): Promise<HTMLVideoElement> {
    if (this.disposed) throw new Error('Video pool disposed')
    const source = this.sources.get(videoId)
    if (!source) {
      throw new ExportError('ASSET_LOAD_FAILED', `Unknown export source ${videoId}`, {
        userMessage: 'A clip references media that is no longer available.',
      })
    }
    let entry = this.elements.get(videoId)
    if (!entry) {
      const element = document.createElement('video')
      element.muted = true
      element.defaultMuted = true
      element.playsInline = true
      element.preload = 'auto'
      element.setAttribute('aria-hidden', 'true')
      element.style.cssText =
        'position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;'
      this.ensureContainer().appendChild(element)
      const ready = this.waitForMetadata(element, signal)
      element.src = source.url
      element.load()
      entry = { element, ready }
      this.elements.set(videoId, entry)
    }
    await entry.ready
    return entry.element
  }

  private ensureContainer(): HTMLDivElement {
    if (this.container) return this.container
    const existing = document.getElementById(CONTAINER_ID)
    if (existing instanceof HTMLDivElement) {
      this.container = existing
      return existing
    }
    const container = document.createElement('div')
    container.id = CONTAINER_ID
    container.setAttribute('aria-hidden', 'true')
    container.style.cssText =
      'position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none;'
    document.body.appendChild(container)
    this.container = container
    return container
  }

  private waitForMetadata(video: HTMLVideoElement, signal?: AbortSignal): Promise<void> {
    if (video.readyState >= 1) return Promise.resolve()
    return new Promise((resolve, reject) => {
      let timer: number | null = null
      const cleanup = () => {
        video.removeEventListener('loadedmetadata', onLoaded)
        video.removeEventListener('error', onError)
        signal?.removeEventListener('abort', onAbort)
        if (timer !== null) window.clearTimeout(timer)
      }
      const onLoaded = () => {
        cleanup()
        resolve()
      }
      const onError = () => {
        cleanup()
        reject(
          new ExportError('ASSET_LOAD_FAILED', `Could not decode video ${video.src}`, {
            userMessage: 'Could not load a video for export. Re-import the file and try again.',
          }),
        )
      }
      const onAbort = () => {
        cleanup()
        reject(new DOMException('Aborted', 'AbortError'))
      }
      video.addEventListener('loadedmetadata', onLoaded, { once: true })
      video.addEventListener('error', onError, { once: true })
      signal?.addEventListener('abort', onAbort, { once: true })
      timer = window.setTimeout(() => {
        cleanup()
        reject(
          new ExportError('TIMEOUT', 'Timed out waiting for video metadata', {
            userMessage: 'Export timed out while loading video metadata.',
          }),
        )
      }, METADATA_TIMEOUT_MS)
    })
  }

  private seekOnce(
    video: HTMLVideoElement,
    targetSeconds: number,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: number | null = null
      const cleanup = () => {
        video.removeEventListener('seeked', onSeeked)
        video.removeEventListener('error', onError)
        signal?.removeEventListener('abort', onAbort)
        if (timer !== null) window.clearTimeout(timer)
      }
      const onSeeked = () => {
        cleanup()
        if (video.readyState < 2) {
          reject(new Error('Seek completed without decoded frame data'))
          return
        }
        if (Math.abs(video.currentTime - targetSeconds) * 1000 > 250) {
          reject(new Error('Seek landed outside the requested frame window'))
          return
        }
        resolve()
      }
      const onError = () => {
        cleanup()
        reject(new Error('Video element reported an error while seeking'))
      }
      const onAbort = () => {
        cleanup()
        reject(new DOMException('Aborted', 'AbortError'))
      }
      video.addEventListener('seeked', onSeeked, { once: true })
      video.addEventListener('error', onError, { once: true })
      signal?.addEventListener('abort', onAbort, { once: true })
      timer = window.setTimeout(() => {
        cleanup()
        reject(new Error(`Seek timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      try {
        video.currentTime = targetSeconds
      } catch (error) {
        cleanup()
        reject(error)
      }
    })
  }
}
