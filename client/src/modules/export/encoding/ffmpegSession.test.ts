import { afterEach, describe, expect, it, vi } from 'vitest'
import { FFmpegSession, loadFfmpeg, resetFfmpegCache, type FfmpegLike } from './ffmpegSession'
import { FileLedger } from './fileLedger'

interface StubOptions {
  exitCode?: number
  readData?: Uint8Array
}

function createStub(options: StubOptions = {}) {
  const files = new Map<string, Uint8Array | string>()
  const logListeners = new Set<(event: { type: string; message: string }) => void>()
  const progressListeners = new Set<(event: { progress: number; time: number }) => void>()
  const stub = {
    loaded: true,
    load: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn(async (name: string, data: Uint8Array | string) => {
      files.set(name, data)
      return true
    }),
    readFile: vi.fn(async (name: string) => files.get(name) ?? options.readData ?? new Uint8Array([1, 2, 3])),
    deleteFile: vi.fn(async (name: string) => files.delete(name)),
    exec: vi.fn(async () => {
      for (const listener of progressListeners) listener({ progress: 0.5, time: 1 })
      return options.exitCode ?? 0
    }),
    on: vi.fn((event: string, callback: never) => {
      if (event === 'log') logListeners.add(callback)
      if (event === 'progress') progressListeners.add(callback)
    }),
    off: vi.fn((event: string, callback: never) => {
      if (event === 'log') logListeners.delete(callback)
      if (event === 'progress') progressListeners.delete(callback)
    }),
    terminate: vi.fn(),
    emitLog: (message: string) => {
      for (const listener of logListeners) listener({ type: 'stderr', message })
    },
    files,
  }
  return stub
}

afterEach(() => {
  resetFfmpegCache()
})

describe('loadFfmpeg', () => {
  it('caches one instance and constructs it only once', async () => {
    const instance = createStub()
    const ctor = vi.fn(() => instance as unknown as never)
    const loader = vi.fn().mockResolvedValue({ coreURL: 'blob:core', wasmURL: 'blob:wasm' })

    const first = await loadFfmpeg(loader, 'https://example.test', ctor)
    const second = await loadFfmpeg(loader, 'https://example.test', ctor)
    expect(first).toBe(second)
    expect(ctor).toHaveBeenCalledTimes(1)
    expect(loader).toHaveBeenCalledTimes(1)
    expect(instance.load).toHaveBeenCalledWith({ coreURL: 'blob:core', wasmURL: 'blob:wasm' })
  })

  it('drops the cache after a failed load so a retry is possible', async () => {
    const ctor = vi.fn(() => createStub() as unknown as never)
    const failing = vi.fn().mockRejectedValue(new Error('network'))
    await expect(loadFfmpeg(failing, 'https://example.test', ctor)).rejects.toThrow('network')
    await expect(
      loadFfmpeg(vi.fn().mockResolvedValue({ coreURL: 'a', wasmURL: 'b' }), 'https://example.test', ctor),
    ).resolves.toBeTruthy()
    expect(ctor).toHaveBeenCalledTimes(2)
  })
})

describe('FFmpegSession', () => {
  it('captures logs, cleans tracked files, and reports progress', async () => {
    const stub = createStub()
    const session = new FFmpegSession(stub as unknown as FfmpegLike)
    const ledger = new FileLedger()

    stub.emitLog('frame written')
    expect(session.getLogs()).toContain('stderr: frame written')

    await session.writeFile('a.bin', new Uint8Array([9]), ledger)
    await session.writeFile('b.bin', new Uint8Array([8]), ledger)
    expect(ledger.size).toBe(2)

    const progress = vi.fn()
    const exit = await session.exec(['-version'], { onProgress: progress })
    expect(exit).toBe(0)
    expect(progress).toHaveBeenCalledWith({ progress: 0.5, time: 1 })

    await session.deleteFile('a.bin', ledger)
    expect(ledger.size).toBe(1)

    await session.cleanup(ledger)
    expect(ledger.size).toBe(0)
    expect(stub.files.has('b.bin')).toBe(false)
  })

  it('throws a typed error on non-zero exits', () => {
    const session = new FFmpegSession(createStub({ exitCode: 1 }) as unknown as FfmpegLike)
    expect(() => session.assertExit(1, 'Encoding chunk 1')).toThrowError(/Encoding chunk 1 failed/)
  })

  it('terminates once and notifies the cache reset hook', () => {
    const stub = createStub()
    const session = new FFmpegSession(stub as unknown as FfmpegLike)
    const onTerminate = vi.fn()
    session.onTerminate(onTerminate)
    session.terminate()
    session.terminate()
    expect(stub.terminate).toHaveBeenCalledTimes(1)
    expect(onTerminate).toHaveBeenCalledTimes(1)
    expect(session.terminated).toBe(true)
  })

  it('tolerates deleting a file that does not exist', async () => {
    const stub = createStub()
    stub.deleteFile.mockRejectedValueOnce(new Error('ENOENT'))
    const session = new FFmpegSession(stub as unknown as FfmpegLike)
    const ledger = new FileLedger()
    ledger.track('missing.bin')
    await expect(session.cleanup(ledger)).resolves.toBeUndefined()
    expect(ledger.size).toBe(0)
  })
})
