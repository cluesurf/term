/**
 * IC3 / PDR (Property Directed Reachability): the modern unbounded
 * safety model-checking algorithm. Where BMC only checks up to depth k
 * and k-induction needs the property to be (nearly) inductive, IC3
 * proves safety for ALL time by incrementally discovering an inductive
 * strengthening of the property - a set of "frames" F_0, F_1, ... where
 * F_i over-approximates the states reachable in at most i steps, each
 * implies safety, and the construction converges when two adjacent
 * frames coincide (an inductive invariant has been found).
 *
 * It works over the same symbolic `System` as bmc.ts (integer state
 * vars, init/trans/safe), discharged by Z3. The loop:
 *   - find a state in the frontier frame that can step to an unsafe
 *     state (a proof obligation);
 *   - recursively block it - prove it is unreachable from the previous
 *     frame, learning a clause (a blocked cube) that strengthens the
 *     frames; if blocking chases the obligation back to an initial
 *     state, that chain IS a counterexample;
 *   - when no frontier obligation remains, push learned clauses forward;
 *     if a frame stops changing, its clauses are an inductive invariant
 *     and the system is SAFE.
 *
 * Cubes are concrete assignments pulled from Z3 models, generalized by
 * dropping literals that stay disjoint from init and unreachable. On
 * infinite (integer) domains termination is not guaranteed in general
 * (the problem is undecidable); an iteration cap returns `unknown`
 * rather than spinning. Needs z3-solver.
 */

type Z3 = any

import type { System, State } from './bmc'
import { bmc } from './bmc'

/** A cube: a partial assignment (variable -> integer value). */
type Cube = Record<string, number>

export type Ic3Result =
  | { safe: true; invariantFrames: number }
  | { safe: false; trace: Record<string, number>[] }
  | { safe: false; unknown: true }

const MAX_FRAMES = 60

function z3Num(term: Z3): number {
  if (term && typeof term.value === 'function') return Number(term.value())
  const text = String(term)
  const neg = text.match(/^\(-\s*(\d+)\)$/)
  return neg ? -Number(neg[1]) : Number(text)
}

