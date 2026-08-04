// The ref store: a small mutable map from a name to a hash (branch head to commit
// hash), with compare-and-swap. This is the only mutable state, and it needs a
// transactional backend in production; in memory here for tests and local use.
//
// See note/library/base/design/storage-backend.md and
// note/library/base/design/consistency-and-concurrency.md.

export interface RefStore {
  get(name: string): string | undefined
  // set `name` to `next` only if its current value equals `expected`
  // (undefined expected means the ref must not yet exist). Returns whether it took.
  compareAndSwap(
    name: string,
    expected: string | undefined,
    next: string,
  ): boolean
  list(): Array<string>
  delete(name: string): void
}

export class MemoryRefStore implements RefStore {
  private map = new Map<string, string>()

  get(name: string): string | undefined {
    return this.map.get(name)
  }

  compareAndSwap(
    name: string,
    expected: string | undefined,
    next: string,
  ): boolean {
    const current = this.map.get(name)
    if (current !== expected) {
      return false
    }
    this.map.set(name, next)
    return true
  }

  list(): Array<string> {
    return [...this.map.keys()]
  }

  delete(name: string): void {
    this.map.delete(name)
  }
}
