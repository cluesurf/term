// Binding a key to a publisher, for a range of time.
//
// `verifyCommit` proves the holder of a key signed a commit. It says nothing about WHOSE key
// it was, and the commit carries the key it was signed with, which is circular: anyone can
// generate a key and sign anything. So a signature alone proves only that a release has not
// changed since whoever made it signed it, and that is the weakest of the four guarantees a
// citation makes.
//
// The properties worth holding are all about TIME, because a directory that only says which
// key is CURRENT gets both rotations wrong: an ordinary rotation would invalidate every
// release signed before it, and a compromise would force a choice between leaving forged
// signatures valid and invalidating honest history.
//
// See note/library/base/design/citeable-releases.md.

import { describe, it, expect } from 'vitest'
import { generateKeypair, signCommit } from '@term/base/code/access/sign'
import {
  canonicalDirectory,
  covers,
  endKey,
  keysAt,
  verifyAuthorship,
  type Directory,
} from '@term/base/code/access/directory'

const COMMIT = 'kvmtnhbs-rzdxfwlc-mnbdtkhs-fvzxcwlr'

const JANUARY = Date.parse('2026-01-01T00:00:00.000Z')
const JUNE = Date.parse('2026-06-01T00:00:00.000Z')
const DECEMBER = Date.parse('2026-12-01T00:00:00.000Z')

const OLD = generateKeypair()
const NEW = generateKeypair()
const STRANGER = generateKeypair()

/** A rotation: the old key ran to June, the new one from June. */
const DIRECTORY: Directory = {
  entries: [
    { publisher: 'commons', publicKey: OLD.publicKey, from: JANUARY, to: JUNE },
    { publisher: 'commons', publicKey: NEW.publicKey, from: JUNE },
  ],
}

function signedBy(key: { privateKey: string; publicKey: string }) {
  return {
    publicKey: key.publicKey,
    signature: signCommit(COMMIT, key.privateKey),
  }
}

describe('verifying who signed a release', () => {
  it('accepts a key that was valid at the commit time', () => {
    const verdict = verifyAuthorship({
      directory: DIRECTORY,
      publisher: 'commons',
      ...signedBy(OLD),
      commit: COMMIT,
      at: JANUARY + 1000,
    })

    expect(verdict.ok).toBe(true)
  })

  it('still accepts a release signed BEFORE a rotation', () => {
    // The property the whole design exists for. Rotating a key must not invalidate every
    // citation made before the rotation, and a directory that only knew the current key
    // would refuse this.
    const verdict = verifyAuthorship({
      directory: DIRECTORY,
      publisher: 'commons',
      ...signedBy(OLD),
      commit: COMMIT,
      at: JANUARY + 1000,
    })

    expect(verdict.ok).toBe(true)
    expect(verdict.ok && verdict.entry.publicKey).toBe(OLD.publicKey)
  })

  it('refuses the old key for a commit made after the rotation', () => {
    // The other direction, and what makes a revocation mean anything: a key that stopped
    // being valid cannot sign anything dated after it stopped.
    const verdict = verifyAuthorship({
      directory: DIRECTORY,
      publisher: 'commons',
      ...signedBy(OLD),
      commit: COMMIT,
      at: DECEMBER,
    })

    expect(verdict).toEqual({ ok: false, reason: 'expired' })
  })

  it('refuses a key that belongs to somebody else', () => {
    const directory: Directory = {
      entries: [
        { publisher: 'someone', publicKey: NEW.publicKey, from: JANUARY },
      ],
    }

    const verdict = verifyAuthorship({
      directory,
      publisher: 'commons',
      ...signedBy(NEW),
      commit: COMMIT,
      at: JUNE,
    })

    expect(verdict).toEqual({ ok: false, reason: 'wrong-publisher' })
  })

  it('refuses a key nobody has ever registered', () => {
    // The circularity this file removes: a self-generated key signing its own release.
    const verdict = verifyAuthorship({
      directory: DIRECTORY,
      publisher: 'commons',
      ...signedBy(STRANGER),
      commit: COMMIT,
      at: JUNE,
    })

    expect(verdict).toEqual({ ok: false, reason: 'unknown-key' })
  })

  it('checks the SIGNATURE before it consults the directory', () => {
    // Answering `unknown-key` to a forged signature would turn this into a lookup service
    // for which keys exist. A bad signature has to be refused as a bad signature, whatever
    // the directory would have said.
    const verdict = verifyAuthorship({
      directory: DIRECTORY,
      publisher: 'commons',
      publicKey: STRANGER.publicKey,
      signature: signCommit('a different commit', STRANGER.privateKey),
      commit: COMMIT,
      at: JUNE,
    })

    expect(verdict).toEqual({ ok: false, reason: 'signature' })
  })
})

