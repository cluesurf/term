import { CANONICAL_FORM_VERSION } from '@term/base/code/canon/cbor'

// The canonical-form version: which rules produced this repository's hashes.
//
// Every commit is addressed by a hash, and the prolly tree, deduplication, sync, mirroring
// and every citeable release address off it. So changing how bytes are canonicalized after
// data exists is a migration of everything ever committed. That is survivable only if a
// repository can SAY which rules it was written under, and refuse a build that means
// something different by the same bytes.
//
// Without this, the two failure modes are both silent. An old reader opening a
// newer-format repository computes different hashes for the same records and concludes the
// data is corrupt. A new reader opening an older one writes chunks the old reader cannot
// address. Neither reports a version problem, because neither knows versions exist.
//
// Stored as a ref rather than in a side table. The ref store is the only mutable state base
// has, every backend already implements it (memory, SQL, R2), and it already offers the
// compare-and-swap that makes claiming the version race-free. A new table would have to be
// added to three backends to hold one string.
//
// See note/library/base/design/canonical-serialization-rigor.md and
// note/library/base/design/projection-sync-protocol.md.

/**
 * The ref that holds a repository's canonical-form version.
 *
 * Under `meta/` rather than `branch/` or `tag/`, so it can never collide with a branch
 * somebody names `format`, and so a listing can tell repository metadata from history.
 */
export const FORMAT_REF = 'meta/format'

// Derived from the encoder's own version rather than restated, so the number a repository
// records and the number the encoder implements cannot drift apart. Restating it is how a
// format change ships with last version's label on it.


/**
 * The canonical form this build reads and writes.
 *
 * `base/1` is DAG-CBOR encoded, hashed with sha256, marks as 16 raw bytes, no floats, and
 * decimals as tagged decimal fractions.
 *
 * Namespaced rather than a bare integer so the string is self-describing wherever it
 * surfaces, and so a fork can pick its own prefix instead of colliding on `2`.
 */
export const FORMAT_VERSION = `base/${CANONICAL_FORM_VERSION}`

/**
 * The versions this build can read.
 *
 * A set rather than a single value because reading an older form stays possible long after
 * writing it stops. Today there is one, and the machinery exists so the second one is a
 * one-line change rather than an archaeology project.
 */
export const READABLE_FORMATS: ReadonlySet<string> = new Set([FORMAT_VERSION])

export type FormatCheck =
  | { ok: true; version: string; claimed: boolean }
  | { ok: false; version: string; reason: 'unreadable' }

/**
 * Settle a repository's canonical-form version before anything is written.
 *
 * Three cases, and the third is the one this exists for:
 *
 *   absent      a fresh repository, or one written before versions existed. Claim it.
 *   ours        proceed.
 *   unknown     REFUSE. Written by a build that means something different by the same
 *               bytes, and touching it would mix two canonical forms in one history.
 *
 * Claiming uses compare-and-swap against absent, so two writers racing on a fresh
 * repository cannot both claim. The loser re-reads and finds the winner's value, which is
 * its own value too, so it proceeds.
 *
 * On an existing repository with no version ref, claiming is the correct move rather than a
 * guess: `base/1` is the only form that has ever been written, so the ref records what is
 * already true instead of asserting something new.
 */
export function settleFormat(refs: {
  get(name: string): string | undefined
  compareAndSwap(
    name: string,
    expected: string | undefined,
    next: string,
  ): boolean
}): FormatCheck {
  const found = refs.get(FORMAT_REF)

  if (found === undefined) {
    const took = refs.compareAndSwap(FORMAT_REF, undefined, FORMAT_VERSION)

    if (took) {
      return { ok: true, version: FORMAT_VERSION, claimed: true }
    }

    // lost the claim, so somebody else just set it. Fall through to reading theirs.
    const settled = refs.get(FORMAT_REF) ?? FORMAT_VERSION

    return READABLE_FORMATS.has(settled)
      ? { ok: true, version: settled, claimed: false }
      : { ok: false, version: settled, reason: 'unreadable' }
  }

  return READABLE_FORMATS.has(found)
    ? { ok: true, version: found, claimed: false }
    : { ok: false, version: found, reason: 'unreadable' }
}
