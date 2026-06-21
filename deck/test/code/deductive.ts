/**
 * Deductive verification of imperative algorithms: prove FULL functional
 * correctness, not just "no counterexample up to a bound". This is the
 * Dafny / Why3 / Frama-C WP family (formal-methods-landscape.md #4),
 * native to the Seed verification stack and discharged by Z3.
 *
 * You give a procedure as a small imperative intermediate language
 * (assignments, sequencing, if, while) annotated with a precondition
 * (`requires`), a postcondition (`ensures`), a loop INVARIANT, and a
 * loop VARIANT (a decreasing measure proving termination). The engine
 * computes verification conditions by a weakest-precondition calculus
 * and proves each with the solver. If every VC holds, the procedure
 * meets its spec for ALL inputs and terminates.
 *
 * The verification conditions for a `while c invariant I variant V do B`:
 *   1. the precondition establishes the invariant     (requires => I)
 *   2. the invariant is preserved by the body          (I & c => wp(B, I))
 *   3. the invariant + exit gives the postcondition     (I & !c => ensures)
 *   4. the variant is non-negative while looping        (I & c => V >= 0)
 *   5. the body strictly decreases the variant          (I & c => wp(B, V < V0))
 *
 * Integer state only (the decidable linear-integer fragment), which is
 * exactly where this is automatic. Needs z3-solver.
 */

type Z3 = any

// ---- the expression language (pure, over integer/boolean program vars) ----

export type AExpr =
  | { form: 'lit'; value: number }
  | { form: 'var'; name: string }
  | { form: 'add'; left: AExpr; right: AExpr }
  | { form: 'sub'; left: AExpr; right: AExpr }
  | { form: 'mul'; left: AExpr; right: AExpr }
  | { form: 'neg'; arg: AExpr }

export type BExpr =
  | { form: 'true' }
  | { form: 'false' }
  | { form: 'le'; left: AExpr; right: AExpr }
  | { form: 'lt'; left: AExpr; right: AExpr }
  | { form: 'ge'; left: AExpr; right: AExpr }
  | { form: 'gt'; left: AExpr; right: AExpr }
  | { form: 'eq'; left: AExpr; right: AExpr }
  | { form: 'and'; left: BExpr; right: BExpr }
  | { form: 'or'; left: BExpr; right: BExpr }
  | { form: 'not'; arg: BExpr }
  | { form: 'implies'; left: BExpr; right: BExpr }

// ---- the statement language ----

export type Stmt =
  | { form: 'skip' }
  | { form: 'assign'; name: string; value: AExpr }
  | { form: 'seq'; first: Stmt; second: Stmt }
  | { form: 'if'; cond: BExpr; then: Stmt; else: Stmt }
  | {
      form: 'while'
      cond: BExpr
      invariant: BExpr
      variant: AExpr // a non-negative measure that strictly decreases
      body: Stmt
    }

export type Procedure = {
  name: string
  // program variables (all integers)
  vars: string[]
  requires: BExpr
  ensures: BExpr
  body: Stmt
}

// ---- substitution: P[name := value] over expressions ----

function substA(e: AExpr, name: string, value: AExpr): AExpr {
  switch (e.form) {
    case 'lit': return e
    case 'var': return e.name === name ? value : e
    case 'add': return { form: 'add', left: substA(e.left, name, value), right: substA(e.right, name, value) }
    case 'sub': return { form: 'sub', left: substA(e.left, name, value), right: substA(e.right, name, value) }
    case 'mul': return { form: 'mul', left: substA(e.left, name, value), right: substA(e.right, name, value) }
    case 'neg': return { form: 'neg', arg: substA(e.arg, name, value) }
  }
}

function substB(b: BExpr, name: string, value: AExpr): BExpr {
  switch (b.form) {
    case 'true': case 'false': return b
    case 'le': case 'lt': case 'ge': case 'gt': case 'eq':
      return { form: b.form, left: substA(b.left, name, value), right: substA(b.right, name, value) }
    case 'and': case 'or': case 'implies':
      return { form: b.form, left: substB(b.left, name, value), right: substB(b.right, name, value) }
    case 'not': return { form: 'not', arg: substB(b.arg, name, value) }
  }
}

