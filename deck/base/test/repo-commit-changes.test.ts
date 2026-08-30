// Committing CHANGES rather than a dataset.
//
// `commit` takes a dataset, so it checks the branch out, diffs the whole thing to discover
// what changed, and validates every record. Each is O(the repository), and a loader doing it
// once per batch pays that N/B times. Measured 2026-08-30: total backfill work grows as
// size^1.74, and at 160,000 records one load costs 124 seconds.
//
// The tree write was never the problem: `commit` already updates the tree incrementally.
// What is quadratic is everything around it, and all of it exists only to recover the change
// set the caller already had.
//
// Two properties matter more than the speed.
//
//   the RESULT must be identical to what `commit` would have produced, or this is a second
//   way to write history that disagrees with the first, and the disagreement is silent
//
//   it must REFUSE what it cannot check. A `sole` constraint is a fact about the whole
//   dataset, and checking it needs every record, which is the cost being avoided. Validating
//   only the changed records and calling it done would let a new record duplicate an
//   existing unique value, silently, on the exact path built for loading data in bulk.

import { describe, it, expect } from 'vitest'
import { Repository } from '@term/base/code/repo/repo'
import { MemoryChunkStore } from '@term/base/code/store/chunk-store'
import { MemoryRefStore } from '@term/base/code/store/ref-store'
import { diffDataset } from '@term/base/code/diff/diff'
import type { Dataset, Change } from '@term/base/code/diff/change'
import type { RecordNode } from '@term/base/code/base/type'
import type { RoleBase } from '@term/base/code/form/form'

const BRANCH = 'main'
const META = { author: 'test', time: 1_700_000_000_000, message: 'load' }

