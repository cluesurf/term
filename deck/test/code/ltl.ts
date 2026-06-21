/**
 * LTL model checking by bounded model checking with LASSO detection
 * (Biere-Cimatti-Clarke-Zhu). LTL reasons about a single linear path
 * through time - X (next), F (eventually), G (globally), U (until), R
 * (release) - where CTL branches over successors. The killer case is
 * LIVENESS: a counterexample to "p happens eventually" is an infinite
 * path on which p never happens, and on a finite system every infinite
 * path is eventually periodic - a LASSO (a prefix plus a loop). So we
 * search for a lasso of length <= k that satisfies the NEGATED property;
 * finding one is a counterexample, finding none up to k means the
 * property holds within that bound.
 *
 * Built on the same symbolic `System` as bmc.ts/ic3.ts (init/trans over
 * integer state vars), discharged by Z3. The property is an `Ltl`
 * formula over atomic state predicates. Needs z3-solver.
 */

type Z3 = any

import type { System, State } from './bmc'

/** An atomic predicate over a state: e.g. s => s.x.gt(0). */
export type Atom = (s: State, z3: Z3) => Z3

/** An LTL formula over atoms. */
export type Ltl =
  | { form: 'atom'; atom: Atom }
  | { form: 'not'; arg: Ltl }
  | { form: 'and'; left: Ltl; right: Ltl }
  | { form: 'or'; left: Ltl; right: Ltl }
  | { form: 'next'; arg: Ltl }
  | { form: 'eventually'; arg: Ltl } // F
  | { form: 'globally'; arg: Ltl } // G
  | { form: 'until'; left: Ltl; right: Ltl }
  | { form: 'release'; left: Ltl; right: Ltl }

// constructors
export const atom = (a: Atom): Ltl => ({ form: 'atom', atom: a })
export const not = (arg: Ltl): Ltl => ({ form: 'not', arg })
export const and = (left: Ltl, right: Ltl): Ltl => ({ form: 'and', left, right })
export const or = (left: Ltl, right: Ltl): Ltl => ({ form: 'or', left, right })
export const next = (arg: Ltl): Ltl => ({ form: 'next', arg })
export const eventually = (arg: Ltl): Ltl => ({ form: 'eventually', arg })
export const globally = (arg: Ltl): Ltl => ({ form: 'globally', arg })
export const until = (left: Ltl, right: Ltl): Ltl => ({ form: 'until', left, right })
export const release = (left: Ltl, right: Ltl): Ltl => ({ form: 'release', left, right })

/** Push negations to atoms (negation normal form), so the encoders only
 * ever see `not` wrapping an atom. Uses LTL dualities:
 *   !X = X!,  !F = G!,  !G = F!,  !(a U b) = (!a R !b),  !(a R b) = (!a U !b). */
export function nnf(f: Ltl): Ltl {
  switch (f.form) {
    case 'atom': return f
    case 'and': return { form: 'and', left: nnf(f.left), right: nnf(f.right) }
    case 'or': return { form: 'or', left: nnf(f.left), right: nnf(f.right) }
    case 'next': return { form: 'next', arg: nnf(f.arg) }
    case 'eventually': return { form: 'eventually', arg: nnf(f.arg) }
    case 'globally': return { form: 'globally', arg: nnf(f.arg) }
    case 'until': return { form: 'until', left: nnf(f.left), right: nnf(f.right) }
    case 'release': return { form: 'release', left: nnf(f.left), right: nnf(f.right) }
    case 'not': {
      const g = f.arg
      switch (g.form) {
        case 'atom': return f // negation on an atom stays
        case 'not': return nnf(g.arg) // double negation
        case 'and': return { form: 'or', left: nnf({ form: 'not', arg: g.left }), right: nnf({ form: 'not', arg: g.right }) }
        case 'or': return { form: 'and', left: nnf({ form: 'not', arg: g.left }), right: nnf({ form: 'not', arg: g.right }) }
        case 'next': return { form: 'next', arg: nnf({ form: 'not', arg: g.arg }) }
        case 'eventually': return { form: 'globally', arg: nnf({ form: 'not', arg: g.arg }) }
        case 'globally': return { form: 'eventually', arg: nnf({ form: 'not', arg: g.arg }) }
        case 'until': return { form: 'release', left: nnf({ form: 'not', arg: g.left }), right: nnf({ form: 'not', arg: g.right }) }
        case 'release': return { form: 'until', left: nnf({ form: 'not', arg: g.left }), right: nnf({ form: 'not', arg: g.right }) }
      }
    }
  }
}

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

