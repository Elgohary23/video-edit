/**
 * Deterministic timeline evaluation for export.
 *
 * Frame N always maps to `N / fps * 1000` on the timeline. Chunk boundaries
 * are derived from the same integer frame grid so audio, video, and segment
 * durations never drift by partial frames.
 */
import { timelineDurationMs, timelineToSource, type Clip } from '../../timeline/engine'
import type { ExportAudioMixdown, ExportCodec, ExportVideoSource, PlannedClip, RenderChunk } from '../types'
import { sampleAtFrame, sampleCountForFrames } from '../audio/pcm'

export interface SourceRef {
  id: string
}

/**
 * Mirrors the editor's legacy-clip rule: clips without `videoId` follow the
 * active source, dangling ids fall back to it as well.
 */
export function resolveClipSourceId(
  clip: Clip,
  sources: readonly SourceRef[],
  activeVideoId: string | null,
): string | null {
  if (clip.videoId !== undefined) {
    return sources.some((source) => source.id === clip.videoId) ? clip.videoId : activeVideoId
  }
  return activeVideoId
}

/** Lay clips out end-to-end and resolve their source ids once. */
export function planClips(
  clips: Clip[],
  sources: readonly SourceRef[],
  activeVideoId: string | null,
): PlannedClip[] {
  const planned: PlannedClip[] = []
  let cursor = 0
  for (const clip of clips) {
    const span = Math.max(0, clip.srcEndMs - clip.srcStartMs)
    // Empty windows cannot contribute a frame; skipping them also keeps the
    // binary-search assumption "sorted, non-empty spans" true.
    if (span <= 0) continue
    planned.push({
      clip,
      sourceId: resolveClipSourceId(clip, sources, activeVideoId),
      startMs: cursor,
      endMs: cursor + span,
    })
    cursor += span
  }
  return planned
}

/** Total output frames, rounded up so the last partial frame is included. */
export function totalFramesFor(durationMs: number, fps: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(fps) || fps <= 0) return 0
  return Math.max(1, Math.ceil((durationMs * fps) / 1000))
}

/** Timeline instant sampled for a zero-based output frame. */
export function frameTimeMs(frameIndex: number, fps: number): number {
  return (frameIndex / fps) * 1000
}

export interface FramePlacement {
  planned: PlannedClip
  /** Instant inside the source media. */
  srcMs: number
}

/**
 * Resolve the clip/source instant under a sampled timeline time.
 *
 * Binary search (plans are sorted and contiguous) keeps per-frame lookup
 * O(log n) instead of O(n): exports routinely rasterize tens of thousands of
 * frames against timelines with hundreds of split clips.
 */
export function placementAt(planned: readonly PlannedClip[], timelineMs: number): FramePlacement | null {
  let low = 0
  let high = planned.length - 1
  let candidate = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (planned[mid].startMs <= timelineMs) {
      candidate = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  if (candidate === -1) return null
  const entry = planned[candidate]
  if (timelineMs >= entry.endMs) return null
  return { planned: entry, srcMs: entry.clip.srcStartMs + (timelineMs - entry.startMs) }
}

/** Convenience wrapper used by tests and callers that still hold raw clips. */
export function placementFromClips(
  clips: Clip[],
  timelineMs: number,
): { clip: Clip; srcMs: number; clipIndex: number } | null {
  return timelineToSource(clips, timelineMs)
}

/**
 * Choose a chunk duration that caps decoded/JPEG frame memory. The estimate
 * is deliberately conservative: 4K 60 fps must not materialize 10 seconds
 * of JPEG frames inside FFmpeg's MEMFS at once.
 */
export function chunkFrameCount(width: number, height: number, fps: number, targetBytes = 48 * 1024 * 1024): number {
  const safeFps = Math.max(1, fps)
  const bytesPerFrame = Math.max(32_000, width * height * 0.12)
  const byMemory = Math.max(1, Math.floor(targetBytes / bytesPerFrame))
  const byDuration = Math.max(1, Math.floor(safeFps * 6))
  const maxByFps = Math.max(1, Math.floor(safeFps * 8))
  return Math.max(1, Math.min(byMemory, byDuration, maxByFps))
}

/** Split output frames into independently encoded chunks. */
export function planChunks(totalFrames: number, fps: number, chunkFrames: number): RenderChunk[] {
  if (totalFrames <= 0) return []
  const size = Math.max(1, Math.floor(chunkFrames))
  const chunks: RenderChunk[] = []
  for (let startFrame = 0, index = 0; startFrame < totalFrames; startFrame += size, index++) {
    const endFrame = Math.min(totalFrames, startFrame + size)
    chunks.push({
      index,
      startFrame,
      endFrame,
      startMs: frameTimeMs(startFrame, fps),
      endMs: frameTimeMs(endFrame, fps),
    })
  }
  return chunks
}

/** Audio timeline segments derived from the same clip plan. */
export interface PlannedAudioSegment {
  timelineStartMs: number
  timelineEndMs: number
  sourceStartMs: number
  source: ExportAudioMixdown
}

export function planAudioSegments(
  planned: readonly PlannedClip[],
  sources: readonly ExportVideoSource[],
): PlannedAudioSegment[] {
  const byId = new Map(sources.map((source) => [source.id, source]))
  const segments: PlannedAudioSegment[] = []
  for (const entry of planned) {
    if (entry.sourceId === null) continue
    const source = byId.get(entry.sourceId)
    // Image assets are static: they never contribute an audio segment.
    if (!source || source.kind === 'image') continue
    if (!source.mixdown || source.mixdown.samples.length === 0) continue
    segments.push({
      timelineStartMs: entry.startMs,
      timelineEndMs: entry.endMs,
      sourceStartMs: entry.clip.srcStartMs,
      source: source.mixdown,
    })
  }
  return segments
}

/** Timeline length re-exported for pipeline callers (single source of truth). */
export function exportDurationMs(clips: Clip[]): number {
  return timelineDurationMs(clips)
}

/** Absolute sample position for one chunk boundary (never accumulated). */
export interface AudioPcmChunk {
  startSample: number
  endSample: number
  sampleCount: number
  startByte: number
}

/**
 * Lay chunk audio out on the exact same integer frame grid as the video.
 * Boundaries are computed from absolute frame indices, so rounding cannot
 * accumulate into drift over a long export.
 */
export function planAudioPcmChunks(
  chunks: readonly RenderChunk[],
  fps: number,
  sampleRate: number,
): AudioPcmChunk[] {
  return chunks.map((chunk) => {
    const startSample = sampleAtFrame(chunk.startFrame, fps, sampleRate)
    const endSample = sampleAtFrame(chunk.endFrame, fps, sampleRate)
    const sampleCount = Math.max(0, endSample - startSample)
    return { startSample, endSample, sampleCount, startByte: startSample * 2 }
  })
}

/** Total PCM samples for the exact video frame count (not the raw timeline). */
export function exportAudioSampleCount(totalFrames: number, fps: number, sampleRate: number): number {
  return sampleCountForFrames(totalFrames, fps, sampleRate)
}

/**
 * Alpha is only meaningful in an alpha-capable container (VP9/WebM) and only
 * when a still-image clip can expose the transparent canvas beneath it.
 */
export function planPreservesAlpha(
  planned: readonly PlannedClip[],
  sources: readonly ExportVideoSource[],
  codec: ExportCodec,
): boolean {
  if (codec !== 'vp9') return false
  const byId = new Map(sources.map((source) => [source.id, source]))
  return planned.some((entry) => entry.sourceId !== null && byId.get(entry.sourceId)?.kind === 'image')
}
