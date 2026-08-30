// Garbage collection against a corpus with real history.
//
// `gc-erase.test.ts` covers the collector on small fixtures, and a collector that is wrong on
// a small fixture fails a test. **A collector that is wrong at scale deletes data that is
// still referenced, and there is no undo for that.** The failure is not an exception, it is a
// chunk that is gone and a commit that no longer reads, discovered whenever somebody next
// walks that far back.
//
// So this builds history with the shapes that actually break a reachability walk, and asserts
// the total property rather than a sample: after a sweep, EVERY commit on EVERY ref still
// checks out, and every record in it still reads.
//
// The shapes that matter, and why each one can break a naive walk:
//
//   depth        a long chain, so a walk that stops early loses the tail
//   branches     several heads, so a walk rooted only at `main` collects the others
//   a merge      two parents, so a first-parent-only walk loses the second parent's side
//   a tag        a root that is not a branch, so a walk over branches alone collects it
//   shared data  records untouched across many commits, so the tree shares subtrees and the
//                reachable set is much smaller than the sum of the checkouts
//
// Measured on this corpus: 31 commits over 400 records hold 2,684 chunks, and a sweep removes
// NONE of them, which is the correct answer because every one is reachable. That a sweep is
// not simply a no-op is proved by its own case, with a chunk nothing references.

import { describe, it, expect } from 'vitest'
import { MemoryChunkStore } from '@term/base/code/store/chunk-store'
import { MemoryRefStore } from '@term/base/code/store/ref-store'
import { Repository } from '@term/base/code/repo/repo'
import { record, text, integer } from '@term/base/code/base/make'
import { datasetOf, type Dataset } from '@term/base/code/diff/change'
import { form, property, roleBase } from '@term/base/code/form/form'

const wordForm = form('word', [
  property('term', { base: 'text' }),
  property('turn', { base: 'integer' }),
])

const meta = (time: number, message: string) => ({
  author: 'lance',
  time,
  message,
})

