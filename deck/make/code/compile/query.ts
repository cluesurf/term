// The incremental query engine (Tier 2, the Salsa model), async edition. Every phase becomes a memoized query keyed by
// an interned id; dependencies record themselves automatically; a value that recomputes to the same result does not
// invalidate its dependents (backdating); durability tiers give O(1) validation when only a low-stability input
// changed. This edition is ASYNC and concurrency-safe: a query body runs under an explicit execution context (`Cx`)
// rather than a global frame stack, so many query bodies can be in flight at once (the foundation for parallel
// per-definition compilation). See note/seed/compiler/async-query-engine.md and note/seed/plan/tier-4-parallel-compile.md.
//
// The state and every decision made on it are Term, compile/memo.tree (self-hosting, 2026-10-04). This file is the
// host driver, and holds only what Term cannot: each query's compute closure by key, the in-flight promise per key,
// and the two identity tests (`Object.is` on an input, a query's own `equals` on a recompute), passed to the store as
// booleans. Its API is the original's, so its callers and test/compile/query.ts are unchanged.

import {
  hasInput,
  hasMemo,
  inputChangedAfter,
  inputValue,
  isUnchangedByDurability,
  isVerified,
  makeFrame,
  makeStore,
  markVerified,
  memoChangedAfter,
  memoDeps,
  memoValue,
  memoVerifiedAt,
  noteQuery,
  readInput,
  recomputesOf,
  revisionOf,
  runs,
  setInput,
  storeResult,
} from '@term/make/code/compile/memo'
import type { Frame, Store } from '@term/make/code/compile/memo'

// durability tiers: LOW = the edited buffer, MEDIUM = other project files, HIGH = the stdlib (rarely changes).
export const LOW = 0
export const MEDIUM = 1
export const HIGH = 2
export type Durability = 0 | 1 | 2

export type Compute<T> = (cx: Cx) => T | Promise<T>
export type Equals<T> = (a: T, b: T) => boolean

// the handle a query body uses to read inputs and sub-queries. Reads record themselves as dependencies of the running
// query, onto THIS context's frame (not a global stack), so tracking stays correct across `await` points.
export interface Cx {
  input<T>(key: string): T
  query<T>(
    key: string,
    compute: Compute<T>,
    equals?: Equals<T>,
  ): Promise<T>
}

// what a memo was computed with, kept by key so a stale dependency can be recomputed on demand
type Recipe = { compute: Compute<unknown>; equals: Equals<unknown> }

export class Database {
  private readonly store: Store = makeStore()
  private readonly recipes = new Map<string, Recipe>()
  // the in-flight computation per key, so two concurrent requests for one key share one run (dedup)
  private readonly inFlight = new Map<string, Promise<unknown>>()

  // observability for tests: total query-body executions
  get recomputes(): number {
    return recomputesOf(this.store)
  }

  // how many times a specific query's body has executed (for tests / diagnostics)
  runs(key: string): number {
    return runs(this.store, key)
  }

  // set (or change) an input. Setting it to its current value is a no-op (content-addressed: re-saving identical
  // source invalidates nothing). A real change bumps the global revision and the durability's last-changed marker.
  setInput(
    key: string,
    value: unknown,
    durability: Durability = LOW,
  ): void {
    const same = hasInput(this.store, key) && Object.is(inputValue(this.store, key), value)

    setInput(this.store, key, value, durability, same)
  }

  // the top-level entry: run `fn` under a fresh root context. The root is not memoized; it exists only to give the
  // body a context to evaluate real queries under. Returns whatever `fn` returns. Use this to drive a build / analysis.
  async transaction<T>(fn: (cx: Cx) => T | Promise<T>): Promise<T> {
    return fn(this.makeContext(new Set()))
  }

  // evaluate a single root query (a convenience over `transaction` for a one-query read)
  async evaluate<T>(
    key: string,
    compute: Compute<T>,
    equals: Equals<T> = Object.is,
  ): Promise<T> {
    return this.transaction(cx => cx.query(key, compute, equals))
  }

