import { hashBytes } from '@/canon/hash'
import type { ObjectStore } from '@/store/object-store'

// A content-addressed chunk store backed by object storage (R2/S3). Chunks are
// immutable blobs keyed by their content hash, written once and shared forever, so the
// key layout is a flat namespace exactly like the rest of the platform's R2 usage in
// mesh (mesh/deck/back/code/resource/registry/r2-store.ts): the key is the hash plus a
// `.chunk` suffix at the bucket root, no shard directories. This is the async
// counterpart to the in-memory ChunkStore, for when the store is a network service.
//
// See note/library/base/design/storage-backend.md.

// The async chunk-store contract: same shape as ChunkStore, but every access is a
// promise since the backend is a network service.
export interface AsyncChunkStore {
  put(bytes: string): Promise<string>
  get(hash: string): Promise<string | undefined>
  has(hash: string): Promise<boolean>
}

// The flat object key for a chunk. Mirrors mesh's `<id>.<ext>` convention.
export function chunkKey(hash: string): string {
  // the hash already carries its `sha256:` scheme; keep it stable and URL-safe
  return `${hash.replace(':', '-')}.chunk`
}

export class R2ChunkStore implements AsyncChunkStore {
  constructor(private objects: ObjectStore) {}

  // Store bytes under their content hash, skipping the write when the immutable chunk
  // is already present (a HEAD is cheaper than re-uploading).
  async put(bytes: string): Promise<string> {
    const hash = hashBytes(bytes)
    const key = chunkKey(hash)
    if ((await this.objects.head(key)) === undefined) {
      await this.objects.put(key, bytes)
    }
    return hash
  }

  get(hash: string): Promise<string | undefined> {
    return this.objects.get(chunkKey(hash))
  }

  async has(hash: string): Promise<boolean> {
    return (await this.objects.head(chunkKey(hash))) !== undefined
  }
}