export type LtlResult =
  | { holds: true; depth: number }
  | { holds: false; trace: Record<string, number>[]; loopStart: number }

/**
 * Check an LTL property of a system up to bound k. Searches for a
 * counterexample: a path (optionally a lasso looping back at some l) that
 * satisfies the NEGATION of the property. None found -> the property
 * holds within k. Found -> the counterexample trace, with `loopStart`
 * the index the path loops back to (-1 for a finite safety prefix).
 */
export async function ltlCheck(input: { system: System; property: Ltl; k: number; z3: Z3 }): Promise<LtlResult> {
  const { system, k, z3 } = input
  const neg = nnf({ form: 'not', arg: input.property })

  const states: State[] = []
  for (let i = 0; i <= k; i++) states.push(makeState(system, i, z3))

  const solver = new z3.Solver()
  // the path is a real run of the system
  solver.add(system.init(states[0]!, z3))
  for (let i = 0; i < k; i++) solver.add(system.trans(states[i]!, states[i + 1]!, z3))

  // loop selectors: loop_l means the path loops from s_k back to s_l
  const loop: Z3[] = []
  for (let l = 0; l <= k; l++) loop.push(z3.Bool.const(`__loop_${l}`))
  // at most one loop selector, and it must be a real back-edge
  for (let l = 0; l <= k; l++) {
    solver.add(z3.Implies(loop[l]!, system.trans(states[k]!, states[l]!, z3)))
  }
  for (let a = 0; a <= k; a++) {
    for (let b = a + 1; b <= k; b++) {
      solver.add(z3.Or(z3.Not(loop[a]!), z3.Not(loop[b]!)))
    }
  }
  const hasLoop = z3.Or(...loop)

  // bounded semantics. noLoop[f][i] for a finite prefix; withLoop[l][f][i]
  // for an infinite lasso looping at l. Memoized per (formula-id, index).
  const id = formulaIds(neg)

  const noLoopMemo = new Map<string, Z3>()
  const noLoopSem = (f: Ltl, i: number): Z3 => {
    const key = `${id.get(f)}@${i}`
    const hit = noLoopMemo.get(key)
    if (hit !== undefined) return hit
    const r = noLoopCompute(f, i)
    noLoopMemo.set(key, r)
    return r
  }
  const noLoopCompute = (f: Ltl, i: number): Z3 => {
    switch (f.form) {
      case 'atom': return f.atom(states[i]!, z3)
      case 'not': return z3.Not((f.arg as { form: 'atom'; atom: Atom }).atom(states[i]!, z3)) // NNF: arg is an atom
      case 'and': return z3.And(noLoopSem(f.left, i), noLoopSem(f.right, i))
      case 'or': return z3.Or(noLoopSem(f.left, i), noLoopSem(f.right, i))
      case 'next': return i < k ? noLoopSem(f.arg, i + 1) : z3.Bool.val(false)
      case 'eventually': {
        const terms: Z3[] = []
        for (let j = i; j <= k; j++) terms.push(noLoopSem(f.arg, j))
        return z3.Or(...terms)
      }
      case 'globally': return z3.Bool.val(false) // can't witness G on a finite prefix
      case 'until': {
        const terms: Z3[] = []
        for (let j = i; j <= k; j++) {
          const conj: Z3[] = [noLoopSem(f.right, j)]
          for (let n = i; n < j; n++) conj.push(noLoopSem(f.left, n))
          terms.push(z3.And(...conj))
        }
        return z3.Or(...terms)
      }
      case 'release': {
        // finite: release holds only if left releases within the bound
        const terms: Z3[] = []
        for (let j = i; j <= k; j++) {
          const conj: Z3[] = [noLoopSem(f.left, j)]
          for (let n = i; n <= j; n++) conj.push(noLoopSem(f.right, n))
          terms.push(z3.And(...conj))
        }
        return z3.Or(...terms)
      }
    }
  }

  const succ = (i: number, l: number): number => (i < k ? i + 1 : l)
  const withLoopMemo = new Map<string, Z3>()
  const withLoopSem = (l: number, f: Ltl, i: number): Z3 => {
    const key = `${l}:${id.get(f)}@${i}`
    const hit = withLoopMemo.get(key)
    if (hit !== undefined) return hit
    // place a guard so recursion around the loop terminates: seed with a
    // boolean const, then solve the fixpoint by substitution-free unrolling.
    const r = withLoopCompute(l, f, i)
    withLoopMemo.set(key, r)
    return r
  }
  const withLoopCompute = (l: number, f: Ltl, i: number): Z3 => {
    switch (f.form) {
      case 'atom': return f.atom(states[i]!, z3)
      case 'not': return z3.Not((f.arg as { form: 'atom'; atom: Atom }).atom(states[i]!, z3))
      case 'and': return z3.And(withLoopSem(l, f.left, i), withLoopSem(l, f.right, i))
      case 'or': return z3.Or(withLoopSem(l, f.left, i), withLoopSem(l, f.right, i))
      case 'next': return withLoopSem(l, f.arg, succ(i, l))
      case 'eventually': {
        // over the loop, F phi = OR over all states in min(i,l)..k
        const lo = Math.min(i, l)
        const terms: Z3[] = []
        for (let j = lo; j <= k; j++) terms.push(withLoopSem(l, f.arg, j))
        return z3.Or(...terms)
      }
      case 'globally': {
        const lo = Math.min(i, l)
        const terms: Z3[] = []
        for (let j = lo; j <= k; j++) terms.push(withLoopSem(l, f.arg, j))
        return z3.And(...terms)
      }
      case 'until': {
        // unbounded until over a lasso: phi U psi holds at i iff psi holds at
        // some reachable j (going forward, wrapping once through the loop) with
        // phi at all positions before it. Unroll once around the loop.
        return unrollUntil(l, f.left, f.right, i, false)
      }
      case 'release': {
        return unrollRelease(l, f.left, f.right, i, false)
      }
    }
  }

  // a single pass around the lasso is enough to decide U/R on an eventually-
  // periodic path: visit i, i+1, ..., k, l, l+1, ..., i (each index once).
  const lassoOrder = (l: number, i: number): number[] => {
    const order: number[] = []
    let cur = i
    const seen = new Set<number>()
    while (!seen.has(cur)) {
      order.push(cur)
      seen.add(cur)
      cur = succ(cur, l)
    }
    return order
  }
  function unrollUntil(l: number, left: Ltl, right: Ltl, i: number, _w: boolean): Z3 {
    const order = lassoOrder(l, i)
    const terms: Z3[] = []
    for (let idx = 0; idx < order.length; idx++) {
      const conj: Z3[] = [withLoopSem(l, right, order[idx]!)]
      for (let p = 0; p < idx; p++) conj.push(withLoopSem(l, left, order[p]!))
      terms.push(z3.And(...conj))
    }
    return z3.Or(...terms)
  }
  function unrollRelease(l: number, left: Ltl, right: Ltl, i: number, _w: boolean): Z3 {
    // R = psi holds always, unless released by phi. Over the lasso: psi at
    // every position, OR (psi up to and including some j where phi holds).
    const order = lassoOrder(l, i)
    const always: Z3[] = order.map(j => withLoopSem(l, right, j))
    const released: Z3[] = []
    for (let idx = 0; idx < order.length; idx++) {
      const conj: Z3[] = [withLoopSem(l, left, order[idx]!)]
      for (let p = 0; p <= idx; p++) conj.push(withLoopSem(l, right, order[p]!))
      released.push(z3.And(...conj))
    }
    return z3.Or(z3.And(...always), z3.Or(...released))
  }

  // the counterexample exists iff: (no loop AND neg holds on the prefix) OR
  // (some loop l AND neg holds on that lasso)
  const noLoopCase = z3.And(z3.Not(hasLoop), noLoopSem(neg, 0))
  const loopCases: Z3[] = []
  for (let l = 0; l <= k; l++) loopCases.push(z3.And(loop[l]!, withLoopSem(l, neg, 0)))
  solver.add(z3.Or(noLoopCase, ...loopCases))

  const status = await solver.check()
  if (status !== 'sat') return { holds: true, depth: k }

  const model = solver.model()
  const trace = states.map(s => {
    const row: Record<string, number> = {}
    for (const v of system.vars) row[v] = z3Num(model.eval(s[v]!, true))
    return row
  })
  let loopStart = -1
  for (let l = 0; l <= k; l++) {
    if (String(model.eval(loop[l]!, true)) === 'true') { loopStart = l; break }
  }
  return { holds: false, trace, loopStart }
}

// assign a stable id to each distinct subformula node (for memo keys)
function formulaIds(root: Ltl): Map<Ltl, number> {
  const ids = new Map<Ltl, number>()
  let n = 0
  const visit = (f: Ltl): void => {
    if (ids.has(f)) return
    ids.set(f, n++)
    switch (f.form) {
      case 'atom': break
      case 'not': visit(f.arg); break
      case 'next': case 'eventually': case 'globally': visit(f.arg); break
      case 'and': case 'or': case 'until': case 'release': visit(f.left); visit(f.right); break
    }
  }
  visit(root)
  return ids
}
