import type { ChunkStore } from '@term/base/code/store/chunk-store'
import type { RefStore } from '@term/base/code/store/ref-store'
import { reachableChunks } from '@term/base/code/gc/gc'
import { fsck } from '@term/base/code/verify/fsck'

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

/**
 * The transfer framing's own version, SEPARATE from the canonical form's.
 *
 * `base/1` names the bytes a record hashes to. This names how a set of chunks and refs is
 * packaged for transfer. They are two different things that change for different reasons,
 * and formats that version them together end up unable to fix one without a flag day for the
 * other. Keeping them apart costs one field now and is the mistake most formats make once.
 *
 * A frozen wire format is the point: once anyone implements against it, changing it is
 * expensive, and a bundle that carries no version cannot be changed at all without guessing
 * at what a reader will do.
 */
export const BUNDLE_FORMAT = 'base-bundle/1'

/** A bundle as it travels: the framing version, then the payload. */
type Framed = { format: string } & Bundle

/**
 * A map with its keys in sorted order.
 *
 * `JSON.stringify` writes an object's keys in INSERTION order, so without this two hosts
 * packaging the same slice produce different bytes purely from the order they happened to
 * add things in. Found by the conformance corpus on 2026-08-30, the first time the framing
 * was pinned to a digest.
 *
 * It matters wherever the bundle's own bytes are the identity: content-addressing a deposit,
 * comparing two copies of one release, or signing a transfer. Every one of those silently
 * says "different" for two bundles that hold exactly the same thing.
 */
function ordered(map: { [key: string]: string }): { [key: string]: string } {
  const out: { [key: string]: string } = {}

  for (const key of Object.keys(map).sort()) {
    out[key] = map[key]!
  }

  return out
}

export function encodeBundle(bundle: Bundle): string {
  // `format` first, so a reader can see what it is holding before it has parsed the rest,
  // and so a human looking at the head of a large file learns the version immediately.
  const framed: Framed = {
    format: BUNDLE_FORMAT,
    refs: ordered(bundle.refs),
    chunks: ordered(bundle.chunks),
  }

  return JSON.stringify(framed)
}

/**
 * Read a bundle, refusing a framing this build does not understand.
 *
 * REFUSES rather than guesses, including for a bundle with no `format` at all. A reader that
 * treats an unknown or absent version as "probably the current one" will parse a future
 * bundle into the wrong shape and report success, and content addressing does not save it:
 * the chunks would verify individually while the refs meant something else.
 *
 * Nothing has been deposited or transferred in production yet, so being strict costs nothing
 * today and is the only moment it is free.
 */
export function decodeBundle(bytes: string): Bundle {
  const parsed = JSON.parse(bytes) as Partial<Framed>

  if (parsed.format !== BUNDLE_FORMAT) {
    throw new Error(
      `unknown bundle framing ${JSON.stringify(parsed.format ?? null)}: this build reads ${BUNDLE_FORMAT}`,
    )
  }

  if (
    typeof parsed.refs !== 'object' ||
    parsed.refs === null ||
    typeof parsed.chunks !== 'object' ||
    parsed.chunks === null
  ) {
    throw new Error('a bundle must carry a refs map and a chunks map')
  }

  return { refs: parsed.refs, chunks: parsed.chunks }
}

/**
 * What a bundle proved about itself, offline.
 *
 * `complete` is the claim that matters and the one `applyBundle` cannot make: every chunk
 * the commit reaches is present IN THE BUNDLE. A bundle can be entirely un-tampered and
 * still be a truncated copy, and a truncated copy applies without complaint until somebody
 * reads the part that is not there.
 */
export type BundleVerdict = {
  /** the commit is present, every chunk it reaches is present, and every one hashes */
  ok: boolean
  /** chunks the walk followed a reference into and the bundle does not carry */
  missing: Array<string>
  /** chunks whose bytes do not hash to the name they are filed under */
  corrupt: Array<string>
  /** chunks reached from the commit */
  checked: number
  /** chunks the bundle carries that the commit does not reach */
  extra: Array<string>
}

/**
 * Verify a bundle against a commit, with no store, no network, and no trust in the source.
 *
 * THE PROPERTY A DEPOSIT NEEDS. A citation names a commit; a copy of the bundle turns up
 * somewhere, an archive, a mirror, a colleague's disk. This answers whether that copy IS the
 * release, from the bytes alone. It is what lets a deposit be a fallback without becoming a
 * fork: the same bytes under the same hashes, verified without asking anyone.
 *
 * READ ONLY, deliberately. `applyBundle` re-hashes on the way in, which is the right check
 * for a receiver that wants the data, and it is the wrong shape for a verifier: it mutates a
 * store, so checking a stranger's file means letting it write into yours first. Nobody
 * should have to accept a copy in order to find out whether to accept it.
 *
 * `extra` is reported and does NOT fail the verdict. Chunks the commit cannot reach are
 * harmless, since content addressing means nothing can reference them by accident, and a
 * bundle carrying several refs legitimately holds chunks this one commit does not touch.
 * Reporting them anyway, because a deposit that is mostly unreachable is worth a look.
 *
 * See note/library/base/design/citeable-releases.md.
 */
export function verifyBundle(input: {
  bundle: Bundle
  commit: string
}): BundleVerdict {
  const held = new Map(Object.entries(input.bundle.chunks))

  if (!held.has(input.commit)) {
    return {
      ok: false,
      missing: [input.commit],
      corrupt: [],
      checked: 0,
      extra: [...held.keys()],
    }
  }

  // A read-only view, so `fsck` does the walk rather than a second one written here. A
  // second implementation of a graph walk disagrees with the first eventually, and this is
  // the walk that decides whether a citation resolves.
  const view: ChunkStore = {
    get: (hash: string) => held.get(hash),
    // A verifier that can write is a verifier that can be made to store what it is
    // checking. This throws rather than quietly accepting, because a caller reaching for it
    // has confused verifying with receiving, and `applyBundle` is the one that receives.
    put: () => {
      throw new Error('verifyBundle does not write')
    },
    has: (hash: string) => held.has(hash),
    size: () => held.size,
  }

  const report = fsck(view, [input.commit])

  // `extra` is computed ONLY when the walk succeeded, and that is not a convenience.
  // `reachableChunks` THROWS on a chunk it followed a reference into and cannot read, so
  // asking it about a broken bundle fails inside the reporting rather than returning the
  // finding. And on a broken bundle the question is meaningless anyway: what is unreachable
  // cannot be known when part of the graph is unreadable.
  const reached = report.ok
    ? reachableChunks(view, [input.commit])
    : new Set<string>()

  const extra = report.ok
    ? [...held.keys()].filter(hash => !reached.has(hash))
    : []

  return {
    ok: report.ok,
    missing: report.missing,
    corrupt: report.corrupt,
    checked: report.checked,
    extra,
  }
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
