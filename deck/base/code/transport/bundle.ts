import type { ChunkStore } from '@term/base/code/store/chunk-store'
import type { RefStore } from '@term/base/code/store/ref-store'
import { reachableChunks } from '@term/base/code/gc/gc'

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
  // refs NOT set because a concurrent local move failed the compare-and-swap
  refConflicts: Array<string>
}

// Apply a bundle into a store and ref store. Each chunk is verified by re-hashing; a
// chunk whose bytes do not match its hash is rejected, not stored. Refs are advanced
// to the bundle's hashes by compare-and-swap.
//
// A ref is advanced ONLY if the bundle applied cleanly. If any chunk was rejected the
// bundle's tree is incomplete, so advancing a ref to a head whose subtree is missing a
// chunk would create a corrupt branch (checkout would throw). And the compare-and-swap
// result is honoured: a ref a concurrent writer moved is reported as a conflict, not
// silently clobbered and reported as set.
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
  const refConflicts: Array<string> = []
  if (rejected.length === 0) {
    for (const [name, hash] of Object.entries(bundle.refs)) {
      const ok = refs.compareAndSwap(name, refs.get(name), hash)
      if (ok) {
        setRefs.push(name)
      } else {
        refConflicts.push(name)
      }
    }
  } else {
    // the bundle is incomplete: name every ref it wanted to move as unmet rather
    // than pointing a branch at a head whose objects are not all present
    for (const name of Object.keys(bundle.refs)) {
      refConflicts.push(name)
    }
  }
  return { stored, rejected, refs: setRefs, refConflicts }
}
