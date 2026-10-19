import { useRef, type DragEvent } from 'react'
import { useEditor } from '../../app/state/EditorProvider'
import { clipsOfSource } from '../../app/state/editor'
import { PanelSection } from '../shared/ui/PanelSection'
import { MOTION_PRESET_NAMES, type MotionPresetName } from '../motion/engine'

function SliderRow({ label, value, min, max, step, suffix, onChange }: {
  label: string
  value: number
  min: number
  max: number
  step: number
  suffix: string
  onChange: (value: number) => void
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-xs text-zinc-300">
      <span className="shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-24 flex-1 cursor-pointer appearance-none rounded-full bg-zinc-700 accent-accent sm:w-32"
        aria-label={label}
      />
      <span className="w-16 shrink-0 text-right tabular-nums text-zinc-400">
        {value}
        {suffix}
      </span>
    </label>
  )
}

/** Left rail: media import (single or multiple videos), jump-cut controls, blur, and props. */
export function MediaRail() {
  const { state, importVideo, selectVideo, addTimelineClip, setSilenceConfig, applySilenceCut, resetCuts, autoZoom, setBlurEnabled, setBlurPx, addProp, selectProp, removeProp, setPropPreset } = useEditor()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const propInputRef = useRef<HTMLInputElement>(null)

  const hasMedia = state.project !== null
  const hasMixdown = state.project?.mixdown !== null && state.project?.mixdown !== undefined
  const hasClips = state.clips.length > 0
  const isCutApplied = state.cutPlan !== null

  // Stats track the ACTIVE source only: the one track spans all imports.
  const activeClips = (state.activeVideoId !== null ? clipsOfSource(state, state.activeVideoId) : [])
  const origSec = Math.round((state.project?.durationMs ?? 0) / 100) / 10
  const cutSec = Math.round(activeClips.reduce((acc, c) => acc + (c.srcEndMs - c.srcStartMs), 0) / 100) / 10
  const savedSec = Math.max(0, Math.round((origSec - cutSec) * 10) / 10)
  const pctFaster = origSec > 0 ? Math.round((savedSec / origSec) * 100) : 0

  const onFileDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files ?? []).filter((f) => f.type === '' || f.type.startsWith('video/'))
    files.forEach((f) => importVideo(f))
  }

  return (
    <aside className="w-full min-w-0 shrink-0 space-y-5 overflow-y-auto border-b border-line p-3 lg:w-72 lg:border-b-0 lg:border-r">
      <PanelSection title="Media">
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={onFileDrop}
          className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-xs text-zinc-500 transition-colors hover:border-accent/60"
        >
          {hasMedia ? (
            <>
              <p className="truncate font-medium text-zinc-300" title={state.project?.fileName}>{state.project?.fileName}</p>
              <p className="mt-1 tabular-nums">{Math.round((state.project?.durationMs ?? 0) / 100) / 10}s source</p>
              <button
                type="button"
                onClick={() => addTimelineClip()}
                className="mt-2 text-[11px] text-accent underline-offset-2 hover:underline"
                title="Appends this full video as one more clip at the end of the timeline"
              >
                + Add to timeline
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="mt-2 block text-[11px] text-accent underline-offset-2 hover:underline"
              >
                Import another video
              </button>
            </>
          ) : (
            <>
              <p>Drag &amp; drop a video file here</p>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="mt-2 rounded-lg border border-line px-3 py-1.5 text-[11px] font-medium text-zinc-200 transition-colors hover:bg-zinc-800/70"
              >
                Browse files
              </button>
            </>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? [])
              files.forEach((f) => importVideo(f))
              e.target.value = ''
            }}
          />
          {state.videos.length > 1 && (
            <ul className="mt-3 space-y-1 border-t border-line pt-3">
              {state.videos.map((video) => {
                const active = video.id === state.activeVideoId
                return (
                  <li key={video.id}>
                    <div
                      role="button"
                      tabIndex={0}
                      title={active ? 'Currently editing' : `Switch to ${video.fileName}`}
                      onClick={() => selectVideo(video.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') selectVideo(video.id)
                      }}
                      className={`flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-left text-[11px] transition-colors ${
                        active ? 'bg-zinc-800/80 text-zinc-200' : 'text-zinc-500 hover:bg-zinc-800/40'
                      }`}
                    >
                      <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${active ? 'bg-accent' : 'bg-zinc-600'}`} />
                      <span className="min-w-0 flex-1 truncate">{video.fileName}</span>
                      <span className="shrink-0 tabular-nums text-zinc-600">
                        {Math.round(video.durationMs / 100) / 10}s
                      </span>
                      <button
                        type="button"
                        aria-label={`Add ${video.fileName} to the timeline`}
                        title="Append this full video at the end of the timeline"
                        onClick={(e) => {
                          e.stopPropagation()
                          addTimelineClip(video.id)
                        }}
                        className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[11px] leading-none text-zinc-300 transition-colors hover:bg-zinc-700/60 hover:text-zinc-100"
                      >
                        +
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </PanelSection>

      <PanelSection title="Jump cut">
        <div className="space-y-2.5">
          <SliderRow label="Silence under" value={state.silenceConfig.thresholdDb} min={-70} max={-15} step={1} suffix="dB" onChange={(v) => setSilenceConfig({ thresholdDb: v })} />
          <SliderRow label="Min silence" value={state.silenceConfig.minSilenceMs} min={100} max={1500} step={50} suffix="ms" onChange={(v) => setSilenceConfig({ minSilenceMs: v })} />
          <SliderRow label="Padding" value={state.silenceConfig.paddingMs} min={0} max={400} step={10} suffix="ms" onChange={(v) => setSilenceConfig({ paddingMs: v })} />

          {/* Status banner */}
          {isCutApplied ? (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/30 p-2.5 text-xs space-y-1.5">
              <div className="flex items-center justify-between font-semibold text-emerald-400">
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400/50" />
                  Silence Cut Applied
                </span>
                <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-300 font-mono">
                  {activeClips.length} clips
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px] text-zinc-400 pt-1 border-t border-emerald-900/40">
                <span>Original: <strong className="text-zinc-200">{origSec}s</strong></span>
                <span>Trimmed: <strong className="text-emerald-300">{cutSec}s</strong></span>
                <span className="text-emerald-400 font-medium">-{savedSec}s ({pctFaster}%)</span>
              </div>
              <p className="text-[10px] text-zinc-400 leading-tight">
                {state.cutPlan?.cutRegions.length ?? 0} silent gaps eliminated. Playhead skips dead air automatically.
              </p>
            </div>
          ) : (
            <div className="flex items-center justify-between rounded-lg border border-zinc-700 bg-zinc-800/40 px-2.5 py-1.5 text-[11px] text-zinc-400">
              <span className="flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-amber-400" />
                Silence uncut (Full video)
              </span>
              <span className="text-[10px] text-zinc-500">Red = silence</span>
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={applySilenceCut}
              disabled={!hasMixdown}
              className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition-colors disabled:opacity-40 ${
                isCutApplied
                  ? 'border border-line bg-zinc-800/80 text-zinc-200 hover:bg-zinc-700'
                  : 'bg-accent text-white shadow-md hover:opacity-90'
              }`}
            >
              {isCutApplied ? '↻ Re-apply cut' : '✂ Apply silence cut'}
            </button>
            {isCutApplied && (
              <button
                type="button"
                onClick={resetCuts}
                className="rounded-lg border border-line px-2.5 py-2 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60"
                title="Restore uncut original video"
              >
                Reset
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={autoZoom}
            disabled={!hasClips}
            className="w-full rounded-lg border border-line px-3 py-2 text-xs font-medium text-zinc-100 transition-colors hover:bg-zinc-800/70 disabled:opacity-40"
          >
            Auto-zoom clips (100% ↔ 115%)
          </button>
        </div>
      </PanelSection>

      <PanelSection title="Background blur">
        <div className="flex items-center justify-between text-xs text-zinc-300">
          <span>Blur behind props</span>
          <button
            type="button"
            role="switch"
            aria-checked={state.blur.enabled}
            onClick={() => setBlurEnabled(!state.blur.enabled)}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${state.blur.enabled ? 'bg-accent' : 'bg-zinc-700'}`}
          >
            <span className={`inline-block size-4 translate-x-0.5 rounded-full bg-white transition-transform ${state.blur.enabled ? 'translate-x-4.5' : ''}`} />
          </button>
        </div>
        <SliderRow label="Blur strength" value={state.blur.px} min={0} max={30} step={1} suffix="px" onChange={setBlurPx} />
      </PanelSection>

      <PanelSection title="Props">
        <button
          type="button"
          onClick={() => propInputRef.current?.click()}
          className="w-full rounded-lg border border-line px-3 py-2 text-xs font-medium text-zinc-100 transition-colors hover:bg-zinc-800/70"
        >
          Import PNG prop
        </button>
        <input
          ref={propInputRef}
          type="file"
          accept="image/png"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) addProp(file)
            e.target.value = ''
          }}
        />
        <ul className="space-y-1.5">
          {state.props.map((prop) => {
            const selected = state.selectedPropId === prop.id
            return (
              <li key={prop.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => selectProp(prop.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') selectProp(prop.id)
                  }}
                  className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs transition-colors ${
                    selected ? 'border-accent/60 bg-zinc-800/60' : 'border-line hover:bg-zinc-800/40'
                  }`}
                >
                  <img src={prop.src} alt="" className="size-6 shrink-0 rounded object-contain" />
                  <span className="min-w-0 flex-1 truncate" title={prop.name}>{prop.name}</span>
                  <select
                    value={prop.preset}
                    onChange={(e) => setPropPreset(prop.id, e.target.value as MotionPresetName)}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Motion preset for ${prop.name}`}
                    className="rounded border border-line bg-zinc-900 px-1 py-0.5 text-[11px] text-zinc-300"
                  >
                    {MOTION_PRESET_NAMES.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    aria-label={`Remove ${prop.name}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      removeProp(prop.id)
                    }}
                    className="shrink-0 text-zinc-500 transition-colors hover:text-red-400"
                  >
                    ×
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      </PanelSection>
    </aside>
  )
}
