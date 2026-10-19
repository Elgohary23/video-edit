/**
 * Optional decode path for sources whose analysis has not completed.
 *
 * This is deliberately outside the playback audio graph: the export mixer
 * only consumes decoded PCM, never a live <video> element.
 */
import { mixdownToMono, type AudioBufferLike } from '../../media/engine'
import type { ExportAudioMixdown } from '../types'

export async function decodeAudioTrack(url: string, signal?: AbortSignal): Promise<ExportAudioMixdown | null> {
  if (typeof AudioContext === 'undefined') return null
  let context: AudioContext | null = null
  try {
    const response = await fetch(url, { signal })
    if (!response.ok) return null
    const data = await response.arrayBuffer()
    context = new AudioContext()
    const buffer = await context.decodeAudioData(data)
    const mix = mixdownToMono(buffer as unknown as AudioBufferLike)
    return { samples: mix.samples, sampleRate: mix.sampleRate, durationMs: mix.durationMs }
  } catch (error) {
    if (signal?.aborted) throw error
    // A silent source (or an unsupported decoder) is not fatal: the export
    // simply renders silence for those clips.
    return null
  } finally {
    if (context) void context.close().catch(() => {})
  }
}
