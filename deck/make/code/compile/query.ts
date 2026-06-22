// The incremental query engine (Tier 2, the Salsa model), async edition. Every phase becomes a memoized query keyed by
// an interned id; dependencies record themselves automatically; a value that recomputes to the same result does not
// invalidate its dependents (backdating); durability tiers give O(1) validation when only a low-stability input
// changed. This edition is ASYNC and concurrency-safe: a query body runs under an explicit execution context (`Cx`)
// rather than a global frame stack, so many query bodies can be in flight at once (the foundation for parallel
// per-definition compilation). See note/seed/compiler/async-query-engine.md and note/seed/plan/tier-4-parallel-compile.md.

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

type InputCell = {
  value: unknown
  changedAt: number
  durability: Durability
}
type Memo = {
  value: unknown
  changedAt: number
  verifiedAt: number
  deps: string[]
  durability: Durability
  compute: Compute<unknown>
  equals: Equals<unknown>
}
// a query's own dependency frame: the keys it read and the weakest durability among them
type Frame = { deps: Set<string>; durability: Durability }

export class Database {
  private revision = 1
  private readonly inputs = new Map<string, InputCell>()
  private readonly memos = new Map<string, Memo>()
  // the in-flight computation per key, so two concurrent requests for one key share one run (dedup)
  private readonly inFlight = new Map<string, Promise<unknown>>()
  // the last revision at which an input of each durability changed (index by durability). The durability shortcut.
  private readonly lastChanged: [number, number, number] = [0, 0, 0]
  // observability for tests: total query-body executions, and per-key execution counts
  recomputes = 0
  private readonly runCount = new Map<string, number>()

  // how many times a specific query's body has executed (for tests / diagnostics)
  runs(key: string): number {
    return this.runCount.get(key) ?? 0
  }

  // set (or change) an input. Setting it to its current value is a no-op (content-addressed: re-saving identical
  // source invalidates nothing). A real change bumps the global revision and the durability's last-changed marker.
  setInput(
    key: string,
    value: unknown,
    durability: Durability = LOW,
  ): void {
    const existing = this.inputs.get(key)

    if (
      existing &&
      Object.is(existing.value, value) &&
      existing.durability === durability
    ) {
      return
    }

    this.revision += 1
    this.inputs.set(key, {
      value,
      changedAt: this.revision,
      durability,
    })
    this.lastChanged[durability] = this.revision
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
    const frame: Frame = { deps: new Set(), durability: HIGH }
    const db = this

    return {
      frame,
      input<T>(key: string): T {
        const cell = db.inputs.get(key)

        if (!cell) {
          throw new Error(`unknown input: ${key}`)
        }

        frame.deps.add(key)

        if (cell.durability < frame.durability) {
          frame.durability = cell.durability
        }

        return cell.value as T
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
          compute,
          equals as Equals<unknown>,
          active,
        )) as T

        // record `key` as a dependency of THIS query, lowering its durability to the weakest dep
        const memo = db.memos.get(key)!
        frame.deps.add(key)

        if (memo.durability < frame.durability) {
          frame.durability = memo.durability
        }

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
    const memo = this.memos.get(key)

    if (memo?.verifiedAt === this.revision) {
      return Promise.resolve(memo.value)
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
    const memo = this.memos.get(key)

    if (memo && !(await this.depsChanged(memo))) {
      memo.verifiedAt = this.revision

      return memo.value
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
    const previous = this.memos.get(key)
    const childActive = new Set(active)
    childActive.add(key)

    const cx = this.makeContext(childActive)
    const value = await compute(cx)
    this.recomputes += 1
    this.runCount.set(key, (this.runCount.get(key) ?? 0) + 1)

    // backdating: an equal result keeps the old changedAt, so dependents are not invalidated
    const changedAt =
      previous && equals(previous.value, value)
        ? previous.changedAt
        : this.revision

    this.memos.set(key, {
      value,
      changedAt,
      verifiedAt: this.revision,
      deps: [...cx.frame.deps],
      durability: cx.frame.durability,
      compute,
      equals,
    })

    return value
  }

  // would this memo's value differ if recomputed? The cheap-to-expensive ladder: durability shortcut, then a walk of
  // recorded dependencies (recomputing a stale derived dep on demand)
  private async depsChanged(memo: Memo): Promise<boolean> {
    // durability shortcut: if no input of durability >= this memo's changed since it was verified, it cannot have
    // changed. This is the O(1) keystroke case: editing a LOW file never walks a HIGH-durability (stdlib) query.
    let maxChanged = 0

    for (let d = memo.durability; d <= HIGH; d++) {
      maxChanged = Math.max(maxChanged, this.lastChanged[d])
    }

    if (maxChanged <= memo.verifiedAt) {
      return false
    }

    for (const dep of memo.deps) {
      if (await this.changedAfter(dep, memo.verifiedAt)) {
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
    const input = this.inputs.get(key)

    if (input) {
      return input.changedAt > revision
    }

    const memo = this.memos.get(key)

    if (!memo) {
      return true
    } // unknown dependency: assume changed

    if (memo.verifiedAt !== this.revision) {
      if (await this.depsChanged(memo)) {
        await this.resolveKey(key, memo.compute, memo.equals, new Set())
      } else {
        memo.verifiedAt = this.revision
      }
    }

    return this.memos.get(key)!.changedAt > revision
  }
}
