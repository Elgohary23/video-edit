/**
 * Editor domain state — the single store the UI binds to.
 * The reducer is a pure transition function; most actions are covered by
 * plain unit tests (media URLs/images are opaque values to it).
 */
import { clipsFromKeepSegments, splitClip, trimClip, timelineDurationMs, type Clip } from '../../modules/timeline/engine'
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

export interface ExportStatus {
  phase: 'recording' | 'transcoding' | null
  detail: string
}

export type FitMode = 'contain' | 'cover';
export type Rotation = 0 | 90 | 180 | 270

export interface EditorState {
  project: MediaInfo | null
  analysisProgress: number // 0..1
  silenceConfig: SilenceConfig
  cutPlan: CutPlan | null
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
  | { type: 'MEDIA_IMPORTED'; fileName: string; videoUrl: string; durationMs: number }
  | { type: 'MEDIA_FAILED' }
  | { type: 'ROTATION_SET'; rotation: Rotation }
  | { type: 'ANALYSIS_PROGRESS'; ratio: number }
  | { type: 'ANALYSIS_DONE'; samples: Float32Array; sampleRate: number; durationMs: number }
  | { type: 'SILENCE_CONFIG_SET'; config: Partial<SilenceConfig> }
  | { type: 'CUT_APPLIED'; cutPlan: CutPlan }
  | { type: 'RESET_CUTS' }
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
  analysisProgress: 0,
  silenceConfig: { ...DEFAULT_SILENCE_CONFIG },
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

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'MEDIA_IMPORTED':
      return {
        ...initialEditorState,
        project: { fileName: action.fileName, videoUrl: action.videoUrl, durationMs: action.durationMs, mixdown: null },
      }

    case 'MEDIA_FAILED':
      return { ...state, project: null, playing: false }

    case 'ANALYSIS_PROGRESS':
      return { ...state, analysisProgress: clamp(action.ratio, 0, 1) }

    case 'ANALYSIS_DONE':
      return {
        ...state,
        project: state.project
          ? { ...state.project, mixdown: { samples: action.samples, sampleRate: action.sampleRate, durationMs: action.durationMs } }
          : null,
      }

    case 'SILENCE_CONFIG_SET':
      // changing parameters invalidates the last plan
      return { ...state, silenceConfig: { ...state.silenceConfig, ...action.config }, cutPlan: null }

    case 'CLIP_DELETED': {
      // Keep the playhead inside the shrunken timeline so the preview never
      // hangs past the end after the deleted clip contained it.
      const clips = state.clips.filter(c => c.id !== action.clipId)
      if (clips.length === state.clips.length) return state
      return { ...state, clips, playheadMs: clamp(state.playheadMs, 0, timelineDurationMs(clips)) }
    }
    case 'CUT_APPLIED':
      return {
        ...state,
        clips: clipsFromKeepSegments(action.cutPlan.keepSegments),
        cutPlan: action.cutPlan,
        playing: false,
        playheadMs: 0,
      }

    case 'RESET_CUTS':
      return {
        ...state,
        clips: [],
        cutPlan: null,
        playing: false,
        playheadMs: 0,
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
