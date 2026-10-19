/**
 * Editor domain state — the single store the UI binds to.
 * The reducer is a pure transition function; most actions are covered by
 * plain unit tests (media URLs/images are opaque values to it).
 */
import { appendClip, clipsFromKeepSegments, makeClipId, splitClip, trimClip, timelineDurationMs, type Clip } from '../../modules/timeline/engine'
import { applyAutoZoom } from '../../modules/auto-zoom/engine'
import { DEFAULT_SILENCE_CONFIG, type CutPlan, type SilenceConfig } from '../../modules/audio-analysis/engine'
import { MOTION_PRESET_NAMES, type MotionPresetName } from '../../modules/motion/engine'
import { clamp } from '../../modules/shared/utils'
import { defaultRect, type NormalizedRect } from '../../modules/props/engine'

export interface PropItem {
  id: string
  name: string
  /** Object URL or data URL of the imported PNG. */
  src: string
  rect: NormalizedRect
  /** Timeline visibility window. */
  range: { startMs: number; endMs: number }
  preset: MotionPresetName
}

export interface BlurSettings {
  enabled: boolean
  px: number
}

export interface MediaInfo {
  fileName: string
  videoUrl: string
  durationMs: number
  /** Set once audio analysis completes. */
  mixdown: { samples: Float32Array; sampleRate: number; durationMs: number } | null
}

/** One imported video. Several can coexist; the active one owns the timeline. */
export interface VideoSource {
  id: string
  fileName: string
  videoUrl: string
  durationMs: number
  /** Set once audio analysis completes for this source. */
  mixdown: { samples: Float32Array; sampleRate: number; durationMs: number } | null
}

export interface ExportStatus {
  phase: 'recording' | 'transcoding' | null
  detail: string
}

export type FitMode = 'contain' | 'cover';
export type Rotation = 0 | 90 | 180 | 270

export interface EditorState {
  project: MediaInfo | null
  /** Every imported video; the timeline can accumulate clips from all of them. */
  videos: VideoSource[]
  activeVideoId: string | null
  analysisProgress: number // 0..1
  silenceConfig: SilenceConfig
  /**
   * Silence-cut plans keyed by the source they belong to. `cutPlan` below is
   * the derived mirror of the ACTIVE source's entry (kept in sync by the
   * reducer) so the UI keeps reading a single field.
   */
  cutPlans: Record<string, CutPlan>
  /** The active source's plan — always in sync with `cutPlans`. */
  cutPlan: CutPlan | null
  /**
   * The one timeline track: an ordered list of clips, laid out back-to-back.
   * Each clip references a window of its own source, so appending clip after
   * clip (any import) grows the track endlessly.
   */
  clips: Clip[]
  props: PropItem[]
  selectedPropId: string | null
  blur: BlurSettings
  fitMode: FitMode
  rotation: Rotation
  playing: boolean
  playheadMs: number
  exportStatus: ExportStatus
}

