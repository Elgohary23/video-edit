import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useEditor } from '../../app/state/EditorProvider'
import { cn, clamp, formatTimecode } from '../shared/utils'
import { SCRUB_STEP_MS, scrubBounds, scrubValueToMs } from './engine'
import { timelineDurationMs } from '../timeline/engine'

interface FreedPos {
  /** Center point, viewport px. */
  left: number
  top: number
}

interface GripDrag {
  dx: number
  dy: number
  width: number
  height: number
  pointerId: number
}

const EDGE = 8

/**
 * Floating scan bar — a grip lets the user park it anywhere on screen, the
 * range input scrubs `playheadMs` across the timeline (preview updates live
 * through the rAF loop even while paused), and the transport button plays
 * from the scrub position. Fixed positioning keeps it above the shell.
 */
export function ScrubberBar() {
  const { state, seek, play, pause } = useEditor()
  const panelRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<GripDrag | null>(null)
  const [free, setFree] = useState<FreedPos | null>(null)
  const [dragging, setDragging] = useState(false)

  const totalMs = timelineDurationMs(state.clips)
  const bounds = scrubBounds(totalMs)
  const empty = totalMs === 0

  /* ── grip drag: move the bar anywhere (center-based px positioning) ── */

  const onGripDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !panelRef.current) return
    e.preventDefault()
    capturePointer(e)
    const rect = panelRef.current.getBoundingClientRect()
    const centerLeft = rect.left + rect.width / 2
    const centerTop = rect.top + rect.height / 2
    dragRef.current = { dx: e.clientX - centerLeft, dy: e.clientY - centerTop, width: rect.width, height: rect.height, pointerId: e.pointerId }
    setFree({ left: centerLeft, top: centerTop })
    setDragging(true)
  }

  const onGripMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (drag === null || e.pointerId !== drag.pointerId) return
    const halfW = drag.width / 2 + EDGE
    const halfH = drag.height / 2 + EDGE
    setFree({
      left: clamp(e.clientX - drag.dx, halfW, Math.max(halfW, window.innerWidth - halfW)),
      top: clamp(e.clientY - drag.dy, halfH, Math.max(halfH, window.innerHeight - halfH)),
    })
  }

  const onGripEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current !== null && e.pointerId !== dragRef.current.pointerId) return
    dragRef.current = null
    setDragging(false)
  }

  /* ── scanning + transport ───────────────────────────────────────────── */

  const onScrub = (raw: number) => seek(scrubValueToMs(raw, totalMs))

  const togglePlay = () => (state.playing ? pause() : play())

  return (
    <div
      ref={panelRef}
      data-scrubber-bar
      className={cn(
        'fixed z-30 flex max-w-[calc(100vw-1.5rem)] items-center gap-2.5 rounded-xl border border-line bg-zinc-900/85 py-2 pl-2.5 pr-3 shadow-xl backdrop-blur-sm',
        free === null && 'bottom-9 left-1/2 -translate-x-1/2',
      )}
      style={free === null ? undefined : { left: free.left, top: free.top, transform: 'translate(-50%, -50%)' }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-label="Move scan bar"
        title="Drag to move the scan bar anywhere"
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripEnd}
        onPointerCancel={onGripEnd}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setFree(null)
        }}
        className={cn(
          'size-5 shrink-0 cursor-grab touch-none rounded-full active:cursor-grabbing',
          'bg-[radial-gradient(currentColor_1px,transparent_1px)] bg-[length:3px_3px] bg-center bg-no-repeat text-zinc-600 hover:text-zinc-400',
          dragging && 'text-accent',
        )}
      />

      <button
        type="button"
        onClick={togglePlay}
        disabled={empty}
        aria-label={state.playing ? 'Pause' : 'Play'}
        className="grid size-8 shrink-0 place-items-center rounded-full border border-line transition-colors hover:bg-zinc-800/70 disabled:opacity-40"
      >
        {state.playing ? (
          <svg viewBox="0 0 24 24" className="size-4 fill-current" aria-hidden>
            <path d="M8 5h3v14H8zM13 5h3v14h-3z" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="size-4 fill-current" aria-hidden>
            <path d="M8 5l11 7-11 7z" />
          </svg>
        )}
      </button>

      <span className="shrink-0 tabular-nums text-[11px] text-zinc-400" aria-live="off">
        {formatTimecode(state.playheadMs)} <span className="text-zinc-600">/ {formatTimecode(totalMs)}</span>
      </span>

      {empty ? (
        <span className="shrink-0 select-none text-[10px] uppercase tracking-[0.14em] text-zinc-600">No timeline</span>
      ) : (
        <input
          type="range"
          min={bounds.min}
          max={bounds.max}
          step={SCRUB_STEP_MS}
          value={clamp(Math.round(state.playheadMs), bounds.min, bounds.max)}
          onChange={(e) => onScrub(Number(e.target.value))}
          aria-label="Scan timeline"
          className="w-40 accent-accent sm:w-64"
        />
      )}
    </div>
  )
}

function capturePointer(e: ReactPointerEvent<HTMLDivElement>): void {
  try {
    e.currentTarget.setPointerCapture(e.pointerId)
  } catch {
    // jsdom / disabled capture: drag still tracks via move events on the same element
  }
}
