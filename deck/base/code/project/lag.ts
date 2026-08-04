// The lag contract.
//
// A projection is a rebuildable cache that trails its repository. That is not a defect
// to hide, it is a property to EXPOSE: every read reports the commit it was served at, a
// caller may demand a minimum, and a projection that has fallen too far behind reports
// unhealthy rather than quietly answering with old data.
//
// The last part is the one that matters. A stale answer with no signal is
// indistinguishable from a fresh one, so a projection that cannot meet its bound must
// refuse, not guess.
//
// See note/library/base/design/caching-and-query-performance.md and
// note/library/base/plan/implementation.md phase 5.

// What a caller needs from a read.
export type Freshness =
  // whatever the projection currently holds
  | { need: 'any' }
  // read-your-writes: the projection must have applied this commit. Membership rather
  // than ordering, because commits form a graph and "at or after" is not a comparison
  // two hashes can answer on their own.
  | { need: 'commit'; commit: string }

// How far behind a projection may fall before it stops answering.
export type LagBound = {
  // the projection must have applied something within this window
  maxAgeMs?: number
  // the projection must be no more than this many commits behind the branch head
  maxCommits?: number
}

// What a projection knows about its own currency.
export type LagState = {
  serving: string | undefined
  // when the last commit was applied
  appliedAt?: number
  // commits between the projection and the branch head, when the head is known
  behind?: number
}

export type Health =
  | { healthy: true; state: LagState }
  | {
      healthy: false
      state: LagState
      reason: 'never-applied' | 'too-old' | 'too-far-behind'
      detail: string
    }

/**
 * Is a projection within its bound?
 *
 * An empty projection is unhealthy rather than merely empty: it has never applied a
 * commit, so an answer from it means "nothing matched" and "nothing is loaded yet"
 * at the same time, and a caller cannot tell those apart.
 */
export function health(input: {
  state: LagState
  bound?: LagBound
  now: number
}): Health {
  const { state, bound } = input

  if (state.serving === undefined) {
    return {
      healthy: false,
      state,
      reason: 'never-applied',
      detail: 'the projection has never applied a commit',
    }
  }

  if (bound?.maxAgeMs !== undefined && state.appliedAt !== undefined) {
    const age = input.now - state.appliedAt

    if (age > bound.maxAgeMs) {
      return {
        healthy: false,
        state,
        reason: 'too-old',
        detail: `last applied ${age}ms ago, bound is ${bound.maxAgeMs}ms`,
      }
    }
  }

  if (bound?.maxCommits !== undefined && state.behind !== undefined) {
    if (state.behind > bound.maxCommits) {
      return {
        healthy: false,
        state,
        reason: 'too-far-behind',
        detail: `${state.behind} commits behind, bound is ${bound.maxCommits}`,
      }
    }
  }

  return { healthy: true, state }
}

// The outcome of a read against the lag contract. A refusal is a VALUE rather than an
// exception, because falling behind is an expected operating condition and a caller has
// to handle it either way.
export type Served<T> =
  | { ok: true; rows: T; serving: string }
  | {
      ok: false
      reason: 'never-applied' | 'too-old' | 'too-far-behind' | 'behind-demand'
      detail: string
      serving: string | undefined
    }

/**
 * Whether a read may be served, given what the caller demanded.
 *
 * Health is checked BEFORE the demand: a projection that is unhealthy should say so
 * rather than report the more specific "I have not applied your commit", which reads
 * like a race when it is actually an outage.
 */
export function admit(input: {
  state: LagState
  bound?: LagBound
  freshness: Freshness
  // whether the projection has applied the demanded commit
  hasCommit?: boolean
  now: number
}): { ok: true; serving: string } | Extract<Served<never>, { ok: false }> {
  const check = health({ state: input.state, bound: input.bound, now: input.now })

  if (!check.healthy) {
    return {
      ok: false,
      reason: check.reason,
      detail: check.detail,
      serving: input.state.serving,
    }
  }

  if (input.freshness.need === 'commit' && input.hasCommit !== true) {
    return {
      ok: false,
      reason: 'behind-demand',
      detail: `the projection has not applied ${input.freshness.commit}`,
      serving: input.state.serving,
    }
  }

  return { ok: true, serving: input.state.serving! }
}
