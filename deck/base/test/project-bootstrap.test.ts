// Snapshot, then follow.
//
// A new projection computing the feed from empty pulls the whole dataset as individual
// changes, which is correct and the wrong shape over a network: a customer bringing up a
// projection of a few million records would transfer every record as a change before serving
// one read. So a bootstrap takes the dataset at a commit and follows from there.
//
// THE OBLIGATION IS THAT THE TWO PATHS AGREE, and it is the whole reason this file exists.
// Bootstrapping is an optimisation, not a second set of semantics, so a projection built by
// snapshot-then-follow has to be indistinguishable from one built by replaying every commit.
// If it is not, then which path a customer took becomes a thing you have to know about their
// data, and that is exactly what "rebuildable" is supposed to rule out.
//
// The argument for why it holds is that a snapshot is the dataset at a commit and a rebuild
// depends only on that state rather than the path taken to reach it (invariant I5). This is
// the proof rather than the argument.

import { describe, it, expect } from 'vitest'
import { record, text, integer } from '@term/base/code/base/make'
import { datasetOf } from '@term/base/code/diff/change'
import { form, property, roleBase } from '@term/base/code/form/form'
import { MemoryChunkStore } from '@term/base/code/store/chunk-store'
import { MemoryRefStore } from '@term/base/code/store/ref-store'
import { Repository } from '@term/base/code/repo/repo'
import { commitChanges } from '@term/base/code/project/feed'
import { snapshotAt, snapshotOf } from '@term/base/code/project/bootstrap'
import { decodeResume } from '@term/base/code/project/resume'
import { Projector } from '@term/base/code/project/projector'
import { FORMAT_VERSION, READABLE_FORMATS } from '@term/base/code/canon/format'
import type { Mapping } from '@term/base/code/project/mapping'
import type { TableForm } from '@term/base/code/project/table'
import { MemoryEngine } from './project-engine'

const REPOSITORY = '0195f0e6-0000-7bd3-9f2e-00000000000a'
const M1 = '11111111-1111-4111-8111-111111111111'
const M2 = '22222222-2222-4222-8222-222222222222'
const M3 = '33333333-3333-4333-8333-333333333333'

const wordForm = form('word', [
  property('term', { base: 'text' }),
  property('gloss', { base: 'text' }),
  property('syllables', { base: 'integer' }),
])

const wordTable: TableForm = {
  table: 'word',
  mark: 'mark',
  columns: [
    { name: 'mark', type: 'uuid', need: true },
    { name: 'term', type: 'text' },
    { name: 'gloss', type: 'text' },
    { name: 'syllables', type: 'integer' },
  ],
  indexes: [],
}

const MAPPING: Mapping = {
  tables: [
    {
      form: 'word',
      table: 'word',
      markColumn: 'mark',
      columns: [
        { column: 'term', field: 'term' },
        { column: 'gloss', field: 'gloss' },
        { column: 'syllables', field: 'syllables' },
      ],
    },
  ],
}

const meta = (time: number, message: string) => ({
  author: 'lance',
  time,
  message,
})

const word = (mark: string, term: string, gloss: string, syllables: number) =>
  record({
    type: 'word',
    mark,
    fields: {
      term: text(term),
      gloss: text(gloss),
      syllables: integer(syllables),
    },
  })

/**
 * A repository with a history worth replaying: records added, one edited, one removed, and
 * one added after the removal.
 *
 * The edit and the removal are what make the two paths capable of disagreeing. A history of
 * pure additions would agree trivially, so it would prove nothing.
 */
function history(): { repo: Repository; commits: string[] } {
  const repo = new Repository(
    new MemoryChunkStore(),
    new MemoryRefStore(),
    roleBase([wordForm]),
  )

  const commits: string[] = []

  const one = repo.commit(
    'main',
    meta(1, 'two words'),
    datasetOf([word(M1, 'one', 'first', 1), word(M2, 'two', 'second', 2)]),
  )

  expect(one.ok).toBe(true)
  commits.push(repo.head('main')!)

  const two = repo.commit(
    'main',
    meta(2, 'edit one, add a third'),
    datasetOf([
      word(M1, 'uno', 'first, edited', 1),
      word(M2, 'two', 'second', 2),
      word(M3, 'three', 'third', 3),
    ]),
  )

  expect(two.ok).toBe(true)
  commits.push(repo.head('main')!)

  // a removal, so the two paths have something they could genuinely disagree about: a
  // replay must delete M2, and a snapshot must simply never carry it
  const three = repo.commit(
    'main',
    meta(3, 'remove the second'),
    datasetOf([word(M1, 'uno', 'first, edited', 1), word(M3, 'three', 'third', 3)]),
  )

  expect(three.ok).toBe(true)
  commits.push(repo.head('main')!)

  return { repo, commits }
}

async function projector(engine: MemoryEngine): Promise<Projector> {
  const one = new Projector(engine, REPOSITORY, MAPPING)
  await one.install([wordTable])

  return one
}

/** Replay every commit from empty, one at a time. The path a minimal applier takes. */
async function byReplay(repo: Repository, commits: string[]): Promise<MemoryEngine> {
  const engine = new MemoryEngine()
  const one = await projector(engine)

  let at: string | undefined

  for (const commit of commits) {
    await one.apply({
      commit,
      changes: commitChanges(repo, at, commit),
      covers: [commit],
    })

    at = commit
  }

  return engine
}

