import { describe, expect, it, vi } from 'vitest'
import { delay, throwIfAborted, withRetry } from './async'

describe('throwIfAborted', () => {
  it('throws only when the signal is already aborted', () => {
    expect(() => throwIfAborted()).not.toThrow()
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow()
    const controller = new AbortController()
    controller.abort()
    expect(() => throwIfAborted(controller.signal)).toThrow()
  })
})

describe('delay', () => {
  it('resolves after the requested time', async () => {
    vi.useFakeTimers()
    try {
      const promise = delay(250)
      vi.advanceTimersByTime(250)
      await expect(promise).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects immediately when the signal is aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(delay(1000, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('withRetry', () => {
  it('retries failed attempts and resolves on success', async () => {
    const task = vi.fn().mockRejectedValueOnce(new Error('flaky')).mockResolvedValue('ok')
    const onRetry = vi.fn()
    await expect(withRetry(task, { retries: 2, delayMs: 0, onRetry })).resolves.toBe('ok')
    expect(task).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1)
  })

  it('stops after the configured number of retries', async () => {
    const task = vi.fn().mockRejectedValue(new Error('always'))
    await expect(withRetry(task, { retries: 1, delayMs: 0 })).rejects.toThrow('always')
    expect(task).toHaveBeenCalledTimes(2)
  })

  it('never retries an abort', async () => {
    const controller = new AbortController()
    const task = vi.fn().mockImplementation(() => {
      controller.abort()
      return Promise.reject(new DOMException('Aborted', 'AbortError'))
    })
    await expect(withRetry(task, { retries: 3, signal: controller.signal, delayMs: 0 })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(task).toHaveBeenCalledTimes(1)
  })
})
