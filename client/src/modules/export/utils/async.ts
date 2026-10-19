/**
 * Small dependency-free helpers used by the export orchestrator.
 */

export interface RetryOptions {
  retries: number
  signal?: AbortSignal
  onRetry?: (error: unknown, attempt: number) => void
  /** Delay before the next attempt (ms). */
  delayMs?: number
}

/** Reject promptly when a long-running operation observes an abort. */
export function throwIfAborted(signal?: AbortSignal, errorFactory: () => Error = () => new DOMException('Aborted', 'AbortError')): void {
  if (signal?.aborted) throw errorFactory()
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Retry an async operation. Aborts are never retried. Each attempt is
 * awaited in full so callers can reuse already-written chunk inputs.
 */
export async function withRetry<T>(task: () => Promise<T>, options: RetryOptions): Promise<T> {
  const retries = Math.max(0, Math.floor(options.retries))
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    try {
      return await task()
    } catch (error) {
      lastError = error
      if (options.signal?.aborted || isAbortError(error)) throw error
      if (attempt >= retries) break
      options.onRetry?.(error, attempt + 1)
      await delay(options.delayMs ?? 250 * (attempt + 1), options.signal)
    }
  }
  throw lastError
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
