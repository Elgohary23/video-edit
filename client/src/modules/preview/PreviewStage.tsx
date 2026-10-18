import { useCallback, useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useEditor } from '../../app/state/EditorProvider'
import { formatTimecode } from '../shared/utils'
import { hitTest, type Handle, type NormalizedRect } from '../props/engine'
import { resolveMotion } from '../motion/engine'
import { timelineDurationMs } from '../timeline/engine'

interface DragSession {
  propId: string
  kind: 'body' | 'handle'
  handle?: Handle
  startClientX: number
  startClientY: number
  stageW: number
  stageH: number
}

/**
 * Preview stage — compositor canvas + interactive prop overlay + transport.
 * The canvas renders 1280×720 internally and scales to fit via CSS, so the
 * compositor math and exports share one fixed resolution.
 */
export function PreviewStage() {
  const { state, registerCanvas, play, pause, selectProp, movePropBy, resizePropBy, exportToMp4, importVideo, previewSize } = useEditor()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<DragSession | null>(null)

  useEffect(() => {
    registerCanvas(canvasRef.current)
    return () => registerCanvas(null)
  }, [registerCanvas])

  const totalMs = timelineDurationMs(state.clips)
  const isPlaying = state.playing
  const busy = state.exportStatus.phase !== null

  /* Prop drag/resize via pointer capture on the prop element itself. */

  const normalizedOf = useCallback((e: ReactPointerEvent) => {
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0) return null
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
      w: rect.width,
      h: rect.height,
    }
  }, [])

  const onPropPointerDown = (propId: string, propRect: NormalizedRect, e: ReactPointerEvent<HTMLDivElement>) => {
    if (busy) return
    const nx = normalizedOf(e)
    if (!nx) return
    e.stopPropagation()
    selectProp(propId)
    const hit = hitTest(propRect, nx.x, nx.y)
    if (!hit) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({
      propId,
      kind: hit.kind,
      handle: hit.kind === 'handle' ? hit.handle : undefined,
      startClientX: e.clientX,
      startClientY: e.clientY,
      stageW: nx.w,
      stageH: nx.h,
    })
  }

  const onPropPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || drag.propId !== e.currentTarget.dataset.propId) return
    const dxNorm = (e.clientX - drag.startClientX) / drag.stageW
    const dyNorm = (e.clientY - drag.startClientY) / drag.stageH
    if (drag.kind === 'body') {
      movePropBy(drag.propId, dxNorm, dyNorm)
    } else if (drag.handle) {
      resizePropBy(drag.propId, drag.handle, dxNorm, dyNorm)
    }
  }

  const endDrag = () => setDrag(null)

  const onStageClick = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('[data-prop-overlay]')) return
    selectProp(null)
  }

  const onStageDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    const file = e.dataTransfer.files?.[0]
    if (file) importVideo(file)
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-3 sm:p-4">
      <div
        ref={stageRef}
        onPointerDown={onStageClick}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onStageDrop}
        className="relative mx-auto aspect-video w-full max-w-5xl overflow-hidden rounded-xl border border-line bg-black"
      >
        <canvas
          ref={canvasRef}
          width={previewSize.width}
          height={previewSize.height}
          className="absolute inset-0 size-full"
          aria-label="Preview canvas"
        />

        {state.project === null && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-center text-sm text-zinc-500">
            <div>
              <p className="font-medium text-zinc-400">No media loaded</p>
              <p className="mt-1 text-xs">Drop a video file anywhere on this stage</p>
            </div>
          </div>
        )}

        {/* Prop overlays */}
        <div className="pointer-events-none absolute inset-0">
          {state.props.map((prop) => {
            const t = resolveMotion(prop.preset, state.playheadMs, prop.range.startMs, prop.range.endMs)
            if (t.opacity <= 0.01) return null
            const selected = state.selectedPropId === prop.id
            return (
              <div
                key={prop.id}
                data-prop-overlay={prop.id}
                data-prop-id={prop.id}
                onPointerDown={(e) => onPropPointerDown(prop.id, prop.rect, e)}
                onPointerMove={onPropPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                className={`pointer-events-auto absolute cursor-move touch-none rounded bg-contain bg-center bg-no-repeat transition-[box-shadow] ${
                  selected ? 'ring-1 ring-accent' : ''
                }`}
                style={{
                  left: `${prop.rect.x * 100}%`,
                  top: `${prop.rect.y * 100}%`,
                  width: `${prop.rect.w * 100}%`,
                  height: `${prop.rect.h * 100}%`,
                  backgroundImage: `url(${prop.src})`,
                  opacity: t.opacity,
                  transform: `translate(${t.offsetX * 100}%, ${t.offsetY * 100}%) scale(${t.scale})`,
                }}
              >
                {selected && (
                  <>
                    {(['nw', 'ne', 'sw', 'se'] as const).map((h) => (
                      <span
                        key={h}
                        aria-hidden
                        className={`absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-zinc-900 bg-accent ${
                          h === 'nw'
                            ? 'left-0 top-0 cursor-nwse-resize'
                            : h === 'ne'
                              ? 'left-full top-0 cursor-nesw-resize'
                              : h === 'sw'
                                ? 'left-0 top-full cursor-nesw-resize'
                                : 'left-full top-full cursor-nwse-resize'
                        }`}
                      />
                    ))}
                  </>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Transport */}
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-2 text-xs text-zinc-400">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => (isPlaying ? pause() : play())}
            disabled={totalMs === 0}
            aria-label={isPlaying ? 'Pause' : 'Play'}
            className="grid size-8 place-items-center rounded-full border border-line transition-colors hover:bg-zinc-800/70 disabled:opacity-40"
          >
            {isPlaying ? (
              <svg viewBox="0 0 24 24" className="size-4 fill-current" aria-hidden>
                <path d="M8 5h3v14H8zM13 5h3v14h-3z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="size-4 fill-current" aria-hidden>
                <path d="M8 5l11 7-11 7z" />
              </svg>
            )}
          </button>
          <span className="tabular-nums">
            {formatTimecode(state.playheadMs)} <span className="text-zinc-600">/ {formatTimecode(totalMs)}</span>
          </span>
        </div>

        <div className="flex items-center gap-2">
          {state.exportStatus.phase !== null && (
            <span className="animate-pulse text-accent">{state.exportStatus.detail || state.exportStatus.phase}</span>
          )}
          <button
            type="button"
            onClick={() => void exportToMp4()}
            disabled={totalMs === 0 || busy}
            className="rounded-lg bg-accent px-3 py-1.5 font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? 'Exporting…' : 'Export MP4'}
          </button>
        </div>
      </div>

      {/* Analysis progress */}
      {state.project !== null && state.project.mixdown === null && (
        <div className="mx-auto w-full max-w-5xl">
          <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-800">
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${state.analysisProgress * 100}%` }} />
          </div>
          <p className="mt-1 text-center text-[11px] text-zinc-500">Analyzing audio… {Math.round(state.analysisProgress * 100)}%</p>
        </div>
      )}
    </section>
  )
}