function markOf(n: number): string {
  const hex = n.toString(16).padStart(12, '0')

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(0, 3)}-8${hex.slice(3, 6)}-${hex.slice(0, 12)}`
}

function recordOf(n: number, text = `word-${n}`): RecordNode {
  return {
    mark: markOf(n),
    type: 'word',
    fields: new Map([['text', { kind: 'text', value: text }]]),
  }
}

function datasetOf(from: number, to: number): Dataset {
  const dataset: Dataset = new Map()

  for (let n = from; n < to; n++) {
    dataset.set(markOf(n), recordOf(n))
  }

  return dataset
}

function repoOf(role?: RoleBase): Repository {
  return new Repository(new MemoryChunkStore(), new MemoryRefStore(), role)
}

function commitOf(result: ReturnType<Repository['commit']>): string {
  if (!result.ok) {
    throw new Error(`commit refused: ${JSON.stringify(result.diagnostics ?? [])}`)
  }

  return result.commit
}

describe('committing changes instead of a dataset', () => {
  it('produces the same commit hash as committing the equivalent dataset', () => {
    // The property everything else rests on. Two ways to write the same history must agree
    // byte for byte, or one of them is quietly writing something else. Same content, same
    // parent, same meta, so the hashes must be equal.
    const first = datasetOf(0, 10)
    const second = datasetOf(0, 20)

    const viaDataset = repoOf()
    const base = commitOf(viaDataset.commit(BRANCH, META, first))
    const whole = commitOf(viaDataset.commit(BRANCH, META, second))

    const viaChanges = repoOf()
    const sameBase = commitOf(viaChanges.commit(BRANCH, META, first))
    const incremental = viaChanges.commitChanges(
      BRANCH,
      META,
      diffDataset(first, second),
    )

    expect(sameBase).toBe(base)
    expect(incremental.ok).toBe(true)
    expect(incremental.ok && incremental.commit).toBe(whole)
  })

  it('leaves records it did not name untouched', () => {
    // A change set names a few marks. Everything else has to survive, or a batched load
    // erases the batches before it by omission.
    const repo = repoOf()

    commitOf(repo.commit(BRANCH, META, datasetOf(0, 50)))

    const result = repo.commitChanges(BRANCH, META, [
      { type: 'record.add', mark: markOf(99), value: recordOf(99) },
    ])

    expect(result.ok).toBe(true)

    const after = repo.checkout(result.ok ? result.commit : '')

    expect(after.size).toBe(51)
    expect(after.get(markOf(0))?.fields.get('text')).toEqual({
      kind: 'text',
      value: 'word-0',
    })
  })

  it('applies a field change to a record it has to read from the parent', () => {
    // A field-level change carries no record, so the current one is read from the parent
    // tree. Reading the wrong one, or none, would drop every field the change did not name.
    const repo = repoOf()

    commitOf(
      repo.commit(
        BRANCH,
        META,
        new Map([
          [
            markOf(1),
            {
              mark: markOf(1),
              type: 'word',
              fields: new Map([
                ['text', { kind: 'text', value: 'before' }],
                ['gloss', { kind: 'text', value: 'kept' }],
              ]),
            } as RecordNode,
          ],
        ]),
      ),
    )

    const result = repo.commitChanges(BRANCH, META, [
      {
        type: 'field.set',
        mark: markOf(1),
        field: 'text',
        before: { kind: 'text', value: 'before' },
        after: { kind: 'text', value: 'after' },
      },
    ])

    const record = repo
      .checkout(result.ok ? result.commit : '')
      .get(markOf(1))

    expect(record?.fields.get('text')).toEqual({ kind: 'text', value: 'after' })
    // the field the change never mentioned
    expect(record?.fields.get('gloss')).toEqual({ kind: 'text', value: 'kept' })
  })

  it('removes a record', () => {
    const repo = repoOf()

    commitOf(repo.commit(BRANCH, META, datasetOf(0, 3)))

    const result = repo.commitChanges(BRANCH, META, [
      { type: 'record.remove', mark: markOf(1), before: recordOf(1) },
    ])

    const after = repo.checkout(result.ok ? result.commit : '')

    expect(after.has(markOf(1))).toBe(false)
    expect(after.size).toBe(2)
  })

  it('commits onto an empty branch, where there is no parent tree to update', () => {
    const repo = repoOf()

    const result = repo.commitChanges(BRANCH, META, [
      { type: 'record.add', mark: markOf(0), value: recordOf(0) },
    ])

    expect(result.ok).toBe(true)
    expect(repo.checkout(result.ok ? result.commit : '').size).toBe(1)
  })

  it('is a no-op rather than an empty commit when there is nothing to change', () => {
    const repo = repoOf()
    const head = commitOf(repo.commit(BRANCH, META, datasetOf(0, 3)))
    const result = repo.commitChanges(BRANCH, META, [])

    expect(result.ok && result.commit).toBe(head)
  })

  it('carries its change set into the commit, so a projection can read it', () => {
    // The projector applies a commit's changeset rather than diffing. A commit written this
    // way that carried no changeset would project as nothing and the projection would drift
    // from a checkout without any error.
    const repo = repoOf()

    commitOf(repo.commit(BRANCH, META, datasetOf(0, 3)))

    const changes: Array<Change> = [
      { type: 'record.add', mark: markOf(9), value: recordOf(9) },
    ]
    const result = repo.commitChanges(BRANCH, META, changes)
    const stored = repo.commitChangeset(result.ok ? result.commit : '')

    expect(stored).toHaveLength(1)
    expect(stored?.[0]?.mark).toBe(markOf(9))
  })
})

describe('what it refuses', () => {
  const ROLE = {
    forms: new Map([
      [
        'word',
        {
          name: 'word',
          properties: [
            {
              name: 'text',
              constraints: [{ kind: 'sole' }],
            },
          ],
        },
      ],
    ]),
  } as unknown as RoleBase

  it('refuses a form whose role declares a sole constraint', () => {
    // The refusal is the feature. A `sole` constraint is a fact about the whole dataset, and
    // checking it needs every record, which is the cost this exists to avoid. Validating
    // only the changed records and calling it done would let a duplicate through silently,
    // on the exact path built for loading data in bulk.
    const repo = repoOf(ROLE)

    const result = repo.commitChanges(BRANCH, META, [
      { type: 'record.add', mark: markOf(0), value: recordOf(0) },
    ])

    expect(result.ok).toBe(false)
    expect(
      !result.ok && result.diagnostics?.[0]?.message,
    ).toContain('sole')
  })

  it('names the form and points at the path that can check it', () => {
    const repo = repoOf(ROLE)
    const result = repo.commitChanges(BRANCH, META, [
      { type: 'record.add', mark: markOf(0), value: recordOf(0) },
    ])

    const said = (!result.ok && result.diagnostics?.[0]?.message) || ''

    expect(said).toContain('word')
    expect(said).toContain('commit')
  })
})