  // build an execution context whose frame records the dependencies of one running query. `active` is the set of keys
  // on this path (ancestors), for cycle detection.
  private makeContext(active: Set<string>): Cx & { frame: Frame } {
    const frame = makeFrame()
    const db = this

    return {
      frame,
      input<T>(key: string): T {
        if (!hasInput(db.store, key)) {
          throw new Error(`unknown input: ${key}`)
        }

        return readInput(db.store, frame, key) as T
      },
      async query<T>(
        key: string,
        compute: Compute<T>,
        equals: Equals<T> = Object.is,
      ): Promise<T> {
        if (active.has(key)) {
          throw new Error(`query cycle: ${key}`)
        }

        const value = (await db.resolveKey(
          key,
          compute as Compute<unknown>,
          equals as Equals<unknown>,
          active,
        )) as T

        // record `key` as a dependency of THIS query, lowering its durability to the weakest dep
        noteQuery(db.store, frame, key)

        return value
      },
    }
  }

  // return the up-to-date value of a query this revision, deduping concurrent requests for the same key
  private resolveKey(
    key: string,
    compute: Compute<unknown>,
    equals: Equals<unknown>,
    active: Set<string>,
  ): Promise<unknown> {
    if (isVerified(this.store, key)) {
      return Promise.resolve(memoValue(this.store, key))
    }

    const flying = this.inFlight.get(key)

    if (flying) {
      return flying
    }

    const promise = this.computeKey(key, compute, equals, active)
    this.inFlight.set(key, promise)
    // clear the in-flight slot once settled, but only if it is still ours (a later revision may have replaced it)
    void promise
      .catch(() => undefined)
      .finally(() => {
        if (this.inFlight.get(key) === promise) {
          this.inFlight.delete(key)
        }
      })

    return promise
  }

  // verify-or-recompute one key: if its memo's dependencies have not changed, mark it verified and reuse; else run it
  private async computeKey(
    key: string,
    compute: Compute<unknown>,
    equals: Equals<unknown>,
    active: Set<string>,
  ): Promise<unknown> {
    if (hasMemo(this.store, key) && !(await this.depsChanged(key))) {
      markVerified(this.store, key)

      return memoValue(this.store, key)
    }

    return this.run(key, compute, equals, active)
  }

  // run a query body under a fresh child context, backdate against the prior value, and store the memo
  private async run(
    key: string,
    compute: Compute<unknown>,
    equals: Equals<unknown>,
    active: Set<string>,
  ): Promise<unknown> {
    const childActive = new Set(active)
    childActive.add(key)

    const cx = this.makeContext(childActive)
    const value = await compute(cx)
    // backdating is decided by the store: an equal result keeps the old changedAt, so dependents are not invalidated
    const equal = hasMemo(this.store, key) && equals(memoValue(this.store, key), value)

    storeResult(this.store, key, value, equal, cx.frame)
    this.recipes.set(key, { compute, equals })

    return value
  }

  // would this memo's value differ if recomputed? The cheap-to-expensive ladder: durability shortcut, then a walk of
  // recorded dependencies (recomputing a stale derived dep on demand)
  private async depsChanged(key: string): Promise<boolean> {
    if (isUnchangedByDurability(this.store, key)) {
      return false
    }

    const verifiedAt = memoVerifiedAt(this.store, key)

    for (const dep of memoDeps(this.store, key)) {
      if (await this.changedAfter(dep, verifiedAt)) {
        return true
      }
    }

    return false
  }

  // did `key` (an input or a derived query) change after `revision`? Recomputes a stale derived dep on demand.
  private async changedAfter(
    key: string,
    revision: number,
  ): Promise<boolean> {
    if (hasInput(this.store, key)) {
      return inputChangedAfter(this.store, key, revision)
    }

    // unknown dependency: assume changed
    if (!hasMemo(this.store, key)) {
      return true
    }

    if (memoVerifiedAt(this.store, key) !== revisionOf(this.store)) {
      if (await this.depsChanged(key)) {
        const recipe = this.recipes.get(key)!

        await this.resolveKey(key, recipe.compute, recipe.equals, new Set())
      } else {
        markVerified(this.store, key)
      }
    }

    return memoChangedAfter(this.store, key, revision)
  }
}
