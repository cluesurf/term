// Access control at the served boundary, tested on the DENIAL paths.
//
// The allow paths were already covered. The ones nobody tests are the ones that return data,
// so every case here is something that must NOT happen.
//
// The failure this file exists for: `getChunk` gated on nothing is a full read bypass, not
// merely a permissive default. A chunk is addressed by its hash and hashes LEAK BY DESIGN,
// into every commit's parents, every log line, every citeable release. So an unguarded
// `getChunk` means anyone who has ever seen a hash reads that content forever, whatever the
// policy says about the branch it sits under.

import { describe, it, expect } from 'vitest'
import { MemoryChunkStore } from '@term/base/code/store/chunk-store'
import { MemoryRefStore } from '@term/base/code/store/ref-store'
import { Repository } from '@term/base/code/repo/repo'
import { MemoryRemoteRepo } from '@term/base/code/transport/session'
import { AccessPolicy } from '@term/base/code/access/policy'
import { guard, Denied } from '@term/base/code/access/serve'
import { record, text } from '@term/base/code/base/make'
import { datasetOf } from '@term/base/code/diff/change'
import { form, property, roleBase } from '@term/base/code/form/form'

const wordForm = form('word', [property('term', { base: 'text' })])
const meta = (time: number, message: string) => ({ author: 'lance', time, message })

