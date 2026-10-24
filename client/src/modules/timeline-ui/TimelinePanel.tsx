import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { useEditor } from '../../app/state/EditorProvider'
import { clipVideoSource, clipsOfSource, type VideoSource } from '../../app/state/editor'
import { computePeaks } from '../audio-analysis/engine'
import { mediaKindOf } from '../media/engine'
import { isMediaDrag, readMediaDragId } from '../media/drag'
import { timelineDurationMs, timelineStartOfClip } from '../timeline/engine'
import { clamp } from '../shared/utils'
import { ClipDeleteButton } from './ClipDeleteButton'

const WAVE_HEIGHT = 72
const ZOOM_MAX = 4
const ZOOM_STEP = 0.5
/** Wheel zoom sensitivity (per notch, multiplicative around 1.0). */
const WHEEL_ZOOM_RATE = 0.0012

interface LaneDrag {
  kind: 'clip-start' | 'clip-end' | 'prop-start' | 'prop-end'
  id: string
  totalMs: number
  laneWidth: number
  lastClientX: number
}

/**
 * Timeline panel — waveform lane with red cut overlays, clip lane with
 * draggable in/out trim edges, prop lane with draggable in/out ranges, and a
 * shared playhead. Pointer interactions map directly to reducer actions.
 */