// ---- weakest precondition + verification conditions ----

/**
 * Compute wp(stmt, post) and collect the side verification conditions
 * (the loop obligations, which wp cannot fold into a single formula).
 * The returned `wp` is what must hold before `stmt` for `post` to hold
 * after; `vcs` are the extra goals that must each be valid.
 */
export function wp(stmt: Stmt, post: BExpr): { wp: BExpr; vcs: BExpr[] } {
  switch (stmt.form) {
    case 'skip':
      return { wp: post, vcs: [] }

    case 'assign':
      // wp(x := e, P) = P[x := e]
      return { wp: substB(post, stmt.name, stmt.value), vcs: [] }

    case 'seq': {
      // wp(S1; S2, P) = wp(S1, wp(S2, P))
      const second = wp(stmt.second, post)
      const first = wp(stmt.first, second.wp)
      return { wp: first.wp, vcs: [...first.vcs, ...second.vcs] }
    }

    case 'if': {
      // wp(if c then S1 else S2, P) = (c => wp(S1,P)) & (!c => wp(S2,P))
      const t = wp(stmt.then, post)
      const e = wp(stmt.else, post)
      return {
        wp: and(implies(stmt.cond, t.wp), implies(not(stmt.cond), e.wp)),
        vcs: [...t.vcs, ...e.vcs],
      }
    }

    case 'while': {
      // the invariant must hold before the loop (wp = invariant); the
      // standard loop VCs become side conditions.
      const I = stmt.invariant
      const c = stmt.cond
      const V = stmt.variant
      const bodyKeepsI = wp(stmt.body, I)

      // freeze the variant's value before the body as V0, then require V<V0 after
      const V0 = freshVar(stmt)
      const bodyDecreases = wp(stmt.body, lt(V, { form: 'var', name: V0 }))

      const vcs: BExpr[] = [
        // invariant preserved by the body
        implies(and(I, c), bodyKeepsI.wp),
        // invariant + exit condition implies the postcondition
        implies(and(I, not(c)), post),
        // variant non-negative while looping
        implies(and(I, c), ge(V, lit(0))),
        // variant strictly decreases (with V0 bound to the pre-body value)
        implies(and(and(I, c), eq({ form: 'var', name: V0 }, V)), bodyDecreases.wp),
        ...bodyKeepsI.vcs,
        ...bodyDecreases.vcs,
      ]
      return { wp: I, vcs }
    }
  }
}

// a deterministic fresh name for a loop's frozen variant value
function freshVar(stmt: Stmt): string {
  return `__v0_${hashStmt(stmt)}`
}

let stmtCounter = 0
const stmtIds = new WeakMap<object, number>()
function hashStmt(stmt: Stmt): number {
  let id = stmtIds.get(stmt)
  if (id === undefined) {
    id = stmtCounter++
    stmtIds.set(stmt, id)
  }
  return id
}

// ---- the full procedure obligations ----

/** All verification conditions for a procedure: requires => wp(body, ensures),
 * plus every loop side condition. Each must be valid for the procedure to
 * be correct. */
export function vcsFor(proc: Procedure): BExpr[] {
  const main = wp(proc.body, proc.ensures)
  return [implies(proc.requires, main.wp), ...main.vcs]
}

// ---- discharge with Z3 ----

function aToZ3(e: AExpr, env: Record<string, Z3>, z3: Z3): Z3 {
  switch (e.form) {
    case 'lit': return z3.Int.val(e.value)
    case 'var': return env[e.name] ?? (env[e.name] = z3.Int.const(e.name))
    case 'add': return aToZ3(e.left, env, z3).add(aToZ3(e.right, env, z3))
    case 'sub': return aToZ3(e.left, env, z3).sub(aToZ3(e.right, env, z3))
    case 'mul': return aToZ3(e.left, env, z3).mul(aToZ3(e.right, env, z3))
    case 'neg': return aToZ3(e.arg, env, z3).neg()
  }
}

