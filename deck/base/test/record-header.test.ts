import { describe, it, expect } from 'vitest'
import type { RecordNode } from '@term/base/code/base/type'
import { record, text, log, item } from '@term/base/code/base/make'
import { datasetOf, type Dataset } from '@term/base/code/diff/change'
import { diffDataset } from '@term/base/code/diff/diff'
import { applyChanges } from '@term/base/code/patch/patch'
import { encodeChanges, decodeChanges } from '@term/base/code/commit/changeset'
import { mergeDataset } from '@term/base/code/merge/merge'
import { MergeSession } from '@term/base/code/merge/session'
import { canonicalizeRecord } from '@term/base/code/canon/canonicalize'

const M1 = '11111111-1111-4111-8111-111111111111'
const M2 = '22222222-2222-4222-8222-222222222222'

function ds(records: RecordNode[]): Dataset {
  return datasetOf(records)
}

function withComments(
  node: RecordNode,
  comments: Record<string, string[]>,
): RecordNode {
  const map = new Map<string, string[]>()
  for (const key of Object.keys(comments)) {
    map.set(key, comments[key]!)
  }
  return { ...node, comments: map }
}

function canon(d: Dataset): string {
  return [...d.keys()]
    .sort()
    .map(m => `${m}=${canonicalizeRecord(d.get(m)!)}`)
    .join('|')
}

// The header (label, type, comments) is hashed content, so diff must represent a
// change to it and patch must reconstruct it: apply(diff(a,b), a) === b.
describe('record header diff/patch round-trip', () => {
  const cases: Array<[string, RecordNode, RecordNode]> = [
    [
      'relabel',
      record({ type: 'word', mark: M1, label: 'Bob', fields: { a: text('1') } }),
      record({ type: 'word', mark: M1, label: 'Robert', fields: { a: text('1') } }),
    ],
    [
      'add label',
      record({ type: 'word', mark: M1, fields: { a: text('1') } }),
      record({ type: 'word', mark: M1, label: 'X', fields: { a: text('1') } }),
    ],
    [
      'remove label',
      record({ type: 'word', mark: M1, label: 'X', fields: { a: text('1') } }),
      record({ type: 'word', mark: M1, fields: { a: text('1') } }),
    ],
    [
      'retype',
      record({ type: 'word', mark: M1, fields: { a: text('1') } }),
      record({ type: 'phrase', mark: M1, fields: { a: text('1') } }),
    ],
    [
      'recomment',
      withComments(record({ type: 'word', mark: M1, fields: { a: text('1') } }), {
        '': ['top note'],
      }),
      withComments(record({ type: 'word', mark: M1, fields: { a: text('1') } }), {
        '': ['edited note'],
        a: ['field note'],
      }),
    ],
    [
      'field change preserves comments',
      withComments(record({ type: 'word', mark: M1, fields: { a: text('1') } }), {
        a: ['keep me'],
      }),
      withComments(record({ type: 'word', mark: M1, fields: { a: text('2') } }), {
        a: ['keep me'],
      }),
    ],
  ]

  for (const [name, before, after] of cases) {
    it(`round-trips: ${name}`, () => {
      const a = ds([before])
      const b = ds([after])
      const changes = diffDataset(a, b)

      // a header-only edit must NOT diff to nothing (was un-committable)
      expect(changes.length).toBeGreaterThan(0)

      const patched = applyChanges(a, changes)
      expect(canon(patched)).toBe(canon(b))

      // and the change set must survive its own content-addressed serialization
      const roundTripped = decodeChanges(encodeChanges(changes))
      const patched2 = applyChanges(a, roundTripped)
      expect(canon(patched2)).toBe(canon(b))
    })
  }
})

describe('record header merge', () => {
  it('keeps a one-sided rename and does not conflict', () => {
    const base = ds([record({ type: 'word', mark: M1, label: 'Bob', fields: { a: text('1') } })])
    const a = ds([record({ type: 'word', mark: M1, label: 'Bob', fields: { a: text('1') } })])
    const b = ds([record({ type: 'word', mark: M1, label: 'Robert', fields: { a: text('1') } })])

    const m = mergeDataset(base, a, b)
    expect(m.conflicts).toHaveLength(0)
    expect(m.merged.get(M1)!.label).toBe('Robert')

    // symmetric: order of a/b does not change the outcome
    const swapped = mergeDataset(base, b, a)
    expect(canon(swapped.merged)).toBe(canon(m.merged))
  })

  it('conflicts on a concurrent divergent rename', () => {
    const base = ds([record({ type: 'word', mark: M1, label: 'Bob', fields: {} })])
    const a = ds([record({ type: 'word', mark: M1, label: 'Robert', fields: {} })])
    const b = ds([record({ type: 'word', mark: M1, label: 'Bobby', fields: {} })])

    const m = mergeDataset(base, a, b)
    expect(m.conflicts).toHaveLength(1)
    expect(m.conflicts[0]!.scope).toBe('label')

    // and it resolves through a MergeSession to the chosen side
    const session = new MergeSession(base, a, b)
    session.resolve(M1, '@label', { choose: 'theirs' })
    expect(session.resolved()).toBe(true)
    expect(session.result().get(M1)!.label).toBe('Bobby')
  })

  it('preserves comments (idempotency: merge(base,a,a) === a)', () => {
    const a = ds([
      withComments(record({ type: 'word', mark: M1, fields: { a: text('1') } }), {
        '': ['a note'],
      }),
    ])
    const m = mergeDataset(a, a, a)
    expect(canon(m.merged)).toBe(canon(a))
  })
})

