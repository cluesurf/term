/**
 * Real automated symbolic model checking: bounded model checking (BMC)
 * and k-induction over a transition system, discharged by Z3. This is
 * the genuine article from concepts.md - NOT the input-domain
 * enumeration in prove.ts, but a state machine whose transition
 * relation is unrolled symbolically into SMT.
 *
 *   - bmc: unroll the transition relation k steps and ask Z3 whether a
 *     reachable state violates the safety property. SAT -> a concrete
 *     counterexample TRACE (the exact path to the bad state). UNSAT ->
 *     safe within k steps.
 *   - kInduction: prove safety for ALL steps (unbounded) with two SMT
 *     queries - the base case and the inductive step.
 *
 * "Symbolic" because Z3 reasons over sets of states as formulas, not by
 * enumerating them - the cure for state explosion (concepts.md). Needs
 * z3-solver.
 */

type Z3 = any

/** A state: each variable name bound to a Z3 integer term. */
export type State = Record<string, Z3>

/** A symbolic transition system over integer state variables. */
export type System = {
  /** State variable names. */
  vars: string[]
  /** Initial-state predicate. */
  init: (s: State, z3: Z3) => Z3
  /** Transition relation: current state s -> next state sn. */
  trans: (s: State, sn: State, z3: Z3) => Z3
  /** Safety property: must hold in every reachable state. */
  safe: (s: State, z3: Z3) => Z3
}

/** Make a fresh state (one Z3 Int const per variable) tagged by step. */
function makeState(system: System, step: number, z3: Z3): State {
  const s: State = {}
  for (const v of system.vars) s[v] = z3.Int.const(`${v}_${step}`)
  return s
}

function z3Num(term: Z3): number {
  if (term && typeof term.value === 'function') return Number(term.value())
  const text = String(term)
  const neg = text.match(/^\(-\s*(\d+)\)$/)
  return neg ? -Number(neg[1]) : Number(text)
}

export type BmcResult =
  | { safe: true; depth: number }
  | { safe: false; trace: Record<string, number>[] }

/**
 * Bounded model checking: is there a path of length <= k from an
 * initial state to a state violating `safe`? Returns the counterexample
 * trace, or "safe within k".
 */
export async function bmc(system: System, k: number, z3: Z3): Promise<BmcResult> {
  const steps: State[] = []
  for (let i = 0; i <= k; i++) steps.push(makeState(system, i, z3))

  const solver = new z3.Solver()
  solver.add(system.init(steps[0], z3))
  for (let i = 0; i < k; i++) solver.add(system.trans(steps[i], steps[i + 1], z3))
  // a violation at SOME step along the path
  solver.add(z3.Or(...steps.map(s => z3.Not(system.safe(s, z3)))))

  const status = await solver.check()
  if (status === 'unsat') return { safe: true, depth: k }

  const model = solver.model()
  const trace = steps.map(s => {
    const row: Record<string, number> = {}
    for (const v of system.vars) row[v] = z3Num(model.eval(s[v], true))
    return row
  })
  return { safe: false, trace }
}

export type InductionResult =
  | { proven: true }
  | { proven: false; reason: 'base' | 'step' }

/**
 * k-induction: prove `safe` holds in ALL reachable states (unbounded).
 *   base: no violation reachable within k steps from init.
 *   step: if k+1 consecutive states are safe and connected by trans,
 *         the next is safe too.
 * Both are single Z3 queries. If both hold, safety is proven for all time.
 */
export async function kInduction(system: System, k: number, z3: Z3): Promise<InductionResult> {
  // base case: bmc up to k from init must be safe
  const base = await bmc(system, k, z3)
  if (!base.safe) return { proven: false, reason: 'base' }

  // step case: a path s0..s_{k+1} where s0..sk are safe and connected,
  // but s_{k+1} is unsafe -> if UNSAT, the property is inductive.
  const steps: State[] = []
  for (let i = 0; i <= k + 1; i++) steps.push(makeState(system, i, z3))

  const solver = new z3.Solver()
  for (let i = 0; i <= k; i++) solver.add(system.safe(steps[i], z3))
  for (let i = 0; i <= k; i++) solver.add(system.trans(steps[i], steps[i + 1], z3))
  solver.add(z3.Not(system.safe(steps[k + 1], z3)))

  const status = await solver.check()
  if (status === 'unsat') return { proven: true }
  return { proven: false, reason: 'step' }
}