describe('the range boundaries', () => {
  it('includes `from` and excludes `to`', () => {
    // Exclusive at the end so two entries in a rotation are never both valid at the instant
    // they meet, which is the one moment a rotation has to be unambiguous about.
    const entry = { publisher: 'commons', publicKey: OLD.publicKey, from: JANUARY, to: JUNE }

    expect(covers(entry, JANUARY)).toBe(true)
    expect(covers(entry, JUNE - 1)).toBe(true)
    expect(covers(entry, JUNE)).toBe(false)
    expect(covers(entry, JANUARY - 1)).toBe(false)
  })

  it('leaves exactly one key valid at the moment of a rotation', () => {
    expect(keysAt(DIRECTORY, 'commons', JUNE)).toHaveLength(1)
    expect(keysAt(DIRECTORY, 'commons', JUNE)[0]?.publicKey).toBe(NEW.publicKey)
    expect(keysAt(DIRECTORY, 'commons', JUNE - 1)[0]?.publicKey).toBe(
      OLD.publicKey,
    )
  })

  it('treats an entry with no `to` as still valid', () => {
    expect(keysAt(DIRECTORY, 'commons', DECEMBER)).toHaveLength(1)
  })
})

describe('ending a key', () => {
  it('does not invalidate what it signed before', () => {
    // The property most likely to be broken by a later "simplify this" pass, so it is held
    // rather than only written down. Revoking a compromised key must not take the honest
    // history down with it.
    const open: Directory = {
      entries: [
        { publisher: 'commons', publicKey: OLD.publicKey, from: JANUARY },
      ],
    }

    const revoked = endKey({
      directory: open,
      publisher: 'commons',
      publicKey: OLD.publicKey,
      at: JUNE,
    })

    const before = verifyAuthorship({
      directory: revoked,
      publisher: 'commons',
      ...signedBy(OLD),
      commit: COMMIT,
      at: JANUARY + 1000,
    })

    const after = verifyAuthorship({
      directory: revoked,
      publisher: 'commons',
      ...signedBy(OLD),
      commit: COMMIT,
      at: DECEMBER,
    })

    expect(before.ok).toBe(true)
    expect(after).toEqual({ ok: false, reason: 'expired' })
  })

  it('returns a new directory rather than mutating the old one', () => {
    // The old directory is what earlier verifications were made against, and something may
    // still be holding it.
    const open: Directory = {
      entries: [
        { publisher: 'commons', publicKey: OLD.publicKey, from: JANUARY },
      ],
    }

    endKey({
      directory: open,
      publisher: 'commons',
      publicKey: OLD.publicKey,
      at: JUNE,
    })

    expect(open.entries[0]?.to).toBeUndefined()
  })

  it('leaves an already-ended entry alone', () => {
    // Ending a key twice must not move the first ending later, which would quietly re-open
    // a window that was closed.
    const twice = endKey({
      directory: DIRECTORY,
      publisher: 'commons',
      publicKey: OLD.publicKey,
      at: DECEMBER,
    })

    expect(twice.entries[0]?.to).toBe(JUNE)
  })
})

describe('the canonical form', () => {
  it('does not depend on the order the entries were added in', () => {
    // A checkpoint is taken over these bytes. If the order leaked in, rebuilding the
    // directory would change the hash and a consistency proof would report a rewrite that
    // never happened.
    const forward: Directory = { entries: [...DIRECTORY.entries] }
    const backward: Directory = { entries: [...DIRECTORY.entries].reverse() }

    expect(canonicalDirectory(forward)).toBe(canonicalDirectory(backward))
  })

  it('changes when an entry validity range changes', () => {
    const revoked = endKey({
      directory: DIRECTORY,
      publisher: 'commons',
      publicKey: NEW.publicKey,
      at: DECEMBER,
    })

    expect(canonicalDirectory(revoked)).not.toBe(canonicalDirectory(DIRECTORY))
  })
})
