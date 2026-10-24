import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react'
import {
  editorReducer,
  initialEditorState,
  clipVideoSource,
  type EditorState,
  type ExportStatus,
  type PropItem,
  type FitMode,
} from './editor'
import { dbEnvelope, buildCutPlan, type SilenceConfig } from '../../modules/audio-analysis/engine'
import { mediaKindOf, mixdownToMono, type AudioBufferLike, type MediaKind } from '../../modules/media/engine'
import { resolveMotion } from '../../modules/motion/engine'
import {
  drawFrame,
  PREVIEW_FRAME,
  type CompositorSettings,
  type PropFrame,
  type VideoSource,
} from '../../modules/compositor/engine'
import { createBackdropRenderer, type BackdropRenderer } from '../../modules/compositor/backdrop'
import {
  timelineDurationMs,
  timelineToSource,
  timelineStartOfClip,
  type Clip,
} from '../../modules/timeline/engine'
import { planTransport, previewPlayheadMs } from '../../modules/playback/engine'
import { moveRect, resizeRect, type Handle as PropHandle, type NormalizedRect } from '../../modules/props/engine'
import { saveProject as apiSaveProject, listProjects, loadProject as apiLoadProject, type SavedProjectSummary } from '../../modules/projects/api'
import { runExport } from '../../modules/export/pipeline/exportPipeline'
import { normalizeExportSettings } from '../../modules/export/settings'
import { isExportBusy, type ExportProgress, type ExportSettings } from '../../modules/export/types'
import { isExportCancelled, ExportError } from '../../modules/export/utils/errors'

/** Runtime message surfaced in the header (save confirmations, export errors...). */
export interface EditorContextValue {
  state: EditorState
  /** Import a video or still image; the clip is appended to the track. */
  importMedia: (file: File) => void
  /** Change an image asset's nominal length (also updates its full clips). */
  setImageDuration: (assetId: string, durationMs: number) => void
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
  exportToMp4: (settings?: Partial<ExportSettings>) => Promise<void>
  cancelExport: () => void
  openExportDialog: () => void
  closeExportDialog: () => void
  setExportSettings: (settings: Partial<ExportSettings>) => void
  saveProject: () => Promise<void>
  fetchProjectList: () => Promise<SavedProjectSummary[]>
  applySavedProject: (id: string) => Promise<void>
  selectVideo: (id: string) => void
  /** NLE-style appending: drop one more full clip at the end of the track. */
  addTimelineClip: (videoId?: string) => void
  registerCanvas: (canvas: HTMLCanvasElement | null) => void
  message: string
  deleteClip: (clipId: string) => void
}

const EditorContext = createContext<EditorContextValue | null>(null)

/** Decoded prop images, keyed by the src they were loaded from. */
const imageEls = new Map<string, HTMLImageElement>()

/** Decoded timeline images, keyed by their asset object URL. */
const mediaImages = new Map<string, HTMLImageElement>()