export type EditorAction =
  | { type: 'VIDEO_ADDED'; id: string; fileName: string; videoUrl: string; durationMs: number }
  | { type: 'VIDEO_SELECTED'; id: string }
  | { type: 'MEDIA_FAILED' }
  | { type: 'ROTATION_SET'; rotation: Rotation }
  | { type: 'ANALYSIS_PROGRESS'; ratio: number }
  | {
      type: 'ANALYSIS_DONE'
      /** Which source the decoded audio belongs to; without it, the active one. */
      videoId?: string
      samples: Float32Array
      sampleRate: number
      durationMs: number
    }
  | { type: 'SILENCE_CONFIG_SET'; config: Partial<SilenceConfig> }
  | { type: 'CUT_APPLIED'; cutPlan: CutPlan }
  | { type: 'RESET_CUTS' }
  | { type: 'CLIP_APPEND'; videoId?: string }
  | { type: 'AUTO_ZOOM' }
  | { type: 'FIT_MODE_SET'; fitMode: FitMode }
  | { type: 'CLIP_DELETED'; clipId: string }
  | { type: 'CLIP_SPLIT'; clipId: string; atMs: number }
  | { type: 'CLIP_TRIM'; clipId: string; leftMs: number; rightMs: number }
  | { type: 'PROP_ADDED'; id: string; name: string; src: string; aspect: number }
  | { type: 'PROP_SELECTED'; id: string | null }
  | { type: 'PROP_RECT_SET'; id: string; rect: NormalizedRect }
  | { type: 'PROP_RANGE_SET'; id: string; range: { startMs: number; endMs: number } }
  | { type: 'PROP_PRESET_SET'; id: string; preset: MotionPresetName }
  | { type: 'PROP_REMOVED'; id: string }
  | { type: 'BLUR_SET'; enabled: boolean }
  | { type: 'BLUR_STRENGTH_SET'; px: number }
  | { type: 'PLAYBACK_SET'; playing: boolean; playheadMs?: number }
  | { type: 'PLAYHEAD_SET'; playheadMs: number }
  | { type: 'EXPORT_PHASE_SET'; phase: ExportStatus['phase']; detail?: string }
  | {
      type: 'PROJECT_LOADED'
      project: { fileName: string; videoUrl: string; durationMs: number }
      clips: Clip[]
      props: PropItem[]
      silenceConfig: SilenceConfig
      blur: BlurSettings
    }

export const initialEditorState: EditorState = {
  project: null,
  videos: [],
  activeVideoId: null,
  analysisProgress: 0,
  silenceConfig: { ...DEFAULT_SILENCE_CONFIG },
  cutPlans: {},
  cutPlan: null,
  clips: [],
  props: [],
  selectedPropId: null,
  blur: { enabled: false, px: 8 },
  fitMode: 'contain',
  rotation: 0,
  playing: false,
  playheadMs: 0,
  exportStatus: { phase: null, detail: '' },
};

/** Minimal in/out separation so motion presets always have room to play. */
const MIN_PROP_RANGE_MS = 50

/** Delete one key from a record without mutating it. */
function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record }
  delete next[key]
  return next
}

/** `state.cutPlan` mirrors the active source's stored plan (or null). */
function withActiveCutPlan(state: EditorState): EditorState {
  const plan = state.activeVideoId !== null ? (state.cutPlans[state.activeVideoId] ?? null) : null
  return plan === state.cutPlan ? state : { ...state, cutPlan: plan }
}

/** Which source id a clip cuts from; legacy clips (no videoId) follow the active source. */
export function clipSourceId(state: Pick<EditorState, 'videos' | 'activeVideoId'>, clip: Clip): string | null {
  if (clip.videoId !== undefined) {
    return state.videos.some((v) => v.id === clip.videoId) ? clip.videoId : state.activeVideoId
  }
  return state.activeVideoId
}

/** Resolve the imported source behind a clip (for playback, labels, stats). */
export function clipVideoSource(state: Pick<EditorState, 'videos' | 'activeVideoId'>, clip: Clip): VideoSource | null {
  const id = clipSourceId(state, clip)
  return (id !== null && state.videos.find((v) => v.id === id)) || null
}

/** All clips of one source, in timeline order. */
export function clipsOfSource(state: EditorState, videoId: string): Clip[] {
  return state.clips.filter((c) => clipSourceId(state, c) === videoId)
}

/** Pure transition wrapping: keeps the derived `cutPlan` in sync everywhere. */
export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  return withActiveCutPlan(baseEditorReducer(state, action))
}

function baseEditorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'VIDEO_ADDED': {
      const video: VideoSource = {
        id: action.id,
        fileName: action.fileName,
        videoUrl: action.videoUrl,
        durationMs: action.durationMs,
        mixdown: null,
      }
      // NLE-style appending: a fresh import drops a full-length clip at the END
      // of the track instead of wiping it, so clips accumulate endlessly. The
      // rest of the edit (prefs, props, other sources) stays untouched.
      const clips = video.durationMs > 0 ? appendClip(state.clips, { startMs: 0, endMs: video.durationMs }, video.id) : state.clips
      return {
        ...state,
        analysisProgress: 0,
        videos: [...state.videos, video],
        activeVideoId: video.id,
        project: { fileName: video.fileName, videoUrl: video.videoUrl, durationMs: video.durationMs, mixdown: null },
        clips,
        playing: false,
      }
    }

    case 'VIDEO_SELECTED': {
      const video = state.videos.find((v) => v.id === action.id)
      if (!video) return state
      // Switching only retargets the cut/analysis tools; the one track now
      // spans every import, so clips and props are left untouched.
      return {
        ...state,
        activeVideoId: video.id,
        project: { fileName: video.fileName, videoUrl: video.videoUrl, durationMs: video.durationMs, mixdown: video.mixdown },
        playing: false,
      }
    }

    case 'MEDIA_FAILED':
      return { ...state, project: null, playing: false }

    case 'ANALYSIS_PROGRESS':
      return { ...state, analysisProgress: clamp(action.ratio, 0, 1) }

    case 'ANALYSIS_DONE': {
      const mixdown = { samples: action.samples, sampleRate: action.sampleRate, durationMs: action.durationMs }
      const belongs = (id: string | null) => (action.videoId === undefined ? id === state.activeVideoId : id === action.videoId)
      const videos = state.videos.map((v) => (belongs(v.id) ? { ...v, mixdown } : v))
      return {
        ...state,
        videos,
        project: state.project && belongs(state.activeVideoId) ? { ...state.project, mixdown } : state.project,
      }
    }

    case 'SILENCE_CONFIG_SET': {
      // changing parameters invalidates the ACTIVE source's plan
      return {
        ...state,
        silenceConfig: { ...state.silenceConfig, ...action.config },
        cutPlans: state.activeVideoId !== null ? withoutKey(state.cutPlans, state.activeVideoId) : state.cutPlans,
      }
    }

    case 'CLIP_DELETED': {
      // Keep the playhead inside the shrunken timeline so the preview never
      // hangs past the end after the deleted clip contained it.
      const clips = state.clips.filter(c => c.id !== action.clipId)
      if (clips.length === state.clips.length) return state
      return { ...state, clips, playheadMs: clamp(state.playheadMs, 0, timelineDurationMs(clips)) }
    }

    case 'CUT_APPLIED': {
      // Silence cutting is per-source: the active source's clips are replaced
      // by its kept segments in place; every other import's clips survive.
      const target = state.activeVideoId
      if (!target) return state
      const isTarget = (c: Clip) => clipSourceId(state, c) === target
      const without = state.clips.filter((c) => !isTarget(c))
      const first = state.clips.findIndex(isTarget)
      // generated ids may collide with clips that stay on the track
      const used = new Set(without.map((c) => c.id))
      const replacement = clipsFromKeepSegments(action.cutPlan.keepSegments).map((c) => {
        const id = used.has(c.id) ? makeClipId() : c.id
        used.add(id)
        return { ...c, id, videoId: target }
      })
      const clips =
        first === -1
          ? [...without, ...replacement] // no prior clips of this source: grow the track
          : [...without.slice(0, first), ...replacement, ...without.slice(first)]
      return {
        ...state,
        clips,
        cutPlans: { ...state.cutPlans, [target]: action.cutPlan },
        playing: false,
        playheadMs: clamp(state.playheadMs, 0, timelineDurationMs(clips)),
      }
    }

    case 'RESET_CUTS': {
      // "Reset" restores the ACTIVE source to one uncut full-length clip where
      // its cut clips lived; other imports keep their timeline presence.
      const target = state.activeVideoId
      if (!target) return state
      const source = state.videos.find((v) => v.id === target)
      const isTarget = (c: Clip) => clipSourceId(state, c) === target
      const first = state.clips.findIndex(isTarget)
      if (first === -1 && (source === undefined || source.durationMs <= 0)) return state
      const full: Clip | null =
        source && source.durationMs > 0
          ? { id: makeClipId(), videoId: target, srcStartMs: 0, srcEndMs: source.durationMs, zoom: 1 }
          : null
      const without = state.clips.filter((c) => !isTarget(c))
      const clips =
        full === null
          ? without
          : first === -1
            ? [...without, full]
            : [...without.slice(0, first), full, ...without.slice(first)]
      return {
        ...state,
        clips,
        cutPlans: withoutKey(state.cutPlans, target),
        playing: false,
        playheadMs: clamp(state.playheadMs, 0, timelineDurationMs(clips)),
      }
    }

    case 'CLIP_APPEND': {
      // Append a whole source as one more clip at the end of the track.
      const target = action.videoId ?? state.activeVideoId
      const source = target !== null ? state.videos.find((v) => v.id === target) : undefined
      if (!source || source.durationMs <= 0) return state
      return { ...state, clips: appendClip(state.clips, { startMs: 0, endMs: source.durationMs }, source.id) }
    }

    case 'AUTO_ZOOM':
      return { ...state, clips: applyAutoZoom(state.clips) }

    case 'FIT_MODE_SET':
      return { ...state, fitMode: action.fitMode }

    case 'CLIP_SPLIT': {
      const clips = splitClip(state.clips, action.clipId, action.atMs)
      return clips ? { ...state, clips } : state
    }

    case 'CLIP_TRIM': {
      const clips = trimClip(state.clips, action.clipId, action.leftMs, action.rightMs)
      return clips ? { ...state, clips } : state
    }

    case 'PROP_ADDED': {
      const total = state.project?.durationMs ?? 0
      const prop: PropItem = {
        id: action.id,
        name: action.name,
        src: action.src,
        rect: defaultRect(action.aspect),
        range: {
          startMs: clamp(state.playheadMs, 0, total),
          endMs: clamp(state.playheadMs + 3000, 0, total),
        },
        preset: 'pop-bounce',
      }
      return { ...state, props: [...state.props, prop], selectedPropId: prop.id }
    }

    case 'PROP_SELECTED':
      return { ...state, selectedPropId: action.id }

    case 'PROP_RECT_SET':
      return {
        ...state,
        props: state.props.map((p) => (p.id === action.id ? { ...p, rect: action.rect } : p)),
        selectedPropId: action.id,
      }

    case 'PROP_RANGE_SET': {
      const total = state.project?.durationMs ?? Number.MAX_SAFE_INTEGER
      const startMs = clamp(Math.min(action.range.startMs, action.range.endMs), 0, total)
      const endMs = clamp(Math.max(action.range.startMs, action.range.endMs), 0, total)
      if (endMs - startMs < MIN_PROP_RANGE_MS) return state // too short for visible motion
      return {
        ...state,
        props: state.props.map((p) => (p.id === action.id ? { ...p, range: { startMs, endMs } } : p)),
      }
    }

    case 'PROP_PRESET_SET':
      return {
        ...state,
        props: state.props.map((p) => (p.id === action.id ? { ...p, preset: action.preset } : p)),
      }

    case 'PROP_REMOVED':
      return {
        ...state,
        props: state.props.filter((p) => p.id !== action.id),
        selectedPropId: state.selectedPropId === action.id ? null : state.selectedPropId,
      }

    case 'BLUR_SET':
      return { ...state, blur: { ...state.blur, enabled: action.enabled } }

    case 'BLUR_STRENGTH_SET':
      return { ...state, blur: { ...state.blur, px: clamp(action.px, 0, 40) } }

    case 'PLAYBACK_SET':
      return {
        ...state,
        playing: action.playing,
        playheadMs: action.playheadMs ?? state.playheadMs,
      }

    case 'PLAYHEAD_SET':
      return { ...state, playheadMs: clamp(action.playheadMs, 0, timelineDurationMs(state.clips)) }

    case 'EXPORT_PHASE_SET':
      return { ...state, exportStatus: { phase: action.phase, detail: action.detail ?? state.exportStatus.detail } }

    case 'PROJECT_LOADED':
      return {
        ...state,
        project: {
          fileName: action.project.fileName,
          videoUrl: action.project.videoUrl,
          durationMs: action.project.durationMs,
          mixdown: null,
        },
        clips: action.clips,
        props: action.props,
        silenceConfig: action.silenceConfig,
        blur: action.blur,
        playing: false,
        playheadMs: 0,
      }

    default:
      return state
  }
}

export { MOTION_PRESET_NAMES }
