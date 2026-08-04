import type { Dataset } from '@term/base/code/diff/change'
import type { RecordNode, Value } from '@term/base/code/base/type'
import { canonicalizeValue } from '@term/base/code/canon/canonicalize'
import { MarkIndex, marksTouched } from '@term/base/code/lookup/mark-index'
import type { Repository } from '@term/base/code/repo/repo'

// History operations over the commit graph: who last set each field of a record
// (blame), when a record changed (record history), and a binary search for the first
// commit at which a condition holds (bisect). All walk the first-parent log, which
// the repository already exposes, and use point lookups so blaming one record does
// not read the whole dataset. See note/library/base/design/history-operations.md.

export type FieldBlame = {
  field: string
  value: Value
  commit: string
  author: string
  time: number
  message: string
}

// For each field currently on a record, the commit that last set it to its present
// value, walking the first-parent history oldest to newest.
export function blame(
  repo: Repository,
  branch: string,
  mark: string,
): Array<FieldBlame> {
  const history = repo.log(branch).slice().reverse() // oldest first
  const lastCanon = new Map<string, string>()
  const setAt = new Map<
    string,
    { hash: string; author: string; time: number; message: string }
  >()

  for (const { hash, commit } of history) {
    const rec = repo.recordAt(hash, mark)
    const fields = rec ? rec.fields : new Map<string, Value>()
    for (const [field, value] of fields) {
      const canon = canonicalizeValue(value)
      if (lastCanon.get(field) !== canon) {
        lastCanon.set(field, canon)
        setAt.set(field, {
          hash,
          author: commit.author,
          time: commit.time,
          message: commit.message,
        })
      }
    }
    for (const field of [...lastCanon.keys()]) {
      if (!fields.has(field)) {
        lastCanon.delete(field)
        setAt.delete(field)
      }
    }
  }

  const current = repo.recordAt(repo.head(branch)!, mark)
  if (current === undefined) {
    return []
  }
  const out: Array<FieldBlame> = []
  for (const [field, value] of current.fields) {
    const at = setAt.get(field)
    if (at !== undefined) {
      out.push({
        field,
        value,
        commit: at.hash,
        author: at.author,
        time: at.time,
        message: at.message,
      })
    }
  }
  return out
}

export type HistoryEntry = {
  commit: string
  author: string
  time: number
  message: string
  record: RecordNode | undefined
}

// The commits at which a record changed, newest first, including its removal.
export function recordHistory(
  repo: Repository,
  branch: string,
  mark: string,
): Array<HistoryEntry> {
  const log = repo.log(branch) // newest first
  const out: Array<HistoryEntry> = []
  const canonOf = (hash: string | undefined): string | undefined => {
    if (hash === undefined) {
      return undefined
    }
    const rec = repo.recordAt(hash, mark)
    return rec ? canonicalizeValue({ kind: 'record', record: rec }) : undefined
  }
  for (const { hash, commit } of log) {
    // a commit changed the record when its value differs from its first parent's
    if (canonOf(hash) !== canonOf(commit.parents[0])) {
      out.push({
        commit: hash,
        author: commit.author,
        time: commit.time,
        message: commit.message,
        record: repo.recordAt(hash, mark),
      })
    }
  }
  return out
}

// Build the mark-to-commits index for a branch from the stored change sets, so
// per-record history and blame do not scan the whole history per query.
export function buildMarkIndex(repo: Repository, branch: string): MarkIndex {
  const index = new MarkIndex()
  for (const { hash } of repo.log(branch)) {
    const changes = repo.commitChangeset(hash)
    if (changes === undefined) {
      continue
    }
    for (const mark of marksTouched(changes)) {
      index.add(mark, hash)
    }
  }
  return index
}

// The commits that touched a record, newest first, resolved via the mark index in
// O(touches) rather than a full history scan. Pass a prebuilt index to amortize it
// across many records.
export function markHistory(
  repo: Repository,
  branch: string,
  mark: string,
  index?: MarkIndex,
): Array<HistoryEntry> {
  const idx = index ?? buildMarkIndex(repo, branch)
  return idx.commitsFor(mark).map(hash => {
    const commit = repo.readCommit(hash)
    return {
      commit: hash,
      author: commit.author,
      time: commit.time,
      message: commit.message,
      record: repo.recordAt(hash, mark),
    }
  })
}

// Binary search the first-parent history for the earliest commit at which a
// predicate over the checked-out dataset holds. Assumes the predicate is monotonic
// along the history (false on older commits, true from some commit onward), the way
// `git bisect` assumes a single introducing commit. Returns undefined if it never
// holds.
export function bisect(
  repo: Repository,
  branch: string,
  isBad: (dataset: Dataset, commit: string) => boolean,
): string | undefined {
  const order = repo.log(branch).slice().reverse() // oldest first
  let lo = 0
  let hi = order.length - 1
  let found: string | undefined
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const hash = order[mid]!.hash
    if (isBad(repo.checkout(hash), hash)) {
      found = hash
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  return found
}
