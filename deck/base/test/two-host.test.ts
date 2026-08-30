// Two hosts, one repository.
//
// `transport/`, `sync/` and `mirror.test.ts` all exist, and two hosts have never actually
// talked to each other. Everything in `base-hosted` is deployment detail once this passes,
// and doing it as a test means the first failure lands on a laptop rather than in production.
//
// The property is the one the Git-not-GitHub split promises: clone a repository to a second
// host, commit on both, reconcile, and END WITH IDENTICAL HISTORIES. Not similar. Identical,
// compared by commit hash, because content addressing means two histories that agree on their
// hashes agree on every byte beneath them, and any weaker comparison would pass on a
// transfer that silently dropped something.
//
// The `RemoteRepo` seam is the network boundary, so a real server implements the same
// interface over https or ssh and this exercises everything except the socket. Two SEPARATE
// stores stand for two hosts, and the test asserts a chunk is actually absent from one before
// it is fetched, so "already had it" cannot masquerade as "transferred it".

import { describe, it, expect } from 'vitest'
import { MemoryChunkStore } from '@term/base/code/store/chunk-store'
import { MemoryRefStore } from '@term/base/code/store/ref-store'
import { Repository } from '@term/base/code/repo/repo'
import { MemoryRemoteRepo } from '@term/base/code/transport/session'
import { applyChunks } from '@term/base/code/sync/chunk-sync'
import { record, text } from '@term/base/code/base/make'
import { datasetOf } from '@term/base/code/diff/change'
import { form, property, roleBase } from '@term/base/code/form/form'

const wordForm = form('word', [property('term', { base: 'text' })])

const meta = (time: number, message: string) => ({
  author: 'lance',
  time,
  message,
})