function mark(i: number): string {
  return `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
}

function word(i: number, value: string) {
  return record({ type: 'word', mark: mark(i), fields: { term: text(value) } })
}

/** A repository with a public branch and a private one, and a guard for a given user. */
function served(user: string, policy: AccessPolicy) {
  const chunks = new MemoryChunkStore()
  const refs = new MemoryRefStore()
  const repo = new Repository(chunks, refs, roleBase([wordForm]))

  repo.commit('main', meta(1, 'public'), datasetOf([word(1, 'public-word')]))
  const open = repo.head('main')!

  repo.createBranch('secret', { commit: open })
  repo.commit('secret', meta(2, 'private'), datasetOf([word(2, 'secret-word')]))
  const closed = repo.head('secret')!

  const remote = guard({
    inner: new MemoryRemoteRepo(chunks, refs),
    policy,
    user,
    refs: () => refs.list(),
    chunks,
    head: name => refs.get(name),
  })

  return { repo, chunks, refs, remote, open, closed }
}

/** A policy granting `role` on `resource` to `user` and nothing else. */
function only(user: string, role: 'read' | 'commit', resource: string) {
  const policy = new AccessPolicy()
  policy.grant(user, role, resource)

  return policy
}

describe('a reader with no grant at all', () => {
  it('sees no refs, rather than seeing them and being refused', () => {
    const { remote } = served('nobody', new AccessPolicy())

    return expect(remote.listRefs()).resolves.toEqual([])
  })

  it('cannot read a ref, and cannot tell absent from forbidden', async () => {
    const { remote } = served('nobody', new AccessPolicy())

    // undefined for BOTH, so nothing distinguishes a branch that exists from one that does
    // not. A refusal that told them apart would enumerate the branches.
    expect(await remote.getRef('branch/main')).toBeUndefined()
    expect(await remote.getRef('branch/does-not-exist')).toBeUndefined()
  })

  it('cannot read a chunk EVEN HOLDING ITS HASH', async () => {
    // the whole point. Hashes leak, so possession of one must not be authority over it.
    const { remote, open } = served('nobody', new AccessPolicy())

    expect(await remote.getChunk(open)).toBeUndefined()
  })

  it('cannot probe existence by hash either', async () => {
    const { remote, open } = served('nobody', new AccessPolicy())

    // false rather than a refusal, so `has` is not an oracle for whether a hash exists
    expect(await remote.hasChunk(open)).toBe(false)
  })

  it('cannot move a ref', async () => {
    const { remote, open } = served('nobody', new AccessPolicy())

    await expect(remote.setRef('branch/main', open, open)).rejects.toBeInstanceOf(Denied)
  })

  it('cannot write a chunk', async () => {
    const { remote } = served('nobody', new AccessPolicy())

    await expect(remote.putChunk('anything')).rejects.toBeInstanceOf(Denied)
  })
})

describe('a reader granted ONE branch', () => {
  it('sees only that branch', async () => {
    const { remote } = served('reader', only('reader', 'read', 'branch:main'))

    expect(await remote.listRefs()).toEqual(['branch/main'])
  })

  it('reads a chunk reachable from it', async () => {
    const { remote, open } = served('reader', only('reader', 'read', 'branch:main'))

    expect(await remote.getChunk(open)).toBeDefined()
  })

  it('CANNOT read a chunk that only the other branch reaches', async () => {
    // the case a naive guard fails: the user is authorised, holds a valid hash, and the
    // content belongs to a branch they were never granted
    const { remote, closed } = served('reader', only('reader', 'read', 'branch:main'))

    expect(await remote.getChunk(closed)).toBeUndefined()
    expect(await remote.hasChunk(closed)).toBe(false)
  })

  it('cannot move even the branch it can read, with only `read`', async () => {
    const { remote, open } = served('reader', only('reader', 'read', 'branch:main'))

    await expect(remote.setRef('branch/main', open, open)).rejects.toBeInstanceOf(Denied)
  })
})

describe('a writer', () => {
  it('may move the branch it holds commit on', async () => {
    const { remote, open } = served('writer', only('writer', 'commit', 'branch:main'))

    await expect(remote.setRef('branch/main', open, open)).resolves.toBe(true)
  })

  it('may NOT move a different branch', async () => {
    const { remote, closed } = served('writer', only('writer', 'commit', 'branch:main'))

    await expect(
      remote.setRef('branch/secret', closed, closed),
    ).rejects.toBeInstanceOf(Denied)
  })
})

describe('the shape of a refusal', () => {
  it('names the action and never the resource', async () => {
    // a message naming the branch or hash tells an unauthorised caller it exists, which is
    // the thing being withheld
    const { remote, closed } = served('nobody', new AccessPolicy())

    try {
      await remote.setRef('branch/secret', closed, closed)
      expect.unreachable('should have refused')
    } catch (error) {
      const message = (error as Error).message

      expect(message).toContain('not permitted')
      expect(message).not.toContain('secret')
      expect(message).not.toContain(closed)
    }
  })
})

describe('the policy is consulted per call, not captured', () => {
  it('honours a grant added AFTER the guard was built', async () => {
    // reachability and permission are recomputed on every call on purpose. If either were
    // captured at construction, a grant would not take effect until a restart and, worse, a
    // REVOCATION would not either, which makes revoking a formality rather than an act.
    const policy = new AccessPolicy()
    const { remote, open } = served('reader', policy)

    // no grant yet
    expect(await remote.getChunk(open)).toBeUndefined()
    expect(await remote.listRefs()).toEqual([])

    policy.grant('reader', 'read', 'branch:main')

    // the same guard, no rebuild
    expect(await remote.getChunk(open)).toBeDefined()
    expect(await remote.listRefs()).toEqual(['branch/main'])
  })

  it('lets a new branch become visible without rebuilding the guard', async () => {
    // a repo-wide grant plus a branch created later: the ref list is read per call, so the
    // new branch appears rather than being invisible until a restart
    const policy = new AccessPolicy()
    policy.grant('reader', 'read', 'repo')

    const { repo, remote, open } = served('reader', policy)

    // `meta/format` is here because a ref outside `branch/` maps to the `repo` resource
    // rather than being ungoverned, so a repo-wide grant reaches it. That default is what
    // keeps a new ref namespace from arriving unguarded, and it is worth seeing in a test
    // rather than discovering when one does.
    expect((await remote.listRefs()).sort()).toEqual([
      'branch/main',
      'branch/secret',
      'meta/format',
    ])

    repo.createBranch('later', { commit: open })

    expect((await remote.listRefs()).sort()).toEqual([
      'branch/later',
      'branch/main',
      'branch/secret',
      'meta/format',
    ])
  })
})
