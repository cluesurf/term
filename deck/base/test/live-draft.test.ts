import { describe, it, expect } from 'vitest'
import {
  coalesce,
  materialize,
  pendingOps,
  settleReason,
  implicitBranchName,
  isImplicitBranch,
  OPERATION_CAP,
  IDLE_DEBOUNCE,
} from '@term/base/code/live/draft'
import type { Segment } from '@term/base/code/live/draft'
import { applyOps, type Op } from '@term/base/code/sync/op-sync'
import { datasetOf, emptyDataset, type Dataset } from '@term/base/code/diff/change'
import type { RecordNode, Value } from '@term/base/code/base/type'
import { text } from '@term/base/code/base/make'

const A = '0195f0e6-1c4a-7bd3-9f2e-000000000001'
const B = '0195f0e6-1c4a-7bd3-9f2e-000000000002'

let tick = 0

// Operations from one actor, in issue order. A fresh wall time per call keeps the HLC
// order equal to the call order, which is what an editing session produces.
function op(node: string, change: Op['change']): Op {
  tick += 1
  return { hlc: { wall: 1_000 + tick, count: 0, node }, change }
}

function set(node: string, mark: string, field: string, before: Value | undefined, after: string): Op {
  return op(node, { type: 'field.set', mark, field, before, after: text(after) })
}

function word(mark: string, fields: Record<string, string>): RecordNode {
  return {
    mark,
    type: 'word',
    fields: new Map(Object.entries(fields).map(([k, v]) => [k, text(v)])),
  }
}

// The one property that matters: a coalesced stream must be indistinguishable from the
// stream it replaces, against any starting dataset.
function equivalent(base: Dataset, ops: Array<Op>): void {
  const long = applyOps(base, ops)
  const short = applyOps(base, coalesce(ops))

  expect(short).toEqual(long)
}

describe('coalesce is exact', () => {
  it('collapses typing into one operation with the same net effect', () => {
    const base = datasetOf([word(A, { text: '' })])
    const ops = [
      set('lance', A, 'text', text(''), 'h'),
      set('lance', A, 'text', text('h'), 'he'),
      set('lance', A, 'text', text('he'), 'hel'),
      set('lance', A, 'text', text('hel'), 'hell'),
      set('lance', A, 'text', text('hell'), 'hello'),
    ]

    expect(coalesce(ops)).toHaveLength(1)
    equivalent(base, ops)
  })

  it('keeps the first before and the last after', () => {
    const ops = [
      set('lance', A, 'text', text('start'), 'a'),
      set('lance', A, 'text', text('a'), 'b'),
    ]
    const merged = coalesce(ops)[0]!.change

    expect(merged).toMatchObject({ type: 'field.set' })
    expect((merged as { before: Value }).before).toEqual(text('start'))
    expect((merged as { after: Value }).after).toEqual(text('b'))
  })

  it('cancels a record created and removed in the same window', () => {
    const value = word(A, { text: 'x' })
    const ops = [
      op('lance', { type: 'record.add', mark: A, value }),
      op('lance', { type: 'record.remove', mark: A, before: value }),
    ]

    expect(coalesce(ops)).toHaveLength(0)
    equivalent(emptyDataset(), ops)
  })

  it('folds edits to a new record into the record itself', () => {
    const ops = [
      op('lance', { type: 'record.add', mark: A, value: word(A, { text: '' }) }),
      set('lance', A, 'text', text(''), 'hi'),
      set('lance', A, 'gloss', undefined, 'greeting'),
    ]
    const out = coalesce(ops)

    expect(out).toHaveLength(1)
    expect(out[0]!.change.type).toBe('record.add')
    equivalent(emptyDataset(), ops)
  })

  it('rewinds before when a removal supersedes edits', () => {
    const start = word(A, { text: 'original' })
    const edited = word(A, { text: 'edited' })
    const ops = [
      set('lance', A, 'text', text('original'), 'edited'),
      op('lance', { type: 'record.remove', mark: A, before: edited }),
    ]
    const out = coalesce(ops)

    expect(out).toHaveLength(1)
    // the removal must describe the record as it stood at the START of the window
    expect((out[0]!.change as { before: RecordNode }).before.fields.get('text')).toEqual(
      text('original'),
    )
    equivalent(datasetOf([start]), ops)
  })

  it('turns a set then a remove into one remove carrying the original before', () => {
    const ops = [
      set('lance', A, 'text', text('original'), 'edited'),
      op('lance', { type: 'field.remove', mark: A, field: 'text', before: text('edited') }),
    ]
    const out = coalesce(ops)

    expect(out).toHaveLength(1)
    expect(out[0]!.change.type).toBe('field.remove')
    expect((out[0]!.change as { before: Value }).before).toEqual(text('original'))
    equivalent(datasetOf([word(A, { text: 'original' })]), ops)
  })

  it('does not merge across actors, so attribution survives', () => {
    const ops = [
      set('lance', A, 'text', text(''), 'a'),
      set('other', A, 'text', text('a'), 'b'),
      set('lance', A, 'text', text('b'), 'c'),
    ]
    const out = coalesce(ops)

    expect(out.length).toBeGreaterThan(1)
    expect(new Set(out.map(o => o.hlc.node))).toEqual(new Set(['lance', 'other']))
    equivalent(datasetOf([word(A, { text: '' })]), ops)
  })

  it('keeps different fields and different records apart', () => {
    const ops = [
      set('lance', A, 'text', text(''), 'a'),
      set('lance', A, 'gloss', undefined, 'g'),
      set('lance', B, 'text', text(''), 'b'),
    ]

    expect(coalesce(ops)).toHaveLength(3)
    equivalent(datasetOf([word(A, { text: '' }), word(B, { text: '' })]), ops)
  })

  it('stays exact over an interleaved multi-record, multi-actor session', () => {
    const ops = [
      op('lance', { type: 'record.add', mark: B, value: word(B, { text: '' }) }),
      set('lance', A, 'text', text('one'), 'two'),
      set('other', B, 'text', text(''), 'x'),
      set('lance', A, 'text', text('two'), 'three'),
      set('lance', A, 'gloss', undefined, 'g'),
      set('other', B, 'text', text('x'), 'xy'),
      set('lance', A, 'text', text('three'), 'four'),
    ]

    equivalent(datasetOf([word(A, { text: 'one' })]), ops)
    expect(coalesce(ops).length).toBeLessThan(ops.length)
  })

  it('is idempotent', () => {
    const ops = [
      set('lance', A, 'text', text(''), 'a'),
      set('lance', A, 'text', text('a'), 'b'),
      set('lance', A, 'text', text('b'), 'c'),
    ]

    expect(coalesce(coalesce(ops))).toEqual(coalesce(ops))
  })
})

