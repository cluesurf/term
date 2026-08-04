// Live drafts: the state of a branch between commits.
//
// A keystroke is a broadcast, a coalesced edit is a segment, and only a settled burst is
// a commit. This module is the middle tier: it turns a stream of operations into the
// smallest equivalent stream, packages it into immutable segments the object store can
// hold, and decides when a burst has settled.
//
// See note/library/base/design/live-drafts.md.

import type { RecordNode, Value } from '@term/base/code/base/type'
import type { Dataset } from '@term/base/code/diff/change'
import { compareHlc } from '@term/base/code/merge/clock'
import { applyOps, type Op } from '@term/base/code/sync/op-sync'

// An immutable batch of coalesced operations, named by its content hash and naming its
// predecessor. A branch's `pending` points at the newest one, so a single hash names an
// entire in-flight editing session.
export type Segment = {
  previous: string | undefined
  ops: Array<Op>
}

/**
 * The smallest stream of operations with the same net effect.
 *
 * Exactness is the point: a coalesced stream must be indistinguishable from the stream it
 * replaces, so nothing downstream (patch, commit, projection, blame) needs to know
 * whether coalescing ran. Typing five characters into a field produces five operations
 * and one coalesced operation describing the same transition.
 *
 * Two operations merge only when they touch the same field of the same record AND come
 * from the same actor, so attribution survives into blame and one person's edit is never
 * folded into another's.
 */
export function coalesce(ops: Array<Op>): Array<Op> {
  const ordered = [...ops].sort((a, b) => compareHlc(a.hlc, b.hlc))
  // per mark, the collapsed operations so far, in order
  const byMark = new Map<string, Array<Op>>()
  // the marks in the order they were first touched, so output is stable
  const order: Array<string> = []

  for (const op of ordered) {
    const mark = op.change.mark
    let list = byMark.get(mark)

    if (!list) {
      list = []
      byMark.set(mark, list)
      order.push(mark)
    }

    byMark.set(mark, absorb(list, op))
  }

  const out: Array<Op> = []

  for (const mark of order) {
    out.push(...(byMark.get(mark) ?? []))
  }

  return out.sort((a, b) => compareHlc(a.hlc, b.hlc))
}

/** Fold one operation into a mark's collapsed list. */
function absorb(list: Array<Op>, op: Op): Array<Op> {
  const change = op.change

  if (change.type === 'record.remove') {
    if (list.length === 0) {
      return [op]
    }

    const head = list[0]!.change

    // A record created within this window and then removed never existed.
    if (head.type === 'record.add') {
      return []
    }

    // The record was already gone at the window's start, so everything since (a
    // re-creation and any edits to it) was transient. The net effect is that first
    // removal, which is the only one whose `before` describes the record as it stood
    // when the window opened.
    if (head.type === 'record.remove') {
      return [list[0]!]
    }

    // Otherwise the removal supersedes a run of field edits, and its `before` must
    // describe the record BEFORE them. Undoing the collapsed field operations recovers it.
    return [
      {
        hlc: op.hlc,
        change: {
          type: 'record.remove',
          mark: change.mark,
          before: rewind(change.before, list),
        },
      },
    ]
  }

  if (change.type === 'record.add') {
    // A replacement (remove then add) or an add over a live record. Both are meaningful
    // in sequence, so they pass through unmerged.
    return [...list, op]
  }

  // A field change on a record created in this same window is not a separate edit: the
  // record was simply created that way. The creation keeps its own clock, so it does not
  // drift later than anything that references it.
  const addAt = lastAddIndex(list)
  if (addAt !== -1) {
    const created = list[addAt]!
    const value = cloneRecord(
      (created.change as { value: RecordNode }).value,
    )

    if (change.type === 'field.set') {
      value.fields.set(change.field, change.after)
    } else {
      value.fields.delete(change.field)
    }

    const out = [...list]
    out[addAt] = { hlc: created.hlc, change: { ...created.change, value } as Op['change'] }
    return out
  }

  const at = lastFieldIndex(list, change.field)

  if (at === -1 || list[at]!.hlc.node !== op.hlc.node) {
    return [...list, op]
  }

  // Keep the FIRST operation's `before` and the LAST one's `after`, which is exactly the
  // net transition the pair described.
  const previous = list[at]!.change
  const before =
    previous.type === 'field.set' || previous.type === 'field.remove'
      ? previous.before
      : undefined

  const merged: Op =
    change.type === 'field.set'
      ? {
          hlc: op.hlc,
          change: { type: 'field.set', mark: change.mark, field: change.field, before, after: change.after },
        }
      : {
          hlc: op.hlc,
          change:
            before === undefined
              ? // set then removed, having never existed before: nothing happened
                { type: 'field.remove', mark: change.mark, field: change.field, before: change.before }
              : { type: 'field.remove', mark: change.mark, field: change.field, before },
        }

  const out = [...list]
  out[at] = merged
  return out
}

