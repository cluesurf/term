import type { RecordNode } from '@/base/type'
import { makeTombstone } from '@/redact/redact'
import type { GcReport } from '@/gc/gc'

// Hard erasure from immutable history. The content-addressed prolly tree cannot delete
// in place: a record's bytes stay in the older commits that referenced them even after
// a redaction adds a newer tombstone commit. To physically remove content, history is
// rewritten across every branch (each affected commit rebuilt with the content redacted
// or removed), which orphans the original commits, and then garbage collection sweeps
// the now-unreachable chunks. This changes commit hashes, so it is for genuine
// right-to-erasure demands, not routine edits. For content whose hash must stay stable
// (a live citation), crypto-shredding is the tool instead; for content classified as
// regulated up front, the off-history store is.
//
// See note/library/base/design/deletion-and-legal-removal.md.

// Decides each record's fate during an erasure: keep it, remove it entirely, or replace
// it (typically with a tombstone that keeps the mark so references still resolve).
export type Eraser = (node: RecordNode) => RecordNode | 'keep' | 'remove'

// Remove every record matching a predicate, entirely, from all of history.
export function removeMatching(match: (node: RecordNode) => boolean): Eraser {
  return node => (match(node) ? 'remove' : 'keep')
}

// Replace every matching record with a tombstone, keeping its mark and history slot so
// citations resolve to a redacted record rather than dangling.
export function redactMatching(
  match: (node: RecordNode) => boolean,
  opts: { reason: string; by: string; time: number },
): Eraser {
  return node => (match(node) ? makeTombstone(node, opts) : 'keep')
}

export type EraseReport = {
  // branches whose history was rewritten
  branches: Array<string>
  // number of commits rebuilt
  rewritten: number
  // number of record occurrences removed or redacted across all rewritten commits
  erasedOccurrences: number
  // old head -> new head for each branch
  moved: Array<{ branch: string; from: string; to: string }>
  // off-history entries deleted because an erased record referenced them
  offHistoryDeleted: number
  // content hashes of the erased records, to revoke so no peer can re-admit them
  revoked: Array<string>
  // the sweep result, present when erasure ran garbage collection (the default)
  gc?: GcReport
}

// Raised when a branch head moves during an erasure, so the rewrite could not repoint
// it. The erasure is abandoned without deleting anything (the rebuilt commits are left
// as unreachable garbage a later gc reclaims); retry the erasure.
export class ConcurrentErasureError extends Error {
  constructor(public readonly branches: Array<string>) {
    super(`erasure raced a concurrent commit on: ${branches.join(', ')}`)
    this.name = 'ConcurrentErasureError'
  }
}
