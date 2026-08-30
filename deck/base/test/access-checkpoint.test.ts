// Proving the log everyone else sees is the log you were served.
//
// The repository log makes a re-pointed version visible to anyone who reads the log, which
// is not the same as making it visible: a registry that can rewrite the log can rewrite the
// evidence that it did. A checkpoint is a signed root and a size, and it gives two proofs
// that need no trust.
//
// The tests below are chosen for the ways a Merkle log is usually wrong, not for the ways it
// is usually right. A tree that computes a root and verifies its own proofs is easy; the
// value is entirely in what it REFUSES.
//
// See note/library/base/design/citeable-releases.md.

import { describe, it, expect } from 'vitest'
import { generateKeypair } from '@term/base/code/access/sign'
import {
  checkpointOf,
  checkpointSigned,
  consistent,
  inclusionProof,
  rootOf,
  verifyInclusion,
} from '@term/base/code/access/checkpoint'

const KEY = generateKeypair()
const OTHER = generateKeypair()

function logOf(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `entry-${i}`)
}

function checkpoint(entries: string[]) {
  return checkpointOf({
    entries,
    privateKey: KEY.privateKey,
    publicKey: KEY.publicKey,
  })
}

describe('the root', () => {
  it('changes when any entry changes', () => {
    const entries = logOf(9)
    const edited = [...entries]

    edited[4] = 'tampered'

    expect(rootOf(edited)).not.toBe(rootOf(entries))
  })

  it('changes when two entries are swapped', () => {
    // Order is part of the log. A root that ignored it would let a registry reorder history
    // and still show the same commitment.
    const entries = logOf(9)
    const swapped = [...entries]

    swapped[2] = entries[6]!
    swapped[6] = entries[2]!

    expect(rootOf(swapped)).not.toBe(rootOf(entries))
  })

  it('is stable for the same entries', () => {
    expect(rootOf(logOf(13))).toBe(rootOf(logOf(13)))
  })

  it('separates a leaf from an interior node', () => {
    // THE ATTACK THIS PREVENTS. Without domain separation, a leaf whose content happens to
    // be the concatenation of two child hashes has the same hash as the interior node above
    // them, so a crafted leaf can stand in for a whole subtree and an inclusion proof for
    // something that was never in the log verifies.
    const left = rootOf(['a'])
    const right = rootOf(['b'])
    const interior = rootOf(['a', 'b'])

    expect(rootOf([`${left}${right}`])).not.toBe(interior)
  })
})

describe('an inclusion proof', () => {
  it('verifies for every entry, at every log size up to 33', () => {
    // Sizes that are not powers of two are where a split rule goes wrong, so this walks
    // every size rather than picking a comfortable one.
    for (let size = 1; size <= 33; size++) {
      const entries = logOf(size)
      const root = rootOf(entries)

      for (let index = 0; index < size; index++) {
        const ok = verifyInclusion({
          entry: entries[index]!,
          index,
          size,
          root,
          proof: inclusionProof(entries, index),
        })

        expect(ok, `size ${size}, index ${index}`).toBe(true)
      }
    }
  })

  it('fails for an entry that is not in the log', () => {
    const entries = logOf(16)

    expect(
      verifyInclusion({
        entry: 'never-added',
        index: 3,
        size: 16,
        root: rootOf(entries),
        proof: inclusionProof(entries, 3),
      }),
    ).toBe(false)
  })

  it('fails when the proof is for a different position', () => {
    // A path is only meaningful with its index, because the index decides which side each
    // sibling goes on. Accepting a path at the wrong position would let one proof serve for
    // any entry.
    const entries = logOf(16)

    expect(
      verifyInclusion({
        entry: entries[5]!,
        index: 6,
        size: 16,
        root: rootOf(entries),
        proof: inclusionProof(entries, 5),
      }),
    ).toBe(false)
  })

  it('fails when a sibling in the path is altered', () => {
    const entries = logOf(16)
    const proof = inclusionProof(entries, 5)

    proof[0] = rootOf(['something else'])

    expect(
      verifyInclusion({
        entry: entries[5]!,
        index: 5,
        size: 16,
        root: rootOf(entries),
        proof,
      }),
    ).toBe(false)
  })

  it('fails on a proof with extra steps left over', () => {
    // A proof that agrees on the prefix and carries more is a proof for a DIFFERENT tree.
    // Stopping as soon as the root matches would accept it.
    const entries = logOf(8)

    expect(
      verifyInclusion({
        entry: entries[1]!,
        index: 1,
        size: 8,
        root: rootOf(entries),
        proof: [...inclusionProof(entries, 1), rootOf(['extra'])],
      }),
    ).toBe(false)
  })

  it('fails on a truncated proof rather than reading past the end', () => {
    const entries = logOf(8)

    expect(
      verifyInclusion({
        entry: entries[1]!,
        index: 1,
        size: 8,
        root: rootOf(entries),
        proof: inclusionProof(entries, 1).slice(0, 1),
      }),
    ).toBe(false)
  })

  it('refuses an index outside the log', () => {
    const entries = logOf(4)

    expect(
      verifyInclusion({
        entry: 'x',
        index: 9,
        size: 4,
        root: rootOf(entries),
        proof: [],
      }),
    ).toBe(false)
  })
})

