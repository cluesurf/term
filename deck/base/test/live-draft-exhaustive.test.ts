// Exhaustive evidence for the one claim the draft design rests on: a coalesced operation
// stream is indistinguishable from the stream it replaces.
//
// Every sequence up to a bounded length over a small alphabet of edits is enumerated and
// checked, rather than sampled. Deterministic, so a failure is always reproducible.

import { describe, it, expect } from 'vitest'
import { coalesce } from '@term/base/code/live/draft'
import { applyOps, type Op } from '@term/base/code/sync/op-sync'
import { datasetOf, type Dataset } from '@term/base/code/diff/change'
import type { RecordNode } from '@term/base/code/base/type'
import { text } from '@term/base/code/base/make'

const MARK = '0195f0e6-1c4a-7bd3-9f2e-000000000001'
const ACTORS = ['lance', 'other']
const FIELDS = ['text', 'gloss']

// The edit alphabet: every kind of change a session can produce against one record.
type Action =
  | { kind: 'set'; field: string; actor: string; value: string }
  | { kind: 'unset'; field: string; actor: string }
  | { kind: 'add'; actor: string }
  | { kind: 'drop'; actor: string }

const ALPHABET: Array<Action> = [
  ...ACTORS.flatMap(actor =>
    FIELDS.flatMap(field => [
      { kind: 'set', field, actor, value: `${actor}-1` } as Action,
      { kind: 'set', field, actor, value: `${actor}-2` } as Action,
      { kind: 'unset', field, actor } as Action,
    ]),
  ),
  ...ACTORS.map(actor => ({ kind: 'add', actor }) as Action),
  ...ACTORS.map(actor => ({ kind: 'drop', actor }) as Action),
]

/**
 * Turn a sequence of actions into operations, simulating state as it goes so every
 * `before` is truthful. An action that does not apply to the current state is skipped,
 * which is what keeps the generated streams well-formed.
 */
function opsFor(
  actions: Array<Action>,
  start: RecordNode | undefined,
): Array<Op> {
  let record = start ? cloneOf(start) : undefined
  const ops: Array<Op> = []
  let tick = 0

  for (const action of actions) {
    tick += 1
    const hlc = { wall: 1_000 + tick, count: 0, node: action.actor }

    switch (action.kind) {
      case 'set': {
        if (!record) {
          break
        }
        const before = record.fields.get(action.field)
        const after = text(action.value)
        record.fields.set(action.field, after)
        ops.push({
          hlc,
          change: { type: 'field.set', mark: MARK, field: action.field, before, after },
        })
        break
      }
      case 'unset': {
        if (!record) {
          break
        }
        const before = record.fields.get(action.field)
        if (before === undefined) {
          break
        }
        record.fields.delete(action.field)
        ops.push({
          hlc,
          change: { type: 'field.remove', mark: MARK, field: action.field, before },
        })
        break
      }
      case 'add': {
        if (record) {
          break
        }
        const value: RecordNode = {
          mark: MARK,
          type: 'word',
          fields: new Map([['text', text('new')]]),
        }
        record = cloneOf(value)
        ops.push({ hlc, change: { type: 'record.add', mark: MARK, value } })
        break
      }
      case 'drop': {
        if (!record) {
          break
        }
        const before = cloneOf(record)
        record = undefined
        ops.push({ hlc, change: { type: 'record.remove', mark: MARK, before } })
        break
      }
    }
  }

  return ops
}

function cloneOf(record: RecordNode): RecordNode {
  return { ...record, fields: new Map(record.fields) }
}

function existing(): Dataset {
  return datasetOf([
    {
      mark: MARK,
      type: 'word',
      fields: new Map([
        ['text', text('original')],
        ['gloss', text('start')],
      ]),
    },
  ])
}

