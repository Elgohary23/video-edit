/**
 * Default (browser) dependency graph. Tests inject fakes instead.
 */
import type { ExportDependencies, ExportSettings } from '../types'
import { decodeAudioTrack } from '../audio/decode'
import { createDefaultRenderer } from '../renderer/frameRenderer'
import { createFfmpegEncoder } from '../encoding/ffmpegEncoder'
import { CORE_BASE_URL, loadFFmpegSession } from '../encoding/ffmpegSession'
import { throwIfAborted } from '../utils/async'

async function fetchBlobUrl(url: string, mime: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`HTTP ${response.status} while loading ${url}`)
  const bytes = await response.arrayBuffer()
  return URL.createObjectURL(new Blob([bytes], { type: mime }))
}

async function loadCore(baseUrl: string, signal?: AbortSignal): Promise<{ coreURL: string; wasmURL: string }> {
  const [coreURL, wasmURL] = await Promise.all([
    fetchBlobUrl(`${baseUrl}/ffmpeg-core.js`, 'text/javascript', signal),
    fetchBlobUrl(`${baseUrl}/ffmpeg-core.wasm`, 'application/wasm', signal),
  ])
  return { coreURL, wasmURL }
}

async function createEncoder(
  settings: ExportSettings,
  options: { signal?: AbortSignal; onLog?: (line: string) => void; preserveAlpha?: boolean },
) {
  const session = await loadFFmpegSession({
    loader: ({ baseUrl }) => loadCore(baseUrl, options.signal),
  })
  throwIfAborted(options.signal)
  session.clearLogs()
  options.onLog?.('FFmpeg core ready')
  return createFfmpegEncoder(session, settings, options.preserveAlpha === true)
}

export const defaultExportDependencies: ExportDependencies = {
  createRenderer: createDefaultRenderer,
  createEncoder,
  decodeAudio: decodeAudioTrack,
  now: () => Date.now(),
}

export { CORE_BASE_URL }
