// Starting a projection without streaming all of history.
//
// A new projection has nothing. Computing the feed from empty to the head yields the entire
// dataset as changes, which is CORRECT and is the wrong shape over a network for a repository
// of any size: a customer bringing up a projection of a few million records would pull every
// record as an individual change before serving a single read.
//
// So: take a snapshot at a commit, then follow from there.
//
//   1. fetch the dataset at commit X
//   2. apply it, and record the resume token for X
//   3. follow from X, which is the ordinary incremental advance
//
// The correctness obligation is that the two paths AGREE at X. They do, and not by accident:
// a snapshot is the dataset at a commit, and a rebuild is defined as depending only on the
// state at a commit rather than the path taken to reach it (invariant I5). Bootstrapping is
// therefore an optimisation carrying an obligation, not a second code path with its own
// semantics, and the obligation is tested rather than argued.
//
// An applier that skips the snapshot and streams from empty is not wrong, only slow. That
// matters: it means a minimal applier can ignore this file entirely and still be correct.
//
// See note/library/base/design/projection-sync-protocol.md §1c.

import type { Dataset } from '@term/base/code/diff/change'
import type { Repository } from '@term/base/code/repo/repo'
import { encodeResume } from '@term/base/code/project/resume'
import { FORMAT_VERSION } from '@term/base/code/canon/format'

export type Snapshot = {
  // the commit this snapshot is OF. It travels with the data, because a dataset carries no
  // proof of which commit produced it and a recipient that guessed would resume from the
  // wrong place
  commit: string
  dataset: Dataset
  // hand this straight back to the feed. The whole point of the handoff is that a caller
  // never has to construct one itself
  token: string
}

/**
 * The dataset at a branch head, with the token that resumes from it.
 *
 * Returns undefined for a branch with no commits, which is not an error: a repository nobody
 * has written to has nothing to snapshot, and the applier simply starts empty and follows.
 */
export function snapshotAt(input: {
  repo: Repository
  repository: string
  branch: string
  // the applier's mapping version, when it has one. A consumer with no schema (a search
  // index, a file dump) has none and must not be made to invent one
  mapping?: string
}): Snapshot | undefined {
  const head = input.repo.head(input.branch)

  if (head === undefined) {
    return undefined
  }

  return {
    commit: head,
    dataset: input.repo.checkout(head),
    token: encodeResume({
      repository: input.repository,
      commit: head,
      canonical: FORMAT_VERSION,
      ...(input.mapping === undefined ? {} : { mapping: input.mapping }),
    }),
  }
}

/**
 * The dataset at a specific commit, with its token.
 *
 * Separate from `snapshotAt` because a bootstrap should be able to name its commit rather
 * than race the head: a snapshot taken at "whatever the head is right now" cannot be
 * re-requested, so a retry after a failed transfer would fetch a DIFFERENT snapshot and the
 * applier could not tell.
 */
export function snapshotOf(input: {
  repo: Repository
  repository: string
  commit: string
  mapping?: string
}): Snapshot {
  return {
    commit: input.commit,
    dataset: input.repo.checkout(input.commit),
    token: encodeResume({
      repository: input.repository,
      commit: input.commit,
      canonical: FORMAT_VERSION,
      ...(input.mapping === undefined ? {} : { mapping: input.mapping }),
    }),
  }
}