export function TimelinePanel() {
  const { state, seek, splitClipAt, trimClipBy, setPropRange, selectProp, selectVideo, addTimelineClip, importMedia } =
    useEditor()

  const waveRef = useRef<HTMLCanvasElement>(null)
  const totalMs = timelineDurationMs(state.clips)
  const dragRef = useRef<LaneDrag | null>(null)
  const [dropActive, setDropActive] = useState(false)

  /* ── timeline zoom (1x native, up to 4x, scrollable) ──────────────────── */

  const [zoom, setZoom] = useState(1)

  /* ── wheel zoom over the timeline lanes (roller in/out, cursor-anchored) ── */

  const scrollRef = useRef<HTMLDivElement>(null)
  const lanesRef = useRef<HTMLDivElement>(null)
  const zipRef = useRef({ zoom, hasMedia: state.project !== null })
  zipRef.current = { zoom, hasMedia: state.project !== null }
  /** Anchor captured at wheel time; applied after the zoom re-render. */
  const pendingAnchor = useRef<{ frac: number; clientX: number } | null>(null)

  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    const onWheel = (e: WheelEvent) => {
      // horizontal trackpad/shift-scroll keeps native panning; the vertical
      // roller zooms in/out like the buttons do
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
      const { zoom: z, hasMedia } = zipRef.current
      if (!hasMedia) return
      e.preventDefault()
      const lane = lanesRef.current
      if (!lane) return
      const laneRect = lane.getBoundingClientRect()
      const containerRect = container.getBoundingClientRect()
      if (laneRect.width <= 0) return
      // fraction of the lane under the cursor stays put while zooming
      const frac = (e.clientX - laneRect.left) / laneRect.width
      const next = clamp(z * Math.exp(-e.deltaY * WHEEL_ZOOM_RATE), 1, ZOOM_MAX)
      if (next === z) return
      pendingAnchor.current = { frac, clientX: e.clientX - containerRect.left }
      zipRef.current = { zoom: next, hasMedia }
      setZoom(next)
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => container.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    const anchor = pendingAnchor.current
    if (!anchor) return
    pendingAnchor.current = null
    const lane = lanesRef.current
    const container = scrollRef.current
    if (!lane || !container) return
    const laneWidth = lane.getBoundingClientRect().width
    container.scrollLeft = clamp(anchor.frac * laneWidth - anchor.clientX, 0, container.scrollWidth)
  }, [zoom])

  /* ── waveform rendering ───────────────────────────────────────────────── */

  const peaks = useMemo(() => {
    const samples = state.project?.mixdown?.samples
    if (!samples) return null
    return computePeaks(samples, 1200)
  }, [state.project?.mixdown])

  useEffect(() => {
    const canvas = waveRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const w = canvas.width
    const h = canvas.height
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#18181b'
    ctx.fillRect(0, 0, w, h)

    if (peaks) {
      const peakW = w / peaks.length
      const mid = h / 2
      for (let i = 0; i < peaks.length; i++) {
        const p = peaks[i]
        ctx.fillStyle = '#52525b'
        ctx.fillRect(i * peakW, mid + p.min * mid * 0.9, peakW, Math.max(1, (p.max - p.min) * mid * 0.9))
      }
      if (state.cutPlan) {
        const dur = state.project?.mixdown?.durationMs ?? 1
        for (const region of state.cutPlan.cutRegions) {
          const x0 = (region.startMs / dur) * w
          const x1 = (region.endMs / dur) * w
          const rw = Math.max(2, x1 - x0)
          ctx.fillStyle = 'rgba(239, 68, 68, 0.35)'
          ctx.fillRect(x0, 0, rw, h)
          ctx.fillStyle = 'rgba(239, 68, 68, 0.7)'
          ctx.fillRect(x0, 0, rw, 2)
          ctx.fillRect(x0, h - 2, rw, 2)
          if (rw > 32) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.7)'
            ctx.font = '10px sans-serif'
            ctx.fillText('CUT', x0 + 4, 14)
          }
        }
      }
    } else if (state.project) {
      ctx.fillStyle = '#27272a'
      for (let x = 0; x < w; x += 6) ctx.fillRect(x, h / 2 - 1, 3, 2)
    }
  }, [peaks, state.cutPlan, state.project, zoom])

  /* ── seeking on the waveform ──────────────────────────────────────────── */

  const timeAt = useCallback(
    (clientX: number, lane: HTMLElement) => {
      const rect = lane.getBoundingClientRect()
      if (rect.width === 0 || totalMs === 0) return 0
      return clamp(((clientX - rect.left) / rect.width) * totalMs, 0, totalMs)
    },
    [totalMs],
  )

  const onWavePointer = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (totalMs === 0) return
    seek(timeAt(e.clientX, e.currentTarget))
  }

  /* ── lane drags (trim edges / prop ranges) ────────────────────────────── */

  const startLaneDrag = (kind: LaneDrag['kind'], id: string, e: ReactPointerEvent<HTMLElement>) => {
    const lane = e.currentTarget.closest('[data-lane]')
    if (!(lane instanceof HTMLElement)) return
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { kind, id, totalMs, laneWidth: lane.getBoundingClientRect().width, lastClientX: e.clientX }
  }

  const onLanePointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag || drag.laneWidth === 0) return
    const dt = ((e.clientX - drag.lastClientX) / drag.laneWidth) * drag.totalMs
    drag.lastClientX = e.clientX

    if (drag.kind === 'clip-start' || drag.kind === 'clip-end') {
      trimClipBy(drag.id, drag.kind === 'clip-start' ? Math.max(0, dt) : 0, drag.kind === 'clip-end' ? Math.max(0, -dt) : 0)
    } else {
      const prop = state.props.find((p) => p.id === drag.id)
      if (!prop) return
      const maxEnd = state.project?.durationMs ?? totalMs
      if (drag.kind === 'prop-start') {
        setPropRange(drag.id, clamp(prop.range.startMs + dt, 0, prop.range.endMs - 50), prop.range.endMs)
      } else {
        setPropRange(drag.id, prop.range.startMs, clamp(prop.range.endMs + dt, prop.range.startMs + 50, maxEnd))
      }
    }
  }

  const endLaneDrag = () => {
    dragRef.current = null
  }

  /* ── dropping media onto the track ────────────────────────────────────── */

  const carriesMedia = (e: DragEvent<HTMLDivElement>): boolean => {
    const types = Array.from(e.dataTransfer.types)
    return types.includes('Files') || isMediaDrag(e.dataTransfer)
  }

  const onTimelineDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!carriesMedia(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (!dropActive) setDropActive(true)
  }

  const onTimelineDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!carriesMedia(e)) return
    e.preventDefault()
    setDropActive(false)
    const assetId = readMediaDragId(e.dataTransfer)
    if (assetId) {
      addTimelineClip(assetId)
      return
    }
    const files = Array.from(e.dataTransfer.files ?? []).filter((file) => mediaKindOf(file.type, file.name) !== null)
    // Imports append their full clip at the end of the track, so dropping a
    // fresh PNG here uses the exact same path as the rail's Browse button.
    files.forEach((file) => importMedia(file))
  }

  /* ── percent helpers ──────────────────────────────────────────────────── */

  const pct = (ms: number) => (totalMs === 0 ? 0 : (ms / totalMs) * 100)
  const hasMedia = state.project !== null
  const empty = totalMs === 0

  return (
    <section className="shrink-0 border-t border-line p-3">
      <div className="mx-auto w-full max-w-5xl space-y-2">
        <div className="flex items-center justify-between text-[11px] text-zinc-400">
          <div className="flex items-center gap-2">
            <span className="font-semibold uppercase tracking-[0.14em] text-zinc-300">Timeline</span>
            {state.cutPlan !== null ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
                <span className="size-1.5 rounded-full bg-emerald-400" />
                Silence Cut Applied ({clipsOfSource(state, state.activeVideoId ?? '').length} clips)
              </span>
            ) : hasMedia ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-800/80 px-2 py-0.5 text-[10px] text-zinc-400">
                Full original source (uncut)
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-3 text-[10px]">
            <span className="tabular-nums text-zinc-400">
              {state.clips.length} clip{state.clips.length === 1 ? '' : 's'} · {state.props.length} prop
              {state.props.length === 1 ? '' : 's'}
            </span>
            {hasMedia && <span className="hidden text-zinc-600 sm:inline">roller = zoom</span>}
          </div>
        </div>

        {/* zoom controls — lanes below widen with the factor and scroll horizontally */}
        {hasMedia && (
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              aria-label="Zoom out timeline"
              onClick={() => setZoom((z) => Math.max(1, z - ZOOM_STEP))}
              disabled={zoom <= 1}
              className="rounded border border-line px-2 py-0.5 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-800/70 disabled:opacity-40"
            >
              −
            </button>
            <span className="w-9 text-center text-[10px] tabular-nums text-zinc-400">{zoom.toFixed(1)}x</span>
            <button
              type="button"
              aria-label="Zoom in timeline"
              onClick={() => setZoom((z) => Math.min(ZOOM_MAX, z + ZOOM_STEP))}
              disabled={zoom >= ZOOM_MAX}
              className="rounded border border-line px-2 py-0.5 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-800/70 disabled:opacity-40"
            >
              +
            </button>
            <button
              type="button"
              onClick={() => setZoom(1)}
              disabled={zoom === 1}
              className="rounded border border-line px-2 py-0.5 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-800/70 disabled:opacity-40"
            >
              Reset
            </button>
          </div>
        )}

        {/* one waveform "track" per imported source; click switches the edit target */}
        {state.videos.length > 1 && (
          <div className="space-y-1">
            {state.videos.map((video) => (
              <SourceRow
                key={video.id}
                video={video}
                active={video.id === state.activeVideoId}
                onSelect={() => selectVideo(video.id)}
              />
            ))}
          </div>
        )}

        <div
          ref={scrollRef}
          onDragOver={onTimelineDragOver}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropActive(false)
          }}
          onDrop={onTimelineDrop}
          className={`overflow-x-auto overflow-y-hidden rounded-lg transition-shadow ${
            dropActive ? 'ring-1 ring-accent/80' : ''
          }`}
          style={{ maxHeight: 240 }}
        >
          <div
            ref={lanesRef}
            className="relative space-y-2"
            data-all-lanes
            style={{ width: `${zoom * 100}%`, minWidth: '100%' }}
          >
            {state.cutPlan === null ? (
              <canvas
                ref={waveRef}
                width={1200 * zoom}
                height={WAVE_HEIGHT}
                onPointerDown={onWavePointer}
                onPointerMove={(e) => {
                  if (e.buttons === 1) onWavePointer(e)
                }}
                className={`w-full rounded-lg ${empty ? 'cursor-default' : 'cursor-pointer'}`}
                style={{ height: WAVE_HEIGHT }}
                aria-label="Audio waveform"
              />
            ) : (
              <div
                role="img"
                aria-label="Audio waveform hidden"
                className="grid w-full place-items-center rounded-lg bg-zinc-900"
                style={{ height: WAVE_HEIGHT }}
              >
                <span className="text-[11px] text-zinc-600">Waveform hidden — clips built from silence cut</span>
              </div>
            )}

            {/* clip lane */}
            <div className="relative h-9 overflow-hidden rounded-lg bg-zinc-900" data-lane>
              {empty && (
                <span className="absolute inset-0 grid place-items-center text-[11px] text-zinc-600">
                  {hasMedia ? 'Track empty — add a clip from the media panel' : 'Import video or images to begin'}
                </span>
              )}
              {state.clips.map((clip, i) => {
                const startTL = timelineStartOfClip(state.clips, i)
                const span = clip.srcEndMs - clip.srcStartMs
                const source = clipVideoSource(state, clip)
                return (
                  <div
                    key={clip.id}
                    className="group absolute inset-y-0 flex cursor-pointer items-center overflow-hidden rounded-md border border-zinc-700 bg-zinc-800/80 text-[10px] text-zinc-300 transition-colors hover:border-accent/70"
                    style={{
                      left: `${pct(startTL)}%`,
                      width: `max(0.5%, ${pct(span)}%)`,
                      background:
                        source?.kind === 'image'
                          ? 'rgba(139, 92, 246, 0.16)'
                          : clip.zoom > 1
                            ? 'rgba(139, 92, 246, 0.25)'
                            : undefined,
                    }}
                    title={`${source?.fileName ?? clip.id}${source?.kind === 'image' ? ' · still image' : ''} · zoom ${Math.round(clip.zoom * 100)}% · double-click to split`}
                    onDoubleClick={() => splitClipAt(clip.id, state.playheadMs)}
                    onClick={() => seek(startTL)}
                  >
                    {source?.kind === 'image' && (
                      <span aria-hidden className="ml-1 shrink-0 text-[8px] font-semibold uppercase tracking-wide text-accent">
                        IMG
                      </span>
                    )}
                    <span className="truncate px-1.5">{source?.fileName ?? clip.id}</span>
                    <ClipDeleteButton clipId={clip.id} />
                    <div
                      role="separator"
                      aria-label="Trim clip start"
                      className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-accent/40 hover:bg-accent"
                      onPointerDown={(e) => startLaneDrag('clip-start', clip.id, e)}
                      onPointerMove={onLanePointerMove}
                      onPointerUp={endLaneDrag}
                      onPointerCancel={endLaneDrag}
                    />
                    <div
                      role="separator"
                      aria-label="Trim clip end"
                      className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-accent/40 hover:bg-accent"
                      onPointerDown={(e) => startLaneDrag('clip-end', clip.id, e)}
                      onPointerMove={onLanePointerMove}
                      onPointerUp={endLaneDrag}
                      onPointerCancel={endLaneDrag}
                    />
                  </div>
                )
              })}
            </div>

            {/* prop lane */}
            <div className="relative h-7 overflow-hidden rounded-lg bg-zinc-900" data-lane>
              {state.props.length === 0 && (
                <span className="absolute inset-0 grid place-items-center text-[11px] text-zinc-600">Props overlay track</span>
              )}
              {state.props.map((prop) => (
                <div
                  key={prop.id}
                  role="button"
                  tabIndex={0}
                  className={`absolute inset-y-0 flex cursor-pointer items-center overflow-hidden rounded-md border px-1.5 text-[10px] ${
                    state.selectedPropId === prop.id
                      ? 'border-accent bg-accent/20 text-zinc-100'
                      : 'border-zinc-700 bg-zinc-800/60 text-zinc-300'
                  }`}
                  style={{ left: `${pct(prop.range.startMs)}%`, width: `max(0.5%, ${pct(prop.range.endMs - prop.range.startMs)}%)` }}
                  onClick={() => selectProp(prop.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') selectProp(prop.id)
                  }}
                >
                  <span className="truncate">{prop.name}</span>
                  <div
                    role="separator"
                    aria-label="Prop in-point"
                    className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-emerald-400/40 hover:bg-emerald-400"
                    onPointerDown={(e) => startLaneDrag('prop-start', prop.id, e)}
                    onPointerMove={onLanePointerMove}
                    onPointerUp={endLaneDrag}
                    onPointerCancel={endLaneDrag}
                  />
                  <div
                    role="separator"
                    aria-label="Prop out-point"
                    className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-emerald-400/40 hover:bg-emerald-400"
                    onPointerDown={(e) => startLaneDrag('prop-end', prop.id, e)}
                    onPointerMove={onLanePointerMove}
                    onPointerUp={endLaneDrag}
                    onPointerCancel={endLaneDrag}
                  />
                </div>
              ))}
            </div>

            {/* playhead spanning waveform + lanes */}
            {!empty && (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-y-0 w-px bg-accent"
                style={{ left: `${clamp(pct(state.playheadMs), 0, 100)}%` }}
              />
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

interface SourceRowProps {
  video: VideoSource
  active: boolean
  onSelect: () => void
}

/**
 * One imported video as a compact waveform "track" row. Clicking switches the
 * active editing source (VIDEO_SELECTED); the active row is marked by the
 * accent dot and lighter peaks.
 */
function SourceRow({ video, active, onSelect }: SourceRowProps) {
  const waveRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = waveRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const w = canvas.width
    const h = canvas.height
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#18181b'
    ctx.fillRect(0, 0, w, h)

    const mixdown = video.mixdown
    if (!mixdown) {
      // dotted placeholder while this source is still decoding
      ctx.fillStyle = '#27272a'
      for (let x = 0; x < w; x += 6) ctx.fillRect(x, h / 2 - 1, 3, 2)
      return
    }
    const peaks = computePeaks(mixdown.samples, 1200)
    const peakW = w / peaks.length
    const mid = h / 2
    ctx.fillStyle = active ? '#52525b' : '#3f3f46'
    for (let i = 0; i < peaks.length; i++) {
      const p = peaks[i]
      ctx.fillRect(i * peakW, mid + p.min * mid * 0.9, peakW, Math.max(1, (p.max - p.min) * mid * 0.9))
    }
  }, [video.mixdown, active])

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex h-10 w-full items-center gap-2 rounded-lg border px-2 py-1 text-left transition-colors ${
        active ? 'border-accent/60 bg-zinc-900' : 'border-line hover:border-zinc-600'
      }`}
      title={active ? `${video.fileName} (editing)` : `Switch to ${video.fileName}`}
    >
      <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${active ? 'bg-accent' : 'bg-zinc-600'}`} />
      <span className="w-28 shrink-0 truncate text-[10px] text-zinc-400">{video.fileName}</span>
      <canvas
        ref={waveRef}
        width={1200}
        height={28}
        className="h-6 min-w-0 flex-1 rounded"
        style={{ height: 24 }}
        aria-label={`${active ? 'Editing' : 'Imported'} source ${video.fileName}`}
      />
      <span className="flex shrink-0 items-center gap-1.5 text-[10px] tabular-nums text-zinc-500">
        {video.kind === 'image' ? (
          <span className="rounded border border-accent/40 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-accent">
            IMG
          </span>
        ) : (
          video.mixdown === null && <span className="font-medium text-amber-400">analyzing…</span>
        )}
        {Math.round(video.durationMs / 100) / 10}s
      </span>
      {!active && <span className="shrink-0 text-[9px] uppercase tracking-wider text-zinc-600">switch</span>}
    </button>
  )
}