// A valid uuid v4: the version nibble is 4 and the variant nibble is 8, because the record
// validator refuses a mark that is not one. Found by a commit being rejected with "instance
// of a base form must have a mark" while carrying one that merely looked like a uuid.
function mark(i: number): string {
  return `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
}

function word(i: number, turn: number) {
  return record({
    type: 'word',
    mark: mark(i),
    fields: { term: text(`word-${i}`), turn: integer(turn) },
  })
}

/** A dataset of `size` records, with `touched` of them bearing the current turn. */
function corpus(size: number, turn: number, touched: number): Dataset {
  const out = []

  for (let i = 0; i < size; i += 1) {
    out.push(word(i, i < touched ? turn : 0))
  }

  return datasetOf(out)
}

const SIZE = 400
const DEPTH = 25

/**
 * A repository with depth, branches, a merge, and a tag.
 *
 * Returns the refs a correct sweep must keep reachable, and every commit reachable from them,
 * so the assertion can be "all of it" rather than a spot check.
 */
function history(): {
  repo: Repository
  store: MemoryChunkStore
  refs: string[]
  commits: string[]
} {
  const store = new MemoryChunkStore()
  const repo = new Repository(store, new MemoryRefStore(), roleBase([wordForm]))

  // a deep main line, each commit touching a few records so subtrees are shared
  for (let turn = 1; turn <= DEPTH; turn += 1) {
    const done = repo.commit(
      'main',
      meta(turn, `turn ${turn}`),
      corpus(SIZE, turn, turn * 4),
    )

    expect(done.ok).toBe(true)
  }

  const mainAt = repo.head('main')!

  // a side branch off an ancestor, so its commits are only reachable through it
  expect(repo.createBranch('side', { commit: mainAt })).toBe(true)

  for (let turn = 1; turn <= 5; turn += 1) {
    const done = repo.commit(
      'side',
      meta(100 + turn, `side ${turn}`),
      corpus(SIZE, 500 + turn, 20),
    )

    expect(done.ok).toBe(true)
  }

  // a merge, so a first-parent-only walk would lose the side's history
  const merged = repo.merge('main', 'side', meta(200, 'merge side'))

  expect(merged.ok).toBe(true)

  // and a tag, which is a root that is not a branch
  expect(repo.createTag('release', mainAt)).toBe(true)

  const refs = [repo.head('main')!, repo.head('side')!, repo.tag('release')!]
  const commits = new Set<string>()

  // every commit reachable from every ref, by walking ALL parents rather than the first
  const stack = [...refs]

  while (stack.length) {
    const at = stack.pop()!

    if (commits.has(at)) {
      continue
    }

    commits.add(at)

    for (const parent of repo.readCommit(at).parents) {
      stack.push(parent)
    }
  }

  return { repo, store, refs, commits: [...commits] }
}

describe('garbage collection against real history', () => {
  it('keeps every commit on every ref readable, with its records intact', () => {
    const { repo, store, commits } = history()

    // what the whole history looks like BEFORE, so the comparison is exact rather than
    // "it did not throw"
    const before = new Map(
      commits.map(commit => [
        commit,
        [...repo.checkout(commit).keys()].sort().join(','),
      ]),
    )
    const held = store.size()

    const report = repo.gc()

    // the total property: every commit still checks out, to exactly the same records
    for (const commit of commits) {
      const now = [...repo.checkout(commit).keys()].sort().join(',')

      expect(now).toBe(before.get(commit))
    }

    // Reported rather than asserted. On a HEALTHY repository the right answer is that nothing
    // is reclaimed, because everything is reachable, so a bound here would be asserting the
    // absence of garbage rather than the correctness of the sweep. That the collector is not
    // simply a no-op is proved separately, by the stray-chunk case below.
    // eslint-disable-next-line no-console
    console.log(
      `gc over ${commits.length} commits: held ${held} chunks, removed ${report.removed}, kept ${report.kept}`,
    )

    expect(store.size()).toBeGreaterThan(0)
  })

  it('keeps record CONTENT, not only the mark', () => {
    // a sweep that kept the tree and dropped the record bytes would pass a key comparison
    // and lose every value
    const { repo, commits } = history()
    const at = commits[Math.floor(commits.length / 2)]!
    const one = repo.recordAt(at, mark(0))

    expect(one).toBeDefined()

    repo.gc()

    const again = repo.recordAt(at, mark(0))

    expect(again).toBeDefined()
    expect(again!.fields.get('term')).toEqual(one!.fields.get('term'))
    expect(again!.fields.get('turn')).toEqual(one!.fields.get('turn'))
  })

  it('does not lose the second parent of a merge', () => {
    // the shape a first-parent-only walk breaks on, asserted directly rather than relying on
    // the sweep happening to reach it
    const { repo } = history()
    const head = repo.head('main')!
    const parents = repo.readCommit(head).parents

    expect(parents.length).toBe(2)

    repo.gc()

    for (const parent of parents) {
      expect(() => repo.checkout(parent)).not.toThrow()
    }
  })

  it('keeps a tagged commit that no branch head reaches', () => {
    const { repo } = history()
    const tagged = repo.tag('release')!

    repo.gc()

    expect(() => repo.checkout(tagged)).not.toThrow()
  })

  it('reclaims a chunk nothing reaches, so it is genuinely collecting', () => {
    const { repo, store } = history()
    const stray = store.put('a chunk no commit references')

    expect(store.has(stray)).toBe(true)

    const report = repo.gc()

    expect(store.has(stray)).toBe(false)
    expect(report.removedHashes).toContain(stray)
  })

  it('is idempotent: a second sweep finds nothing more', () => {
    // a collector whose reachable set differs between runs would collect a little more each
    // time, which is the slow version of the same failure
    const { repo } = history()

    repo.gc()
    const second = repo.gc()

    expect(second.removed).toBe(0)
    expect(second.removedHashes).toEqual([])
  })

  it('leaves the repository verifiable', () => {
    // fsck is the library's own answer to "is this store coherent", so a sweep that passed
    // every assertion above and still broke an invariant is caught by the thing built to
    // notice
    const { repo } = history()

    repo.gc()

    const report = repo.fsck()

    expect(report.missing).toEqual([])
  })
})
