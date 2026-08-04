import { describe, it, expect } from 'vitest'
import { AccessPolicy, authorizeCommit } from '@/access/policy'
import { generateKeypair, signCommit, verifyCommit } from '@/access/sign'

describe('access policy (relationship-based)', () => {
  it('honors the role hierarchy', () => {
    const p = new AccessPolicy()
    p.grant('alice', 'commit', 'repo')
    // commit implies propose and read
    expect(p.can('alice', 'read', 'repo')).toBe(true)
    expect(p.can('alice', 'propose', 'repo')).toBe(true)
    expect(p.can('alice', 'commit', 'repo')).toBe(true)
    // but not merge or admin
    expect(p.can('alice', 'merge', 'repo')).toBe(false)
    expect(p.can('alice', 'admin', 'repo')).toBe(false)
  })

  it('applies a repo grant to nested resources', () => {
    const p = new AccessPolicy()
    p.grant('alice', 'commit', 'repo')
    expect(p.can('alice', 'commit', 'branch:main')).toBe(true)
    expect(p.can('alice', 'commit', 'field:word.gloss')).toBe(true)
  })

  it('scopes a branch grant to that branch', () => {
    const p = new AccessPolicy()
    p.grant('bob', 'commit', 'branch:feature')
    expect(p.can('bob', 'commit', 'branch:feature')).toBe(true)
    expect(p.can('bob', 'commit', 'branch:main')).toBe(false)
    expect(authorizeCommit(p, 'bob', 'feature')).toBe(true)
    expect(authorizeCommit(p, 'bob', 'main')).toBe(false)
  })

  it('supports anonymous open access via *', () => {
    const p = new AccessPolicy()
    p.grant('*', 'propose', 'repo')
    expect(p.can('anyone', 'propose', 'branch:main')).toBe(true)
    expect(p.can('anyone', 'commit', 'branch:main')).toBe(false)
  })
})

describe('signed authorship (ed25519)', () => {
  it('signs and verifies a commit hash', () => {
    const { publicKey, privateKey } = generateKeypair()
    const commitHash = 'sha256:abc123'
    const sig = signCommit(commitHash, privateKey)
    expect(verifyCommit(commitHash, sig, publicKey)).toBe(true)
  })

  it('rejects a forged or altered signature', () => {
    const { publicKey, privateKey } = generateKeypair()
    const other = generateKeypair()
    const sig = signCommit('sha256:abc', privateKey)
    // wrong content
    expect(verifyCommit('sha256:xyz', sig, publicKey)).toBe(false)
    // wrong key
    expect(verifyCommit('sha256:abc', sig, other.publicKey)).toBe(false)
  })
})
