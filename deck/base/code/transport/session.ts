import type { ChunkStore } from '@/store/chunk-store'
import type { RefStore } from '@/store/ref-store'

// The network seam for remote editing. A `RemoteRepo` is whatever sits across the wire:
// a server for a browser client, or a cloud store for a local replica. base's push and
// pull are defined against this interface, not a transport, so the same protocol runs
// over WebSocket, HTTP, or anything else once someone implements these calls. Every
// method is async because the peer is remote. The transfer stays content-addressed and
// pruned, so a push or pull moves only the chunks the other side lacks, and every chunk
// is re-hashed on receipt, so a hostile peer cannot inject bad data.
//
// See note/library/base/design/sync-and-transport.md.

export interface RemoteRepo {
  hasChunk(hash: string): Promise<boolean>
  getChunk(hash: string): Promise<string | undefined>
  // store bytes, returning their content hash (the receiver re-hashes)
  putChunk(bytes: string): Promise<string>
  getRef(name: string): Promise<string | undefined>
  // compare-and-swap a ref, so a concurrent push is detected
  setRef(name: string, expected: string | undefined, next: string): Promise<boolean>
  listRefs(): Promise<Array<string>>
}

// An in-memory RemoteRepo over a chunk store and ref store, standing in for a server in
// tests and local runs. A real server implements the same interface over its transport.
export class MemoryRemoteRepo implements RemoteRepo {
  constructor(
    private chunks: ChunkStore,
    private refs: RefStore,
  ) {}

  hasChunk(hash: string): Promise<boolean> {
    return Promise.resolve(this.chunks.has(hash))
  }
  getChunk(hash: string): Promise<string | undefined> {
    return Promise.resolve(this.chunks.get(hash))
  }
  putChunk(bytes: string): Promise<string> {
    return Promise.resolve(this.chunks.put(bytes))
  }
  getRef(name: string): Promise<string | undefined> {
    return Promise.resolve(this.refs.get(name))
  }
  setRef(name: string, expected: string | undefined, next: string): Promise<boolean> {
    return Promise.resolve(this.refs.compareAndSwap(name, expected, next))
  }
  listRefs(): Promise<Array<string>> {
    return Promise.resolve(this.refs.list())
  }
}

export type PushResult =
  | { ok: true; status: 'up-to-date' | 'fast-forward'; transferred: number }
  | { ok: false; status: 'rejected'; reason: string }

export type PullResult =
  | { ok: true; status: 'up-to-date' | 'fast-forward' | 'merged'; commit?: string; transferred: number }
  | { ok: false; status: 'conflict'; conflicts: number }
