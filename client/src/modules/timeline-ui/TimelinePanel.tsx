import { useCallback, useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { useEditor } from '../../app/state/EditorProvider'
import { computePeaks } from '../audio-analysis/engine'
import { timelineDurationMs, timelineStartOfClip } from '../timeline/engine'
import { clamp } from '../shared/utils'
import { ClipDeleteButton } from './ClipDeleteButton'

const WAVE_HEIGHT = 72

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
  const { state, seek, splitClipAt, trimClipBy, setPropRange, selectProp } = useEditor()

  const waveRef = useRef<HTMLCanvasElement>(null)
  const totalMs = timelineDurationMs(state.clips)
  const dragRef = useRef<LaneDrag | null>(null)

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
  }, [peaks, state.cutPlan, state.project])

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
                Silence Cut Applied ({state.clips.length} clips)
              </span>
            ) : hasMedia ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-800/80 px-2 py-0.5 text-[10px] text-zinc-400">
                Full original source (uncut)
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-3 text-[10px]">
            {state.cutPlan !== null && (
              <span className="flex items-center gap-1 text-zinc-400">
                <span className="inline-block size-2 rounded-xs bg-red-500/50" />
                Red zones = Removed silence
              </span>
            )}
            <span className="tabular-nums text-zinc-400">
              {state.clips.length} clip{state.clips.length === 1 ? '' : 's'} · {state.props.length} prop
              {state.props.length === 1 ? '' : 's'}
            </span>
          </div>
        </div>

        <div className="relative space-y-2" data-all-lanes>
          <canvas
            ref={waveRef}
            width={1200}
            height={WAVE_HEIGHT}
            onPointerDown={onWavePointer}
            onPointerMove={(e) => {
              if (e.buttons === 1) onWavePointer(e)
            }}
            className={`w-full rounded-lg ${empty ? 'cursor-default' : 'cursor-pointer'}`}
            style={{ height: WAVE_HEIGHT }}
            aria-label="Audio waveform"
          />

          {/* clip lane */}
          <div className="relative h-9 overflow-hidden rounded-lg bg-zinc-900" data-lane>
            {empty && (
              <span className="absolute inset-0 grid place-items-center text-[11px] text-zinc-600">
                {hasMedia ? 'Run "Apply silence cut" to build clips' : 'Import a video to begin'}
              </span>
            )}
            {state.clips.map((clip, i) => {
              const startTL = timelineStartOfClip(state.clips, i)
              const span = clip.srcEndMs - clip.srcStartMs
              return (
                <div
                  key={clip.id}
                  className="group absolute inset-y-0 flex cursor-pointer items-center overflow-hidden rounded-md border border-zinc-700 bg-zinc-800/80 text-[10px] text-zinc-300 transition-colors hover:border-accent/70"
                  style={{
                    left: `${pct(startTL)}%`,
                    width: `max(0.5%, ${pct(span)}%)`,
                    background: clip.zoom > 1 ? 'rgba(139, 92, 246, 0.25)' : undefined,
                  }}
                  title={`${clip.id} (zoom ${Math.round(clip.zoom * 100)}% · double-click to split)`}
                  onDoubleClick={() => splitClipAt(clip.id, state.playheadMs)}
                  onClick={() => seek(startTL)}
                >
                  <span className="truncate px-1.5">{clip.id}</span>
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
    </section>
  )
}
