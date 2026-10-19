/**
 * Typed export failures. Every failure carries a developer-oriented code,
 * collected FFmpeg logs, and a message safe to show in the editor.
 */
export type ExportErrorCode =
  | 'CANCELLED'
  | 'INVALID_SETTINGS'
  | 'NO_CLIPS'
  | 'ASSET_LOAD_FAILED'
  | 'SEEK_TIMEOUT'
  | 'FFMPEG_LOAD_FAILED'
  | 'FFMPEG_EXEC_FAILED'
  | 'TIMEOUT'
  | 'CODEC_UNSUPPORTED'
  | 'UNKNOWN'

export class ExportError extends Error {
  readonly code: ExportErrorCode
  readonly userMessage: string
  readonly logs: string[]

  constructor(code: ExportErrorCode, message: string, options: { userMessage?: string; logs?: string[]; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ExportError'
    this.code = code
    this.userMessage = options.userMessage ?? message
    this.logs = options.logs ?? []
  }
}

export class ExportCancelledError extends ExportError {
  constructor(logs: string[] = []) {
    super('CANCELLED', 'Export cancelled by user', { userMessage: 'Export cancelled.', logs })
    this.name = 'ExportCancelledError'
  }
}

export function isExportCancelled(error: unknown): boolean {
  return error instanceof ExportError && error.code === 'CANCELLED'
}

/** Normalize arbitrary thrown values into an `ExportError`. */
export function toExportError(error: unknown, logs: string[] = []): ExportError {
  if (error instanceof ExportError) {
    if (logs.length > 0 && error.logs.length === 0) {
      return new ExportError(error.code, error.message, { userMessage: error.userMessage, logs, cause: error })
    }
    return error
  }
  if (isAbortLike(error)) {
    return new ExportCancelledError(logs)
  }
  const message = error instanceof Error ? error.message : String(error)
  return new ExportError('UNKNOWN', message, { userMessage: `Export failed: ${message}`, logs, cause: error })
}

export function isAbortLike(error: unknown): boolean {
  if (error instanceof ExportCancelledError) return true
  if (error instanceof DOMException && error.name === 'AbortError') return true
  return error instanceof Error && (error.name === 'AbortError' || error.message === 'called FFmpeg.terminate()')
}

/** Map FFmpeg stderr to a more actionable message. */
export function codecSupportMessage(logs: string[]): string | null {
  const joined = logs.join('\n').toLowerCase()
  if (joined.includes('unknown encoder') || joined.includes('encoder not found')) {
    return 'The bundled FFmpeg build does not support the selected codec. Try H.264.'
  }
  return null
}
