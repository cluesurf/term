// A collection diff pairs by mark when every member has one and by position otherwise,
// so a one-node edit inside a page body is one change and a reordering of identified
// rows is a move rather than a wall of changes.

import { describe, it, expect } from 'vitest'
import { diffValues } from '@cluesurf/save/diff/value-diff'
import { text, integer, list, nested, record } from '@cluesurf/save/base/make'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'

function marked(mark: string, name: string) {
  return { mark, value: nested(record({ type: 'row', mark, fields: { name: text(name) } })) }
}

describe('a collection diff', () => {
  it('pairs unmarked members by position', () => {
    const before = list([{ value: text('a') }, { value: text('b') }, { value: integer(1) }])
    const after = list([{ value: text('a') }, { value: text('B') }, { value: integer(1) }, { value: text('d') }])
    const d = diffValues(before, after)
    expect(d.kind).toBe('collection')
    if (d.kind === 'collection') {
      expect(d.changed.map(c => c.at)).toEqual([1])
      expect(d.changed[0]!.diff.kind).toBe('text')
      expect(d.added.map(c => c.at)).toEqual([3])
      expect(d.removed).toEqual([])
      expect(d.moved).toEqual([])
    }
  })

  it('reports members that fell off the end as removed', () => {
    const d = diffValues(list([{ value: text('a') }, { value: text('b') }]), list([{ value: text('a') }]))
    if (d.kind === 'collection') {
      expect(d.removed.map(c => c.at)).toEqual([1])
      expect(d.changed).toEqual([])
    }
  })

  it('pairs marked members by identity, so a reorder is a move and an edit follows its row', () => {
    const before = list([marked(A, 'first'), marked(B, 'second'), marked(C, 'third')])
    const after = list([marked(C, 'third'), marked(A, 'first'), marked(B, 'SECOND')])
    const d = diffValues(before, after)
    if (d.kind === 'collection') {
      expect(d.added).toEqual([])
      expect(d.removed).toEqual([])
      expect(d.moved).toEqual([
        { mark: C, from: 2, to: 0 },
        { mark: A, from: 0, to: 1 },
        { mark: B, from: 1, to: 2 },
      ])
      expect(d.changed.map(c => c.mark)).toEqual([B])
    }
  })

  it('reports an identified member that appeared or vanished', () => {
    const d = diffValues(list([marked(A, 'a'), marked(B, 'b')]), list([marked(A, 'a'), marked(C, 'c')]))
    if (d.kind === 'collection') {
      expect(d.added.map(c => c.mark)).toEqual([C])
      expect(d.removed.map(c => c.mark)).toEqual([B])
    }
  })

  it('answers equal for two equal collections', () => {
    expect(diffValues(list([{ value: text('a') }]), list([{ value: text('a') }]))).toEqual({ kind: 'equal' })
  })
})
