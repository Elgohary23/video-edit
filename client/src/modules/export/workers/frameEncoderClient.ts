/**
 * Frame image encoder abstraction.
 *
 * Chromium-family browsers compress frames in a module worker (keeping the
 * UI thread responsive). Browsers without OffscreenCanvas/Worker fall back to
 * the exact same conversion on the main thread.
 */
import type { FrameEncodeRequest, FrameEncodeResponse, FrameImageFormat } from './frameEncoderProtocol'
import { encodeCanvasToImage, type CanvasSource } from './canvasToJpeg'

export interface FrameEncoder {
  encode(source: CanvasSource, quality: number): Promise<Uint8Array>
  dispose(): void
}

class LocalFrameEncoder implements FrameEncoder {
  constructor(private readonly format: FrameImageFormat) {}
  encode(source: CanvasSource, quality: number): Promise<Uint8Array> {
    return encodeCanvasToImage(source, quality, this.format)
  }
  dispose(): void {}
}

interface PendingRequest {
  resolve: (value: Uint8Array) => void
  reject: (reason: unknown) => void
}

class WorkerFrameEncoder implements FrameEncoder {
  private readonly worker: Worker
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 1
  private disposed = false
  private failed = false

  constructor(private readonly format: FrameImageFormat) {
    this.worker = new Worker(new URL('./frameEncoder.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (event: MessageEvent<FrameEncodeResponse>) => {
      const { id, buffer, error } = event.data
      const request = this.pending.get(id)
      if (!request) return
      this.pending.delete(id)
      if (error || !buffer) {
        request.reject(new Error(error ?? 'Frame encoder returned no data'))
        return
      }
      request.resolve(new Uint8Array(buffer))
    }
    this.worker.onerror = (event) => {
      this.failed = true
      const error = new Error(event.message || 'Frame encoder worker failed')
      for (const request of this.pending.values()) request.reject(error)
      this.pending.clear()
    }
  }

  async encode(source: CanvasSource, quality: number): Promise<Uint8Array> {
    if (this.disposed || this.failed || typeof createImageBitmap !== 'function') {
      return encodeCanvasToImage(source, quality, this.format)
    }
    let bitmap: ImageBitmap | null = null
    try {
      bitmap = await createImageBitmap(source)
      const id = this.nextId++
      const bytes = await new Promise<Uint8Array>((resolve, reject) => {
        this.pending.set(id, { resolve, reject })
        const request: FrameEncodeRequest = { id, bitmap: bitmap as ImageBitmap, quality, format: this.format }
        this.worker.postMessage(request, [bitmap as ImageBitmap])
      })
      return bytes
    } catch {
      this.failed = true
      if (bitmap) bitmap.close()
      return encodeCanvasToImage(source, quality, this.format)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const request of this.pending.values()) request.reject(new Error('Frame encoder disposed'))
    this.pending.clear()
    this.worker.terminate()
  }
}

function canUseWorker(): boolean {
  return (
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof createImageBitmap === 'function'
  )
}

export function createFrameEncoder(format: FrameImageFormat = 'jpeg'): FrameEncoder {
  if (canUseWorker()) {
    try {
      return new WorkerFrameEncoder(format)
    } catch {
      // Worker construction can be blocked by CSP or older engines.
    }
  }
  return new LocalFrameEncoder(format)
}