/** Run IC3 on a transition system. */
export async function ic3(system: System, z3: Z3): Promise<Ic3Result> {
  const cur: State = {}
  const nxt: State = {}
  for (const v of system.vars) {
    cur[v] = z3.Int.const(`${v}_cur`)
    nxt[v] = z3.Int.const(`${v}_nxt`)
  }

  // a cube as a Z3 formula over a given state
  const cubeOn = (cube: Cube, s: State): Z3 =>
    z3.And(...Object.entries(cube).map(([v, n]) => s[v].eq(z3.Int.val(n))))

  // read a full-state cube out of a model
  const modelCube = (model: Z3, s: State): Cube => {
    const cube: Cube = {}
    for (const v of system.vars) cube[v] = z3Num(model.eval(s[v], true))
    return cube
  }

  // a fresh solver per query keeps the encoding simple and correct
  const sat = async (assertions: Z3[]): Promise<Z3 | null> => {
    const solver = new z3.Solver()
    for (const a of assertions) solver.add(a)
    const status = await solver.check()
    return status === 'sat' ? solver.model() : null
  }

  // frames[i] = clauses (blocked cubes) that hold in frame i. F_i = safe AND
  // (for all k >= i) (not c) for each blocked cube c at level k. F_0 = init.
  const frames: Cube[][] = [[], []]

  // F_i as a formula over state s
  const frameFormula = (i: number, s: State): Z3 => {
    if (i === 0) return system.init(s, z3)
    const parts: Z3[] = [system.safe(s, z3)]
    for (let k = i; k < frames.length; k++) {
      for (const c of frames[k]!) parts.push(z3.Not(cubeOn(c, s)))
    }
    return z3.And(...parts)
  }

  // is a cube disjoint from init? (a generalization may not include init states)
  const disjointFromInit = async (cube: Cube): Promise<boolean> =>
    (await sat([system.init(cur, z3), cubeOn(cube, cur)])) === null

  // generalize a cube to block by dropping literals that keep it both
  // disjoint from init and unreachable from F_{i-1}
  const generalize = async (cube: Cube, i: number): Promise<Cube> => {
    let g: Cube = { ...cube }
    for (const v of Object.keys(cube)) {
      if (Object.keys(g).length <= 1) break
      const trial: Cube = { ...g }
      delete trial[v]
      const stillDisjoint = await disjointFromInit(trial)
      // unreachable from F_{i-1}: no predecessor in F_{i-1} steps into trial
      const reach = await sat([
        frameFormula(i - 1, cur),
        system.trans(cur, nxt, z3),
        cubeOn(trial, nxt),
      ])
      if (stillDisjoint && reach === null) g = trial
    }
    return g
  }

  const addBlocked = (cube: Cube, upto: number): void => {
    for (let j = 1; j <= upto; j++) {
      while (frames.length <= j) frames.push([])
      frames[j]!.push(cube)
    }
  }

  // step 0: does an initial state already violate safety?
  if ((await sat([system.init(cur, z3), z3.Not(system.safe(cur, z3))])) !== null) {
    const trace = await bmc(system, 0, z3)
    return trace.safe ? { safe: false, unknown: true } : trace
  }

  // recursively block a bad cube; false => a real counterexample chain to init
  const blockCube = async (cube0: Cube, level0: number): Promise<boolean> => {
    // a priority queue keyed by level (lowest first)
    const queue: { cube: Cube; level: number }[] = [{ cube: cube0, level: level0 }]
    while (queue.length > 0) {
      queue.sort((a, b) => a.level - b.level)
      const { cube, level } = queue.shift()!
      if (level === 0) return false // chased back to an initial state: CEX

      // is `cube` reachable from F_{level-1} in one step?
      const pred = await sat([
        frameFormula(level - 1, cur),
        system.trans(cur, nxt, z3),
        cubeOn(cube, nxt),
      ])
      if (pred) {
        // a predecessor must itself be blocked first, then retry this cube
        const p = modelCube(pred, cur)
        queue.push({ cube: p, level: level - 1 })
        queue.push({ cube, level })
      } else {
        // unreachable: learn the clause that blocks it (generalized)
        const g = await generalize(cube, level)
        addBlocked(g, level)
      }
    }
    return true
  }

  // main loop: grow the frontier N, blocking and propagating
  for (let N = 1; N < MAX_FRAMES; N++) {
    while (frames.length <= N) frames.push([])

    // drain frontier obligations: a state in F_N that steps to an unsafe state
    for (;;) {
      const bad = await sat([
        frameFormula(N, cur),
        system.trans(cur, nxt, z3),
        z3.Not(system.safe(nxt, z3)),
      ])
      if (!bad) break
      const cube = modelCube(bad, cur)
      const blocked = await blockCube(cube, N)
      if (!blocked) {
        // unsafe: recover a concrete trace with BMC (bounded by the frontier+1)
        for (let k = 1; k <= N + 1; k++) {
          const t = await bmc(system, k, z3)
          if (!t.safe) return t
        }
        return { safe: false, unknown: true }
      }
    }

    // propagation: push each clause forward if it stays inductive
    for (let i = 1; i <= N; i++) {
      while (frames.length <= i + 1) frames.push([])
      for (const c of [...frames[i]!]) {
        const escapes = await sat([
          frameFormula(i, cur),
          system.trans(cur, nxt, z3),
          cubeOn(c, nxt),
        ])
        if (escapes === null && !frames[i + 1]!.some(d => sameCube(d, c))) {
          frames[i + 1]!.push(c)
        }
      }
      // convergence: two adjacent frames have the same clause set => invariant
      if (i >= 1 && sameClauseSet(frames[i]!, frames[i + 1]!)) {
        return { safe: true, invariantFrames: i }
      }
    }
  }

  return { safe: false, unknown: true }
}

function sameCube(a: Cube, b: Cube): boolean {
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every(k => b[k] === a[k])
}

function sameClauseSet(a: Cube[], b: Cube[]): boolean {
  if (a.length !== b.length) return false
  return a.every(c => b.some(d => sameCube(c, d)))
}
