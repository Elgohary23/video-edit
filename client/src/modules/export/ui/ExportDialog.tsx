import { useEditor } from '../../../app/state/EditorProvider'
import {
  AUDIO_BITRATE_OPTIONS,
  CODEC_LABELS,
  FRAME_RATE_PRESETS,
  RESOLUTION_PRESETS,
  formatFps,
} from '../settings'
import { isExportBusy, type ExportCodec, type ExportQuality, type ExportResolution } from '../types'
import { formatEta, stageLabel } from '../pipeline/progress'

const QUALITY_OPTIONS: Array<{ value: ExportQuality; label: string; hint: string }> = [
  { value: 'draft', label: 'Draft', hint: 'Fastest · larger file' },
  { value: 'standard', label: 'Standard', hint: 'Balanced' },
  { value: 'high', label: 'High', hint: 'Smaller file' },
  { value: 'ultra', label: 'Ultra', hint: 'Best quality · slow' },
]

/**
 * Export settings + live pipeline telemetry. The dialog is the only place
 * that starts/cancels an export, so cancellation is always available.
 */
export function ExportDialog() {
  const {
    state,
    setExportSettings,
    exportToMp4,
    cancelExport,
    closeExportDialog,
  } = useEditor()

  if (!state.exportDialogOpen) return null

  const settings = state.exportSettings
  const status = state.exportStatus
  const stage = status.stage ?? 'idle'
  const busy = isExportBusy(status)
  const showProgress = stage !== 'idle'
  const progress = Math.max(0, Math.min(1, status.progress ?? 0))
  const percent = Math.round(progress * 100)
  const fpsIsPreset = (FRAME_RATE_PRESETS as readonly number[]).includes(settings.fps)

  const chooseResolution = (resolution: ExportResolution) => {
    if (resolution === 'custom') {
      setExportSettings({ resolution })
      return
    }
    const preset = RESOLUTION_PRESETS[resolution]
    setExportSettings({ resolution, width: preset.width, height: preset.height })
  }

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/70 p-3 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Export video"
        className="max-h-[92dvh] w-full max-w-xl overflow-y-auto rounded-2xl border border-line bg-zinc-950 p-4 shadow-2xl sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold tracking-tight text-zinc-100">Export video</h2>
            <p className="mt-1 text-xs text-zinc-500">
              Offline frame-by-frame rendering · the preview stays responsive
            </p>
          </div>
          {!busy && (
            <button
              type="button"
              onClick={closeExportDialog}
              aria-label="Close export dialog"
              className="rounded-lg border border-line px-2 py-1 text-xs text-zinc-400 transition-colors hover:bg-zinc-800/70 hover:text-zinc-200"
            >
              Close
            </button>
          )}
        </div>

        {showProgress && (
          <div className="mt-4 rounded-xl border border-line bg-zinc-900/50 p-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-medium text-accent">{stageLabel(stage)}</span>
              <span className="text-lg font-semibold tabular-nums text-zinc-100">{percent}%</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-150"
                style={{ width: `${percent}%` }}
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px] text-zinc-500">
              <span className="truncate text-zinc-400">{status.detail || stageLabel(stage)}</span>
              {status.totalFrames !== undefined && status.totalFrames > 0 && (
                <span className="tabular-nums">
                  Frame {status.frame ?? 0} / {status.totalFrames}
                </span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-500">
              <span>ETA {formatEta(status.etaMs ?? null)}</span>
              {status.renderFps != null && <span>{status.renderFps.toFixed(1)} fps render</span>}
              {status.encodingSpeed != null && <span>{status.encodingSpeed.toFixed(2)}× encode</span>}
            </div>
            {status.error && <p className="mt-2 text-xs text-red-400">{status.error}</p>}
            {busy && (
              <button
                type="button"
                onClick={cancelExport}
                className="mt-3 w-full rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800/70"
              >
                Cancel export
              </button>
            )}
          </div>
        )}

        <div className={`mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 ${busy ? 'pointer-events-none opacity-50' : ''}`}>
          <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
            Quality
            <select
              value={settings.quality}
              disabled={busy}
              onChange={(event) => setExportSettings({ quality: event.target.value as ExportQuality })}
              className="rounded-lg border border-line bg-zinc-900 px-2.5 py-2 text-xs text-zinc-200 outline-none focus:border-accent"
            >
              {QUALITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label} — {option.hint}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
            Resolution
            <select
              value={settings.resolution}
              disabled={busy}
              onChange={(event) => chooseResolution(event.target.value as ExportResolution)}
              className="rounded-lg border border-line bg-zinc-900 px-2.5 py-2 text-xs text-zinc-200 outline-none focus:border-accent"
            >
              {(Object.entries(RESOLUTION_PRESETS) as Array<[Exclude<ExportResolution, 'custom'>, (typeof RESOLUTION_PRESETS)[keyof typeof RESOLUTION_PRESETS]]>).map(
                ([value, preset]) => (
                  <option key={value} value={value}>
                    {preset.label}
                  </option>
                ),
              )}
              <option value="custom">Custom</option>
            </select>
          </label>

          {settings.resolution === 'custom' && (
            <>
              <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
                Width (px)
                <input
                  type="number"
                  min={16}
                  max={7680}
                  step={2}
                  value={settings.width}
                  disabled={busy}
                  onChange={(event) =>
                    setExportSettings({ resolution: 'custom', width: Number(event.target.value), height: settings.height })
                  }
                  className="rounded-lg border border-line bg-zinc-900 px-2.5 py-2 text-xs tabular-nums text-zinc-200 outline-none focus:border-accent"
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
                Height (px)
                <input
                  type="number"
                  min={16}
                  max={7680}
                  step={2}
                  value={settings.height}
                  disabled={busy}
                  onChange={(event) =>
                    setExportSettings({ resolution: 'custom', width: settings.width, height: Number(event.target.value) })
                  }
                  className="rounded-lg border border-line bg-zinc-900 px-2.5 py-2 text-xs tabular-nums text-zinc-200 outline-none focus:border-accent"
                />
              </label>
            </>
          )}

          <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
            Frame rate
            <select
              value={fpsIsPreset ? String(settings.fps) : 'custom'}
              disabled={busy}
              onChange={(event) => {
                if (event.target.value === 'custom') {
                  setExportSettings({ fps: fpsIsPreset ? 25 : settings.fps })
                  return
                }
                setExportSettings({ fps: Number(event.target.value) })
              }}
              className="rounded-lg border border-line bg-zinc-900 px-2.5 py-2 text-xs text-zinc-200 outline-none focus:border-accent"
            >
              {FRAME_RATE_PRESETS.map((fps) => (
                <option key={fps} value={fps}>
                  {fps} FPS{fps === 120 ? ' (experimental)' : ''}
                </option>
              ))}
              <option value="custom">Custom</option>
            </select>
          </label>

          {!fpsIsPreset && (
            <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
              Custom FPS
              <input
                type="number"
                min={1}
                max={120}
                step={1}
                value={settings.fps}
                disabled={busy}
                onChange={(event) => setExportSettings({ fps: Number(event.target.value) })}
                className="rounded-lg border border-line bg-zinc-900 px-2.5 py-2 text-xs tabular-nums text-zinc-200 outline-none focus:border-accent"
              />
            </label>
          )}

          <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
            Codec
            <select
              value={settings.codec}
              disabled={busy}
              onChange={(event) => setExportSettings({ codec: event.target.value as ExportCodec })}
              className="rounded-lg border border-line bg-zinc-900 px-2.5 py-2 text-xs text-zinc-200 outline-none focus:border-accent"
            >
              {(Object.entries(CODEC_LABELS) as Array<[ExportCodec, string]>).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
            Video bitrate
            <select
              value={settings.bitrate === null ? 'auto' : 'custom'}
              disabled={busy}
              onChange={(event) =>
                setExportSettings({ bitrate: event.target.value === 'auto' ? null : settings.bitrate ?? 8000 })
              }
              className="rounded-lg border border-line bg-zinc-900 px-2.5 py-2 text-xs text-zinc-200 outline-none focus:border-accent"
            >
              <option value="auto">Auto (quality based)</option>
              <option value="custom">Custom</option>
            </select>
          </label>

          {settings.bitrate !== null && (
            <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
              Bitrate (kbps)
              <input
                type="number"
                min={100}
                max={200000}
                step={100}
                value={settings.bitrate}
                disabled={busy}
                onChange={(event) => setExportSettings({ bitrate: Number(event.target.value) })}
                className="rounded-lg border border-line bg-zinc-900 px-2.5 py-2 text-xs tabular-nums text-zinc-200 outline-none focus:border-accent"
              />
            </label>
          )}

          <label className="flex flex-col gap-1 text-[11px] text-zinc-500">
            Audio bitrate
            <select
              value={settings.audioBitrate}
              disabled={busy}
              onChange={(event) => setExportSettings({ audioBitrate: Number(event.target.value) })}
              className="rounded-lg border border-line bg-zinc-900 px-2.5 py-2 text-xs text-zinc-200 outline-none focus:border-accent"
            >
              {AUDIO_BITRATE_OPTIONS.map((bitrate) => (
                <option key={bitrate} value={bitrate}>
                  {bitrate} kbps
                </option>
              ))}
            </select>
          </label>

          <div className="flex items-end pb-1 text-[11px] text-zinc-500 sm:col-span-2">
            Output: {settings.width}×{settings.height} @ {formatFps(settings.fps)} FPS ·{' '}
            {CODEC_LABELS[settings.codec]}
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          {!busy && stage !== 'done' && (
            <button
              type="button"
              onClick={() => void exportToMp4()}
              className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90"
            >
              Start export
            </button>
          )}
          {stage === 'done' && (
            <>
              <span className="mr-auto text-xs text-zinc-400">Export complete.</span>
              <button
                type="button"
                onClick={closeExportDialog}
                className="rounded-lg border border-line px-4 py-2 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-800/70"
              >
                Done
              </button>
            </>
          )}
          {busy && <span className="mr-auto animate-pulse text-xs text-accent">Exporting…</span>}
        </div>
      </div>
    </div>
  )
}
