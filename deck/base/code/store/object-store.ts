// An object-storage interface modeled on how mesh talks to Cloudflare R2 through the
// S3 SDK (the platform R2 client): put, get, head, delete, list over
// a flat key namespace. base depends on this interface, not on the SDK, so the same
// chunk store runs over R2, S3, a filesystem, or the in-memory stub below. Bytes are
// carried as strings, matching the synchronous ChunkStore, so the canonical encoders
// need no second serialization.
//
// See note/library/base/design/storage-backend.md.

export type ObjectHead = { size: number }

export interface ObjectStore {
  put(key: string, bytes: string): Promise<void>
  get(key: string): Promise<string | undefined>
  head(key: string): Promise<ObjectHead | undefined>
  delete(key: string): Promise<void>
  list(prefix?: string): Promise<Array<string>>
}

// In-memory ObjectStore for tests and local runs. A real deployment supplies an
// R2/S3-backed implementation with the same interface.
export class MemoryObjectStore implements ObjectStore {
  private data = new Map<string, string>()

  put(key: string, bytes: string): Promise<void> {
    this.data.set(key, bytes)
    return Promise.resolve()
  }

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.data.get(key))
  }

  head(key: string): Promise<ObjectHead | undefined> {
    const bytes = this.data.get(key)
    return Promise.resolve(bytes === undefined ? undefined : { size: bytes.length })
  }

  delete(key: string): Promise<void> {
    this.data.delete(key)
    return Promise.resolve()
  }

  list(prefix = ''): Promise<Array<string>> {
    return Promise.resolve([...this.data.keys()].filter(k => k.startsWith(prefix)))
  }
}
