import { emptyDataset, type Change } from '@/diff/change'
import { diffDataset, diffRecord } from '@/diff/diff'
import type { Repository } from '@/repo/repo'
import type { Projection } from '@/project/projection'

// The change feed is the one integration point for the read side: an ordered stream
// of field-level changes per commit, which any projection subscribes to. base emits
// it; CockroachDB, a search index, and a custom in-memory index are all subscribers.
//
// See note/library/base/design/custom-projections.md.

// The field-level change set between two commits, built from a point-read diff of
// only the records that differ (O(size of the difference)), not a scan of both states.
function changesBetween(
  repo: Repository,
  from: string,
  to: string,
): Array<Change> {
  const changes: Array<Change> = []
  for (const mark of [...repo.diffCommits(from, to)].sort()) {
    const before = repo.recordAt(from, mark)
    const after = repo.recordAt(to, mark)
    if (before === undefined && after !== undefined) {
      changes.push({ type: 'record.add', mark, value: after })
    } else if (before !== undefined && after === undefined) {
      changes.push({ type: 'record.remove', mark, before })
    } else if (before !== undefined && after !== undefined) {
      changes.push(...diffRecord(mark, before, after))
    }
  }
  return changes
}

// The change set between two commits (or from empty to a commit). A forward step to a
// commit's immediate child returns that commit's recorded change set directly. Any
// other adjacent pair is diffed by changed-marks and point reads. A rebuild from empty
// reads the full target once.
export function commitChanges(
  repo: Repository,
  from: string | undefined,
  to: string,
): Array<Change> {
  if (from !== undefined) {
    // hot path: advancing to the child commit reuses its stored change set
    if (repo.readCommit(to).parents[0] === from) {
      const stored = repo.commitChangeset(to)
      if (stored !== undefined) {
        return stored
      }
    }
    return changesBetween(repo, from, to)
  }
  return diffDataset(emptyDataset(), repo.checkout(to))
}

// Rebuild a projection from empty at a commit. This is the disaster-recovery and
// reproducibility path: a projection is always rebuildable from history.
export function projectFromEmpty(
  repo: Repository,
  commit: string,
  projection: Projection,
): void {
  projection.apply(commitChanges(repo, undefined, commit))
  projection.setServingCommit(commit)
}

// Advance a projection incrementally from one commit to another, applying only the
// changes between them. This is how a projection tracks live edits cheaply.
export function advance(
  repo: Repository,
  from: string,
  to: string,
  projection: Projection,
): void {
  projection.apply(commitChanges(repo, from, to))
  projection.setServingCommit(to)
}

// Bring a projection up to a branch head, incrementally if it already reflects an
// earlier commit, or from empty if it is fresh.
export function sync(
  repo: Repository,
  branch: string,
  projection: Projection,
): void {
  const head = repo.head(branch)
  if (head === undefined) {
    return
  }
  const at = projection.servingCommit()
  if (at === undefined) {
    projectFromEmpty(repo, head, projection)
  } else if (at !== head) {
    advance(repo, at, head, projection)
  }
}

// A simple in-process change feed for realtime and custom projections: subscribers
// receive each emitted change set in order.
export class ChangeFeed {
  private subscribers: Array<(changes: Array<Change>) => void> = []

  subscribe(fn: (changes: Array<Change>) => void): () => void {
    this.subscribers.push(fn)
    return () => {
      this.subscribers = this.subscribers.filter(s => s !== fn)
    }
  }

  emit(changes: Array<Change>): void {
    for (const fn of this.subscribers) {
      fn(changes)
    }
  }
}
