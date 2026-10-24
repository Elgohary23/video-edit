/**
 * Playback transport math shared by the floating ScrubberBar and the
 * EditorProvider's rAF loop. Pure decisions only — no DOM — so the exact
 * "where does playback start/seek/hold" rules are unit-tested.
 */
import { timelineDurationMs, timelineStartOfClip, timelineToSource, type Clip } from '../timeline/engine'
import type { MediaKind } from '../media/engine'

/** Slider granularity in ms; smooth enough to scrub phase-accurate previews. */
export const SCRUB_STEP_MS = 10

/**
 * A playing <video> is sampled once per rAF tick, so its currentTime is
 * normally 1 frame behind the timeline playhead. This tolerance absorbs that
 * while still catching a stale/seeking element after a seek or a cut.
 */
export const VIDEO_SYNC_TOLERANCE_MS = 60

/** Paused previews must land on the requested frame, not "close enough". */
export const PAUSED_SEEK_TOLERANCE_MS = 2

/** Timeline end is exclusive; keep the frame sampler just inside the last clip. */
const END_EPSILON_MS = 0.001

/** Timeline position used to composite a preview frame (never past the end). */
export function previewPlayheadMs(playheadMs: number, totalMs: number): number {
  if (!Number.isFinite(playheadMs) || totalMs <= 0) return 0
  return Math.max(0, Math.min(playheadMs, totalMs - END_EPSILON_MS))
}

export interface TransportInput {
  clips: readonly Clip[]
  /** Authoritative timeline position from the reducer. */
  playheadMs: number
  playing: boolean
  /** Kind of the asset under the playhead; null when none/outside. */
  kind: MediaKind | null
  /** URL of the video under the playhead (null for images). */
  sourceUrl: string | null
  /** State of the single preview <video> element. */
  videoUrl: string | null
  videoTimeMs: number
  videoReady: boolean
  videoSeeking: boolean
  /** Wall-clock advance since the previous tick (only used for images). */
  deltaMs: number
}

/**
 * One command for the preview transport. The provider applies exactly this
 * command per tick, which keeps `playheadMs` the single source of truth:
 * the video element is always slaved to it, never the other way around.
 */
export type TransportPlan =
  | { action: 'hold' }
  | { action: 'pause-video' }
  | { action: 'seek-video'; url: string; srcMs: number }
  | { action: 'play-video'; playheadMs: number }
  | { action: 'advance'; playheadMs: number }
  | { action: 'finish'; playheadMs: number }

/**
 * Decide the next transport move.
 *
 * Regression guard for "timeline playback starts from an incorrect
 * position": when the element is parked somewhere else than the playhead,
 * the plan seeks the element to the playhead's source instant before it is
 * allowed to play. The playhead is never overwritten from a stale
 * `video.currentTime`.
 */
export function planTransport(input: TransportInput): TransportPlan {
  const clips = input.clips as Clip[]
  const totalMs = timelineDurationMs(clips)
  if (totalMs <= 0) return { action: 'pause-video' }

  const clampedPlayhead = Math.max(0, Math.min(input.playheadMs, totalMs))
  const sampleMs = previewPlayheadMs(clampedPlayhead, totalMs)
  const place = timelineToSource(clips, sampleMs)
  if (!place) return input.playing ? { action: 'finish', playheadMs: totalMs } : { action: 'pause-video' }

  const clipStartMs = timelineStartOfClip(clips, place.clipIndex)
  const clipEndMs = clipStartMs + (place.clip.srcEndMs - place.clip.srcStartMs)

  if (input.kind === 'image') {
    if (!input.playing) return { action: 'pause-video' }
    const nextMs = clampedPlayhead + Math.max(0, input.deltaMs)
    if (nextMs >= clipEndMs) {
      if (place.clipIndex + 1 < clips.length) return { action: 'advance', playheadMs: clipEndMs }
      return { action: 'finish', playheadMs: totalMs }
    }
    return { action: 'advance', playheadMs: nextMs }
  }

  if (input.kind !== 'video' || input.sourceUrl === null) {
    return input.playing ? { action: 'finish', playheadMs: totalMs } : { action: 'pause-video' }
  }

  // A clip from another import, or an element that has not decoded yet: seek
  // to the mapped source instant before any playhead update.
  if (input.videoUrl !== input.sourceUrl || !input.videoReady) {
    return { action: 'seek-video', url: input.sourceUrl, srcMs: place.srcMs }
  }

  if (!input.playing) {
    if (input.videoSeeking) return { action: 'hold' }
    if (Math.abs(input.videoTimeMs - place.srcMs) > PAUSED_SEEK_TOLERANCE_MS) {
      return { action: 'seek-video', url: input.sourceUrl, srcMs: place.srcMs }
    }
    return { action: 'pause-video' }
  }

  if (input.videoSeeking) return { action: 'hold' }

  // The element reached the end of this clip before the playhead caught up.
  if (input.videoTimeMs >= place.clip.srcEndMs) {
    if (place.clipIndex + 1 < clips.length) return { action: 'advance', playheadMs: clipEndMs }
    return { action: 'finish', playheadMs: totalMs }
  }

  // The video clock drives the playhead only when it is actually in sync.
  if (Math.abs(input.videoTimeMs - place.srcMs) > VIDEO_SYNC_TOLERANCE_MS) {
    return { action: 'seek-video', url: input.sourceUrl, srcMs: place.srcMs }
  }

  return {
    action: 'play-video',
    playheadMs: Math.max(0, Math.min(totalMs, clipStartMs + (input.videoTimeMs - place.clip.srcStartMs))),
  }
}

/** Native range-input bounds for scanning across a timeline of `totalMs`. */
export function scrubBounds(totalMs: number): { min: number; max: number } {
  return { min: 0, max: Math.max(1, Math.round(totalMs)) }
}

/** Clamp a raw slider emit to a valid timeline position (bounds shift when clips are deleted). */
export function scrubValueToMs(raw: number, totalMs: number): number {
  if (!Number.isFinite(raw)) return 0
  const safe = Math.round(raw)
  return Math.max(0, Math.min(safe, Math.round(totalMs)))
}
