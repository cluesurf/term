import type { ChunkStore } from '@/store/chunk-store'
import { collectMissingChunks } from '@/store/tree'
import type { RevocationList } from '@/erase/revocation'

// The async replica sync protocol: prolly-tree chunk transfer. Two peers reconcile
// by comparing what they have and transferring only the chunks the receiver lacks.
// Because the store is content-addressed, a chunk the receiver already holds (a
// shared subtree, an unchanged record) is never sent, so the transfer tracks the
// size of the difference, not the dataset. This is the wire logic, transport-free;
// a real deployment frames these messages over https or ssh.
//
// See note/library/base/design/sync-and-transport.md.

// The chunk hashes reachable from a root that the receiver does not already have.
// Prunes shared subtrees, so it costs the size of the difference, not the dataset.
export function missingChunks(
  root: string,
  source: ChunkStore,
  receiverHas: (hash: string) => boolean,
): Array<string> {
  return [...collectMissingChunks(root, source, receiverHas)]
}

// A transferable chunk: its hash and bytes. The receiver re-hashes on store, so a
// corrupted or spoofed chunk is rejected because its bytes would not match.
export type ChunkMessage = { hash: string; bytes: string }

// Package the chunks the receiver needs to reach `root`.
export function packMissing(
  root: string,
  source: ChunkStore,
  receiverHas: (hash: string) => boolean,
): Array<ChunkMessage> {
  const out: Array<ChunkMessage> = []
  for (const hash of missingChunks(root, source, receiverHas)) {
    const bytes = source.get(hash)
    if (bytes !== undefined) {
      out.push({ hash, bytes })
    }
  }
  return out
}

// Apply received chunks into the receiver's store, verifying each by re-hashing.
// Returns the number stored. Throws if a chunk's bytes do not match its claimed hash.
// A revoked chunk (erased elsewhere) is refused, never stored, so a peer cannot push
// erased content back into the store.
export function applyChunks(
  chunks: Array<ChunkMessage>,
  target: ChunkStore,
  revocation?: RevocationList,
): number {
  let stored = 0
  for (const { hash, bytes } of chunks) {
    if (revocation !== undefined && revocation.has(hash)) {
      continue // erased content: refuse to re-admit it
    }
    const actual = target.put(bytes)
    if (actual !== hash) {
      throw new Error(`chunk integrity failure: claimed ${hash}, got ${actual}`)
    }
    stored++
  }
  return stored
}

// Pull a root from a source store into a target store, transferring only missing
// chunks. After this, the target can read the full state at `root`. Returns how many
// chunks were transferred. Revoked chunks are never admitted.
export function pull(
  root: string,
  source: ChunkStore,
  target: ChunkStore,
  revocation?: RevocationList,
): number {
  const chunks = packMissing(root, source, h => target.has(h))
  return applyChunks(chunks, target, revocation)
}
