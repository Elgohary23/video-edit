/**
 * Dedicated worker: JPEG compression is the only frame step that can safely
 * leave the UI thread (video seeking/drawing must stay on the main thread
 * because HTMLVideoElement is not transferable).
 */
import { encodeBitmapToJpeg } from './frameEncodeCore'
import type { FrameEncodeRequest, FrameEncodeResponse } from './frameEncoderProtocol'

interface WorkerScope {
  onmessage: ((event: MessageEvent<FrameEncodeRequest>) => void) | null
  postMessage: (message: FrameEncodeResponse, transfer?: Transferable[]) => void
}

const scope = self as unknown as WorkerScope

scope.onmessage = (event) => {
  const { id, bitmap, quality } = event.data
  void encodeBitmapToJpeg(bitmap, quality)
    .then((bytes) => {
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      scope.postMessage({ id, buffer }, [buffer])
    })
    .catch((error: unknown) => {
      scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
    })
    .finally(() => bitmap.close())
}
