/**
 * Timeline domain engine — a non-destructive, ordered list of clips that
 * reference windows of the source video (PRD Feature 2).
 *
 * "Non-destructive" invariants:
 *   - clips only ever reference `srcStartMs/srcEndMs` windows of the original file;
 *   - silence removal only changes which windows appear, not the media itself;
 *   - all operations are immutable and return new arrays.
 */

/** Half-open source-time region in milliseconds. */
export interface Region {
  startMs: number
  endMs: number
}

export interface Clip {
  id: string
  srcStartMs: number
  srcEndMs: number
  /** Framing scale for this clip (1 = base, >1 = punch-in). */
  zoom: number
  /**
   * Which imported source this clip cuts from (one track can grow across
   * several files). Omitted on legacy clips — they follow the active source.
   */
  videoId?: string
}

export interface PlacedSource {
  clip: Clip
  clipIndex: number
  /** Corresponding instant within the source media. */
  srcMs: number
}

export function timelineDurationMs(clips: Clip[]): number {
  return clips.reduce((acc, c) => acc + (c.srcEndMs - c.srcStartMs), 0)
}

/** Build the initial timeline from kept (non-silent) segments. */
export function clipsFromKeepSegments(segments: Region[]): Clip[] {
  return segments.map((seg, i) => ({
    id: `clip-${i + 1}`,
    srcStartMs: seg.startMs,
    srcEndMs: seg.endMs,
    zoom: 1,
  }))
}

/** Collision-safe id for clips appended by hand or by an import. */
export function makeClipId(): string {
  return `clip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/**
 * NLE-style appending: push one more clip onto the end of the single track.
 * Timeline position is derived from array order, so the new clip always starts
 * exactly where the track currently ends — clips accumulate endlessly.
 */
export function appendClip(clips: Clip[], window: Region, videoId?: string, id?: string): Clip[] {
  const clip: Clip = {
    id: id ?? makeClipId(),
    srcStartMs: window.startMs,
    srcEndMs: window.endMs,
    zoom: 1,
    ...(videoId !== undefined ? { videoId } : {}),
  }
  return [...clips, clip]
}

/**
 * Map a timeline position to its source media position.
 * Time outside the timeline → null.
 */
export function timelineToSource(clips: Clip[], tMs: number): PlacedSource | null {
  let timelineCursor = 0
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]
    const span = clip.srcEndMs - clip.srcStartMs
    if (tMs < timelineCursor + span) {
      return { clip, clipIndex: i, srcMs: clip.srcStartMs + (tMs - timelineCursor) }
    }
    timelineCursor += span
  }
  return null
}

/** Map a source instant back to timeline position; null when the window is cut out. */
export function sourceToTimeline(clips: Clip[], srcMs: number): number | null {
  let timelineCursor = 0
  for (const clip of clips) {
    if (srcMs >= clip.srcStartMs && srcMs < clip.srcEndMs) {
      return timelineCursor + (srcMs - clip.srcStartMs)
    }
    timelineCursor += clip.srcEndMs - clip.srcStartMs
  }
  return null
}

/** Index the clip at `clipIndex` starts on the timeline (sum of prior spans). */
export function timelineStartOfClip(clips: Clip[], clipIndex: number): number {
  let timeline = 0
  for (let i = 0; i < clipIndex && i < clips.length; i++) {
    timeline += clips[i].srcEndMs - clips[i].srcStartMs
  }
  return timeline
}

/** Split one clip's window at a timeline position into two immutable clips. */
export function splitClip(clips: Clip[], clipId: string, atTimelineMs: number): Clip[] | null {
  const at = timelineToSource(clips, atTimelineMs)
  if (!at || at.clip.id !== clipId) return null

  const cutSrcMs = at.srcMs
  // Nudge instead of zero-length splits at window edges
  const gap = 1
  if (cutSrcMs - at.clip.srcStartMs < gap || at.clip.srcEndMs - cutSrcMs < gap) return null

  return clips.flatMap((clip) => {
    if (clip.id !== clipId) return [clip]
    return [
      { ...clip, id: `${clip.id}-L`, srcEndMs: cutSrcMs },
      { ...clip, id: `${clip.id}-R`, srcStartMs: cutSrcMs },
    ]
  })
}

/** Trim a clip's window inward by edge trims (manual cleanup of "uh"/"um" leftovers). */
export function trimClip(clips: Clip[], clipId: string, startTrimMs: number, endTrimMs: number): Clip[] | null {
  return clips.flatMap((clip) => {
    if (clip.id !== clipId) return [clip]
    const a = Math.max(clip.srcStartMs, clip.srcStartMs + startTrimMs)
    const b = Math.min(clip.srcEndMs, clip.srcEndMs - endTrimMs)
    if (b - a <= 0) return [clip] // cannot fully consume a clip — keep it unchanged
    return [{ ...clip, srcStartMs: a, srcEndMs: b }]
  })
}