/** Snapshot at a commit, then follow to the head. The path a bootstrap takes. */
async function byBootstrap(
  repo: Repository,
  at: string,
  head: string,
): Promise<MemoryEngine> {
  const engine = new MemoryEngine()
  const one = await projector(engine)

  const snapshot = snapshotOf({ repo, repository: REPOSITORY, commit: at })

  await one.rebuild({ commit: snapshot.commit, dataset: snapshot.dataset })

  // the handoff: the token names where to continue from, and nothing else is consulted
  const resumed = decodeResume({
    token: snapshot.token,
    repository: REPOSITORY,
    readable: READABLE_FORMATS,
  })

  expect(resumed.ok).toBe(true)

  if (resumed.ok && resumed.resume.commit !== head) {
    await one.apply({
      commit: head,
      changes: commitChanges(repo, resumed.resume.commit, head),
      covers: repo.commitsBetween(resumed.resume.commit, head),
    })
  }

  return engine
}

describe('the snapshot handoff', () => {
  it('carries the commit and a token that resumes from it', () => {
    const { repo, commits } = history()
    const head = commits[commits.length - 1]!
    const snapshot = snapshotAt({ repo, repository: REPOSITORY, branch: 'main' })

    expect(snapshot?.commit).toBe(head)

    const resumed = decodeResume({
      token: snapshot!.token,
      repository: REPOSITORY,
      readable: READABLE_FORMATS,
    })

    expect(resumed.ok && resumed.resume.commit).toBe(head)
    expect(resumed.ok && resumed.resume.canonical).toBe(FORMAT_VERSION)
  })

  it('names its commit explicitly, so a retry fetches the SAME snapshot', () => {
    // a snapshot of "whatever the head is now" cannot be re-requested, so a retry after a
    // failed transfer would silently fetch a different one and the applier could not tell
    const { repo, commits } = history()
    const first = snapshotOf({ repo, repository: REPOSITORY, commit: commits[0]! })
    const again = snapshotOf({ repo, repository: REPOSITORY, commit: commits[0]! })

    expect(first.token).toBe(again.token)
    expect([...first.dataset.keys()].sort()).toEqual([...again.dataset.keys()].sort())
  })

  it('carries the mapping version when the applier has one, and omits it otherwise', () => {
    const { repo, commits } = history()
    const withOne = snapshotOf({
      repo,
      repository: REPOSITORY,
      commit: commits[0]!,
      mapping: 'sha256:abcd',
    })
    const without = snapshotOf({ repo, repository: REPOSITORY, commit: commits[0]! })

    const one = decodeResume({
      token: withOne.token,
      repository: REPOSITORY,
      readable: READABLE_FORMATS,
    })
    const other = decodeResume({
      token: without.token,
      repository: REPOSITORY,
      readable: READABLE_FORMATS,
    })

    expect(one.ok && one.resume.mapping).toBe('sha256:abcd')
    expect(other.ok && other.resume.mapping).toBeUndefined()
  })

  it('has nothing to snapshot on a branch with no commits, which is not an error', () => {
    const repo = new Repository(
      new MemoryChunkStore(),
      new MemoryRefStore(),
      roleBase([wordForm]),
    )

    expect(snapshotAt({ repo, repository: REPOSITORY, branch: 'main' })).toBeUndefined()
  })
})

describe('bootstrapping agrees with replaying', () => {
  it('produces identical rows when bootstrapping at the FIRST commit', async () => {
    // the longest follow: one commit of snapshot, two of incremental, including an edit and
    // a removal
    const { repo, commits } = history()
    const head = commits[commits.length - 1]!

    const replayed = await byReplay(repo, commits)
    const booted = await byBootstrap(repo, commits[0]!, head)

    expect(booted.dump('word')).toEqual(replayed.dump('word'))
  })

  it('produces identical rows when bootstrapping at a MIDDLE commit', async () => {
    const { repo, commits } = history()
    const head = commits[commits.length - 1]!

    const replayed = await byReplay(repo, commits)
    const booted = await byBootstrap(repo, commits[1]!, head)

    expect(booted.dump('word')).toEqual(replayed.dump('word'))
  })

  it('produces identical rows when bootstrapping AT the head, with no follow at all', async () => {
    const { repo, commits } = history()
    const head = commits[commits.length - 1]!

    const replayed = await byReplay(repo, commits)
    const booted = await byBootstrap(repo, head, head)

    expect(booted.dump('word')).toEqual(replayed.dump('word'))
  })

  it('does not carry a record that was removed before the snapshot', async () => {
    // the case a naive bootstrap gets wrong: M2 exists in commit one and is gone by the
    // head, so a snapshot at the head must simply never contain it, while a replay has to
    // add it and then delete it. Both must end with it absent.
    const { repo, commits } = history()
    const head = commits[commits.length - 1]!

    const booted = await byBootstrap(repo, head, head)
    const marks = booted.dump('word').map(row => row.mark)

    expect(marks).not.toContain(M2)
    expect(marks).toContain(M1)
    expect(marks).toContain(M3)
  })

  it('carries the EDITED value, not the original, when the edit predates the snapshot', async () => {
    const { repo, commits } = history()
    const head = commits[commits.length - 1]!
    const booted = await byBootstrap(repo, head, head)
    const row = booted.dump('word').find(one => one.mark === M1)

    expect(row?.term).toBe('uno')
    expect(row?.gloss).toBe('first, edited')
  })

  it('leaves the projection serving the head either way', async () => {
    const { repo, commits } = history()
    const head = commits[commits.length - 1]!

    const replayed = await byReplay(repo, commits)
    const booted = await byBootstrap(repo, commits[0]!, head)

    expect(await new Projector(booted, REPOSITORY, MAPPING).serving()).toBe(head)
    expect(await new Projector(replayed, REPOSITORY, MAPPING).serving()).toBe(head)
  })
})
