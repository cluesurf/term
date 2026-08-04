import type { ChunkStore } from '@term/base/code/store/chunk-store'

// A pack gathers many small chunks into one blob with an index, so a store or a transfer
// holds one large object instead of thousands of tiny ones. It is base's answer to git's
// packfiles, minus the delta encoding, since content-defined chunking already dedups
// shared data. Every chunk stays addressable by its hash through the index, and unpacking
// re-hashes each chunk, so a corrupt pack is caught.
//
// See note/library/base/design/storage-backend.md.

export type Pack = {
  // chunk hash -> [offset, length] into the blob
  index: { [hash: string]: [number, number] }
  blob: string
}

// Pack the given chunk hashes into one blob. Missing hashes are skipped.
export function packChunks(chunks: ChunkStore, hashes: Iterable<string>): Pack {
  const index: { [hash: string]: [number, number] } = {}
  let blob = ''
  for (const hash of hashes) {
    if (index[hash] !== undefined) {
      continue
    }
    const bytes = chunks.get(hash)
    if (bytes === undefined) {
      continue
    }
    index[hash] = [blob.length, bytes.length]
    blob += bytes
  }
  return { index, blob }
}

// Read one chunk out of a pack by hash.
export function readFromPack(pack: Pack, hash: string): string | undefined {
  const span = pack.index[hash]
  if (span === undefined) {
    return undefined
  }
  return pack.blob.slice(span[0], span[0] + span[1])
}

// Unpack every chunk into a store, verifying each by re-hashing (the store's put returns
// the content hash). Returns the count. Throws on a chunk whose bytes do not match.
export function unpack(pack: Pack, target: ChunkStore): number {
  let stored = 0
  for (const hash of Object.keys(pack.index)) {
    const actual = target.put(readFromPack(pack, hash)!)
    if (actual !== hash) {
      throw new Error(`pack integrity failure: claimed ${hash}, got ${actual}`)
    }
    stored++
  }
  return stored
}
