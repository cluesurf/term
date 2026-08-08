// The base.surf read and sync API, as operations rather than as a server.
//
// Transport-free on purpose, the same way the rest of this package is. base.surf mounts
// these on Fastify; a customer running their own projector calls the same shapes over
// whatever their infrastructure speaks. Keeping the surface here means there is one
// definition of what the API IS, and a server is a binding rather than a second source of
// truth.
//
// The surface exists to serve one thing above all: a projection somewhere else staying
// current. That needs three questions answered, and everything else is convenience.
//
//   where is the branch now      -> head
//   what changed since I looked  -> changes
//   give me everything, I am new -> state
//
// See note/library/base/design/control-plane-and-projections.md.

import type { Change } from '@term/base/code/diff/change'
import { emptyDataset } from '@term/base/code/diff/change'
import { applyChanges } from '@term/base/code/patch/patch'
import type { Conflict } from '@term/base/code/merge/merge'
import type { Diagnostic } from '@term/base/code/form/validate'
import type { RecordNode } from '@term/base/code/base/type'
import type { Repository } from '@term/base/code/repo/repo'
import { commitChanges } from '@term/base/code/project/feed'
import { recordHistory } from '@term/base/code/history/history'

export type Head = { branch: string; commit: string | undefined }

export type Changes = {
  from: string | undefined
  to: string
  changes: Array<Change>
}

export type State = { commit: string; records: Array<RecordNode> }

// Every failure a caller can act on differently. A string message alone forces callers to
// pattern-match on prose, which breaks the moment the prose improves.
export type Fault =
  | { fault: 'no-branch'; branch: string }
  | { fault: 'no-commit'; commit: string }
  | { fault: 'no-record'; mark: string }
  // the request body was malformed (e.g. a change that is not a well-formed change).
  // A client error, distinct from a semantically-refused write.
  | { fault: 'invalid'; message: string }
  // a write the repository refused. Carries BOTH diagnostics and conflicts because they
  // mean different things to a caller: a diagnostic is "your data is wrong", a conflict
  // is "someone else changed this too", and only the second is worth retrying.
  | {
      fault: 'rejected'
      diagnostics: Array<Diagnostic>
      conflicts: Array<Conflict>
    }

export type Result<T> = { ok: true; value: T } | ({ ok: false } & Fault)

const fail = <T>(fault: Fault): Result<T> => ({ ok: false, ...fault })
const good = <T>(value: T): Result<T> => ({ ok: true, value })

/**
 * Where a branch points.
 *
 * The cheapest call in the API, and the one a follower makes most, so it reads a ref and
 * nothing else. A projection polling this on a quiet branch does no work beyond one ref
 * read per interval.
 */
export function head(repo: Repository, branch: string): Result<Head> {
  return good({ branch, commit: repo.head(branch) })
}

/**
 * What changed between two commits.
 *
 * Field-level, so a caller applies exactly what moved rather than re-reading records. With
 * no `from`, this is the whole state expressed as changes, which is what a projection
 * building from empty needs.
 *
 * A `from` the repository does not have is a fault rather than a silent full resend. A
 * caller that lost its place should say so and ask for everything, because quietly
 * sending the entire corpus to something expecting a delta is how a sync loop becomes an
 * outage.
 */
export function changes(
  repo: Repository,
  input: { branch: string; from?: string; to?: string },
): Result<Changes> {
  const to = input.to ?? repo.head(input.branch)

  if (to === undefined) {
    return fail({ fault: 'no-branch', branch: input.branch })
  }

  for (const commit of [input.from, to]) {
    if (commit !== undefined && !has(repo, commit)) {
      return fail({ fault: 'no-commit', commit })
    }
  }

  return good({
    from: input.from,
    to,
    changes: commitChanges(repo, input.from, to),
  })
}

/**
 * The full state at a commit.
 *
 * For a projection with nowhere to start from, and for a dump. Deliberately separate from
 * `changes`: the two have different costs, and a caller should have to ask for the
 * expensive one by name.
 */
export function state(
  repo: Repository,
  input: { branch: string; commit?: string },
): Result<State> {
  const commit = input.commit ?? repo.head(input.branch)

  if (commit === undefined) {
    return fail({ fault: 'no-branch', branch: input.branch })
  }

  if (!has(repo, commit)) {
    return fail({ fault: 'no-commit', commit })
  }

  return good({ commit, records: [...repo.checkout(commit).values()] })
}

