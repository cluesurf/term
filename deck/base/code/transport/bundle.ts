import type { ChunkStore } from '@/store/chunk-store'
import type { RefStore } from '@/store/ref-store'
import { reachableChunks } from '@/gc/gc'

// A bundle is a whole repo slice in one transferable object: the refs it names and every
// chunk reachable from them. It is how base moves history without a live connection, the
// content-addressed analogue of `git bundle`. Applying a bundle re-hashes every chunk on
// the way in, so a tampered bundle is rejected, and because chunks are content-addressed
// a bundle that overlaps what the receiver already has costs nothing extra to apply.
//
// See note/library/base/design/sync-and-transport.md.

export type Bundle = {
  // ref name -> commit hash (branches and tags)
  refs: { [name: string]: string }
  // chunk hash -> bytes
  chunks: { [hash: string]: string }
}

// Package the refs and all chunks reachable from them into a bundle.
export function createBundle(
  chunks: ChunkStore,
  refs: { [name: string]: string },
): Bundle {
  const reachable = reachableChunks(chunks, Object.values(refs))
  const out: { [hash: string]: string } = {}
  for (const hash of reachable) {
    const bytes = chunks.get(hash)
    if (bytes !== undefined) {
      out[hash] = bytes
    }
  }
  return { refs: { ...refs }, chunks: out }
}

export function encodeBundle(bundle: Bundle): string {
  return JSON.stringify(bundle)
}

export function decodeBundle(bytes: string): Bundle {
  return JSON.parse(bytes) as Bundle
}

export type ApplyBundleReport = {
  // chunks stored (skips ones already present and any that fail the hash check)
  stored: number
  // chunks whose bytes did not match their claimed hash
  rejected: Array<string>
  // refs set
  refs: Array<string>
}

// Apply a bundle into a store and ref store. Each chunk is verified by re-hashing; a
// chunk whose bytes do not match its hash is rejected, not stored. Refs are set to the
// bundle's hashes (forced), so a bundle can seed or advance a replica.
export function applyBundle(
  bundle: Bundle,
  chunks: ChunkStore,
  refs: RefStore,
): ApplyBundleReport {
  let stored = 0
  const rejected: Array<string> = []
  for (const [hash, bytes] of Object.entries(bundle.chunks)) {
    const actual = chunks.put(bytes)
    if (actual !== hash) {
      rejected.push(hash)
      continue
    }
    stored++
  }
  const setRefs: Array<string> = []
  for (const [name, hash] of Object.entries(bundle.refs)) {
    refs.compareAndSwap(name, refs.get(name), hash)
    setRefs.push(name)
  }
  return { stored, rejected, refs: setRefs }
}
