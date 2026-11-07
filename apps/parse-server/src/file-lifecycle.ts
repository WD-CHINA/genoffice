/** Single-instance file lifecycle coordination; distributed ownership belongs to DB leases. */
export class FileLifecycle {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly readers = new Map<string, number>()

  async withFile<T>(fileId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(fileId) ?? Promise.resolve()
    let unlock!: () => void
    const next = new Promise<void>((resolve) => {
      unlock = resolve
    })
    this.tails.set(fileId, next)
    await previous
    try {
      return await work()
    } finally {
      unlock()
      if (this.tails.get(fileId) === next) this.tails.delete(fileId)
    }
  }

  async acquire(fileId: string): Promise<() => void> {
    await this.withFile(fileId, async () => {
      this.readers.set(fileId, (this.readers.get(fileId) ?? 0) + 1)
    })
    let released = false
    return () => {
      if (released) return
      released = true
      const count = (this.readers.get(fileId) ?? 1) - 1
      if (count) this.readers.set(fileId, count)
      else this.readers.delete(fileId)
    }
  }

  has(fileId: string): boolean {
    return this.readers.has(fileId)
  }
  get activeFileIds(): Set<string> {
    return new Set(this.readers.keys())
  }
}