describe('record delete-vs-edit conflict', () => {
  it('is resolvable to restore or delete, and the two are distinguishable', () => {
    const base = ds([record({ type: 'word', mark: M1, fields: { a: text('1') } })])
    const a = ds([record({ type: 'word', mark: M1, fields: { a: text('2') } })]) // edited
    const b = ds([]) // removed

    const m = mergeDataset(base, a, b)
    expect(m.conflicts).toHaveLength(1)
    expect(m.conflicts[0]!.scope).toBe('record')

    // resolve 'theirs' = the delete: the record must actually be gone
    const del = new MergeSession(base, a, b)
    del.resolve(M1, '', { choose: 'theirs' })
    expect(del.result().has(M1)).toBe(false)

    // resolve 'ours' = the edit: the edited record survives
    const keep = new MergeSession(base, a, b)
    keep.resolve(M1, '', { choose: 'ours' })
    const kept = keep.result().get(M1)
    expect(kept).toBeDefined()
    expect(kept!.fields.get('a')).toEqual(text('2'))
  })
})

describe('collection item edit-vs-delete', () => {
  it('conflicts instead of silently dropping the edit', () => {
    // a map field: base item key k -> v0, a edits to v1, b removes key k
    const mapOf = (entries: Array<[string, string]>): RecordNode =>
      record({
        type: 'word',
        mark: M1,
        fields: {
          roles: {
            kind: 'collection',
            order: 'map',
            items: entries.map(([k, v]) => item(text(v), undefined, k)),
          },
        },
      })

    const base = ds([mapOf([['k', 'v0']])])
    const a = ds([mapOf([['k', 'v1']])])
    const b = ds([mapOf([])])

    const m = mergeDataset(base, a, b)
    expect(m.conflicts.length).toBeGreaterThan(0)
    // the surviving edit is kept provisionally, not dropped
    const merged = m.merged.get(M1)!
    const roles = merged.fields.get('roles')!
    expect(roles.kind).toBe('collection')
  })
})

describe('log merge convergence', () => {
  it('merges commutatively (same hash regardless of side order)', () => {
    const logField = (values: string[]): RecordNode =>
      record({
        type: 'word',
        mark: M2,
        fields: {
          prov: log(values.map(v => item(text(v)))),
        },
      })

    const base = ds([logField(['s1'])])
    const a = ds([logField(['s1', 's2'])])
    const b = ds([logField(['s1', 's3'])])

    const ab = mergeDataset(base, a, b)
    const ba = mergeDataset(base, b, a)

    // both orders converge to identical bytes
    expect(canon(ab.merged)).toBe(canon(ba.merged))

    // and every entry survives (grow-only)
    const items = (ab.merged.get(M2)!.fields.get('prov') as {
      items: Array<unknown>
    }).items
    expect(items).toHaveLength(3)
  })
})

// The JSON canonical form (used for changesets / commit objects) must order a map
// collection's items independently of input order, or two semantically equal
// changesets hash differently.
describe('json canon map ordering', () => {
  it('a map collection hashes the same regardless of item input order', () => {
    const mapRec = (entries: Array<[string, string]>): RecordNode =>
      record({
        type: 'word',
        mark: M1,
        fields: {
          roles: {
            kind: 'collection',
            order: 'map',
            items: entries.map(([k, v]) => item(text(v), undefined, k)),
          },
        },
      })

    const forward = diffDataset(ds([]), ds([mapRec([['a', '1'], ['b', '2'], ['c', '3']])]))
    const shuffled = diffDataset(ds([]), ds([mapRec([['c', '3'], ['a', '1'], ['b', '2']])]))

    expect(encodeChanges(forward)).toBe(encodeChanges(shuffled))
  })
})