describe('a consistency proof', () => {
  it('holds when the log only grew', () => {
    // The property that makes the whole scheme worth anything: the tree is the same tree,
    // grown, rather than merely another internally consistent tree.
    const before = checkpoint(logOf(7))
    const entries = logOf(19)

    expect(consistent({ entries, before, after: checkpoint(entries) })).toBe(true)
  })

  it('holds across every pair of sizes up to 24', () => {
    for (let small = 0; small <= 24; small++) {
      for (let large = small; large <= 24; large++) {
        const entries = logOf(large)

        expect(
          consistent({
            entries,
            before: checkpoint(logOf(small)),
            after: checkpoint(entries),
          }),
          `${small} -> ${large}`,
        ).toBe(true)
      }
    }
  })

  it('FAILS when an already-published entry was altered', () => {
    // The forgery this exists to catch: a registry re-pointing a version it already
    // published, and growing the log afterwards so the newest checkpoint looks fine.
    const before = checkpoint(logOf(7))
    const entries = logOf(19)

    entries[3] = 'silently rewritten'

    expect(consistent({ entries, before, after: checkpoint(entries) })).toBe(false)
  })

  it('FAILS when an already-published entry was removed', () => {
    const before = checkpoint(logOf(8))
    const entries = logOf(12).filter((_, i) => i !== 2)

    expect(consistent({ entries, before, after: checkpoint(entries) })).toBe(false)
  })

  it('fails when the log shrank', () => {
    const before = checkpoint(logOf(12))
    const entries = logOf(5)

    expect(consistent({ entries, before, after: checkpoint(entries) })).toBe(false)
  })

  it('fails when the entries do not match the checkpoint they are checked against', () => {
    // A checkpoint is only a commitment if the entries are held to it. Skipping this would
    // let any log satisfy any checkpoint.
    const entries = logOf(10)

    expect(
      consistent({
        entries,
        before: checkpoint(logOf(4)),
        after: checkpoint(logOf(10).map(one => `${one}-different`)),
      }),
    ).toBe(false)
  })
})

describe('the signature on a checkpoint', () => {
  it('verifies against the key that signed it', () => {
    expect(checkpointSigned(checkpoint(logOf(6)))).toBe(true)
  })

  it('fails when the root is changed underneath it', () => {
    const one = checkpoint(logOf(6))

    expect(
      checkpointSigned({ ...one, root: rootOf(logOf(7)) }),
    ).toBe(false)
  })

  it('fails when the SIZE is changed and the root is not', () => {
    // Both are signed together, so a checkpoint cannot be lifted onto a different size. A
    // signature over the root alone would let a small log's commitment be presented as a
    // large one's.
    const one = checkpoint(logOf(6))

    expect(checkpointSigned({ ...one, size: 99 })).toBe(false)
  })

  it('fails when another key claims it', () => {
    const one = checkpoint(logOf(6))

    expect(checkpointSigned({ ...one, signer: OTHER.publicKey })).toBe(false)
  })
})
