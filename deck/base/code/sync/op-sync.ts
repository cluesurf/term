import type { Change, Dataset } from '@term/base/code/diff/change'
import { applyChanges } from '@term/base/code/patch/patch'
import { compareHlc, type Hlc } from '@term/base/code/merge/clock'

// The realtime session protocol: operation-based delta sync. Each operation carries
// a change and a hybrid-logical-clock timestamp. A joining or reconnecting peer
// sends its last-seen clock and receives only the operations since, so it catches up
// in bytes proportional to what it missed. Operations settle into commits, which
// then propagate through the chunk-sync protocol.
//
// See note/library/base/design/sync-and-transport.md and
// note/library/base/editing/06-algorithms.md.

export type Op = { hlc: Hlc; change: Change }

export class OpLog {
  private ops: Array<Op> = []

  // Insert in clock order via binary search, so an append does not re-sort the log.
  append(op: Op): void {
    let lo = 0
    let hi = this.ops.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (compareHlc(this.ops[mid]!.hlc, op.hlc) <= 0) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }
    this.ops.splice(lo, 0, op)
  }

  all(): Array<Op> {
    return [...this.ops]
  }

  // The operations strictly after a given clock: the delta a peer needs to catch up.
  since(clock: Hlc | undefined): Array<Op> {
    if (clock === undefined) {
      return this.all()
    }
    return this.ops.filter(op => compareHlc(op.hlc, clock) > 0)
  }

  // The latest clock in the log, for a peer to report as last-seen.
  latest(): Hlc | undefined {
    return this.ops.length ? this.ops[this.ops.length - 1]!.hlc : undefined
  }
}

// Apply a stream of operations to a dataset, in clock order.
export function applyOps(base: Dataset, ops: Array<Op>): Dataset {
  const ordered = [...ops].sort((a, b) => compareHlc(a.hlc, b.hlc))
  return applyChanges(
    base,
    ordered.map(o => o.change),
  )
}
