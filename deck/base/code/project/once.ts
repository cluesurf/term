// Applying a change feed into a store that has no transactions.
//
// Modes A, B and C put the applier next to a transactional database, so rows and watermark
// commit together and the acknowledgement IS the transaction. A customer projecting into
// Redis, a search index, object storage, or a service in another language has no transaction
// to hold those together, and the protocol has to say what replaces it rather than pretend
// the case does not exist.
//
// Three rules, and together they recover a real guarantee:
//
//   1. delivery is AT-LEAST-ONCE. Do not chase exactly-once on the wire. It is not
//      achievable, and every attempt spends its whole complexity budget there
//   2. every write is IDEMPOTENT, keyed by the record's mark. A projection is a STATE
//      projection, not an event log, so applying the same change twice must produce the same
//      result. Upsert by mark, never append
//   3. ROWS FIRST, CURSOR SECOND. Never the reverse
//
// Rule 3 is the one a careful person gets backwards, because writing progress first feels
// like the diligent thing to do. It is the only ordering that loses data:
//
//   rows then cursor    a crash between them re-applies a span, which rule 2 makes harmless
//   cursor then rows    a crash between them SKIPS a span, permanently and silently
//
// The result is effectively-once for records, with a cursor that trails the data and never
// leads it. That is genuinely weaker than modes A to C, because a reader can observe a
// partially applied span, and it must be said out loud to whoever runs it rather than
// implied.
//
// See note/library/base/design/projection-sync-protocol.md §1a and §1b.

import type { Change } from '@term/base/code/diff/change'
import type { RecordNode } from '@term/base/code/base/type'

/**
 * The seam a non-transactional target implements.
 *
 * Deliberately four methods. Anything larger starts assuming capabilities a key-value store
 * does not have, and the point of this path is that it assumes almost nothing.
 */
export type Sink = {
  /** Idempotent upsert, keyed by mark. Applying twice must equal applying once. */
  put(input: { mark: string; record: RecordNode }): Promise<void>
  /** Idempotent delete. Removing something absent is not an error. */
  drop(mark: string): Promise<void>
  /** The resume token last written, or undefined for a fresh applier. */
  cursor(): Promise<string | undefined>
  /** Record the resume token. Called ONLY after every write above has landed. */
  advance(token: string): Promise<void>
}

export type Applied = {
  put: number
  dropped: number
  token: string
}

/**
 * Fold a change set into the records it produces, before touching the target.
 *
 * Field-level changes are collapsed per mark first, so a mark touched five times in one span
 * is written once. That is not only cheaper: on a non-transactional target it narrows the
 * window in which a reader can observe a partially applied span, which is the one guarantee
 * this path gives up.
 */
export function foldChanges(changes: Change[]): {
  put: Map<string, RecordNode>
  drop: Set<string>
} {
  const put = new Map<string, RecordNode>()
  const drop = new Set<string>()

  for (const change of changes) {
    switch (change.type) {
      case 'record.add': {
        drop.delete(change.mark)
        put.set(change.mark, change.value)
        break
      }
      case 'record.remove': {
        put.delete(change.mark)
        drop.add(change.mark)
        break
      }
      case 'field.set': {
        const held = put.get(change.mark)

        if (held) {
          held.fields.set(change.field, change.after)
        }

        break
      }
      case 'field.remove': {
        const held = put.get(change.mark)

        if (held) {
          held.fields.delete(change.field)
        }

        break
      }
      default:
        break
    }
  }

  return { put, drop }
}

/**
 * Apply a span to a non-transactional target, at least once.
 *
 * The ordering is the whole contract, and it is enforced here rather than left to each
 * applier: every record write completes, then the cursor advances. A caller that reverses
 * them has not made this faster, it has made it lossy.
 *
 * Returns what it wrote, so a caller can log progress without inspecting the target. It does
 * NOT swallow errors: a failed write must propagate, so the cursor stays where it was and
 * the span is re-applied. Swallowing would advance past data that never landed, which is
 * exactly the failure this ordering exists to prevent.
 */
export async function applyOnce(input: {
  changes: Change[]
  // the resume token to record once every write has landed
  token: string
  sink: Sink
}): Promise<Applied> {
  const { put, drop } = foldChanges(input.changes)

  // Every write first. If any throws, the cursor is untouched and the whole span is
  // re-applied on the next attempt, which rule 2 makes harmless.
  for (const [mark, record] of put) {
    await input.sink.put({ mark, record })
  }

  for (const mark of drop) {
    await input.sink.drop(mark)
  }

  // Only now. This line is the acknowledgement, and it must be the last thing that happens.
  await input.sink.advance(input.token)

  return { put: put.size, dropped: drop.size, token: input.token }
}
