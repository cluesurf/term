/**
 * Proving the log everyone else sees is the log you were served.
 *
 * The repository log makes a re-pointed version visible TO ANYONE WHO READS THE LOG. That is
 * not the same as making it visible, because a registry that can rewrite the log can rewrite
 * the evidence that it did, and a verifier has no way to tell whether the log it was handed
 * is the log everyone else has.
 *
 * A CHECKPOINT is a signed root hash and a size. It gives two proofs that need no trust:
 *
 *   INCLUSION    this entry is in the tree that root commits to
 *   CONSISTENCY  that tree is an extension of an earlier one, so nothing already published
 *                was altered or removed
 *
 * Consistency is the one that matters, and it is the one a naive design leaves out. Inclusion
 * alone lets a registry serve two entirely different logs to two verifiers, each internally
 * consistent. Only comparing checkpoints across verifiers catches that, and consistency is
 * what makes the comparison cheap enough that people do it.
 *
 * So to forge a release undetectably, a compromised registry would have to serve a different
 * log to every verifier who ever compared checkpoints. This is the shape Certificate
 * Transparency, the Go checksum database and Rekor all use, for that reason.
 *
 * THE CHECKPOINTS MUST BE PUBLISHED SOMEWHERE WE DO NOT CONTROL. One published only by us is
 * signed by the party it exists to constrain, and this file cannot supply that: it produces
 * the values and the proofs, and where they go is a deployment decision. See
 * note/library/base/design/citeable-releases.md.
 *
 * DOMAIN-SEPARATED HASHES, which is not a detail. A leaf and an interior node are hashed
 * under different prefixes, so no leaf hash can ever equal an interior node hash. Without
 * that separation a crafted leaf can stand in for a whole subtree, and an inclusion proof
 * for something that was never in the log verifies. RFC 6962 separates them for the same
 * reason.
 */

import { hashBytes } from '@term/base/code/canon/hash'
import { signCommit, verifyCommit } from '@term/base/code/access/sign'

/** A signed commitment to the whole log at one size. */
export type Checkpoint = {
  /** entries in the log when this was taken */
  size: number
  /** the Merkle root over those entries */
  root: string
  /** the key that signed it, PEM */
  signer: string
  /** ed25519 over `size` and `root` together */
  signature: string
}

// The domain separators, written as escapes rather than as literal bytes: a literal control
// character in a source file makes it binary to grep and to every tool that reads it.
const LEAF = '\u0000'
const NODE = '\u0001'

function leafHash(entry: string): string {
  return hashBytes(`${LEAF}${entry}`)
}

function nodeHash(left: string, right: string): string {
  return hashBytes(`${NODE}${left}${right}`)
}

/**
 * The largest power of two strictly less than n.
 *
 * The split point RFC 6962 uses. Splitting at the midpoint instead would still build a tree,
 * and would make proofs between different sizes disagree about the shape, so the rule has to
 * be the same everywhere and stated once.
 */
function split(n: number): number {
  let k = 1

  while (k * 2 < n) {
    k *= 2
  }

  return k
}

/** The Merkle root over a range of entries. An empty log hashes the empty string. */
export function rootOf(entries: ReadonlyArray<string>): string {
  if (entries.length === 0) {
    return hashBytes('')
  }

  if (entries.length === 1) {
    return leafHash(entries[0]!)
  }

  const k = split(entries.length)

  return nodeHash(rootOf(entries.slice(0, k)), rootOf(entries.slice(k)))
}

/** A checkpoint over a log, signed. */
export function checkpointOf(input: {
  entries: ReadonlyArray<string>
  privateKey: string
  publicKey: string
}): Checkpoint {
  const root = rootOf(input.entries)
  const size = input.entries.length

  return {
    size,
    root,
    signer: input.publicKey,
    // size and root together, so a signature cannot be lifted onto a different size
    signature: signCommit(`${size}:${root}`, input.privateKey),
  }
}

/** Whether a checkpoint was signed by the key it names. */
export function checkpointSigned(checkpoint: Checkpoint): boolean {
  return verifyCommit(
    `${checkpoint.size}:${checkpoint.root}`,
    checkpoint.signature,
    checkpoint.signer,
  )
}

/**
 * The audit path proving entry `index` is in a log of `entries`.
 *
 * Sibling hashes from the leaf up. The verifier recomputes the root from the entry and the
 * path, so the path is worthless unless the entry is genuinely there.
 */
export function inclusionProof(
  entries: ReadonlyArray<string>,
  index: number,
): Array<string> {
  if (index < 0 || index >= entries.length || entries.length === 1) {
    return []
  }

  const k = split(entries.length)

  return index < k
    ? [...inclusionProof(entries.slice(0, k), index), rootOf(entries.slice(k))]
    : [
        ...inclusionProof(entries.slice(k), index - k),
        rootOf(entries.slice(0, k)),
      ]
}

/**
 * Does this entry sit at this index in a log with this root?
 *
 * Rebuilds the root from the entry and the path. The index and the size are both needed
 * because they decide which side each sibling goes on, and getting that wrong is how a proof
 * for one position verifies at another.
 */
export function verifyInclusion(input: {
  entry: string
  index: number
  size: number
  root: string
  proof: ReadonlyArray<string>
}): boolean {
  if (input.index < 0 || input.index >= input.size) {
    return false
  }

  // The descent has to be worked out TOP-DOWN, because only the size tells you where a
  // level splits. The proof is ordered LEAF-UPWARD, because that is the order it is built
  // in. So the sides are collected on the way down and applied in reverse on the way up.
  //
  // Consuming the proof top-down instead reads the root's sibling first and the leaf's
  // sibling last, which is the wrong pairing at every level. It still verifies for a log
  // whose size is a power of two, because there the tree is symmetric and the order happens
  // not to matter, so a test that only tried 2, 4, 8 would have passed. Caught at size 3.
  const sides: Array<'left' | 'right'> = []
  let index = input.index
  let size = input.size

  while (size > 1) {
    const k = split(size)

    if (index < k) {
      // the entry is in the left subtree, so its sibling is on the right
      sides.push('right')
      size = k
    } else {
      sides.push('left')
      index -= k
      size -= k
    }
  }

  if (sides.length !== input.proof.length) {
    // A proof with the wrong number of steps is a proof for a different tree. Checking the
    // count up front also means the loop below cannot read past the end.
    return false
  }

  let hash = leafHash(input.entry)

  for (const [step, side] of [...sides].reverse().entries()) {
    const sibling = input.proof[step]!

    hash = side === 'right' ? nodeHash(hash, sibling) : nodeHash(sibling, hash)
  }

  return hash === input.root
}

/**
 * Is the log at `after` an extension of the log at `before`?
 *
 * THE PROOF THAT MATTERS. Inclusion says an entry is in some tree; this says the tree is the
 * same tree, grown. Without it a registry can serve two different logs to two verifiers and
 * both are internally consistent.
 *
 * Proved by recomputing rather than by shipping an audit path, because the caller that needs
 * this holds the entries: it is the log's operator publishing a checkpoint, or a verifier
 * that has downloaded the log. A path-based version, for a verifier holding only the two
 * checkpoints, is a strictly later concern than having the property at all.
 */
export function consistent(input: {
  entries: ReadonlyArray<string>
  before: Checkpoint
  after: Checkpoint
}): boolean {
  if (input.before.size > input.after.size) {
    return false
  }

  if (input.after.size !== input.entries.length) {
    return false
  }

  if (rootOf(input.entries) !== input.after.root) {
    return false
  }

  return rootOf(input.entries.slice(0, input.before.size)) === input.before.root
}
