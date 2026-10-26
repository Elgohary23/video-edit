/**
 * Project snapshot (server payload) serialization.
 *
 * Kept separate from the provider so the save/load contract is a pure,
 * testable value transform. Media blobs are never stored — only clip windows,
 * props, settings, and the review position (playhead + loop region).
 */
import { DEFAULT_SILENCE_CONFIG, type SilenceConfig } from '../../modules/audio-analysis/engine'
import { timelineDurationMs, type Clip } from '../../modules/timeline/engine'
import { normalizeLoopRegion, type LoopRegion } from '../../modules/playback/engine'
import { clamp } from '../../modules/shared/utils'
import type { BlurSettings, EditorState, PropItem } from './editor'

export interface SnapshotPayload extends Record<string, unknown> {
  version?: number
  media?: { fileName?: string; durationMs?: number }
  silenceConfig?: SilenceConfig
  clips?: Clip[]
  props?: Array<{
    id: string
    name: string
    src: string
    rect: PropItem['rect']
    range: { startMs: number; endMs: number }
    preset: PropItem['preset']
  }>
  blur?: BlurSettings
  /** Resume a review session at the exact parked frame. */
  playheadMs?: number
  loopRegion?: LoopRegion | null
  loopEnabled?: boolean
}

export interface ParsedSnapshot {
  clips: Clip[]
  props: PropItem[]
  silenceConfig: SilenceConfig
  blur: BlurSettings
  playheadMs: number
  loopRegion: LoopRegion | null
  loopEnabled: boolean
}

export function serializeSnapshot(s: EditorState): SnapshotPayload {
  return {
    version: 2,
    media: { fileName: s.project?.fileName, durationMs: s.project?.durationMs },
    silenceConfig: s.silenceConfig,
    clips: s.clips,
    props: s.props,
    blur: s.blur,
    playheadMs: s.playheadMs,
    loopRegion: s.loopRegion,
    loopEnabled: s.loopEnabled,
  }
}

export function parseSnapshot(payload: SnapshotPayload): ParsedSnapshot | null {
  if (typeof payload !== 'object' || payload === null || !Array.isArray(payload.clips) || !Array.isArray(payload.props)) {
    return null
  }
  const totalMs = timelineDurationMs(payload.clips)
  const requestedPlayhead = typeof payload.playheadMs === 'number' ? payload.playheadMs : 0
  const playheadMs = Number.isFinite(requestedPlayhead) ? clamp(requestedPlayhead, 0, totalMs) : 0
  const loopRegion = normalizeLoopRegion(readLoopRegion(payload.loopRegion), totalMs)

  return {
    clips: payload.clips,
    props: payload.props,
    silenceConfig: payload.silenceConfig ?? { ...DEFAULT_SILENCE_CONFIG },
    blur: payload.blur ?? { enabled: false, px: 8 },
    playheadMs,
    loopRegion,
    // Version-1 payloads have no loop fields; a loop needs a valid region.
    loopEnabled: payload.loopEnabled === true && loopRegion !== null,
  }
}

/** Defensive read: server payloads are user-editable JSON. */
function readLoopRegion(value: unknown): LoopRegion | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as { startMs?: unknown; endMs?: unknown }
  if (typeof candidate.startMs !== 'number' || typeof candidate.endMs !== 'number') return null
  return { startMs: candidate.startMs, endMs: candidate.endMs }
}
