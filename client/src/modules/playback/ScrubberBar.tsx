import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
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
 * Floating scan bar — a grip lets the user park it anywhere on screen.
 *
 * Scrubbing is a pointer-owned session: grabbing the range pauses the media,
 * the local draft value owns the thumb (rAF cannot overwrite it), and release
 * resumes from the exact release position if playback was running. Keyboard
 * frame-step and loop controls are wired globally by the provider.
 */
export function ScrubberBar() {
  const { state, seek, play, pause, beginScrub, endScrub, stepFrames, toggleLoop, clearLoop } = useEditor()
  const panelRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<GripDrag | null>(null)
  const [free, setFree] = useState<FreedPos | null>(null)
  const [dragging, setDragging] = useState(false)

  /** Non-null only while the pointer owns the range; external state can't win. */
  const [draftMs, setDraftMs] = useState<number | null>(null)
  const [scrubActive, setScrubActive] = useState(false)
  const scrubActiveRef = useRef(false)
  const draftRef = useRef<number | null>(null)
  /** Whether playback was running when the thumb was grabbed. */
  const resumeRef = useRef(false)

  const totalMs = timelineDurationMs(state.clips)
  const bounds = scrubBounds(totalMs)
  const empty = totalMs === 0
  const displayMs = draftMs ?? state.playheadMs

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

  /* ── pointer-owned scrub session ──────────────────────────────────────── */

  const startScrub = () => {
    if (scrubActiveRef.current) return
    resumeRef.current = state.playing
    scrubActiveRef.current = true
    setScrubActive(true)
    // Provider pauses the media synchronously and sets the reducer scrub flag;
    // the rAF loop will only follow the user's seek target from here on.
    beginScrub()
  }

  const finishScrub = useCallback(
    (stayPaused: boolean) => {
      if (!scrubActiveRef.current) return
      scrubActiveRef.current = false
      const shouldResume = resumeRef.current
      const releaseMs = draftRef.current ?? state.playheadMs
      resumeRef.current = false
      draftRef.current = null
      setScrubActive(false)
      setDraftMs(null)
      endScrub()
      // Alt-on-release is an explicit "park here and stay paused" gesture;
      // otherwise a running transport resumes through the acyclic play gate.
      if (shouldResume && !stayPaused) play(releaseMs)
    },
    [endScrub, play, state.playheadMs],
  )

  useEffect(() => {
    if (!scrubActive) return
    const onPointerUp = (e: PointerEvent) => finishScrub(e.altKey)
    const onPointerCancel = () => finishScrub(true)
    const onWindowBlur = () => finishScrub(true)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
    window.addEventListener('blur', onWindowBlur)
    return () => {
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
      window.removeEventListener('blur', onWindowBlur)
    }
  }, [finishScrub, scrubActive])

  // Never leave the reducer stuck in "scrubbing" if the bar unmounts mid-drag.
  useEffect(
    () => () => {
      if (scrubActiveRef.current) {
        scrubActiveRef.current = false
        endScrub()
      }
    },
    [endScrub],
  )

  const onScrub = (raw: number) => {
    const value = scrubValueToMs(raw, totalMs)
    if (scrubActiveRef.current) {
      draftRef.current = value
      setDraftMs(value)
    }
    seek(value)
  }

  const togglePlay = () => (state.playing ? pause() : play())
  const hasLoop = state.loopRegion !== null

  return (
    <div
      ref={panelRef}
      data-scrubber-bar
      data-scrubbing={scrubActive ? 'true' : undefined}
      className={cn(
        'fixed z-30 flex max-w-[calc(100vw-1.5rem)] items-center gap-2 rounded-xl border border-line bg-zinc-900/85 py-2 pl-2.5 pr-3 shadow-xl backdrop-blur-sm',
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

      <div className="hidden items-center sm:flex">
        <button
          type="button"
          onClick={() => stepFrames(-1)}
          disabled={empty}
          aria-label="Step back one frame"
          title="Step back one frame (, or ←)"
          className="grid size-7 place-items-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-800/70 hover:text-zinc-100 disabled:opacity-40"
        >
          <svg viewBox="0 0 24 24" className="size-3.5 fill-current" aria-hidden>
            <path d="M6 5h2v14H6zM19 5l-9 7 9 7z" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => stepFrames(1)}
          disabled={empty}
          aria-label="Step forward one frame"
          title="Step forward one frame (. or →)"
          className="grid size-7 place-items-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-800/70 hover:text-zinc-100 disabled:opacity-40"
        >
          <svg viewBox="0 0 24 24" className="size-3.5 fill-current" aria-hidden>
            <path d="M16 5h2v14h-2zM5 5l9 7-9 7z" />
          </svg>
        </button>
      </div>

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

      <span className="hidden shrink-0 tabular-nums text-[11px] text-zinc-400 sm:inline" aria-live="off">
        {formatTimecode(displayMs)} <span className="text-zinc-600">/ {formatTimecode(totalMs)}</span>
      </span>

      {empty ? (
        <span className="shrink-0 select-none text-[10px] uppercase tracking-[0.14em] text-zinc-600">No timeline</span>
      ) : (
        <input
          type="range"
          min={bounds.min}
          max={bounds.max}
          step={SCRUB_STEP_MS}
          value={clamp(Math.round(displayMs), bounds.min, bounds.max)}
          onPointerDown={(e) => {
            if (e.button === 0) startScrub()
          }}
          onPointerUp={(e) => finishScrub(e.altKey)}
          onPointerCancel={() => finishScrub(true)}
          onChange={(e) => onScrub(Number(e.target.value))}
          aria-label="Scan timeline"
          aria-valuetext={formatTimecode(displayMs)}
          title="Drag to scrub · Alt-release to stay parked"
          className="w-32 accent-accent sm:w-64"
        />
      )}

      <button
        type="button"
        onClick={toggleLoop}
        disabled={empty || !hasLoop}
        aria-pressed={state.loopEnabled}
        aria-label={state.loopEnabled ? 'Disable loop playback' : 'Enable loop playback'}
        title={
          hasLoop && state.loopRegion
            ? `Loop ${formatTimecode(state.loopRegion.startMs)}–${formatTimecode(state.loopRegion.endMs)} (P). Mark with I / O.`
            : 'Mark a loop with I (in) and O (out)'
        }
        className={cn(
          'shrink-0 rounded-md border px-1.5 py-1 text-[9px] font-semibold uppercase tracking-[0.1em] transition-colors disabled:opacity-35',
          state.loopEnabled
            ? 'border-accent/70 bg-accent/15 text-accent'
            : 'border-line text-zinc-500 hover:text-zinc-300',
        )}
      >
        Loop
      </button>

      {hasLoop && (
        <button
          type="button"
          onClick={clearLoop}
          aria-label="Clear loop region"
          title="Clear loop in/out (Shift+P)"
          className="shrink-0 rounded-md px-1 py-1 text-[11px] leading-none text-zinc-500 transition-colors hover:text-zinc-200"
        >
          ×
        </button>
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