/** Every sequence of a given length over the alphabet, in index order. */
function* sequences(length: number): Generator<Array<Action>> {
  const total = ALPHABET.length ** length

  for (let n = 0; n < total; n += 1) {
    const out: Array<Action> = []
    let rest = n

    for (let i = 0; i < length; i += 1) {
      out.push(ALPHABET[rest % ALPHABET.length]!)
      rest = Math.floor(rest / ALPHABET.length)
    }

    yield out
  }
}

/**
 * The inverse of a change, built from its `before`.
 *
 * Forward application ignores `before` entirely, so an equivalence check on the resulting
 * dataset cannot tell whether `before` is truthful. Undoing the coalesced stream can: it
 * must land back exactly where it started. This is what makes coalescing safe for the
 * things `before` exists for, which are undo, blame, and three-way merge.
 */
function invert(change: Op['change']): Op['change'] {
  switch (change.type) {
    case 'record.add':
      return { type: 'record.remove', mark: change.mark, before: change.value }
    case 'record.remove':
      return { type: 'record.add', mark: change.mark, value: change.before }
    case 'field.set':
      return change.before === undefined
        ? { type: 'field.remove', mark: change.mark, field: change.field, before: change.after }
        : {
            type: 'field.set',
            mark: change.mark,
            field: change.field,
            before: change.after,
            after: change.before,
          }
    case 'field.remove':
      return {
        type: 'field.set',
        mark: change.mark,
        field: change.field,
        before: undefined,
        after: change.before,
      }
    default:
      // header changes (relabel / retype / recomment) are not part of this test's
      // operation alphabet, which is field-level edits only
      throw new Error(`invert not defined for ${change.type}`)
  }
}

function undo(state: Dataset, ops: Array<Op>): Dataset {
  return applyOps(
    state,
    [...ops].reverse().map((op, i) => ({
      // reversed order, so the clock must run backwards too
      hlc: { ...op.hlc, wall: 1_000_000 + i },
      change: invert(op.change),
    })),
  )
}

function checkAll(length: number, start: () => Dataset): number {
  let checked = 0

  for (const actions of sequences(length)) {
    const base = start()
    const ops = opsFor(actions, base.get(MARK))

    if (ops.length === 0) {
      continue
    }

    const short = coalesce(ops)
    const long = applyOps(start(), ops)
    const brief = applyOps(start(), short)

    if (JSON.stringify(serialize(long)) !== JSON.stringify(serialize(brief))) {
      throw new Error(
        `coalesce changed the result for: ${actions.map(nameOf).join(' -> ')}`,
      )
    }

    // `before` must be truthful, or undo and blame silently lie
    const back = undo(brief, short)

    if (JSON.stringify(serialize(back)) !== JSON.stringify(serialize(start()))) {
      throw new Error(
        `coalesced stream did not invert for: ${actions.map(nameOf).join(' -> ')}`,
      )
    }

    checked += 1
  }

  return checked
}

function nameOf(action: Action): string {
  return action.kind === 'set'
    ? `${action.actor}:set ${action.field}=${action.value}`
    : action.kind === 'unset'
      ? `${action.actor}:unset ${action.field}`
      : `${action.actor}:${action.kind}`
}

// Maps do not compare structurally through JSON, so records are flattened first.
function serialize(dataset: Dataset): unknown {
  return [...dataset.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([mark, record]) => [
      mark,
      record.type,
      [...record.fields.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    ])
}

describe('coalesce is exact over every short edit sequence', () => {
  it('holds for every sequence of two edits on an existing record', () => {
    expect(checkAll(2, existing)).toBeGreaterThan(100)
  })

  it('holds for every sequence of three edits on an existing record', () => {
    expect(checkAll(3, existing)).toBeGreaterThan(1_000)
  })

  it('holds for every sequence of three edits starting from nothing', () => {
    expect(checkAll(3, () => new Map())).toBeGreaterThan(100)
  })

  it('holds for every sequence of four edits on an existing record', () => {
    expect(checkAll(4, existing)).toBeGreaterThan(60_000)
  })
})
