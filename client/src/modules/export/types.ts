/**
 * Public contracts for the offline export pipeline.
 *
 * The editor only depends on these interfaces, never on FFmpeg, canvas, or
 * DOM details. Concrete engines are injected through `ExportDependencies`
 * (dependency inversion), which keeps the orchestrator deterministic and
 * unit-testable without a browser.
 */
import type { Clip } from '../timeline/engine'
import type { MotionPresetName } from '../motion/engine'
import type { NormalizedRect } from '../props/engine'
import type { MediaKind } from '../media/engine'

export type ExportQuality = 'draft' | 'standard' | 'high' | 'ultra'
export type ExportResolution = '720p' | '1080p' | '1440p' | '4k' | 'custom'
export type ExportCodec = 'h264' | 'h265' | 'vp9'

/** Detailed pipeline stages surfaced in the export dialog. */
export type ExportStage =
  | 'idle'
  | 'initializing'
  | 'loading-assets'
  | 'rendering'
  | 'audio'
  | 'encoding'
  | 'finalizing'
  | 'done'
  | 'cancelled'
  | 'error'

export interface ExportSettings {
  quality: ExportQuality
  resolution: ExportResolution
  width: number
  height: number
  fps: number
  /** null = automatic (CRF based on quality). */
  bitrate: number | null
  codec: ExportCodec
  audioBitrate: number
}

/** Decoded mono audio for one imported source. */
export interface ExportAudioMixdown {
  samples: Float32Array
  sampleRate: number
  durationMs: number
}

export interface ExportVideoSource {
  id: string
  url: string
  /** Images are static: no decoding/seeking, no audio track. */
  kind?: MediaKind
  /** Nominal length of an image asset (video length comes from the file). */
  durationMs?: number
  /** Available once the import's analysis finished. */
  mixdown: ExportAudioMixdown | null
}

export interface ExportProp {
  id: string
  /** Object/data URL of the overlay image. */
  src: string
  rect: NormalizedRect
  range: { startMs: number; endMs: number }
  preset: MotionPresetName
}

/** Immutable snapshot handed to the pipeline at export start. */
export interface ExportJob {
  projectName: string
  clips: Clip[]
  videos: ExportVideoSource[]
  activeVideoId: string | null
  props: ExportProp[]
  blur: { enabled: boolean; px: number }
  fitMode: 'contain' | 'cover'
  settings: ExportSettings
  signal?: AbortSignal
}

export interface ExportProgress {
  stage: ExportStage
  detail: string
  /** Overall completion 0..1. */
  progress: number
  frame: number
  totalFrames: number
  etaMs: number | null
  /** Frames rasterized per wall-clock second. */
  renderFps: number | null
  /** Encoded output seconds per wall-clock second. */
  encodingSpeed: number | null
}

export interface ExportResult {
  blob: Blob
  filename: string
  mimeType: string
  durationMs: number
  totalFrames: number
  logs: string[]
}

/** One independently encoded chunk that can be concatenated losslessly. */
export interface RenderChunk {
  index: number
  startFrame: number
  endFrame: number
  /** Timeline window covered by the chunk (end exclusive). */
  startMs: number
  endMs: number
}

export interface PlannedClip {
  clip: Clip
  sourceId: string | null
  /** Timeline start of this clip (sum of preceding spans). */
  startMs: number
  endMs: number
}

/**
 * Frame rasterizer. Implementations own their offscreen surface, video
 * elements, and prop images; none of them touch the preview canvas.
 */
export interface FrameRenderer {
  readonly width: number
  readonly height: number
  renderFrame(frameIndex: number, timelineMs: number, signal?: AbortSignal): Promise<Uint8Array>
  dispose(): void
}

/**
 * Chunk encoder. The concrete implementation owns FFmpeg and its virtual
 * filesystem; the pipeline only sees bytes and lifecycle calls.
 */
export interface SegmentEncoder {
  writeFrame(chunkIndex: number, localFrameIndex: number, data: Uint8Array): Promise<void>
  /**
   * Video-only chunk encode. Audio is deliberately NOT encoded per chunk:
   * every AAC/Opus stream carries encoder priming, so concatenating them
   * accumulates drift. The full PCM track is muxed once in `concat`.
   */
  encodeChunk(
    chunkIndex: number,
    frameCount: number,
    signal: AbortSignal | undefined,
    onProgress: (ratio: number) => void,
  ): Promise<Uint8Array>
  concat(
    segments: Uint8Array[],
    audioPcm: Uint8Array | null,
    signal?: AbortSignal,
    onProgress?: (ratio: number) => void,
  ): Promise<Uint8Array>
  discardChunk(chunkIndex: number, frameCount: number): Promise<void>
  cleanup(): Promise<void>
  terminate(): void
  logs(): string[]
}

export interface ExportDependencies {
  createRenderer: (
    job: ExportJob,
    settings: ExportSettings,
    options: { signal?: AbortSignal; onAssetProgress?: (ratio: number) => void; preserveAlpha?: boolean },
  ) => Promise<FrameRenderer>
  createEncoder: (
    settings: ExportSettings,
    options: { signal?: AbortSignal; onLog?: (line: string) => void; preserveAlpha?: boolean },
  ) => Promise<SegmentEncoder>
  /** Decode a source's audio when analysis has not finished yet. */
  decodeAudio: (url: string, signal?: AbortSignal) => Promise<ExportAudioMixdown | null>
  now: () => number
}

export interface ExportHooks {
  onProgress?: (progress: ExportProgress) => void
  onLog?: (line: string) => void
  dependencies?: Partial<ExportDependencies>
}

/** True while a pipeline owns resources (used to lock the editor UI). */
export function isExportBusy(status: { stage?: ExportStage; phase?: 'recording' | 'transcoding' | null }): boolean {
  if (status.stage !== undefined) {
    return (
      status.stage === 'initializing' ||
      status.stage === 'loading-assets' ||
      status.stage === 'rendering' ||
      status.stage === 'audio' ||
      status.stage === 'encoding' ||
      status.stage === 'finalizing'
    )
  }
  return status.phase !== null && status.phase !== undefined
}
