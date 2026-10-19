/**
 * Streaming-style chunk encoder on top of FFmpeg's MEMFS.
 *
 * Frames are written one at a time, encoded into a standalone segment, read
 * back into a compact Uint8Array, and immediately deleted. Peak memory is
 * therefore bounded by one chunk of JPEG frames + the accumulated encoded
 * segments, not by the raw timeline.
 */
import type { ExportSettings, SegmentEncoder } from '../types'
import {
  audioFileName,
  chunkEncodeTimeoutMs,
  concatArgs,
  concatListName,
  concatTimeoutMs,
  finalFileName,
  frameFileName,
  framePattern,
  segmentEncodingOptions,
  segmentFileName,
} from './args'
import { FileLedger } from './fileLedger'
import type { FFmpegSession } from './ffmpegSession'
import { ExportError } from '../utils/errors'

export interface FfmpegSessionLike {
  writeFile: (name: string, data: Uint8Array | string, ledger?: FileLedger) => Promise<void>
  readFile: (name: string) => Promise<Uint8Array>
  deleteFile: (name: string, ledger?: FileLedger) => Promise<void>
  exec: (
    args: string[],
    options: { signal?: AbortSignal; timeout?: number; onProgress?: (event: { progress: number }) => void },
  ) => Promise<number>
  assertExit: (exitCode: number, stage: string) => void
  cleanup: (ledger: FileLedger) => Promise<void>
  terminate: () => void
  getLogs: () => string[]
}

export class FfmpegSegmentEncoder implements SegmentEncoder {
  private readonly ledger = new FileLedger()

  constructor(
    private readonly session: FfmpegSessionLike,
    private readonly settings: ExportSettings,
  ) {}

  async writeFrame(chunkIndex: number, localFrameIndex: number, data: Uint8Array): Promise<void> {
    const name = frameFileName(chunkIndex, localFrameIndex)
    try {
      await this.session.writeFile(name, data, this.ledger)
    } catch (error) {
      this.ledger.untrack(name)
      throw new ExportError('FFMPEG_EXEC_FAILED', `Could not write frame ${name} into FFmpeg`, {
        userMessage: 'Export failed while preparing frames for encoding.',
        logs: this.session.getLogs(),
        cause: error,
      })
    }
  }

  async encodeChunk(
    chunkIndex: number,
    frameCount: number,
    audioWav: Uint8Array | null,
    signal: AbortSignal | undefined,
    onProgress: (ratio: number) => void,
  ): Promise<Uint8Array> {
    const hasAudio = audioWav !== null
    if (audioWav) {
      // Multiple encode attempts must each get an owned buffer: writeFile
      // transfers the underlying ArrayBuffer into FFmpeg's worker.
      await this.session.writeFile(audioFileName(chunkIndex), new Uint8Array(audioWav), this.ledger)
    }
    const output = segmentFileName(chunkIndex, this.settings)
    // Track the output before exec so a partially written file is cleaned up.
    this.ledger.track(output)
    const args = [
      '-framerate',
      String(this.settings.fps),
      '-i',
      framePattern(chunkIndex),
      ...(hasAudio ? ['-i', audioFileName(chunkIndex)] : []),
      ...segmentEncodingOptions(this.settings, frameCount, hasAudio),
      output,
    ]

    const exitCode = await this.session.exec(args, {
      signal,
      timeout: chunkEncodeTimeoutMs(this.settings, frameCount),
      onProgress: (event) => onProgress(clamp01(event.progress)),
    })
    this.session.assertExit(exitCode, `Encoding chunk ${chunkIndex + 1}`)

    const bytes = await this.session.readFile(output)
    await this.session.deleteFile(output, this.ledger)
    return bytes
  }

  async concat(
    segments: Uint8Array[],
    signal?: AbortSignal,
    onProgress?: (ratio: number) => void,
  ): Promise<Uint8Array> {
    const names: string[] = []
    try {
      for (let index = 0; index < segments.length; index++) {
        const name = segmentFileName(index, this.settings)
        names.push(name)
        await this.session.writeFile(name, segments[index], this.ledger)
      }
      const list = segments.map((_, index) => `file '${segmentFileName(index, this.settings)}'`).join('\n')
      const listName = concatListName()
      names.push(listName)
      await this.session.writeFile(listName, list, this.ledger)

      const output = finalFileName(this.settings)
      names.push(output)
      this.ledger.track(output)
      const exitCode = await this.session.exec(concatArgs(this.settings), {
        signal,
        timeout: concatTimeoutMs(),
        onProgress: onProgress ? (event) => onProgress(clamp01(event.progress)) : undefined,
      })
      this.session.assertExit(exitCode, 'Finalizing export')
      return await this.session.readFile(output)
    } finally {
      // Release both JS-side references and MEMFS entries immediately.
      for (const name of names) {
        await this.session.deleteFile(name, this.ledger)
      }
    }
  }

  async discardChunk(chunkIndex: number, frameCount: number, hasAudio: boolean): Promise<void> {
    for (let frame = 0; frame < frameCount; frame++) {
      await this.session.deleteFile(frameFileName(chunkIndex, frame), this.ledger)
    }
    if (hasAudio) await this.session.deleteFile(audioFileName(chunkIndex), this.ledger)
    await this.session.deleteFile(segmentFileName(chunkIndex, this.settings), this.ledger)
  }

  async cleanup(): Promise<void> {
    await this.session.cleanup(this.ledger)
  }

  terminate(): void {
    this.session.terminate()
  }

  logs(): string[] {
    return this.session.getLogs()
  }
}

/** Convenience constructor for the default dependency graph. */
export function createFfmpegEncoder(session: FFmpegSession, settings: ExportSettings): FfmpegSegmentEncoder {
  return new FfmpegSegmentEncoder(session, settings)
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
}