function bToZ3(b: BExpr, env: Record<string, Z3>, z3: Z3): Z3 {
  switch (b.form) {
    case 'true': return z3.Bool.val(true)
    case 'false': return z3.Bool.val(false)
    case 'le': return aToZ3(b.left, env, z3).le(aToZ3(b.right, env, z3))
    case 'lt': return aToZ3(b.left, env, z3).lt(aToZ3(b.right, env, z3))
    case 'ge': return aToZ3(b.left, env, z3).ge(aToZ3(b.right, env, z3))
    case 'gt': return aToZ3(b.left, env, z3).gt(aToZ3(b.right, env, z3))
    case 'eq': return aToZ3(b.left, env, z3).eq(aToZ3(b.right, env, z3))
    case 'and': return z3.And(bToZ3(b.left, env, z3), bToZ3(b.right, env, z3))
    case 'or': return z3.Or(bToZ3(b.left, env, z3), bToZ3(b.right, env, z3))
    case 'not': return z3.Not(bToZ3(b.arg, env, z3))
    case 'implies': return z3.Implies(bToZ3(b.left, env, z3), bToZ3(b.right, env, z3))
  }
}

export type VerifyResult =
  | { verified: true; conditions: number }
  | { verified: false; failedCondition: number; total: number }
  | { verified: false; unknown: true }

/**
 * Verify a procedure: prove every verification condition valid (its
 * negation unsatisfiable) with Z3. If all hold, the procedure satisfies
 * its contract for all inputs and terminates.
 */
export async function verifyProcedure(proc: Procedure, z3: Z3): Promise<VerifyResult> {
  const conditions = vcsFor(proc)

  for (let i = 0; i < conditions.length; i++) {
    const env: Record<string, Z3> = {}
    const solver = new z3.Solver()
    // a condition is valid iff its negation is unsatisfiable
    solver.add(z3.Not(bToZ3(conditions[i]!, env, z3)))
    const status = await solver.check()
    if (status === 'sat') return { verified: false, failedCondition: i, total: conditions.length }
    if (status === 'unknown') return { verified: false, unknown: true }
  }

  return { verified: true, conditions: conditions.length }
}

// ---- tiny constructors so callers read like math ----

export const lit = (value: number): AExpr => ({ form: 'lit', value })
export const v = (name: string): AExpr => ({ form: 'var', name })
export const add = (left: AExpr, right: AExpr): AExpr => ({ form: 'add', left, right })
export const sub = (left: AExpr, right: AExpr): AExpr => ({ form: 'sub', left, right })
export const mul = (left: AExpr, right: AExpr): AExpr => ({ form: 'mul', left, right })

export const tt: BExpr = { form: 'true' }
export const le = (left: AExpr, right: AExpr): BExpr => ({ form: 'le', left, right })
export const lt = (left: AExpr, right: AExpr): BExpr => ({ form: 'lt', left, right })
export const ge = (left: AExpr, right: AExpr): BExpr => ({ form: 'ge', left, right })
export const gt = (left: AExpr, right: AExpr): BExpr => ({ form: 'gt', left, right })
export const eq = (left: AExpr, right: AExpr): BExpr => ({ form: 'eq', left, right })
export const and = (left: BExpr, right: BExpr): BExpr => ({ form: 'and', left, right })
export const or = (left: BExpr, right: BExpr): BExpr => ({ form: 'or', left, right })
export const not = (arg: BExpr): BExpr => ({ form: 'not', arg })
export const implies = (left: BExpr, right: BExpr): BExpr => ({ form: 'implies', left, right })

export const skip: Stmt = { form: 'skip' }
export const assign = (name: string, value: AExpr): Stmt => ({ form: 'assign', name, value })
export const seq = (...stmts: Stmt[]): Stmt =>
  stmts.reduce((first, second) => ({ form: 'seq', first, second }))
export const ifThenElse = (cond: BExpr, then: Stmt, els: Stmt): Stmt => ({ form: 'if', cond, then, else: els })
export const whileLoop = (input: {
  cond: BExpr
  invariant: BExpr
  variant: AExpr
  body: Stmt
}): Stmt => ({ form: 'while', ...input })
