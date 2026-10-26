/**
 * Playback transport math shared by the floating ScrubberBar and the
 * EditorProvider's rAF loop. Pure decisions only — no DOM — so the exact
 * "where does playback start/seek/hold/step/loop" rules are unit-tested.
 */
import { timelineDurationMs, timelineStartOfClip, timelineToSource, type Clip } from '../timeline/engine'
import type { MediaKind } from '../media/engine'
import { clamp } from '../shared/utils'

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

/**
 * Play is a two-phase operation: the media element must first land on the
 * parked frame, then it may start. This is the tight landing tolerance for
 * that gate — the 60 ms playback tolerance must never let a stale clock win.
 */
export const PLAY_START_LAND_TOLERANCE_MS = 2

/** Keep the tightened clock tolerance for this long after playback starts. */
export const PLAY_START_GUARD_MS = 250

/** A single decoded frame can lag the rAF sample by ~33 ms at 30 fps. */
export const PLAY_START_GUARD_TOLERANCE_MS = 40

/** An in/out review region; endMs is exclusive. */
export interface LoopRegion {
  startMs: number
  endMs: number
}

/** Shorter regions are treated as an accidental click, not a review loop. */
export const MIN_LOOP_REGION_MS = 100

/** Timeline end is exclusive; keep the frame sampler just inside the last clip. */
const END_EPSILON_MS = 0.001

/** Fallback frame rate for stepping when a caller has no export setting. */
export const DEFAULT_STEP_FPS = 30

/** Timeline position used to composite a preview frame (never past the end). */
export function previewPlayheadMs(playheadMs: number, totalMs: number): number {
  if (!Number.isFinite(playheadMs) || totalMs <= 0) return 0
  return Math.max(0, Math.min(playheadMs, totalMs - END_EPSILON_MS))
}

/**
 * Clamp a raw in/out pair onto a real timeline. Returns null when either edge
 * is unusable or the region is shorter than `MIN_LOOP_REGION_MS`.
 */
export function normalizeLoopRegion(
  region: LoopRegion | null | undefined,
  totalMs: number,
): LoopRegion | null {
  if (!region || totalMs <= 0) return null
  if (!Number.isFinite(region.startMs) || !Number.isFinite(region.endMs)) return null
  const low = Math.min(region.startMs, region.endMs)
  const high = Math.max(region.startMs, region.endMs)
  const startMs = clamp(low, 0, totalMs)
  const endMs = clamp(high, 0, totalMs)
  if (endMs - startMs < MIN_LOOP_REGION_MS) return null
  return { startMs, endMs }
}

/**
 * Resolve the timeline instant Play should use. Parked positions are kept
 * verbatim, except at the exclusive end (which restarts at zero) and when an
 * active loop region means an outside-the-loop parking spot should enter at
 * the in-point.
 */
export function playStartMs(
  playheadMs: number,
  totalMs: number,
  loop: LoopRegion | null = null,
  loopEnabled = false,
): number {
  if (!Number.isFinite(totalMs) || totalMs <= 0) return 0
  const safe = Number.isFinite(playheadMs) ? clamp(playheadMs, 0, totalMs) : 0
  const base = safe >= totalMs - 1 ? 0 : safe
  const active = loopEnabled ? normalizeLoopRegion(loop, totalMs) : null
  if (active && (base < active.startMs || base >= active.endMs)) return active.startMs
  return base
}

/** Frame duration used by the frame-step shortcuts. */
export function frameDurationMs(fps: number): number {
  const safeFps = Number.isFinite(fps) ? clamp(fps, 1, 240) : DEFAULT_STEP_FPS
  return 1000 / safeFps
}

/**
 * Frame-grid stepping. Stepping rounds to the nearest frame index first and
 * then counts whole frames, so `.` N times followed by `,` N times returns the
 * same grid instant (no cumulative fractional-millisecond drift).
 */
