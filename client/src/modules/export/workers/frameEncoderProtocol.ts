/** Messages exchanged with the off-main-thread JPEG encoder. */
export interface FrameEncodeRequest {
  id: number
  bitmap: ImageBitmap
  quality: number
}

export interface FrameEncodeResponse {
  id: number
  buffer?: ArrayBuffer
  error?: string
}
