/**
 * Tracks every file written into FFmpeg's virtual filesystem so cleanup can
 * run on success, failure, and cancellation without leaking MEMFS entries.
 */
export class FileLedger {
  private readonly files = new Set<string>()

  track(name: string): void {
    this.files.add(name)
  }

  untrack(name: string): void {
    this.files.delete(name)
  }

  has(name: string): boolean {
    return this.files.has(name)
  }

  all(): string[] {
    return [...this.files]
  }

  get size(): number {
    return this.files.size
  }

  clear(): void {
    this.files.clear()
  }
}