export function stepPlayheadMs(
  playheadMs: number,
  frames: number,
  fps: number,
  totalMs: number,
): number {
  if (!Number.isFinite(totalMs) || totalMs <= 0) return 0
  const frameMs = frameDurationMs(fps)
  const safe = Number.isFinite(playheadMs) ? clamp(playheadMs, 0, totalMs) : 0
  const currentFrame = Math.round(safe / frameMs)
  const totalFrames = Math.max(1, Math.ceil(totalMs / frameMs))
  const lastFrame = Math.max(0, totalFrames - 1)
  const step = Number.isFinite(frames) ? Math.trunc(frames) : 0
  const nextFrame = clamp(currentFrame + step, 0, lastFrame)
  return nextFrame * frameMs
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
  /** True while the user owns the scrubber; media must never move the playhead. */
  scrubbing?: boolean
  /** Play was requested but the element has not landed on the parked frame yet. */
  awaitingStart?: boolean
  /** Tightened media-clock tolerance immediately after a gated start. */
  startGuard?: boolean
  /** Valid in/out region; null/undefined when looping is off. */
  loop?: LoopRegion | null
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
  | { action: 'start-play' }
  | { action: 'play-video'; playheadMs: number }
  | { action: 'advance'; playheadMs: number }
  | { action: 'wrap-loop'; playheadMs: number }
  | { action: 'finish'; playheadMs: number }

/**
 * Decide the next transport move.
 *
 * Regression guards:
 * - "scrubbing": while the pointer owns the slider, playback is paused and
 *   only the user's seek target may move `playheadMs`.
 * - "Play from a parked position": awaitingStart runs a seek-first gate;
 *   `start-play` is emitted only after the element has landed on the exact
 *   parked source instant. No media-clock value is used during the gate.
 * - "Loop review": reaching the out-point wraps to the in-point through the
 *   same hold/seek machinery, so the compositor never sees a gap.
 * - "Stale media clock": after a gated start, a tighter tolerance is used for
 *   `PLAY_START_GUARD_MS` before the normal playback tolerance applies.
 */
export function planTransport(input: TransportInput): TransportPlan {
  const clips = input.clips as Clip[]
  const totalMs = timelineDurationMs(clips)
  if (totalMs <= 0) return { action: 'pause-video' }

  const clampedPlayhead = Math.max(0, Math.min(input.playheadMs, totalMs))
  const loop = input.loop ? normalizeLoopRegion(input.loop, totalMs) : null

  // Scrubbing is a user-owned session: pause the element, seek it to the
  // requested frame, and never let currentTime write the reducer playhead.
  if (input.scrubbing) {
    const sampleMs = previewPlayheadMs(clampedPlayhead, totalMs)
    const scrubbed = timelineToSource(clips, sampleMs)
    if (!scrubbed || input.kind !== 'video' || input.sourceUrl === null) {
      return { action: 'pause-video' }
    }
    if (input.videoUrl !== input.sourceUrl) {
      return { action: 'seek-video', url: input.sourceUrl, srcMs: scrubbed.srcMs }
    }
    // A seek drops readyState to HAVE_METADATA. Re-issuing the seek while it
    // is in flight restarts it every frame and it can never land.
    if (input.videoSeeking) return { action: 'hold' }
    if (!input.videoReady) {
      return { action: 'seek-video', url: input.sourceUrl, srcMs: scrubbed.srcMs }
    }
    if (Math.abs(input.videoTimeMs - scrubbed.srcMs) > PAUSED_SEEK_TOLERANCE_MS) {
      return { action: 'seek-video', url: input.sourceUrl, srcMs: scrubbed.srcMs }
    }
    return { action: 'pause-video' }
  }

  // External seeks (keyboard, waveform, loop edits) can land exactly on or
  // past the out-point. Wrap before sampling so the state never leaves the
  // region while playing.
  if (input.playing && loop && clampedPlayhead >= loop.endMs) {
    return { action: 'wrap-loop', playheadMs: loop.startMs }
  }

  const sampleMs = previewPlayheadMs(clampedPlayhead, totalMs)
  const place = timelineToSource(clips, sampleMs)
  if (!place) return input.playing ? { action: 'finish', playheadMs: totalMs } : { action: 'pause-video' }

  const clipStartMs = timelineStartOfClip(clips, place.clipIndex)
  const clipEndMs = clipStartMs + (place.clip.srcEndMs - place.clip.srcStartMs)

  if (input.kind === 'image') {
    // The still is already composited from state; once the play gate is
    // requested there is no media element to wait for.
    if (input.awaitingStart) return { action: 'start-play' }
    if (!input.playing) return { action: 'pause-video' }
    const nextMs = clampedPlayhead + Math.max(0, input.deltaMs)
    if (loop && nextMs >= loop.endMs) {
      return { action: 'wrap-loop', playheadMs: loop.startMs }
    }
    if (nextMs >= clipEndMs) {
      if (place.clipIndex + 1 < clips.length) return { action: 'advance', playheadMs: clipEndMs }
      return { action: 'finish', playheadMs: totalMs }
    }
    return { action: 'advance', playheadMs: nextMs }
  }

  if (input.kind !== 'video' || input.sourceUrl === null) {
    return input.playing ? { action: 'finish', playheadMs: totalMs } : { action: 'pause-video' }
  }

  // A clip from another import needs its source loaded before any playhead
  // update. A seek that is already running must be allowed to land first:
  // readyState temporarily drops to HAVE_METADATA, and re-issuing currentTime
  // here restarts the seek on every frame. That is what froze playback at a
  // cut boundary before the next clip could start.
  if (input.videoUrl !== input.sourceUrl) {
    return { action: 'seek-video', url: input.sourceUrl, srcMs: place.srcMs }
  }
  if (input.videoSeeking) return { action: 'hold' }
  if (!input.videoReady) {
    return { action: 'seek-video', url: input.sourceUrl, srcMs: place.srcMs }
  }

  // Play gate: never start the media clock until the element is parked on the
  // exact requested frame. The early seek guard above covers the seeked-event
  // wait; here the element is ready and stationary.
  if (input.awaitingStart) {
    if (Math.abs(input.videoTimeMs - place.srcMs) > PLAY_START_LAND_TOLERANCE_MS) {
      return { action: 'seek-video', url: input.sourceUrl, srcMs: place.srcMs }
    }
    return { action: 'start-play' }
  }

  if (!input.playing) {
    if (Math.abs(input.videoTimeMs - place.srcMs) > PAUSED_SEEK_TOLERANCE_MS) {
      return { action: 'seek-video', url: input.sourceUrl, srcMs: place.srcMs }
    }
    return { action: 'pause-video' }
  }

  // The element reached the end of this clip before the playhead caught up.
  if (input.videoTimeMs >= place.clip.srcEndMs) {
    if (place.clipIndex + 1 < clips.length) return { action: 'advance', playheadMs: clipEndMs }
    return { action: 'finish', playheadMs: totalMs }
  }

  // The video clock drives the playhead only when it is actually in sync.
  const syncTolerance = input.startGuard ? PLAY_START_GUARD_TOLERANCE_MS : VIDEO_SYNC_TOLERANCE_MS
  if (Math.abs(input.videoTimeMs - place.srcMs) > syncTolerance) {
    return { action: 'seek-video', url: input.sourceUrl, srcMs: place.srcMs }
  }

  const mediaPlayheadMs = Math.max(
    0,
    Math.min(totalMs, clipStartMs + (input.videoTimeMs - place.clip.srcStartMs)),
  )
  if (loop && input.playing && mediaPlayheadMs >= loop.endMs) {
    return { action: 'wrap-loop', playheadMs: loop.startMs }
  }

  return { action: 'play-video', playheadMs: mediaPlayheadMs }
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
