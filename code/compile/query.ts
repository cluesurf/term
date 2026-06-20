// The incremental query engine (Tier 2, the Salsa model). The foundation for an incremental compiler: every phase
// becomes a memoized query keyed by an interned id, dependencies record themselves automatically, and a value that
// recomputes to the same result does not invalidate its dependents (backdating). Durability tiers give O(1)
// validation when only a low-stability input (the edited buffer) changed. Pure and self-contained: not yet wired into
// the compiler, so it cannot affect existing behavior. See note/research/repo/salsa/ and note/seed/plan/compilation-performance.md (Tier 2).

// durability tiers: LOW = the edited buffer, MEDIUM = other project files, HIGH = the stdlib (rarely changes).
export const LOW = 0
export const MEDIUM = 1
export const HIGH = 2
export type Durability = 0 | 1 | 2

type InputCell = {
  value: unknown
  changedAt: number
  durability: Durability
}
type Memo = {
  value: unknown
  changedAt: number
  verifiedAt: number
  deps: Array<string>
  durability: Durability
  compute: () => unknown
  equals: (a: unknown, b: unknown) => boolean
}
type Frame = { deps: Set<string>; durability: Durability }

export class Database {
  private revision = 1
  private readonly inputs = new Map<string, InputCell>()
  private readonly memos = new Map<string, Memo>()
  // the last revision at which an input of each durability changed (index by durability). The durability shortcut.
  private readonly lastChanged: [number, number, number] = [0, 0, 0]
  private readonly stack: Array<Frame> = []
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
    )
      return
    this.revision += 1
    this.inputs.set(key, { value, changedAt: this.revision, durability })
    this.lastChanged[durability] = this.revision
  }

  // read an input, recording it as a dependency of the running query
  input<T>(key: string): T {
    const cell = this.inputs.get(key)
    if (!cell) throw new Error(`unknown input: ${key}`)
    this.record(key, cell.durability)
    return cell.value as T
  }

  // a memoized query. `compute` reads inputs / other queries (recording deps automatically). `equals` enables
  // backdating: if a recompute yields an equal value, dependents stay valid. Default identity equality.
  query<T>(
    key: string,
    compute: () => T,
    equals: (a: T, b: T) => boolean = Object.is,
  ): T {
    const value = this.fetch(
      key,
      compute as () => unknown,
      equals as (a: unknown, b: unknown) => boolean,
    )
    this.record(key, this.memos.get(key)!.durability)
    return value as T
  }

  // record `key` as a dependency of the currently-running query, lowering that query's durability to its weakest dep
  private record(key: string, durability: Durability): void {
    const top = this.stack[this.stack.length - 1]
    if (top) {
      top.deps.add(key)
      if (durability < top.durability) top.durability = durability
    }
  }

  // return the current value of a query, verifying or recomputing as needed
  private fetch(
    key: string,
    compute: () => unknown,
    equals: (a: unknown, b: unknown) => boolean,
  ): unknown {
    const memo = this.memos.get(key)
    if (memo) {
      if (memo.verifiedAt === this.revision) return memo.value
      if (!this.depsChanged(memo)) {
        memo.verifiedAt = this.revision
        return memo.value
      }
    }
    return this.evaluate(key, compute, equals)
  }

  // run a query body under a fresh dependency frame, backdate against the prior value, and store the memo
  private evaluate(
    key: string,
    compute: () => unknown,
    equals: (a: unknown, b: unknown) => boolean,
  ): unknown {
    const previous = this.memos.get(key)
    const frame: Frame = { deps: new Set(), durability: HIGH }
    this.stack.push(frame)
    let value: unknown
    try {
      value = compute()
    } finally {
      this.stack.pop()
    }
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
      deps: [...frame.deps],
      durability: frame.durability,
      compute,
      equals,
    })
    return value
  }

  // would this memo's value differ if recomputed? The cheap-to-expensive ladder: durability shortcut, then a walk of
  // recorded dependencies (recomputing them on demand)
  private depsChanged(memo: Memo): boolean {
    // durability shortcut: if no input of durability >= this memo's changed since it was verified, it cannot have
    // changed. This is the O(1) keystroke case: editing a LOW file never walks a HIGH-durability (stdlib) query.
    let maxChanged = 0
    for (let d = memo.durability; d <= HIGH; d++)
      maxChanged = Math.max(maxChanged, this.lastChanged[d])
    if (maxChanged <= memo.verifiedAt) return false
    for (const dep of memo.deps)
      if (this.changedAfter(dep, memo.verifiedAt)) return true
    return false
  }

  // did `key` (an input or a derived query) change after `revision`? Recomputes a stale derived dep on demand.
  private changedAfter(key: string, revision: number): boolean {
    const input = this.inputs.get(key)
    if (input) return input.changedAt > revision
    const memo = this.memos.get(key)
    if (!memo) return true // unknown dependency: assume changed
    if (memo.verifiedAt !== this.revision) {
      if (this.depsChanged(memo)) this.evaluate(key, memo.compute, memo.equals)
      else memo.verifiedAt = this.revision
    }
    return this.memos.get(key)!.changedAt > revision
  }
}
