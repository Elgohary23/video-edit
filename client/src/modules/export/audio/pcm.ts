/**
 * Raw 16-bit little-endian PCM helpers.
 *
 * Export audio is mixed per chunk for progress/memory reasons, but written
 * into ONE preallocated buffer at absolute sample offsets. Unlike per-chunk
 * AAC/Opus encoding, raw PCM has no encoder priming, so concatenating it at
 * sample offsets cannot introduce cumulative A/V drift.
 */

/** Bytes needed for `sampleCount` mono 16-bit samples. */
export function pcm16ByteLength(sampleCount: number): number {
  return Math.max(0, Math.round(sampleCount)) * 2
}

/** Sample index for an exact frame-grid instant (absolute, never cumulative). */
export function sampleAtFrame(frameIndex: number, fps: number, sampleRate: number): number {
  if (!Number.isFinite(frameIndex) || !Number.isFinite(fps) || fps <= 0 || sampleRate <= 0) return 0
  return Math.round((frameIndex / fps) * sampleRate)
}

/** Total samples for an export of `totalFrames` at `fps`. */
export function sampleCountForFrames(totalFrames: number, fps: number, sampleRate: number): number {
  return sampleAtFrame(Math.max(0, totalFrames), Math.max(1, fps), sampleRate)
}

/**
 * Convert mono Float32 samples to 16-bit PCM.
 *
 * When `target` is supplied the samples are written at `byteOffset` and the
 * same buffer is returned; otherwise a fresh exact-size array is allocated.
 * This lets the export fill one timeline-sized buffer without a second copy.
 */
export function encodePcm16Mono(
  samples: Float32Array,
  target?: Uint8Array,
  byteOffset = 0,
): Uint8Array {
  const output = target ?? new Uint8Array(pcm16ByteLength(samples.length))
  const start = Math.max(0, Math.round(byteOffset))
  const available = Math.max(0, Math.floor((output.length - start) / 2))
  const count = Math.min(samples.length, available)
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength)
  for (let i = 0; i < count; i++) {
    const value = samples[i]
    const clamped = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0
    view.setInt16(start + i * 2, clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff), true)
  }
  // Any remaining bytes (fractional frame rounding) stay silent.
  return output
}