describe('materialize', () => {
  const committed = datasetOf([word(A, { text: 'committed' })])

  const segments: Array<Segment> = [
    { previous: undefined, ops: [set('lance', A, 'text', text('committed'), 'edit one')] },
    { previous: 'seg1', ops: [set('lance', A, 'text', text('edit one'), 'edit two')] },
  ]

  it('shows committed state with pending work folded on', () => {
    const out = materialize({ committed, segments })

    expect(out.get(A)!.fields.get('text')).toEqual(text('edit two'))
  })

  it('leaves the committed dataset untouched', () => {
    materialize({ committed, segments })

    expect(committed.get(A)!.fields.get('text')).toEqual(text('committed'))
  })

  it('returns the committed state when nothing is pending', () => {
    expect(materialize({ committed, segments: [] })).toEqual(committed)
  })

  it('collects pending operations across the chain in order', () => {
    expect(pendingOps(segments)).toHaveLength(2)
  })
})

describe('settleReason', () => {
  const quiet = { operations: 5, bytes: 100, ageMs: 1_000, idleMs: 0 }

  it('settles realtime editing after an idle pause', () => {
    expect(settleReason({ mode: 'realtime', ...quiet, idleMs: IDLE_DEBOUNCE })).toBe('idle')
    expect(settleReason({ mode: 'realtime', ...quiet, idleMs: 500 })).toBeUndefined()
  })

  it('settles realtime editing at a semantic boundary without waiting', () => {
    expect(
      settleReason({ mode: 'realtime', ...quiet, semanticBoundary: true }),
    ).toBe('semantic')
  })

  it('never settles git or wiki mode implicitly', () => {
    expect(settleReason({ mode: 'git', ...quiet, idleMs: 60_000 })).toBeUndefined()
    expect(settleReason({ mode: 'wiki', ...quiet, idleMs: 60_000 })).toBeUndefined()
  })

  it('settles any mode on an explicit save', () => {
    expect(settleReason({ mode: 'git', ...quiet, saved: true })).toBe('save')
    expect(settleReason({ mode: 'wiki', ...quiet, saved: true })).toBe('save')
  })

  it('never settles a batch per record', () => {
    expect(settleReason({ mode: 'batch', operations: 5_000, bytes: 1_000, ageMs: 10, idleMs: 10_000 })).toBeUndefined()
    expect(
      settleReason({ mode: 'batch', ...quiet, semanticBoundary: true }),
    ).toBe('semantic')
  })

  it('forces a settle at the caps, whatever the mode', () => {
    expect(
      settleReason({ mode: 'git', operations: OPERATION_CAP, bytes: 0, ageMs: 0, idleMs: 0 }),
    ).toBe('operation-cap')
    expect(
      settleReason({ mode: 'git', operations: 1, bytes: 6 * 1024 * 1024, ageMs: 0, idleMs: 0 }),
    ).toBe('byte-cap')
    expect(
      settleReason({ mode: 'git', operations: 1, bytes: 0, ageMs: 2 * 60 * 60 * 1000, idleMs: 0 }),
    ).toBe('age-cap')
  })

  it('does not settle an empty draft', () => {
    expect(
      settleReason({ mode: 'realtime', operations: 0, bytes: 0, ageMs: 0, idleMs: 60_000 }),
    ).toBeUndefined()
  })
})

describe('implicit branches', () => {
  it('namespaces by author so it cannot collide with a named branch', () => {
    expect(implicitBranchName({ user: 'lance', ordinal: 1 })).toBe('~lance/draft-1')
  })

  it('recognises an implicit branch', () => {
    expect(isImplicitBranch('~lance/draft-1')).toBe(true)
    expect(isImplicitBranch('main')).toBe(false)
  })
})
