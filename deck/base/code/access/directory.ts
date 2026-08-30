/**
 * Which key belonged to which publisher, and when.
 *
 * `verifyCommit` proves that the holder of a key signed a commit. It says nothing about
 * WHOSE key it was, and the commit carries the key it was signed with, which is circular:
 * anyone can generate a key and sign anything with it. So a signature alone proves only that
 * a release has not changed since whoever made it signed it.
 *
 * This is the other half. A directory binds a public key to a publisher for a RANGE OF TIME,
 * and verification asks whether the signing key was valid for the claimed publisher AT THE
 * COMMIT'S TIME.
 *
 * TIME-SCOPED, NEVER "CURRENT", and this is the decision the whole file exists to encode. A
 * directory that only says which key is current gets both rotations wrong:
 *
 *   an ordinary rotation would invalidate every release signed before it, because the old
 *   key is no longer current, and a citation that stops verifying is worse than useless
 *
 *   a compromise would force a choice between leaving the forged signatures valid and
 *   invalidating the honest history signed before the key was taken
 *
 * With ranges, a rotation ends one entry and opens another, and a compromise ends an entry
 * at the moment of the breach, so releases before it stay verifiable and anything signed
 * after it does not.
 *
 * APPEND-ONLY, and this file does not enforce that on its own. A directory is only worth
 * what the log carrying it is worth: whoever serves it can also rewrite it, which is why the
 * design pairs it with published checkpoints somewhere we do not control. See
 * note/library/base/design/citeable-releases.md and base-hosted-0007.
 */

import { verifyCommit } from '@term/base/code/access/sign'

/**
 * One key's validity for one publisher.
 *
 * `from` and `to` are epoch milliseconds, `from` inclusive and `to` EXCLUSIVE, so two
 * consecutive entries in a rotation cannot both be valid at the instant they meet. An
 * overlap would let either key sign at that moment, which is the one thing a rotation is
 * meant to make unambiguous.
 */
export type KeyEntry = {
  publisher: string
  /** the public key, PEM, exactly as `generateKeypair` produces it */
  publicKey: string
  from: number
  /** absent means still valid */
  to?: number
}

export type Directory = {
  entries: Array<KeyEntry>
}

/** Why a verification was refused. Named, because the four call for different responses. */
export type Refusal =
  // the signature does not verify against the key at all
  | 'signature'
  // the key is in the directory, for this publisher, but not at this time
  | 'expired'
  // the key is in the directory but belongs to someone else
  | 'wrong-publisher'
  // the key is not in the directory at all
  | 'unknown-key'

export type Verdict =
  | { ok: true; entry: KeyEntry }
  | { ok: false; reason: Refusal }

/** Whether an entry covers an instant. `from` inclusive, `to` exclusive. */
export function covers(entry: KeyEntry, at: number): boolean {
  return at >= entry.from && (entry.to === undefined || at < entry.to)
}

/**
 * Was this commit signed by a key that belonged to this publisher at this time?
 *
 * THE ORDER OF THE CHECKS IS THE POINT. The signature is verified FIRST, before the
 * directory is consulted, so a caller cannot learn anything about the directory by
 * presenting a signature that was never valid. Answering `unknown-key` to a forged
 * signature would turn this into a lookup service for which keys exist.
 *
 * `at` is the COMMIT'S time, not now. Verifying against the present would mean a citation
 * stops verifying the moment a key rotates, which is exactly the failure the ranges exist to
 * prevent, reintroduced by the caller.
 */
export function verifyAuthorship(input: {
  directory: Directory
  publisher: string
  publicKey: string
  commit: string
  signature: string
  at: number
}): Verdict {
  if (!verifyCommit(input.commit, input.signature, input.publicKey)) {
    return { ok: false, reason: 'signature' }
  }

  const forKey = input.directory.entries.filter(
    entry => entry.publicKey === input.publicKey,
  )

  if (!forKey.length) {
    return { ok: false, reason: 'unknown-key' }
  }

  const mine = forKey.filter(entry => entry.publisher === input.publisher)

  if (!mine.length) {
    return { ok: false, reason: 'wrong-publisher' }
  }

  const entry = mine.find(one => covers(one, input.at))

  return entry ? { ok: true, entry } : { ok: false, reason: 'expired' }
}

/** Every key valid for a publisher at an instant. Usually one, and never assumed to be. */
export function keysAt(
  directory: Directory,
  publisher: string,
  at: number,
): Array<KeyEntry> {
  return directory.entries.filter(
    entry => entry.publisher === publisher && covers(entry, at),
  )
}

/**
 * A directory with a key's validity ended at an instant.
 *
 * The one operation both a rotation and a revocation need, and they differ only in what the
 * caller does next: a rotation appends a new entry starting where this one ended, a
 * revocation does not.
 *
 * RETURNS A NEW DIRECTORY rather than mutating, because the old one is what earlier
 * verifications were made against and something may still be holding it.
 *
 * Ending a key does NOT invalidate what it signed before `at`. That is the whole reason the
 * entries carry ranges, and it is the property most likely to be broken by a later "simplify
 * this" pass, so it is stated here and held by a test.
 */
export function endKey(input: {
  directory: Directory
  publisher: string
  publicKey: string
  at: number
}): Directory {
  return {
    entries: input.directory.entries.map(entry =>
      entry.publisher === input.publisher &&
      entry.publicKey === input.publicKey &&
      entry.to === undefined
        ? { ...entry, to: input.at }
        : entry,
    ),
  }
}

/**
 * The directory as canonical bytes, for hashing, signing, or publishing a checkpoint over.
 *
 * Sorted by publisher, then `from`, then key, so two directories holding the same entries
 * serialise identically whatever order they were built in. Without that a checkpoint over
 * the directory would change every time it was rebuilt, and a consistency proof would report
 * a rewrite that never happened.
 */
export function canonicalDirectory(directory: Directory): string {
  const sorted = [...directory.entries].sort((one, two) => {
    if (one.publisher !== two.publisher) {
      return one.publisher < two.publisher ? -1 : 1
    }

    if (one.from !== two.from) {
      return one.from - two.from
    }

    return one.publicKey < two.publicKey ? -1 : one.publicKey > two.publicKey ? 1 : 0
  })

  return JSON.stringify(
    sorted.map(entry => [
      entry.publisher,
      entry.publicKey,
      entry.from,
      entry.to ?? null,
    ]),
  )
}
