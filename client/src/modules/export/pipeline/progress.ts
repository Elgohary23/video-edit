/**
 * Progress math for the export dialog.
 *
 * Overall progress is split into deterministic phase weights:
 *   0–3%   initialization / FFmpeg core
 *   3–8%   asset loading
 *   8–90%  render + audio + encode (per chunk, render-heavy)
 *   90–98% final concatenation
 *   100%   done
 */
import type { ExportProgress, ExportStage } from '../types'

export const STAGE_LABELS: Record<ExportStage, string> = {
  idle: 'Ready',
  initializing: 'Initializing',
  'loading-assets': 'Loading assets',
  rendering: 'Rendering frames',
  audio: 'Mixing audio',
  encoding: 'Encoding',
  finalizing: 'Finalizing',
  done: 'Done',
  cancelled: 'Cancelled',
  error: 'Failed',
}

export function stageLabel(stage: ExportStage): string {
  return STAGE_LABELS[stage]
}

export interface ProgressInput {
  stage: ExportStage
  chunksCompleted: number
  totalChunks: number
  /** Progress inside the chunk currently being rendered (0..1). */
  chunkRenderFraction?: number
  /** Progress inside the chunk currently being encoded (0..1). */
  chunkEncodeFraction?: number
  /** Progress of asset/core loading (0..1). */
  assetFraction?: number
  /** Progress of the final concat pass (0..1). */
  finalizeFraction?: number
}

export function computeOverallProgress(input: ProgressInput): number {
  const total = Math.max(1, input.totalChunks)
  const safe = (value: number | undefined) => Math.max(0, Math.min(1, value ?? 0))
  switch (input.stage) {
    case 'idle':
      return 0
    case 'initializing':
      return 0.02
    case 'loading-assets':
      return 0.02 + safe(input.assetFraction) * 0.06
    case 'rendering':
    case 'audio': {
      const within = input.stage === 'audio' ? 0.85 : safe(input.chunkRenderFraction) * 0.8
      return Math.min(0.9, 0.08 + ((input.chunksCompleted + within) / total) * 0.82)
    }
    case 'encoding': {
      const within = 0.8 + safe(input.chunkEncodeFraction) * 0.2
      return Math.min(0.9, 0.08 + ((input.chunksCompleted + within) / total) * 0.82)
    }
    case 'finalizing':
      return Math.min(0.98, 0.9 + safe(input.finalizeFraction) * 0.08)
    case 'done':
      return 1
    case 'cancelled':
    case 'error':
      return 0
  }
}

export interface EtaInput {
  progress: number
  elapsedMs: number
  renderFps: number | null
  remainingFrames: number
  averageEncodeMs: number | null
  remainingChunks: number
  finalizingMs?: number
}

/** Remaining wall-clock estimate, composed from measured pipeline speeds. */
export function estimateRemainingMs(input: EtaInput): number | null {
  if (input.progress >= 1) return 0
  const renderMs = input.renderFps && input.renderFps > 0 ? (input.remainingFrames / input.renderFps) * 1000 : 0
  const encodeMs = input.averageEncodeMs !== null ? Math.max(0, input.averageEncodeMs) * Math.max(0, input.remainingChunks) : 0
  const pending = renderMs + encodeMs + (input.remainingChunks > 0 ? (input.finalizingMs ?? 2000) : 0)
  if (pending > 0) return pending
  // Fallback: linear extrapolation from the achieved overall rate.
  if (input.progress > 0.01 && input.elapsedMs > 0) {
    return (input.elapsedMs / input.progress) * (1 - input.progress)
  }
  return null
}

/** "1m 20s" / "12s" / "—". */
export function formatEta(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—'
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

export interface ProgressReporter {
  report: (progress: ExportProgress, force?: boolean) => void
}

/**
 * Throttle high-frequency frame callbacks to a UI-friendly rate while always
 * allowing stage transitions to bypass the interval.
 */
export function createProgressReporter(
  send: (progress: ExportProgress) => void,
  intervalMs = 100,
  now: () => number = Date.now,
): ProgressReporter {
  let lastSent = Number.NEGATIVE_INFINITY
  return {
    report(progress, force = false) {
      const timestamp = now()
      if (!force && timestamp - lastSent < intervalMs) return
      lastSent = timestamp
      send(progress)
    },
  }
}
