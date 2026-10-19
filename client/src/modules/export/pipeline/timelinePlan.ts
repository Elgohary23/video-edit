/**
 * Deterministic timeline evaluation for export.
 *
 * Frame N always maps to `N / fps * 1000` on the timeline. Chunk boundaries
 * are derived from the same integer frame grid so audio, video, and segment
 * durations never drift by partial frames.
 */
import { timelineDurationMs, timelineToSource, type Clip } from '../../timeline/engine'
import type { ExportAudioMixdown, ExportVideoSource, PlannedClip, RenderChunk } from '../types'

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

/** Resolve the clip/source instant under a sampled timeline time. */
export function placementAt(planned: readonly PlannedClip[], timelineMs: number): FramePlacement | null {
  for (const entry of planned) {
    if (timelineMs >= entry.startMs && timelineMs < entry.endMs) {
      return { planned: entry, srcMs: entry.clip.srcStartMs + (timelineMs - entry.startMs) }
    }
  }
  return null
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
    if (!source?.mixdown || source.mixdown.samples.length === 0) continue
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
