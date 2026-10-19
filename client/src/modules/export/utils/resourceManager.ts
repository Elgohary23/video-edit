/**
 * Explicit resource lifecycle. Disposers run in reverse acquisition order
 * (LIFO) and one failing disposer never prevents the rest from running.
 * This is what guarantees audio contexts, video elements, workers, and
 * FFmpeg sessions are released on success, failure, and cancellation.
 */
export interface ResourceEntry {
  name: string
  dispose: () => void | Promise<void>
}

export class ResourceManager {
  private readonly entries: ResourceEntry[] = []
  private disposed = false

  /** Register a resource and return its release function. */
  add(name: string, dispose: () => void | Promise<void>): () => Promise<void> {
    if (this.disposed) {
      // Late registration after disposal must not leak.
      void Promise.resolve(dispose()).catch(() => {})
      return async () => {}
    }
    const entry: ResourceEntry = { name, dispose }
    this.entries.push(entry)
    return async () => {
      const index = this.entries.indexOf(entry)
      if (index === -1) return
      this.entries.splice(index, 1)
      await runDisposer(entry)
    }
  }

  get size(): number {
    return this.entries.length
  }

  async disposeAll(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (let i = this.entries.length - 1; i >= 0; i--) {
      await runDisposer(this.entries[i])
    }
    this.entries.length = 0
  }
}

async function runDisposer(entry: ResourceEntry): Promise<void> {
  try {
    await entry.dispose()
  } catch (error) {
    // Cleanup must be best-effort: a dead video element or an already
    // terminated worker must not mask the original export failure.
    console.warn(`[export] failed to dispose ${entry.name}`, error)
  }
}
