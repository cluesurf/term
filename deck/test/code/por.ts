/**
 * Partial-order reduction (POR): the cure for state explosion caused by
 * INTERLEAVING concurrency. When n processes take independent steps, a
 * naive search explores all n! orderings of those steps even though they
 * all reach the same states - the orderings are equivalent (a
 * Mazurkiewicz trace). POR explores only ONE representative ordering per
 * equivalence class, so an exponential interleaving space collapses to a
 * linear one, while preserving the properties being checked.
 *
 * This is the persistent-set / ample-set method (Godefroid, Peled). At
 * each state we expand only a PERSISTENT SET of actions - a subset T of
 * the enabled actions such that anything reachable by going around T is
 * independent of T - plus a cycle PROVISO so a reduction never "ignores"
 * an action forever (the ignoring problem). Independence is derived
 * statically from each action's read / write variable sets: two actions
 * are independent when neither writes a variable the other touches.
 *
 * Pure TypeScript over an explicit state. The companion to the symbolic
 * model checkers (bmc/ic3/ltl) for the concurrent, explicit-state case.
 */

/** An action of one process: when it is enabled, how it fires, and which
 * state variables it reads / writes (for the independence relation). */
export type Action<S> = {
  id: string
  enabled: (s: S) => boolean
  fire: (s: S) => S
  reads: string[]
  writes: string[]
}

export type ConcurrentSystem<S> = {
  init: S
  actions: Action<S>[]
  /** a canonical string key for a state (for the visited set) */
  key: (s: S) => string
}

/** Two actions are independent iff neither writes a variable the other
 * reads or writes. Independent actions commute and cannot enable/disable
 * each other, so their order does not matter. */
export function independent<S>(a: Action<S>, b: Action<S>): boolean {
  const aTouch = new Set([...a.reads, ...a.writes])
  const bTouch = new Set([...b.reads, ...b.writes])
  for (const w of a.writes) if (bTouch.has(w)) return false
  for (const w of b.writes) if (aTouch.has(w)) return false
  return true
}

export type Exploration = {
  /** number of distinct states visited */
  states: number
  /** number of transitions taken */
  transitions: number
  /** whether a state satisfying `bad` was reached */
  badReached: boolean
}

/** Full explicit-state reachability: expand every enabled action. The
 * baseline POR is measured against. */
export function reachFull<S>(system: ConcurrentSystem<S>, bad: (s: S) => boolean): Exploration {
  const seen = new Set<string>()
  const stack: S[] = [system.init]
  seen.add(system.key(system.init))
  let transitions = 0
  let badReached = bad(system.init)

  while (stack.length > 0) {
    const s = stack.pop()!
    for (const a of system.actions) {
      if (!a.enabled(s)) continue
      transitions++
      const t = a.fire(s)
      const k = system.key(t)
      if (!seen.has(k)) {
        seen.add(k)
        if (bad(t)) badReached = true
        stack.push(t)
      }
    }
  }
  return { states: seen.size, transitions, badReached }
}

/**
 * POR reachability via persistent sets with the stack proviso. Explores
 * one representative interleaving per equivalence class; visits far fewer
 * states than `reachFull` while reaching the same `bad` verdict.
 */
export function reachPor<S>(system: ConcurrentSystem<S>, bad: (s: S) => boolean): Exploration {
  const seen = new Set<string>()
  const onStack = new Set<string>()
  let transitions = 0
  let badReached = bad(system.init)

  // DFS so the cycle proviso can check the current path (onStack).
  const dfs = (s: S): void => {
    const k = system.key(s)
    seen.add(k)
    onStack.add(k)

    const enabled = system.actions.filter(a => a.enabled(s))
    const ample = ampleSet(system, s, enabled, onStack)

    for (const a of ample) {
      transitions++
      const t = a.fire(s)
      const tk = system.key(t)
      if (bad(t)) badReached = true
      if (!seen.has(tk)) dfs(t)
    }

    onStack.delete(k)
  }

  dfs(system.init)
  return { states: seen.size, transitions, badReached }
}

/**
 * Choose an ample (persistent) set at state s. A singleton {a} is
 * persistent when `a` is independent of every OTHER enabled action - then
 * deferring the others loses nothing, because they commute with `a` and
 * stay enabled. The stack PROVISO (C3): reject a singleton whose
 * successor is already on the DFS stack while other actions are enabled,
 * to avoid ignoring those others around a cycle. If no safe singleton
 * exists, fall back to the full enabled set (always sound).
 */
function ampleSet<S>(
  system: ConcurrentSystem<S>,
  s: S,
  enabled: Action<S>[],
  onStack: Set<string>,
): Action<S>[] {
  if (enabled.length <= 1) return enabled

  for (const a of enabled) {
    const others = enabled.filter(b => b !== a)
    const allIndep = others.every(b => independent(a, b))
    if (!allIndep) continue

    // proviso: do not close a cycle while ignoring the other enabled actions
    const succKey = system.key(a.fire(s))
    if (onStack.has(succKey)) continue

    return [a]
  }

  // no reducing singleton qualifies: expand everything (sound, no reduction)
  return enabled
}
