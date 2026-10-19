/**
 * Minimal RIFF/WAVE writer. 16-bit PCM is universally supported by the
 * bundled FFmpeg build and keeps chunk buffers small.
 */
export function encodeWav(channels: readonly Float32Array[], sampleRate: number): Uint8Array {
  const channelCount = Math.max(1, channels.length)
  const frames = channels.reduce((min, channel) => Math.min(min, channel.length), channels[0]?.length ?? 0)
  const dataSize = frames * channelCount * 2
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // PCM header size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, channelCount, true)
  view.setUint32(24, Math.max(1, Math.round(sampleRate)), true)
  view.setUint32(28, Math.max(1, Math.round(sampleRate)) * channelCount * 2, true)
  view.setUint16(32, channelCount * 2, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channelCount; channel++) {
      const sample = clampSample(channels[channel]?.[frame] ?? 0)
      view.setInt16(offset, sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff), true)
      offset += 2
    }
  }
  return new Uint8Array(buffer)
}

function clampSample(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(-1, Math.min(1, value))
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i))
  }
}
