/**
 * CEGAR: Counterexample-Guided Abstraction Refinement (concepts.md).
 * The loop that makes abstraction practical and tames state explosion:
 *
 *   1. abstract the (possibly infinite) concrete system by a set of
 *      predicates - the abstract state is the truth vector of those
 *      predicates, so the abstract state space is finite (2^n).
 *   2. model-check the abstraction (reachability over abstract states).
 *   3. if a bad abstract state is reachable, check whether the abstract
 *      counterexample CONCRETIZES (a real path exists). If yes, it is a
 *      true bug. If no, it is SPURIOUS - caused by too coarse an
 *      abstraction.
 *   4. REFINE: add a predicate that rules the spurious path out, and
 *      repeat.
 *
 * The abstraction's feasibility, edges, and concretization checks are
 * all discharged by Z3. This proves properties of infinite-state
 * systems with a finite abstract model. Needs z3-solver.
 */

type Z3 = any

/** A concrete system over a single integer state variable `x`. */
export type Concrete = {
  init: (x: Z3, z3: Z3) => Z3
  trans: (x: Z3, xn: Z3, z3: Z3) => Z3
  bad: (x: Z3, z3: Z3) => Z3
}

/** A predicate over the state variable (the abstraction's vocabulary). */
export type Predicate = (x: Z3, z3: Z3) => Z3

export type CegarResult =
  | { safe: true; predicatesUsed: number; refinements: number }
  | { safe: false; trace: number[]; predicatesUsed: number }
  | { unknown: true; reason: string }

/** An abstract state: a truth value per predicate. */
type AbsState = boolean[]

function key(a: AbsState): string {
  return a.map(b => (b ? '1' : '0')).join('')
}

/** Run CEGAR. `predicates` is the starting abstraction; `refinements`
 * are candidate predicates to add when a spurious counterexample is
 * found (in a full system these come from interpolants). */
export async function cegar(
  concrete: Concrete,
  predicates: Predicate[],
  refinements: Predicate[],
  z3: Z3,
  maxDepth = 12,
): Promise<CegarResult> {
  let preds = predicates.slice()
  const queue = refinements.slice()
  let refinements_used = 0

  for (;;) {
    const result = await checkAbstraction(concrete, preds, z3, maxDepth)

    if (result.kind === 'safe') {
      return { safe: true, predicatesUsed: preds.length, refinements: refinements_used }
    }

    // a bad abstract state is reachable - is it really reachable in the
    // concrete system? Check by bounded concrete unrolling (the abstract
    // path may be shorter than the concrete one, since abstraction merges
    // intermediate states, so we do not match the path exactly).
    const concrete_trace = await concretize(concrete, maxDepth, z3)
    if (concrete_trace) {
      return { safe: false, trace: concrete_trace, predicatesUsed: preds.length }
    }

    // spurious: refine by adding the next candidate predicate
    if (queue.length === 0) {
      return { unknown: true, reason: 'spurious counterexample and no refinement left' }
    }
    preds.push(queue.shift() as Predicate)
    refinements_used++
  }
}

type AbsResult =
  | { kind: 'safe' }
  | { kind: 'bad'; path: AbsState[] }

/** Build the abstract state graph and check reachability of a bad state. */
async function checkAbstraction(
  concrete: Concrete,
  preds: Predicate[],
  z3: Z3,
  maxDepth: number,
): Promise<AbsResult> {
  const n = preds.length
  // enumerate the feasible abstract states
  const all: AbsState[] = []
  for (let mask = 0; mask < 1 << n; mask++) {
    const a: AbsState = []
    for (let i = 0; i < n; i++) a.push((mask & (1 << i)) !== 0)
    if (await feasible(preds, a, z3)) all.push(a)
  }

  const isInit = new Map<string, boolean>()
  const isBad = new Map<string, boolean>()
  for (const a of all) {
    isInit.set(key(a), await holds(z3, x => z3.And(concrete.init(x, z3), match(preds, a, x, z3))))
    isBad.set(key(a), await holds(z3, x => z3.And(concrete.bad(x, z3), match(preds, a, x, z3))))
  }

  // BFS over abstract states, recording the path
  const start = all.filter(a => isInit.get(key(a)))
  const seen = new Map<string, AbsState[]>()
  const frontier: AbsState[] = []
  for (const a of start) {
    seen.set(key(a), [a])
    frontier.push(a)
  }

  let depth = 0
  while (frontier.length && depth <= maxDepth) {
    const a = frontier.shift() as AbsState
    const path = seen.get(key(a)) as AbsState[]
    if (isBad.get(key(a))) return { kind: 'bad', path }
    for (const b of all) {
      if (seen.has(key(b))) continue
      if (await edge(concrete, preds, a, b, z3)) {
        seen.set(key(b), [...path, b])
        frontier.push(b)
      }
    }
    depth++
  }
  return { kind: 'safe' }
}

/** exists x . predicate-conjunction(a) */
function feasible(preds: Predicate[], a: AbsState, z3: Z3): Promise<boolean> {
  return holds(z3, x => match(preds, a, x, z3))
}

/** The predicate conjunction encoding abstract state `a` on var x. */
function match(preds: Predicate[], a: AbsState, x: Z3, z3: Z3): Z3 {
  let f = z3.Bool.val(true)
  for (let i = 0; i < preds.length; i++) {
    const p = preds[i](x, z3)
    f = z3.And(f, a[i] ? p : z3.Not(p))
  }
  return f
}

/** exists x x' . trans(x,x') /\ match(a,x) /\ match(b,x') */
function edge(concrete: Concrete, preds: Predicate[], a: AbsState, b: AbsState, z3: Z3): Promise<boolean> {
  return holds2(z3, (x, xn) =>
    z3.And(concrete.trans(x, xn, z3), match(preds, a, x, z3), match(preds, b, xn, z3)),
  )
}

/** Is a bad state really reachable in the CONCRETE system within
 * `maxDepth` steps? (Bounded concrete unrolling = BMC on the concrete
 * system.) Returns the shortest concrete trace, or null (the abstract
 * counterexample was spurious up to the bound). */
async function concretize(
  concrete: Concrete,
  maxDepth: number,
  z3: Z3,
): Promise<number[] | null> {
  for (let k = 0; k <= maxDepth; k++) {
    const xs = Array.from({ length: k + 1 }, (_, i) => z3.Int.const(`cx_${i}`))
    const solver = new z3.Solver()
    solver.add(concrete.init(xs[0], z3))
    for (let i = 0; i < k; i++) solver.add(concrete.trans(xs[i], xs[i + 1], z3))
    solver.add(concrete.bad(xs[k], z3))
    if ((await solver.check()) === 'sat') {
      const model = solver.model()
      return xs.map(x => Number(String(model.eval(x, true)).replace(/^\(-\s*(\d+)\)$/, '-$1')))
    }
  }
  return null
}

async function holds(z3: Z3, build: (x: Z3) => Z3): Promise<boolean> {
  const solver = new z3.Solver()
  solver.add(build(z3.Int.const('x')))
  return (await solver.check()) === 'sat'
}

async function holds2(z3: Z3, build: (x: Z3, xn: Z3) => Z3): Promise<boolean> {
  const solver = new z3.Solver()
  solver.add(build(z3.Int.const('x'), z3.Int.const('xn')))
  return (await solver.check()) === 'sat'
}