/** The index of the most recent record creation in a list, or -1. */
function lastAddIndex(list: Array<Op>): number {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]!.change.type === 'record.add') {
      return i
    }
  }

  return -1
}

/** The index of the last operation in a list touching a given field. */
function lastFieldIndex(list: Array<Op>, field: string): number {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const change = list[i]!.change

    if (
      (change.type === 'field.set' || change.type === 'field.remove') &&
      change.field === field
    ) {
      return i
    }
  }

  return -1
}

/** A record as it stood before a list of field operations was applied to it. */
function rewind(record: RecordNode, list: Array<Op>): RecordNode {
  const out = cloneRecord(record)

  for (let i = list.length - 1; i >= 0; i -= 1) {
    const change = list[i]!.change

    if (change.type === 'field.set') {
      restore(out, change.field, change.before)
    } else if (change.type === 'field.remove') {
      restore(out, change.field, change.before)
    }
  }

  return out
}

function restore(
  record: RecordNode,
  field: string,
  before: Value | undefined,
): void {
  if (before === undefined) {
    record.fields.delete(field)
  } else {
    record.fields.set(field, before)
  }
}

function cloneRecord(record: RecordNode): RecordNode {
  return { ...record, fields: new Map(record.fields) }
}

/**
 * The dataset a branch actually shows: the committed state with pending work folded on.
 *
 * The fold is keyed by mark and field, so its cost is proportional to the pending
 * operations rather than to the repository. A million-record repository with twelve
 * uncommitted edits touches twelve records.
 */
export function materialize(input: {
  committed: Dataset
  segments: Array<Segment>
}): Dataset {
  const ops: Array<Op> = []

  for (const segment of input.segments) {
    ops.push(...segment.ops)
  }

  return applyOps(input.committed, ops)
}

/** Every operation pending on a branch, oldest first. */
export function pendingOps(segments: Array<Segment>): Array<Op> {
  const ops: Array<Op> = []

  for (const segment of segments) {
    ops.push(...segment.ops)
  }

  return ops.sort((a, b) => compareHlc(a.hlc, b.hlc))
}

// How a burst becomes a commit. The boundary differs by mode, but the caps below do not.
export type SettleMode = 'wiki' | 'realtime' | 'git' | 'batch'

// An unbounded pending chain breaks the reader guarantees, which assume the overlay fits
// in memory and a reconnect stays cheap. These force a settle regardless of mode.
export const OPERATION_CAP = 10_000
export const BYTE_CAP = 5 * 1024 * 1024
export const AGE_CAP = 60 * 60 * 1000

// A pause long enough to mean the person stopped, rather than paused mid-word.
export const IDLE_DEBOUNCE = 3_000

export type SettleReason =
  | 'operation-cap'
  | 'byte-cap'
  | 'age-cap'
  | 'idle'
  | 'save'
  | 'semantic'

/**
 * Whether a draft should settle into a commit now, and why.
 *
 * Caps are checked before mode, because a cap is a correctness bound rather than a
 * preference: a forced settle uses a default reason since nobody is there to ask for one.
 */
export function settleReason(input: {
  mode: SettleMode
  operations: number
  bytes: number
  ageMs: number
  idleMs: number
  saved?: boolean
  semanticBoundary?: boolean
}): SettleReason | undefined {
  if (input.operations >= OPERATION_CAP) {
    return 'operation-cap'
  }

  if (input.bytes >= BYTE_CAP) {
    return 'byte-cap'
  }

  if (input.ageMs >= AGE_CAP) {
    return 'age-cap'
  }

  if (input.operations === 0) {
    return undefined
  }

  if (input.saved) {
    return 'save'
  }

  switch (input.mode) {
    case 'wiki':
      // every save is one revision, and there is no implicit boundary
      return undefined
    case 'git':
      // the author commits explicitly
      return undefined
    case 'batch':
      // a logical batch settles when its caller says so, never per record
      return input.semanticBoundary ? 'semantic' : undefined
    case 'realtime':
      if (input.semanticBoundary) {
        return 'semantic'
      }
      return input.idleMs >= IDLE_DEBOUNCE ? 'idle' : undefined
  }
}

// A branch name a person never chose. Namespaced by author so it cannot collide with a
// named branch, which holds because `~` is rejected in user-supplied names.
export const IMPLICIT_PREFIX = '~'

export function implicitBranchName(input: {
  user: string
  ordinal: number
}): string {
  return `${IMPLICIT_PREFIX}${input.user}/draft-${input.ordinal}`
}

export function isImplicitBranch(name: string): boolean {
  return name.startsWith(IMPLICIT_PREFIX)
}
