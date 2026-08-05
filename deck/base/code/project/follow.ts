// Keeping a projection current, including one on someone else's infrastructure.
//
// `syncAsync` brings a projection up to a branch head once. This is the loop around it:
// it learns that the head moved, applies the difference, and keeps going. That is the
// whole of what a customer running their own database needs from us, and it is
// deliberately transport-free.
//
// The seam is `Signal`: any way of learning that a branch moved. Polling needs nothing
// from the server and works today. A webhook or a socket implements the same interface
// and changes only latency, never the logic below.
//
// See note/library/base/design/control-plane-and-projections.md.

import type { Repository } from '@term/base/code/repo/repo'
import type { AsyncProjection } from '@term/base/code/project/projection'
import { syncAsync } from '@term/base/code/project/feed'
import { check, type Contract, type Derivation, type Verdict } from '@term/base/code/project/contract'

/**
 * A source of "the branch may have moved".
 *
 * It is allowed to be wrong in the cheap direction: a spurious signal costs one
 * comparison, since `syncAsync` no-ops when the projection already serves the head. It
 * must not be wrong in the expensive direction, so a missed signal has to be recoverable,
 * which is what `every` below guarantees.
 */
export type Signal = {
  /** Register interest. Returns a function that stops it. */
  listen(wake: () => void): () => void
}

export type FollowOptions = {
  // an upper bound on how long a missed signal can go unnoticed. Even a perfect push
  // transport gets one, because a dropped connection is indistinguishable from silence.
  every?: number
  // called after each successful advance, with the commit now served
  onAdvance?: (commit: string) => void
  // called when an attempt throws. Following continues: a projection that stops on the
  // first error is worse than one that lags, since lag is visible and a stopped follower
  // is not.
  onError?: (error: unknown) => void
  // What this projection reads. When given, the follower checks each candidate head
  // against it and REFUSES to advance past a commit that drops a property the projection
  // depends on. Without this a projection whose field stopped arriving keeps serving,
  // current and quietly stale, which nothing else here can detect.
  contract?: Contract
  // how a property may still be reachable after a restructuring
  derivation?: Derivation
  // called once when a contract stops holding, with the commit the follower is pinned at
  onPinned?: (verdict: Verdict) => void
}

const DEFAULT_INTERVAL = 30_000

export type Follower = {
  /** Stop following. Safe to call more than once. */
  stop(): void
  /** Bring the projection current now, rather than waiting for a signal. */
  now(): Promise<string | undefined>
}

/**
 * Follow a branch, keeping a projection current.
 *
 * Attempts never overlap. A slow apply that outlasts its interval would otherwise be
 * re-entered, and two concurrent appliers of the same commit race on the bookkeeping row.
 * The projector's idempotence would keep that correct, but it would waste the work, so a
 * signal arriving mid-apply sets a flag and is served by one more pass afterwards.
 */
export function follow(input: {
  repo: Repository
  branch: string
  projection: AsyncProjection
  signal?: Signal
  options?: FollowOptions
}): Follower {
  const { repo, branch, projection } = input
  const every = input.options?.every ?? DEFAULT_INTERVAL

  let stopped = false
  // reported once, not on every attempt, since a pin persists until the contract changes
  let pinned = false
  // work is serialized through this, so attempts never overlap
  let chain: Promise<string | undefined> = Promise.resolve(undefined)

  const run = async (): Promise<string | undefined> => {
    if (stopped) {
      return undefined
    }

    try {
      const before = await projection.serving()

      // Refuse to advance past a commit that breaks the contract. Pinning keeps the
      // consumer working on immutable data and TELLS them, which is the whole point:
      // the alternative is a healthy-looking projection with a column frozen in the past.
      if (input.options?.contract) {
        const head = repo.head(branch)

        if (head && head !== before) {
          const verdict = check({
            contract: input.options.contract,
            dataset: repo.checkout(head),
            derivation: input.options.derivation,
            at: before ?? head,
          })

          if (!verdict.follow) {
            if (!pinned) {
              pinned = true
              input.options.onPinned?.(verdict)
            }

            return before
          }
        }
      }

      const served = await syncAsync(repo, branch, projection)

      if (served && served !== before) {
        input.options?.onAdvance?.(served)
      }

      return served
    } catch (error) {
      input.options?.onError?.(error)
      return undefined
    }
  }

  /**
   * Run, without ever overlapping.
   *
   * A promise chain rather than a flag. Each call queues behind the one before it, so two
   * appliers never race on the bookkeeping row, and every caller gets the result of a run
   * that STARTED AFTER their call rather than one already in flight. An earlier version
   * used a running flag and returned the current serving commit when it found one in
   * progress, which meant a caller could observe state from before its own request.
   */
  const attempt = (): Promise<string | undefined> => {
    chain = chain.catch(() => undefined).then(() => run())

    return chain
  }

  const timer = setInterval(() => void attempt(), every)

  // `unref` where the runtime has it, so following never holds a process open by itself
  ;(timer as unknown as { unref?: () => void }).unref?.()

  const unlisten = input.signal?.listen(() => void attempt())

  // catch up immediately rather than waiting out the first interval
  void attempt()

  return {
    stop(): void {
      if (stopped) {
        return
      }

      stopped = true
      clearInterval(timer)
      unlisten?.()
    },
    now: attempt,
  }
}

/**
 * A signal that asks, rather than being told.
 *
 * Needs nothing from the server, so it is what a projection uses before any push
 * transport exists. It reports a wake only when the head actually changed, so a follower
 * on a quiet branch does no work beyond the head read.
 */
export function pollingSignal(input: {
  head: () => Promise<string | undefined>
  every?: number
}): Signal {
  const every = input.every ?? 5_000

  return {
    listen(wake: () => void): () => void {
      let last: string | undefined
      let stopped = false

      const tick = async (): Promise<void> => {
        if (stopped) {
          return
        }

        try {
          const head = await input.head()

          if (head !== undefined && head !== last) {
            last = head
            wake()
          }
        } catch {
          // a failed head read is not worth reporting: the next tick retries, and the
          // interval timer in `follow` is the backstop either way
        }
      }

      const timer = setInterval(() => void tick(), every)
      ;(timer as unknown as { unref?: () => void }).unref?.()
      void tick()

      return () => {
        stopped = true
        clearInterval(timer)
      }
    },
  }
}

/**
 * A signal driven by something else, for a push transport.
 *
 * A webhook handler or socket message calls `wake`. The transport lives outside this
 * package on purpose, so base stays transport-free and a customer can use whatever their
 * infrastructure already speaks.
 */
export function pushSignal(): Signal & { wake(): void } {
  const listeners = new Set<() => void>()

  return {
    listen(wake: () => void): () => void {
      listeners.add(wake)

      return () => {
        listeners.delete(wake)
      }
    },
    wake(): void {
      for (const listener of [...listeners]) {
        listener()
      }
    },
  }
}