/** One record at a commit, for a reader that wants a record rather than a projection. */
export function readRecord(
  repo: Repository,
  input: { branch: string; mark: string; commit?: string },
): Result<{ commit: string; record: RecordNode }> {
  const commit = input.commit ?? repo.head(input.branch)

  if (commit === undefined) {
    return fail({ fault: 'no-branch', branch: input.branch })
  }

  const record = repo.recordAt(commit, input.mark)

  if (!record) {
    return fail({ fault: 'no-record', mark: input.mark })
  }

  return good({ commit, record })
}

/**
 * A record's history, field by field.
 *
 * The question a projection cannot answer, because a projection holds only the present.
 * Anything asking "when did this change and who changed it" has to come here.
 */
export function history(
  repo: Repository,
  input: { branch: string; mark: string },
): Result<{ mark: string; versions: ReturnType<typeof recordHistory> }> {
  // `recordHistory` walks a BRANCH, not a commit. Both are strings, so passing the wrong
  // one typechecks and silently walks nothing.
  if (repo.head(input.branch) === undefined) {
    return fail({ fault: 'no-branch', branch: input.branch })
  }

  return good({
    mark: input.mark,
    versions: recordHistory(repo, input.branch, input.mark),
  })
}

// Whether a client-supplied commit may be served by this repository: it must be
// REACHABLE from one of the repository's own refs, not merely present in the (possibly
// shared) chunk store. Otherwise a caller could read another repository's commit by its
// hash through a repository they can see.
function has(repo: Repository, commit: string): boolean {
  return repo.containsCommit(commit)
}

// The route table, so a server binds paths once and cannot drift from the operations.
//
// Paths follow the platform's conventions: no `/api/` prefix, a `!` suffix on anything
// that is an action rather than a resource, and snake_case in bodies. `changes!` and
// `state!` are POSTs because a caller may name a commit and a set of options, not because
// they write anything.
export const ROUTES = [
  { method: 'GET', path: '/repositories/:repository/branches/:branch/head' },
  { method: 'POST', path: '/repositories/:repository/branches/:branch/changes!' },
  { method: 'POST', path: '/repositories/:repository/branches/:branch/state!' },
  { method: 'GET', path: '/repositories/:repository/branches/:branch/records/:mark' },
  { method: 'GET', path: '/repositories/:repository/branches/:branch/records/:mark/history' },
  { method: 'GET', path: '/repositories/:repository/branches' },
  { method: 'POST', path: '/repositories/:repository/branches/:branch/commit!' },
] as const

/** The HTTP status a fault maps to, so every binding answers alike. */
export function statusOf(result: { ok: boolean } & Partial<Fault>): number {
  if (result.ok) {
    return 200
  }

  // A rejected write or a malformed body is the caller's problem to fix (422), not a
  // missing resource (404).
  return result.fault === 'rejected' || result.fault === 'invalid' ? 422 : 404
}

// ── the write side ───────────────────────────────────────────────────────────

/**
 * Apply a change set to a branch.
 *
 * A caller sends CHANGES, never a whole dataset. Sending a dataset would mean every
 * writer racing to describe the entire repository, and the last one to arrive silently
 * erasing everyone else's records by omission. Changes say what moved and leave the rest
 * alone, which is also what makes a concurrent write mergeable rather than a clobber.
 *
 * The compare-and-swap and three-way merge live in `Repository.commit`, so a write that
 * loses the race is retried against the advanced head rather than rejected.
 */
export function commit(
  repo: Repository,
  input: {
    branch: string
    author: string
    message: string
    time: number
    // typed changes. A caller crossing the HTTP boundary parses the raw JSON body into
    // these with `parseChanges` (code/api/wire.ts) first, so a malformed body is a 422
    // there rather than a crash here.
    changes: Array<Change>
    user?: string
  },
): Result<{ commit: string; diagnostics: Array<Diagnostic> }> {
  const base = repo.head(input.branch)
  const current = base ? repo.checkout(base) : emptyDataset()
  const next = applyChanges(current, input.changes)

  const result = repo.commit(
    input.branch,
    {
      author: input.author,
      message: input.message,
      time: input.time,
      ...(input.user === undefined ? {} : { user: input.user }),
    },
    next,
  )

  if (!result.ok) {
    return {
      ok: false,
      fault: 'rejected',
      diagnostics: result.diagnostics ?? [],
      conflicts: result.conflicts ?? [],
    }
  }

  return good({ commit: result.commit, diagnostics: result.diagnostics })
}

/** Every branch in the repository, with where each points. */
export function branches(repo: Repository): Result<Array<Head>> {
  return good(
    repo.branches().map(branch => ({ branch, commit: repo.head(branch) })),
  )
}
