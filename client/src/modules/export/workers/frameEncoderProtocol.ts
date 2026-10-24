/** Messages exchanged with the off-main-thread frame encoder. */
export type FrameImageFormat = 'jpeg' | 'png'

export interface FrameEncodeRequest {
  id: number
  bitmap: ImageBitmap
  quality: number
  format: FrameImageFormat
}

export interface FrameEncodeResponse {
  id: number
  buffer?: ArrayBuffer
  error?: string
}