// uuid v4: the record validator refuses a mark that merely looks like a uuid
function mark(i: number): string {
  return `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
}

function word(i: number, value: string) {
  return record({ type: 'word', mark: mark(i), fields: { term: text(value) } })
}

/** A host: its own chunk store, its own refs, its own repository. */
function host() {
  const chunks = new MemoryChunkStore()
  const refs = new MemoryRefStore()

  return {
    chunks,
    refs,
    repo: new Repository(chunks, refs, roleBase([wordForm])),
    remote: () => new MemoryRemoteRepo(chunks, refs),
  }
}

/** Every commit reachable from a branch, oldest first, as hashes. */
function historyOf(repo: Repository, branch: string): string[] {
  return repo
    .log(branch)
    .map(entry => entry.hash)
    .reverse()
}

describe('two hosts, one repository', () => {
  it('clones a repository to a second host, byte for byte', async () => {
    const one = host()

    expect(
      one.repo.commit(
        'main',
        meta(1, 'two words'),
        datasetOf([word(1, 'alpha'), word(2, 'beta')]),
      ).ok,
    ).toBe(true)

    const head = one.repo.head('main')!
    const two = host()

    // the second host genuinely lacks it, so a successful pull cannot be "already had it"
    expect(two.chunks.has(head)).toBe(false)

    const pulled = await two.repo.pull(one.remote(), 'main')

    expect(pulled.ok).toBe(true)
    expect(two.repo.head('main')).toBe(head)

    // identical by hash, which under content addressing means identical beneath
    expect(historyOf(two.repo, 'main')).toEqual(historyOf(one.repo, 'main'))

    // and the records actually read on the second host, rather than the refs merely pointing
    const there = two.repo.checkout(head)

    expect([...there.keys()].sort()).toEqual([mark(1), mark(2)])
    expect(there.get(mark(1))!.fields.get('term')).toEqual(text('alpha'))
  })

  it('pushes a commit made on the second host back to the first', async () => {
    const one = host()

    one.repo.commit('main', meta(1, 'first'), datasetOf([word(1, 'alpha')]))

    const two = host()
    await two.repo.pull(one.remote(), 'main')

    // the second host now commits on its own
    expect(
      two.repo.commit(
        'main',
        meta(2, 'second host adds'),
        datasetOf([word(1, 'alpha'), word(3, 'gamma')]),
      ).ok,
    ).toBe(true)

    const pushed = await two.repo.push(one.remote(), 'main')

    expect(pushed.ok).toBe(true)
    expect(one.repo.head('main')).toBe(two.repo.head('main'))
    expect(historyOf(one.repo, 'main')).toEqual(historyOf(two.repo, 'main'))

    // the first host can read what the second wrote
    const back = one.repo.checkoutBranch('main')

    expect(back.get(mark(3))!.fields.get('term')).toEqual(text('gamma'))
  })

  it('transfers only what the other side lacks', async () => {
    // the whole reason the transfer is content-addressed: a second pull of unchanged history
    // must move nothing, or sync costs the dataset rather than the difference
    const one = host()

    one.repo.commit('main', meta(1, 'first'), datasetOf([word(1, 'alpha')]))

    const two = host()
    const first = await two.repo.pull(one.remote(), 'main')

    expect(first.ok && first.transferred).toBeGreaterThan(0)

    const again = await two.repo.pull(one.remote(), 'main')

    expect(again.ok).toBe(true)
    expect(again.ok && again.transferred).toBe(0)
  })

  it('reconciles commits made on BOTH hosts, and both end identical', async () => {
    // the case the whole file exists for: divergence, then agreement
    const one = host()

    one.repo.commit(
      'main',
      meta(1, 'shared base'),
      datasetOf([word(1, 'alpha'), word(2, 'beta')]),
    )

    const two = host()
    await two.repo.pull(one.remote(), 'main')

    // each host edits a DIFFERENT record, so a correct merge keeps both
    one.repo.commit(
      'main',
      meta(2, 'host one edits alpha'),
      datasetOf([word(1, 'alpha-one'), word(2, 'beta')]),
    )
    two.repo.commit(
      'main',
      meta(3, 'host two edits beta'),
      datasetOf([word(1, 'alpha'), word(2, 'beta-two')]),
    )

    expect(one.repo.head('main')).not.toBe(two.repo.head('main'))

    // two pulls from one, merges, and pushes the result back
    await two.repo.pull(one.remote(), 'main')

    const settled = await two.repo.push(one.remote(), 'main')

    expect(settled.ok).toBe(true)

    // BOTH hosts agree, on the head and on every commit behind it
    expect(one.repo.head('main')).toBe(two.repo.head('main'))
    expect(historyOf(one.repo, 'main')).toEqual(historyOf(two.repo, 'main'))

    // and neither host's edit was lost, which a merge that picked a winner would have done
    const final = one.repo.checkoutBranch('main')

    expect(final.get(mark(1))!.fields.get('term')).toEqual(text('alpha-one'))
    expect(final.get(mark(2))!.fields.get('term')).toEqual(text('beta-two'))
  })

  it('refuses a push that would lose the other side', async () => {
    // a push onto a head that moved must not fast-forward over it. This is the same
    // compare-and-swap discipline the watermark uses, at the ref layer
    const one = host()

    one.repo.commit('main', meta(1, 'base'), datasetOf([word(1, 'alpha')]))

    const two = host()
    await two.repo.pull(one.remote(), 'main')

    // one moves ahead while two is not looking
    one.repo.commit('main', meta(2, 'one moves'), datasetOf([word(1, 'moved')]))
    const oneMoved = one.repo.head('main')!
    // and two commits on the older base
    two.repo.commit('main', meta(3, 'two moves'), datasetOf([word(1, 'other')]))
    const twoMoved = two.repo.head('main')!

    const pushed = await two.repo.push(one.remote(), 'main')

    // either it is rejected, or it merged rather than clobbered. What it must NOT do is
    // leave the first host without its own commit.
    if (pushed.ok) {
      // a merge is fine, a clobber is not: host one's own commit must still be in the
      // history it ends up with
      expect(historyOf(one.repo, 'main')).toContain(oneMoved)
      expect(historyOf(one.repo, 'main')).toContain(twoMoved)
    } else {
      expect(pushed.status).toBe('rejected')
      // the first host is untouched, so nothing was half-applied
      expect(one.repo.checkoutBranch('main').get(mark(1))!.fields.get('term')).toEqual(
        text('moved'),
      )
    }
  })

  it('rejects a chunk whose bytes do not match its claimed address', () => {
    // the guarantee that makes pulling from a stranger safe at all: the receiver RE-HASHES,
    // so a hostile or corrupted peer cannot inject bad data under a good hash. Asserted by
    // handing it a message whose hash and bytes disagree, rather than by inspecting a store
    // and inferring the check happened.
    const two = host()
    const honest = two.chunks.put('the real bytes')

    expect(() =>
      applyChunks([{ hash: honest, bytes: 'different bytes' }], two.chunks),
    ).toThrow(/integrity/)

    // and an honest message is accepted, so the guard is not simply refusing everything
    expect(
      applyChunks([{ hash: honest, bytes: 'the real bytes' }], two.chunks),
    ).toBe(1)
  })
})
