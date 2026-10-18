import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react'
import { editorReducer, initialEditorState, type EditorState, type PropItem, type FitMode } from './editor'
import { dbEnvelope, buildCutPlan, type SilenceConfig } from '../../modules/audio-analysis/engine'
import { mixdownToMono, type AudioBufferLike } from '../../modules/media/engine'
import { resolveMotion } from '../../modules/motion/engine'
import { drawFrame, type CompositorSettings, type PropFrame, type VideoSource } from '../../modules/compositor/engine'
import {
  timelineDurationMs,
  timelineToSource,
  timelineStartOfClip,
  type Clip,
} from '../../modules/timeline/engine'
import { moveRect, resizeRect, type Handle as PropHandle, type NormalizedRect } from '../../modules/props/engine'
import { saveProject as apiSaveProject, listProjects, loadProject as apiLoadProject, type SavedProjectSummary } from '../../modules/projects/api'
import { exportFileName, pickRecorderMimeType, transcodeToMp4 } from '../../modules/export/engine'

/** Runtime message surfaced in the header (save confirmations, export errors...). */
export interface EditorContextValue {
  state: EditorState
  importVideo: (file: File) => void
  setSilenceConfig: (config: Partial<SilenceConfig>) => void
  applySilenceCut: () => void
  resetCuts: () => void
  autoZoom: () => void
  setFitMode: (mode: FitMode) => void
  splitClipAt: (clipId: string, atMs: number) => void
  trimClipBy: (clipId: string, leftMs: number, rightMs: number) => void
  addProp: (file: File) => void
  selectProp: (id: string | null) => void
  updatePropRect: (id: string, rect: NormalizedRect) => void
  movePropBy: (id: string, dx: number, dy: number) => void
  resizePropBy: (id: string, handle: PropHandle, dx: number, dy: number) => void
  setPropRange: (id: string, startMs: number, endMs: number) => void
  setPropPreset: (id: string, preset: PropItem['preset']) => void
  removeProp: (id: string) => void
  setBlurEnabled: (enabled: boolean) => void
  setBlurPx: (px: number) => void
  play: () => void
  pause: () => void
  seek: (tMs: number) => void
  exportToMp4: () => Promise<void>
  saveProject: () => Promise<void>
  fetchProjectList: () => Promise<SavedProjectSummary[]>
  applySavedProject: (id: string) => Promise<void>
  registerCanvas: (canvas: HTMLCanvasElement | null) => void
  message: string
  deleteClip: (clipId: string) => void
}

const EditorContext = createContext<EditorContextValue | null>(null)

const SEEK_EPS = 0.5

/** Decoded prop images, keyed by the src they were loaded from. */
const imageEls = new Map<string, HTMLImageElement>()

