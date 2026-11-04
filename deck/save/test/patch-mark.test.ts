// A dataset entry carries its key as its mark, whatever the change's node said.
//
// The first live commit into a repository with registered forms was refused with
// `instance of a base form must have a mark`: the caller built the `record.add` node from
// a database row without a `mark` on the node, the patch stored it as given, and the role
// then read a top-level record with no identity. The invariant belongs to the patch.

import { describe, it, expect } from 'vitest'
import { applyChanges } from '@cluesurf/save/patch/patch'
import { emptyDataset } from '@cluesurf/save/diff/change'
import { text } from '@cluesurf/save/base/make'
import { mintMark } from '@cluesurf/save/base/mark'

describe('record.add', () => {
  it('stamps the mark on a node that came without one', () => {
    const mark = mintMark()
    const out = applyChanges(emptyDataset(), [
      {
        type: 'record.add',
        mark,
        value: { type: 'page', fields: new Map([['title', text('Phonology')]]) },
      },
    ])

    expect(out.get(mark)?.mark).toBe(mark)
    expect(out.get(mark)?.fields.get('title')).toEqual(text('Phonology'))
  })

  it('keeps a node that carries its mark as it is', () => {
    const mark = mintMark()
    const node = { type: 'page', mark, fields: new Map([['title', text('Phonology')]]) }
    const out = applyChanges(emptyDataset(), [{ type: 'record.add', mark, value: node }])

    expect(out.get(mark)).toBe(node)
  })

  it('does not let a node claim a different mark than the change names', () => {
    const mark = mintMark()
    const other = mintMark()
    const out = applyChanges(emptyDataset(), [
      { type: 'record.add', mark, value: { type: 'page', mark: other, fields: new Map() } },
    ])

    expect(out.get(mark)?.mark).toBe(mark)
    expect(out.has(other)).toBe(false)
  })
})
