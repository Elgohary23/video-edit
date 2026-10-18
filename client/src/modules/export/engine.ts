/**
 * Export engine (PRD Feature 6) — two stages:
 *   1. record the composited canvas + mixed audio with MediaRecorder (webm take)
 *   2. transcode the take locally to MP4 (H.264/AAC) with FFmpeg.wasm
 *
 * Pure planning logic (args, mime picking, filenames) is unit-tested;
 * the wasm wrapper is a thin adapter with explicit phases for the UI.
 */
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'

/** Single-threaded ffmpeg core, loaded from CDN as blob URLs (Vite-safe). */
const CORE_BASE_URL = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd'

export const RECORDED_INPUT_NAME = 'take.webm'
export const COMPLETE_OUTPUT_NAME = 'cut.mp4'

export type ExportPhase = 'loading-core' | 'writing' | 'transcoding' | 'done'

/** ffmpeg arg vector for webm → H.264 MP4, faststart for instant replay. */
export function transcodeArgs(
  inputName = RECORDED_INPUT_NAME,
  outputName = COMPLETE_OUTPUT_NAME,
): string[] {
  return [
    '-i',
    inputName,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-movflags',
    '+faststart',
    outputName,
  ]
}

/** Suggested on-disk filename for a saved edit. */
export function exportFileName(projectName: string): string {
  const cleaned = projectName.trim().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '')
  return `${cleaned.length > 0 ? cleaned : 'cut'}-export.mp4`
}

/** First MediaRecorder mime type the browser supports, or null when none. */
export function pickRecorderMimeType(isTypeSupported: (m: string) => boolean, candidates: string[] = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
]): string | null {
  for (const candidate of candidates) {
    if (isTypeSupported(candidate)) return candidate
  }
  return null
}

let loadPromise: Promise<FFmpeg> | null = null

/**
 * Load (and cache) a single FFmpeg.wasm instance.
 * `loader`/`ctor` are injectable for tests — note @ffmpeg/ffmpeg cannot be
 * *constructed* under vitest (it hard-rejects node environments at import).
 */
export function loadFfmpeg(
  loader: (opts: { baseUrl: string }) => Promise<{ coreURL: string; wasmURL: string }> = async ({ baseUrl }) => {
    const [coreURL, wasmURL] = await Promise.all([
      toBlobURL(`${baseUrl}/ffmpeg-core.js`, 'text/javascript'),
      toBlobURL(`${baseUrl}/ffmpeg-core.wasm`, 'application/wasm'),
    ])
    return { coreURL, wasmURL }
  },
  baseUrl = CORE_BASE_URL,
  ctor: () => FFmpeg = () => new FFmpeg(),
): Promise<FFmpeg> {
  if (!loadPromise) {
    loadPromise = (async () => {
      const ffmpeg = ctor()
      const { coreURL, wasmURL } = await loader({ baseUrl })
      await ffmpeg.load({ coreURL, wasmURL })
      return ffmpeg
    })()
  }
  return loadPromise
}

/** Test hook: drop the cached instance (never needed at runtime). */
export function resetFfmpegCache(): void {
  loadPromise = null
}

export interface TranscodeOutput {
  blob: Blob
}

/**
 * Transcode a recorded take (webm or any ffmpeg-readable media) to MP4.
 * `ffmpegInstance` is injectable so unit tests can use a stub.
 */
export async function transcodeToMp4(
  take: Blob,
  onPhase: (phase: ExportPhase) => void = () => {},
  ffmpegInstance?: FFmpeg,
): Promise<TranscodeOutput> {
  onPhase('loading-core')
  const ffmpeg = ffmpegInstance ?? (await loadFfmpeg())

  onPhase('writing')
  await ffmpeg.writeFile(RECORDED_INPUT_NAME, await fetchFile(take))

  onPhase('transcoding')
  const exitCode = await ffmpeg.exec(transcodeArgs())
  if (exitCode !== 0) throw new Error(`ffmpeg exited with code ${exitCode}`)

  const data = await ffmpeg.readFile(COMPLETE_OUTPUT_NAME)
  onPhase('done')
  // U8Array generic type: safe to hand to Blob at runtime
  return { blob: new Blob([data as BlobPart], { type: 'video/mp4' }) }
}