export function EditorProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(editorReducer, initialEditorState)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const backdropRef = useRef<BackdropRenderer | null>(null)

  /** Sources-of-truth mirror so the rAF loop reads without effect re-subscribes. */
  const stateRef = useRef(state)
  stateRef.current = state

  /** One export at a time; abort is the single cancellation source of truth. */
  const exportAbortRef = useRef<AbortController | null>(null)
  const [message, setMessage] = useReducerString()

  /* ── Import & audio decode ─────────────────────────────────────────────── */

  /** Decode a specific import's audio track; the reducer attaches it by id. */
  const extractAudio = useCallback(async (url: string, videoId: string): Promise<void> => {
    try {
      dispatch({ type: 'ANALYSIS_PROGRESS', ratio: 0.25 })
      const audioCtx = new AudioContext()
      const res = await fetch(url)
      const arrayBuffer = await res.arrayBuffer()
      dispatch({ type: 'ANALYSIS_PROGRESS', ratio: 0.5 })

      const buffer = await new Promise<AudioBuffer>((resolve, reject) => {
        // decode with success|error callback form for maximum browser support
        void audioCtx.decodeAudioData(arrayBuffer, resolve, (err) => reject(err instanceof Error ? err : new Error('decode failed')))
      })

      const mix = mixdownToMono(buffer as unknown as AudioBufferLike)
      dispatch({ type: 'ANALYSIS_PROGRESS', ratio: 1 })
      dispatch({
        type: 'ANALYSIS_DONE',
        videoId,
        samples: mix.samples,
        sampleRate: mix.sampleRate,
        durationMs: mix.durationMs,
      })
      void audioCtx.close()
    } catch (err) {
      console.error(err)
      setMessage(`Audio analysis failed: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }, [setMessage])

  const importMedia = useCallback(
    (file: File) => {
      const kind: MediaKind | null = mediaKindOf(file.type, file.name)
      if (!kind) {
        setMessage(`Unsupported file: ${file.name}. Use a video or a PNG/JPEG/WebP image.`)
        return
      }
      const url = URL.createObjectURL(file)
      const id = `media-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

      if (kind === 'image') {
        const image = new Image()
        image.onload = () => {
          mediaImages.set(url, image)
          dispatch({
            type: 'VIDEO_ADDED',
            id,
            fileName: file.name,
            videoUrl: url,
            durationMs: stateRef.current.imageDurationMs,
            kind: 'image',
          })
        }
        image.onerror = () => {
          URL.revokeObjectURL(url)
          setMessage(`Could not decode image: ${file.name}`)
        }
        image.src = url
        return
      }

      // Probe element: several imports can be in flight at once, so metadata is
      // read off a scratch <video> instead of the single playback element.
      const probe = document.createElement('video')
      probe.preload = 'metadata'
      probe.onloadedmetadata = () => {
        const durationMs = Number.isFinite(probe.duration) ? probe.duration * 1000 : 0
        // Adds the source rather than replacing it — the timeline grows with imports.
        dispatch({ type: 'VIDEO_ADDED', id, fileName: file.name, videoUrl: url, durationMs, kind: 'video' })
        void extractAudio(url, id)
        probe.removeAttribute('src') // done probing; the playback element takes over
      }
      probe.onerror = () => {
        URL.revokeObjectURL(url)
        setMessage(`Could not read video: ${file.name}`)
      }
      probe.src = url
    },
    [setMessage, extractAudio],
  )

  const setImageDuration = useCallback((assetId: string, durationMs: number) => {
    dispatch({ type: 'IMAGE_DURATION_SET', assetId, durationMs })
  }, [])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onEnded = () => {
      // Only treat 'ended' as playback-finish when the timeline is truly over;
      // mid-timeline source hops swap <video> srcs and must not reset the edit.
      const s = stateRef.current
      const totalMs = timelineDurationMs(s.clips)
      if (totalMs - s.playheadMs > 50) return
      // Park at the end. Pressing Play from the end restarts at zero.
      dispatch({ type: 'PLAYBACK_SET', playing: false, playheadMs: totalMs })
    }
    video.addEventListener('ended', onEnded)
    return () => {
      video.removeEventListener('ended', onEnded)
    }
  }, [])

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

  /** Switch the active editing source among the imported videos. */
  const selectVideo = useCallback((id: string) => {
    dispatch({ type: 'VIDEO_SELECTED', id })
  }, [])

  /** Drop one more full clip of a source (default: active) at the track end. */
  const addTimelineClip = useCallback((videoId?: string) => {
    dispatch({ type: 'CLIP_APPEND', videoId })
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
    const totalMs = timelineDurationMs(s.clips)
    if (totalMs <= 0) return
    // Starting from the parked end restarts at zero; anywhere else the
    // playhead is already authoritative and is resumed verbatim.
    const startMs = s.playheadMs >= totalMs - 1 ? 0 : s.playheadMs
    dispatch({ type: 'PLAYBACK_SET', playing: true, playheadMs: startMs })
  }, [])

  const pause = useCallback(() => {
    const s = stateRef.current
    const video = videoRef.current
    const totalMs = timelineDurationMs(s.clips)
    let playheadMs = s.playheadMs

    // Capture the exact instant the user paused. The playback element can be
    // up to one rAF tick ahead of the reducer, but a stale element (different
    // clip, far from the planned source instant) must never move the playhead.
    if (s.playing && video && !video.seeking && totalMs > 0) {
      const sampleMs = previewPlayheadMs(s.playheadMs, totalMs)
      const place = timelineToSource(s.clips, sampleMs)
      const source = place ? clipVideoSource(s, place.clip) : null
      if (place && source?.kind === 'video' && video.src === source.videoUrl) {
        const srcMs = video.currentTime * 1000
        const insideClip = srcMs >= place.clip.srcStartMs - 1 && srcMs <= place.clip.srcEndMs + 1
        const nearPlayhead = Math.abs(srcMs - place.srcMs) <= 250
        if (insideClip && nearPlayhead) {
          const clipStartMs = timelineStartOfClip(s.clips, place.clipIndex)
          playheadMs = Math.min(totalMs, clipStartMs + (srcMs - place.clip.srcStartMs))
        }
      }
    }

    video?.pause()
    dispatch({ type: 'PLAYBACK_SET', playing: false, playheadMs })
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
    // Preview-only backdrop cache. OffscreenCanvas support is checked before
    // creation so jsdom/test environments never touch a 2D context here.
    if (typeof OffscreenCanvas !== 'undefined') {
      backdropRef.current = createBackdropRenderer(PREVIEW_FRAME.width, PREVIEW_FRAME.height)
    }
    return () => {
      backdropRef.current?.dispose()
      backdropRef.current = null
    }
  }, [])

  useEffect(() => {
    let raf = 0
    let lastTick = performance.now()

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const deltaMs = Math.max(0, Math.min(250, now - lastTick))
      lastTick = now
      const s = stateRef.current
      const canvas = canvasRef.current
      const video = videoRef.current
      if (!canvas) return
      // The offline export owns the UI thread's heavy work. Skipping the
      // preview compositor here leaves one CPU core for seeking/encoding and
      // guarantees preview never reads export rendering state.
      if (isExportBusy(s.exportStatus)) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const totalMs = timelineDurationMs(s.clips)
      const playheadMs = previewPlayheadMs(s.playheadMs, totalMs)
      const place = totalMs > 0 ? timelineToSource(s.clips, playheadMs) : null
      const source = place ? clipVideoSource(s, place.clip) : null
      const sourceUrl = source?.kind === 'video' ? source.videoUrl : null

      // Resolve the media element that belongs to the clip under the playhead.
      // A mismatched/source-not-ready element is deliberately treated as "no
      // frame": the compositor then holds the last good frame instead of
      // clearing to black while the seek is in flight.
      let media: VideoSource | null = null
      if (source?.kind === 'image') {
        const image = mediaImages.get(source.videoUrl)
        if (image && image.complete && image.naturalWidth > 0) {
          media = { el: image, width: image.naturalWidth, height: image.naturalHeight, ready: true }
        }
      } else if (
        sourceUrl !== null &&
        video &&
        video.src === sourceUrl &&
        video.readyState >= 2 &&
        video.videoWidth > 0
      ) {
        media = { el: video, width: video.videoWidth, height: video.videoHeight, ready: true }
      }

      const backdrop = backdropRef.current
      if (backdrop && media && s.fitMode === 'contain') backdrop.draw(media.el)

      drawFrame(
        ctx,
        canvas.width,
        canvas.height,
        buildCompositorSettings(s, media, playheadMs, {
          holdLastFrame: true,
          backdrop: backdrop ? backdrop.canvas : null,
        }),
      )

      if (!video) return
      if (totalMs <= 0) {
        if (!video.paused) video.pause()
        return
      }

      const plan = planTransport({
        clips: s.clips,
        playheadMs: s.playheadMs,
        playing: s.playing,
        kind: source?.kind ?? null,
        sourceUrl,
        videoUrl: video.src || null,
        videoTimeMs: video.currentTime * 1000,
        videoReady: video.readyState >= 2,
        videoSeeking: video.seeking,
        deltaMs,
      })

      switch (plan.action) {
        case 'hold':
          break
        case 'pause-video':
          if (!video.paused) video.pause()
          break
        case 'seek-video':
          video.pause()
          if (video.src !== plan.url) video.src = plan.url
          try {
            video.currentTime = plan.srcMs / 1000
          } catch {
            // Metadata is not ready yet; the next tick retries this seek.
          }
          break
        case 'play-video':
          if (video.paused && !video.seeking) void video.play().catch(() => {})
          if (Math.abs(plan.playheadMs - s.playheadMs) > 0.5) {
            dispatch({ type: 'PLAYHEAD_SET', playheadMs: plan.playheadMs })
          }
          break
        case 'advance':
          video.pause()
          dispatch({ type: 'PLAYHEAD_SET', playheadMs: plan.playheadMs })
          break
        case 'finish':
          video.pause()
          dispatch({ type: 'PLAYBACK_SET', playing: false, playheadMs: plan.playheadMs })
          break
      }
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  /* ── Export ────────────────────────────────────────────────────────────── */

  const exportToMp4 = useCallback(
    async (override?: Partial<ExportSettings>) => {
      const s = stateRef.current
      if (!s.project || s.clips.length === 0) {
        setMessage('Import media before exporting.')
        return
      }
      if (exportAbortRef.current) return

      if (override) dispatch({ type: 'EXPORT_SETTINGS_SET', settings: override })
      const settings = normalizeExportSettings({ ...s.exportSettings, ...override })
      const totalFrames = Math.max(0, Math.ceil((timelineDurationMs(s.clips) * settings.fps) / 1000))
      const controller = new AbortController()
      exportAbortRef.current = controller

      // Export never depends on preview playback: pause the transport and
      // leave the canvas alone until the offline job finishes.
      videoRef.current?.pause()
      dispatch({ type: 'PLAYBACK_SET', playing: false })
      dispatch({
        type: 'EXPORT_STATUS_SET',
        status: {
          phase: 'transcoding',
          detail: 'Preparing export…',
          stage: 'initializing',
          progress: 0,
          frame: 0,
          totalFrames,
          etaMs: null,
          renderFps: null,
          encodingSpeed: null,
          error: null,
        },
      })

      try {
        const result = await runExport(
          {
            projectName: s.project.fileName,
            clips: s.clips,
            videos: s.videos.map((video) => ({
              id: video.id,
              url: video.videoUrl,
              kind: video.kind,
              durationMs: video.durationMs,
              mixdown: video.mixdown,
            })),
            activeVideoId: s.activeVideoId,
            props: s.props.map((prop) => ({
              id: prop.id,
              src: prop.src,
              rect: prop.rect,
              range: prop.range,
              preset: prop.preset,
            })),
            blur: s.blur,
            fitMode: s.fitMode,
            settings,
            signal: controller.signal,
          },
          {
            onProgress: (progress: ExportProgress) => {
              dispatch({ type: 'EXPORT_STATUS_SET', status: statusFromProgress(progress, totalFrames) })
            },
            onLog: (line) => console.debug(line),
          },
        )

        const outcome = await saveExportBlob(result.blob, result.filename, result.mimeType)
        if (outcome === 'saved') {
          setMessage('Export complete — video saved.')
          return
        }
        if (outcome === 'cancelled') {
          setMessage('Export finished, but the save dialog was cancelled.')
          return
        }
        // No save dialog in this browser: fall back to a plain download.
        const url = URL.createObjectURL(result.blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = result.filename
        anchor.click()
        window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
        setMessage('Export complete — download started.')
      } catch (err) {
        if (controller.signal.aborted || isExportCancelled(err)) {
          const previous = stateRef.current.exportStatus
          dispatch({
            type: 'EXPORT_STATUS_SET',
            status: {
              ...previous,
              phase: null,
              stage: 'cancelled',
              detail: 'Export cancelled',
              etaMs: null,
              renderFps: null,
              encodingSpeed: null,
              error: null,
            },
          })
          setMessage('Export cancelled.')
          return
        }
        console.error('[export] failed', err, err instanceof ExportError ? err.logs : [])
        const userMessage = err instanceof ExportError ? err.userMessage : `Export failed: ${err instanceof Error ? err.message : 'unknown error'}`
        const previous = stateRef.current.exportStatus
        dispatch({
          type: 'EXPORT_STATUS_SET',
          status: {
            ...previous,
            phase: null,
            stage: 'error',
            detail: 'Export failed',
            etaMs: null,
            renderFps: null,
            encodingSpeed: null,
            error: userMessage,
          },
        })
        setMessage(userMessage)
      } finally {
        exportAbortRef.current = null
      }
    },
    [setMessage],
  )

  const cancelExport = useCallback(() => {
    const controller = exportAbortRef.current
    if (!controller) return
    const previous = stateRef.current.exportStatus
    dispatch({
      type: 'EXPORT_STATUS_SET',
      status: { ...previous, detail: 'Cancelling export…' },
    })
    controller.abort()
  }, [])

  const openExportDialog = useCallback(() => {
    const s = stateRef.current
    if (!s.project || s.clips.length === 0) {
      setMessage('Import media before exporting.')
      return
    }
    dispatch({ type: 'EXPORT_DIALOG_SET', open: true })
  }, [setMessage])

  const closeExportDialog = useCallback(() => {
    dispatch({ type: 'EXPORT_DIALOG_SET', open: false })
  }, [])

  const setExportSettings = useCallback((settings: Partial<ExportSettings>) => {
    dispatch({ type: 'EXPORT_SETTINGS_SET', settings })
  }, [])

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
      importMedia,
      setImageDuration,

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
      cancelExport,
      openExportDialog,
      closeExportDialog,
      setExportSettings,
      saveProject,
      fetchProjectList,
      applySavedProject,
      selectVideo,
      addTimelineClip,
      registerCanvas,
      message,
      deleteClip,
    }),
    [state, importMedia, setImageDuration, setSilenceConfig, applySilenceCut, resetCuts, autoZoom, setFitMode, selectVideo, addTimelineClip, splitClipAt, trimClipBy, addProp, selectProp, updatePropRect, movePropBy, resizePropBy, setPropRange, setPropPreset, removeProp, setBlurEnabled, setBlurPx, play, pause, seek, exportToMp4, cancelExport, openExportDialog, closeExportDialog, setExportSettings, saveProject, fetchProjectList, applySavedProject, registerCanvas, message, deleteClip],
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

/** Map pipeline progress onto the reducer's serializable status shape. */
function statusFromProgress(progress: ExportProgress, fallbackTotalFrames: number): ExportStatus {
  const busy = isExportBusy({ stage: progress.stage })
  return {
    phase: busy ? 'transcoding' : null,
    detail: progress.detail,
    stage: progress.stage,
    progress: progress.progress,
    frame: progress.frame,
    totalFrames: progress.totalFrames || fallbackTotalFrames,
    etaMs: progress.etaMs,
    renderFps: progress.renderFps,
    encodingSpeed: progress.encodingSpeed,
    error: null,
  }
}

type SaveBlobOutcome = 'saved' | 'cancelled' | 'unavailable'

/**
 * Offer the user a native save-location dialog via the File System Access API
 * (Chromium-family). 'cancelled' is returned when the user backs out of the
 * dialog; 'unavailable' means the caller should fall back to a plain download.
 */
async function saveExportBlob(blob: Blob, filename: string, mimeType: string): Promise<SaveBlobOutcome> {
  if (typeof window.showSaveFilePicker !== 'function') return 'unavailable'
  const extension = filename.slice(filename.lastIndexOf('.'))
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: filename,
      types: [{ description: mimeType === 'video/webm' ? 'WebM Video' : 'MP4 Video', accept: { [mimeType]: [extension] } }],
    })
    const writable = await handle.createWritable()
    await writable.write(blob)
    await writable.close()
    return 'saved'
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled'
    console.error(err)
    return 'unavailable'
  }
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

interface CompositorOverrides {
  holdLastFrame?: boolean
  backdrop?: CanvasImageSource | null
}

function buildCompositorSettings(
  s: EditorState,
  video: VideoSource | null,
  playheadMs: number,
  overrides: CompositorOverrides = {},
): CompositorSettings {
  const activeProps: PropFrame[] = []
  for (const prop of s.props) {
    if (prop.range.startMs > playheadMs || prop.range.endMs <= playheadMs) continue
    const image = imageEls.get(prop.src)
    if (!image || !image.complete || image.naturalWidth === 0) continue
    activeProps.push({
      image,
      rect: prop.rect,
      transform: resolveMotion(prop.preset, playheadMs, prop.range.startMs, prop.range.endMs),
    })
  }
  return {
    clips: s.clips,
    playheadMs,
    blurEnabled: s.blur.enabled,
    blurPx: s.blur.px,
    fitMode: s.fitMode,
    video,
    activeProps,
    ...overrides,
  }
}