export function EditorProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(editorReducer, initialEditorState)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  /** Sources-of-truth mirror so the rAF loop reads without effect re-subscribes. */
  const stateRef = useRef(state)
  stateRef.current = state

  const srcUrlRef = useRef<string | null>(null)
  const pendingImportRef = useRef<{ fileName: string } | null>(null)
  const analysisSeqRef = useRef(0)
  const exportingRef = useRef<{ resolve: () => void } | null>(null)
  const mediaGraphRef = useRef<{ ctx: AudioContext; source: MediaElementAudioSourceNode; dest: MediaStreamAudioDestinationNode } | null>(null)
  const [message, setMessage] = useReducerString()

  /* ── Import & audio decode ─────────────────────────────────────────────── */

  const importVideo = useCallback((file: File) => {
    const video = videoRef.current
    if (!video) return
    if (srcUrlRef.current) URL.revokeObjectURL(srcUrlRef.current)
    const url = URL.createObjectURL(file)
    srcUrlRef.current = url
    pendingImportRef.current = { fileName: file.name }
    video.src = url
  }, [])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const onLoadedMetadata = () => {
      const pending = pendingImportRef.current
      const mediaUrl = srcUrlRef.current
      if (!pending || !mediaUrl) return
      const durationMs = Number.isFinite(video.duration) ? video.duration * 1000 : 0
      dispatch({
        type: 'MEDIA_IMPORTED',
        fileName: pending.fileName,
        videoUrl: mediaUrl,
        durationMs,
      })
      void extractAudio(mediaUrl)
    }
    const onEnded = () => {
      // Reset playhead and video position when playback finishes
      dispatch({ type: 'PLAYBACK_SET', playing: false, playheadMs: 0 })
      video.currentTime = 0
      if (!exportingRef.current && stateRef.current.playing) {
        dispatch({ type: 'PLAYBACK_SET', playing: false })
      }
    }

    video.addEventListener('loadedmetadata', onLoadedMetadata)
    video.addEventListener('ended', onEnded)
    // Reset playback position so the user can replay the video immediately
    video.currentTime = 0
    return () => {
      video.removeEventListener('loadedmetadata', onLoadedMetadata)
      video.removeEventListener('ended', onEnded)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function extractAudio(explicitUrl?: string): Promise<void> {
    const seq = ++analysisSeqRef.current
    try {
      dispatch({ type: 'ANALYSIS_PROGRESS', ratio: 0.25 })
      const audioCtx = new AudioContext()
      const fileUrl = explicitUrl ?? srcUrlRef.current ?? stateRef.current.project?.videoUrl
      if (!fileUrl) throw new Error('no media url')
      const res = await fetch(fileUrl)
      const arrayBuffer = await res.arrayBuffer()
      dispatch({ type: 'ANALYSIS_PROGRESS', ratio: 0.5 })

      const buffer = await new Promise<AudioBuffer>((resolve, reject) => {
        // decode with success|error callback form for maximum browser support
        void audioCtx.decodeAudioData(arrayBuffer, resolve, (err) => reject(err instanceof Error ? err : new Error('decode failed')))
      })
      if (seq !== analysisSeqRef.current) return // superseded by another import

      const mix = mixdownToMono(buffer as unknown as AudioBufferLike)
      dispatch({ type: 'ANALYSIS_PROGRESS', ratio: 1 })
      dispatch({
        type: 'ANALYSIS_DONE',
        samples: mix.samples,
        sampleRate: mix.sampleRate,
        durationMs: mix.durationMs,
      })
      void audioCtx.close()
    } catch (err) {
      if (seq === analysisSeqRef.current) {
        console.error(err)
        setMessage(`Audio analysis failed: ${err instanceof Error ? err.message : 'unknown error'}`)
      }
    }
  }

  /* ── Cut + zoom engines ────────────────────────────────────────────────── */

  const setSilenceConfig = useCallback((config: Partial<SilenceConfig>) => {
    dispatch({ type: 'SILENCE_CONFIG_SET', config })
  }, [])

  const applySilenceCut = useCallback(() => {
    const { project, silenceConfig } = stateRef.current
    if (!project?.mixdown) return
    const env = dbEnvelope(project.mixdown.samples, project.mixdown.sampleRate)
    dispatch({ type: 'CUT_APPLIED', cutPlan: buildCutPlan(env, project.mixdown.durationMs, silenceConfig) })
  }, [])

  const resetCuts = useCallback(() => {
    dispatch({ type: 'RESET_CUTS' })
    setMessage('Restored uncut original video.')
  }, [setMessage])

  const setFitMode = useCallback((mode: FitMode) => {
    dispatch({ type: 'FIT_MODE_SET', fitMode: mode })
  }, [])

  const autoZoom = useCallback(() => dispatch({ type: 'AUTO_ZOOM' }), [])

  const splitClipAt = useCallback((clipId: string, atMs: number) => {
    dispatch({ type: 'CLIP_SPLIT', clipId, atMs })
  }, [])

  const trimClipBy = useCallback((clipId: string, leftMs: number, rightMs: number) => {
    dispatch({ type: 'CLIP_TRIM', clipId, leftMs, rightMs })
  }, [])

  /* ── Props ─────────────────────────────────────────────────────────────── */

  const addProp = useCallback((file: File) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      imageEls.set(url, img)
      dispatch({
        type: 'PROP_ADDED',
        id: `prop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        name: file.name,
        src: url,
        aspect: img.naturalWidth / img.naturalHeight,
      })
    }
    img.onerror = () => setMessage(`Could not load prop image: ${file.name}`)
    img.src = url
  }, [setMessage])

  const updatePropRect = useCallback((id: string, rect: NormalizedRect) => {
    dispatch({ type: 'PROP_RECT_SET', id, rect })
  }, [])

  const movePropBy = useCallback((id: string, dx: number, dy: number) => {
    const prop = stateRef.current.props.find((p) => p.id === id)
    if (prop) dispatch({ type: 'PROP_RECT_SET', id, rect: moveRect(prop.rect, dx, dy) })
  }, [])

  const resizePropBy = useCallback((id: string, handle: PropHandle, dx: number, dy: number) => {
    const prop = stateRef.current.props.find((p) => p.id === id)
    if (prop) {
      const img = imageEls.get(prop.src)
      const aspect = img ? img.naturalWidth / img.naturalHeight : undefined
      dispatch({ type: 'PROP_RECT_SET', id, rect: resizeRect(prop.rect, handle, dx, dy, aspect) })
    }
  }, [])

  const setPropRange = useCallback((id: string, startMs: number, endMs: number) => {
    dispatch({ type: 'PROP_RANGE_SET', id, range: { startMs, endMs } })
  }, [])

  const setPropPreset = useCallback((id: string, preset: PropItem['preset']) => {
    dispatch({ type: 'PROP_PRESET_SET', id, preset })
  }, [])

  const removeProp = useCallback((id: string) => {
    const prop = stateRef.current.props.find((p) => p.id === id)
    if (prop?.src.startsWith?.('blob:')) URL.revokeObjectURL(prop.src)
    imageEls.delete(prop?.src ?? '')
    dispatch({ type: 'PROP_REMOVED', id })
  }, [])

  const selectProp = useCallback((id: string | null) => {
    dispatch({ type: 'PROP_SELECTED', id })
  }, [])

  /* ── Playback ──────────────────────────────────────────────────────────── */

  const play = useCallback(() => {
    const s = stateRef.current
    if (s.clips.length === 0) return
    dispatch({ type: 'PLAYBACK_SET', playing: true, playheadMs: s.playheadMs >= timelineDurationMs(s.clips) ? 0 : s.playheadMs })
  }, [])

  const pause = useCallback(() => {
    videoRef.current?.pause()
    dispatch({ type: 'PLAYBACK_SET', playing: false })
  }, [])

  const seek = useCallback((tMs: number) => {
    dispatch({ type: 'PLAYHEAD_SET', playheadMs: tMs })
  }, [])

  const setBlurEnabled = useCallback((enabled: boolean) => dispatch({ type: 'BLUR_SET', enabled }), [])
  const setBlurPx = useCallback((px: number) => dispatch({ type: 'BLUR_STRENGTH_SET', px }), [])

  const registerCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    canvasRef.current = canvas
  }, [])

  /* ── rAF driver: compositor + timeline playback ────────────────────────── */

  useEffect(() => {
    let raf = 0

    const frame = () => {
      raf = requestAnimationFrame(frame)
      const s = stateRef.current
      const canvas = canvasRef.current
      const video = videoRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const videoSource: VideoSource | null =
        video && video.readyState >= 2 && s.project
          ? { el: video, width: video.videoWidth, height: video.videoHeight, ready: true }
          : null
      const settings = buildCompositorSettings(s, videoSource, video)
      drawFrame(ctx, canvas.width, canvas.height, settings)

      if (!s.playing || !video || !s.project) return

      const clips = s.clips
      const place = timelineToSource(clips, s.playheadMs)
      if (!place) {
        video.pause()
        dispatch({ type: 'PLAYBACK_SET', playing: false })
        return
      }

      const srcT = video.currentTime * 1000
      const inClip = srcT >= place.clip.srcStartMs - SEEK_EPS && srcT < place.clip.srcEndMs
      const clipTL = timelineStartOfClip(clips, place.clipIndex)

      if (inClip) {
        if (video.paused && !video.seeking) void video.play().catch(() => {})
        dispatch({ type: 'PLAYHEAD_SET', playheadMs: clipTL + (srcT - place.clip.srcStartMs) })
      } else if (srcT >= place.clip.srcEndMs - SEEK_EPS) {
        // clip finished — hop to the next one or finish playback
        const wasExporting = exportingRef.current !== null
        if (place.clipIndex + 1 < clips.length) {
          dispatch({ type: 'PLAYHEAD_SET', playheadMs: timelineStartOfClip(clips, place.clipIndex + 1) })
        } else {
          void video.play().catch(() => {})
          video.pause()
          dispatch({ type: 'PLAYBACK_SET', playing: false, playheadMs: timelineDurationMs(clips) })
          if (wasExporting) {
            const resolve = exportingRef.current?.resolve
            exportingRef.current = null
            resolve?.()
          }
        }
      } else if (!video.seeking) {
        // start of playback or manual seek: jump the source to the planned window
        video.currentTime = place.srcMs / 1000
      }
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  /* ── Export ────────────────────────────────────────────────────────────── */

  const exportToMp4 = useCallback(async () => {
    const s = stateRef.current
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!s.project || !video || !canvas || s.clips.length === 0) {
      setMessage('Import a video and cut silence before exporting.')
      return
    }
    const recorderMime = pickRecorderMimeType((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m))
    if (!recorderMime) {
      setMessage('Recording is not supported in this browser.')
      return
    }

    try {
      video.pause()
      video.currentTime = 0
      await once(video, 'seeked')

      // audio: route the element into the graph, capture via stream destination
      const audioCtx = mediaGraphRef.current?.ctx ?? new AudioContext()
      const source = mediaGraphRef.current?.source ?? audioCtx.createMediaElementSource(video)
      const dest = mediaGraphRef.current?.dest ?? audioCtx.createMediaStreamDestination()
      source.disconnect()
      source.connect(dest)
      mediaGraphRef.current = { ctx: audioCtx, source, dest }

      const canvasStream = canvas.captureStream(30)
      const stream = new MediaStream([...canvasStream.getVideoTracks(), ...dest.stream.getAudioTracks()])
      const recorder = new MediaRecorder(stream, { mimeType: recorderMime })
      const chunks: BlobPart[] = []
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data)
      }
      recorder.start(250)

      // drive playback to the end, the compositor loop resolves on finish
      const finished = new Promise<void>((resolve) => {
        exportingRef.current = { resolve }
      })
      dispatch({ type: 'PLAYBACK_SET', playing: true, playheadMs: 0 })
      dispatch({ type: 'EXPORT_PHASE_SET', phase: 'recording', detail: 'Capturing timeline…' })
      await finished
      recorder.stop()
      await once(recorder, 'stop')

      // restore speaker monitoring for normal previewing
      source.disconnect()
      source.connect(audioCtx.destination)

      const take = new Blob(chunks, { type: recorderMime })
      dispatch({ type: 'EXPORT_PHASE_SET', phase: 'transcoding', detail: 'Encoding MP4…' })
      const { blob } = await transcodeToMp4(take, (f) => {
        if (f === 'loading-core') dispatch({ type: 'EXPORT_PHASE_SET', phase: 'transcoding', detail: 'Loading FFmpeg…' })
      })
      dispatch({ type: 'EXPORT_PHASE_SET', phase: null, detail: '' })

      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = exportFileName(s.project.fileName.replace(/\.[^.]+$/, ''))
      a.click()
      URL.revokeObjectURL(url)
      setMessage('Export complete — MP4 saved.')
    } catch (err) {
      dispatch({ type: 'EXPORT_PHASE_SET', phase: null, detail: '' })
      console.error(err)
      setMessage(`Export failed: ${err instanceof Error ? err.message : 'unknown error'}`)
    } finally {
      exportingRef.current = null
    }
  }, [setMessage])

  /* ── Save / load projects ─────────────────────────────────────────────── */

  const saveProject = useCallback(async () => {
    const s = stateRef.current
    if (!s.project) {
      setMessage('Nothing to save yet.')
      return
    }
    try {
      const payload = serializeSnapshot(s)
      const saved = await apiSaveProject(s.project.fileName.replace(/\.[^.]+$/, '') || 'edit', payload)
      setMessage(`Project saved on server (${saved.name}).`)
    } catch (err) {
      console.error(err)
      setMessage(`Save failed: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }, [setMessage])

  const fetchProjectList = useCallback(async () => {
    try {
      return await listProjects()
    } catch (err) {
      console.error(err)
      setMessage(`Projects API unavailable: ${err instanceof Error ? err.message : 'failed to load'}`)
      return []
    }
  }, [setMessage])

  const applySnapshotToState = useCallback(
    async (saved: { name?: string; payload: Record<string, unknown> }): Promise<void> => {
      const snapshot = saved.payload as SnapshotPayload
      const video = videoRef.current
      // Re-attach media is required: payloads reference local files by name.
      if (video && stateRef.current.project) {
        const parsed = parseSnapshot(snapshot)
        if (!parsed) {
          setMessage('Saved project is not readable.')
          return
        }
        for (const prop of parsed.props) {
          if (!imageEls.has(prop.src)) {
            const img = new Image()
            img.src = prop.src
            imageEls.set(prop.src, img)
          }
        }
        dispatch({
          type: 'PROJECT_LOADED',
          project: stateRef.current.project,
          clips: parsed.clips,
          props: parsed.props,
          silenceConfig: parsed.silenceConfig,
          blur: parsed.blur,
        })
        setMessage(`Loaded ${saved.name ?? 'project'} onto the current media.`)
      } else {
        setMessage('Import your video first, then load this project.')
      }
    },
    [setMessage],
  )

  const applySavedProject = useCallback(
    async (id: string) => {
      try {
        const saved = await apiLoadProject(id)
        await applySnapshotToState(saved)
      } catch (err) {
        console.error(err)
        setMessage(`Load failed: ${err instanceof Error ? err.message : 'unknown error'}`)
      }
    },
    [applySnapshotToState, setMessage],
  )

  const deleteClip = useCallback((clipId: string) => {
    dispatch({ type: 'CLIP_DELETED', clipId })
  }, [])

  const value = useMemo<EditorContextValue>(
    () => ({
      state,
      importVideo,

      setSilenceConfig,
      applySilenceCut,
      resetCuts,
      autoZoom,
      setFitMode,
      splitClipAt,
      trimClipBy,
      addProp,
      selectProp,
      updatePropRect,
      movePropBy,
      resizePropBy,
      setPropRange,
      setPropPreset,
      removeProp,
      setBlurEnabled,
      setBlurPx,
      play,
      pause,
      seek,
      exportToMp4,
      saveProject,
      fetchProjectList,
      applySavedProject,
      registerCanvas,
      message,
      deleteClip,
    }),
    [state, importVideo, setSilenceConfig, applySilenceCut, resetCuts, autoZoom, setFitMode, splitClipAt, trimClipBy, addProp, selectProp, updatePropRect, movePropBy, resizePropBy, setPropRange, setPropPreset, removeProp, setBlurEnabled, setBlurPx, play, pause, seek, exportToMp4, saveProject, fetchProjectList, applySavedProject, registerCanvas, message, deleteClip],
  )

  return (
    <EditorContext.Provider value={value}>
      {children}
      <video ref={videoRef} className="hidden size-0" preload="auto" playsInline />
    </EditorContext.Provider>
  )
}

export function useEditor(): EditorContextValue {
  const ctx = useContext(EditorContext)
  if (!ctx) throw new Error('useEditor must be used within EditorProvider')
  return ctx
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

function once(target: EventTarget, event: string): Promise<void> {
  return new Promise((resolve) => {
    target.addEventListener(event, () => resolve(), { once: true })
  })
}

/** Plain useReducer string setter — avoids one more state hook API. */
function useReducerString(): [string, (next: string) => void] {
  const [message, setMessageRaw] = useReducer((_: string, next: string) => next, '')
  return [message, setMessageRaw]
}

interface SnapshotPayload extends Record<string, unknown> {
  version?: number
  media?: { fileName?: string; durationMs?: number }
  silenceConfig?: SilenceConfig
  clips?: Clip[]
  props?: Array<{ id: string; name: string; src: string; rect: NormalizedRect; range: { startMs: number; endMs: number }; preset: PropItem['preset'] }>
  blur?: { enabled: boolean; px: number }
}

function serializeSnapshot(s: EditorState): SnapshotPayload {
  return {
    version: 1,
    media: { fileName: s.project?.fileName, durationMs: s.project?.durationMs },
    silenceConfig: s.silenceConfig,
    clips: s.clips,
    props: s.props,
    blur: s.blur,
  }
}

function parseSnapshot(payload: SnapshotPayload): {
  clips: Clip[]
  props: PropItem[]
  silenceConfig: SilenceConfig
  blur: { enabled: boolean; px: number }
} | null {
  if (typeof payload !== 'object' || payload === null || !Array.isArray(payload.clips) || !Array.isArray(payload.props)) return null
  return {
    clips: payload.clips,
    props: payload.props,
    silenceConfig: payload.silenceConfig ?? { ...payloadDefaultSilence() },
    blur: payload.blur ?? { enabled: false, px: 8 },
  }
}

function payloadDefaultSilence(): SilenceConfig {
  // avoids importing DEFAULT here twice — mirrors audio-analysis defaults
  return { thresholdDb: -35, minSilenceMs: 300, paddingMs: 120 }
}

function buildCompositorSettings(s: EditorState, video: VideoSource | null, _videoEl: HTMLVideoElement | null): CompositorSettings {
  const playhead = s.playheadMs
  const activeProps: PropFrame[] = []
  for (const prop of s.props) {
    if (prop.range.startMs > playhead || prop.range.endMs <= playhead) continue
    const image = imageEls.get(prop.src)
    if (!image || !image.complete || image.naturalWidth === 0) continue
    activeProps.push({ image, rect: prop.rect, transform: resolveMotion(prop.preset, playhead, prop.range.startMs, prop.range.endMs) })
  }
  return {
    clips: s.clips,
    playheadMs: playhead,
    blurEnabled: s.blur.enabled,
    blurPx: s.blur.px,
    fitMode: s.fitMode,
    video,
    activeProps,
  }
}
