// The reflog records where every ref has pointed, so a ref move is recoverable. base
// can rewrite history (erase) and auto-rebase on a contended commit, which means a head
// can move out from under a mistake, so a log of prior heads is a safety net, exactly
// like git's reflog: a bad rewrite is undone by resetting the branch to a logged hash.
// Because commits are content-addressed and never deleted until garbage collection, an
// old head stays readable as long as the reflog keeps naming it.
//
// See note/library/base/design/history-operations.md.

export type RefLogEntry = {
  ref: string
  // the previous hash (undefined when the ref was created)
  from: string | undefined
  // the new hash the ref moved to
  to: string
  // the operation that moved it: commit, merge, branch, erase, reset, tag
  op: string
  message: string
  // wall time in milliseconds if the operation carried one, else 0
  time: number
}

export interface RefLog {
  record(entry: RefLogEntry): void
  // entries for one ref, newest first
  entries(ref: string): Array<RefLogEntry>
  // forget a ref's entire history. Used by erasure: the rewritten ref's old entries
  // name the original (pre-erasure) commits, which must not survive the erasure.
  clear(ref: string): void
}

export class MemoryRefLog implements RefLog {
  private log = new Map<string, Array<RefLogEntry>>()

  record(entry: RefLogEntry): void {
    let list = this.log.get(entry.ref)
    if (list === undefined) {
      list = []
      this.log.set(entry.ref, list)
    }
    list.push(entry)
  }

  entries(ref: string): Array<RefLogEntry> {
    return [...(this.log.get(ref) ?? [])].reverse()
  }

  clear(ref: string): void {
    this.log.delete(ref)
  }
}
