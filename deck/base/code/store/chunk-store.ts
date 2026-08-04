import { hashBytes } from '@term/base/code/canon/hash'

// The content-addressed chunk store: immutable blobs keyed by the hash of their
// content. This is the whole storage surface for the prolly tree, so any backend
// (filesystem, key-value, relational, object store) implements this interface. See
// note/library/base/design/storage-backend.md. The in-memory implementation is for
// tests and the default local runtime.

export interface ChunkStore {
  // store bytes, returning their content hash (idempotent: same bytes, same hash)
  put(bytes: string): string
  // fetch bytes by hash, or undefined if absent
  get(hash: string): string | undefined
  has(hash: string): boolean
  // number of distinct chunks held (for dedup assertions)
  size(): number
}

// A chunk store that supports enumeration and deletion, which garbage collection needs
// to sweep unreachable chunks. Not every store must support this (an append-only or
// write-once backend need not), so it is a separate capability.
export interface PrunableChunkStore extends ChunkStore {
  keys(): Array<string>
  delete(hash: string): void
}

export function isPrunable(store: ChunkStore): store is PrunableChunkStore {
  return (
    typeof (store as PrunableChunkStore).keys === 'function' &&
    typeof (store as PrunableChunkStore).delete === 'function'
  )
}

export class MemoryChunkStore implements PrunableChunkStore {
  private map = new Map<string, string>()

  put(bytes: string): string {
    const hash = hashBytes(bytes)
    if (!this.map.has(hash)) {
      this.map.set(hash, bytes)
    }
    return hash
  }

  get(hash: string): string | undefined {
    return this.map.get(hash)
  }

  has(hash: string): boolean {
    return this.map.has(hash)
  }

  size(): number {
    return this.map.size
  }

  keys(): Array<string> {
    return [...this.map.keys()]
  }

  delete(hash: string): void {
    this.map.delete(hash)
  }
}
