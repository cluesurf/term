// Reading across repositories, and what is and is not guaranteed when you do.
//
// Each repository has its own watermark and advances on its own. One repository per form
// means a language and its expressions live in DIFFERENT repositories, so a page that reads
// both can see one advanced and the other not.
//
// That is a deliberate trade, and the danger is not the tearing itself. It is that an
// unstated consistency model gets assumed to be stronger than it is, and the assumption
// stays invisible until a page renders half a word. Three facts, none of them obvious:
//
//   1. a read spanning repositories may see a TORN state: a child whose parent has not
//      arrived, or the reverse
//   2. nothing in the database will catch it, because foreign keys crossing the base and
//      projection boundary are dropped by construction. PostgreSQL cannot enforce one across
//      databases, and a projection is derived state that gets rebuilt rather than constrained
//   3. the house read style already assembles across tables in TypeScript rather than in one
//      join, so a torn read surfaces as a MISSING RELATION rather than a wrong row
//
// Fact 3 is the one that makes this livable: every assembly step already has to handle a
// record that was genuinely deleted, and a torn read looks exactly the same. What it must
// not do is treat absence as impossible.
//
// Where tearing is unacceptable, the answer is NOT cross-repository transactions. It is
// either putting the forms that must agree into one repository, or demanding a commit set,
// which is what this file is for.
//
// See note/library/base/design/projection-sync-protocol.md §0 and §10.3.

import { admit, type LagBound, type LagState } from '@term/base/code/project/lag'

/**
 * What one repository contributes to a cross-repository read.
 *
 * `hasCommit` is membership in that projection's applied-commit log, checked per repository,
 * because a commit hash means nothing outside the repository that produced it.
 */
export type Participant = {
  repository: string
  state: LagState
  // whether this projection has applied the commit demanded of it, when one was
  hasCommit?: boolean
}

/**
 * A demand across several repositories.
 *
 * A map rather than a list, because the caller names WHICH repository each commit belongs
 * to. Two repositories can never be compared by commit hash, so the pairing has to be
 * explicit.
 */
export type CommitSet = Record<string, string>

export type AcrossVerdict =
  | { ok: true; serving: Record<string, string> }
  | {
      ok: false
      // the repository that could not answer. Named, because "the read is stale" without
      // saying which half is stale is not actionable
      repository: string
      reason: 'never-applied' | 'too-old' | 'too-far-behind' | 'behind-demand'
      detail: string
    }

/**
 * May a read spanning these repositories be served?
 *
 * Every participant must independently pass its own health bound and its own demand. There
 * is no notion of the set being collectively fresh: freshness is per repository, and a set
 * is admissible exactly when all of its members are.
 *
 * FAILS ON THE FIRST REFUSAL, and names the repository. A caller that learns only "stale"
 * has to guess which half to wait for, and guessing wrong means waiting on something that
 * was never behind.
 *
 * This is a check, not a lock. Between admitting and reading, a projection can advance. That
 * is harmless in the direction it can move: a projection only ever gets MORE current, so a
 * read admitted at commit X and served at commit Y past X still satisfies a demand for X.
 * Monotonicity is what makes the check meaningful without a transaction spanning two
 * databases, which is not available and would not be wanted.
 */
export function admitAcross(input: {
  participants: Participant[]
  bound?: LagBound
  demand?: CommitSet
  now: number
}): AcrossVerdict {
  const serving: Record<string, string> = {}

  for (const participant of input.participants) {
    const wanted = input.demand?.[participant.repository]

    const verdict = admit({
      state: participant.state,
      ...(input.bound === undefined ? {} : { bound: input.bound }),
      freshness:
        wanted === undefined
          ? { need: 'any' }
          : { need: 'commit', commit: wanted },
      ...(participant.hasCommit === undefined
        ? {}
        : { hasCommit: participant.hasCommit }),
      now: input.now,
    })

    if (!verdict.ok) {
      return {
        ok: false,
        repository: participant.repository,
        reason: verdict.reason,
        detail: `${participant.repository}: ${verdict.detail}`,
      }
    }

    serving[participant.repository] = verdict.serving
  }

  return { ok: true, serving }
}

/**
 * The commit set a mutation produced, ready to hand back to a client.
 *
 * A client that edited across two repositories demands both on its next read. Built from
 * whatever commits actually landed, so a mutation that touched one repository yields a set
 * of one rather than a set with a hole in it.
 */
export function commitSetOf(
  results: Array<{ repository: string; commit?: string | undefined }>,
): CommitSet {
  const out: CommitSet = {}

  for (const result of results) {
    if (result.commit !== undefined) {
      out[result.repository] = result.commit
    }
  }

  return out
}
