// Symbolic Peano induction -- the `fold` tactic. Proves a goal `L(n) == R(n)` for ALL n by base case and inductive
// step, using the recurrence of a single recursive function f that appears in the goal, entirely at the
// commutative-ring level. It never asks the kernel to COMPUTE f (the opaque number model blocks that); it reasons
// symbolically about f's recurrence. Sound: it is exactly Peano induction, with the base and the step each discharged
// by the ring normalizer.
//
//   base : substitute n := 0 and f(0) := f's zero branch. Ring-check L(0) == R(0).
//   step : substitute n := k+1 and f(k+1) := f's otherwise branch (whose recursive call f((k+1)-1) is f(k)). Abstract
//          f(k) as a fresh variable S. With the induction hypothesis L(k) == R(k) (same S), the step holds when
//          (L(k+1) - R(k+1)) equals (L(k) - R(k)) as polynomials -- then the step's difference IS the hypothesis's
//          difference, which is zero. Ring-check (L(k+1)-R(k+1)) == (L(k)-R(k)). (This is the m = 1 certificate of
//          ideal membership: sound, and complete for accumulator recurrences like sums.)

import type {
  Expression,
  Program,
  Statement,
} from '@term/make/code/compile/node'
import type { Span } from '@term/make/code/parser/diagnostic'
import { ringEqual } from '@term/make/code/check/ring'
import type { Fact, Polynomial } from '@term/make/code/check/product'
import { multiply as multiplyPolynomial, productProves, rational } from '@term/make/code/check/product'

type Fn = Extract<Statement, { form: 'function' }>
type Binary = Extract<Expression, { form: 'binary' }>

const intE = (value: number, span: Span): Expression => ({
  form: 'integer',
  value,
  span,
})

const varE = (name: string, span: Span): Expression => ({
  form: 'variable',
  name,
  span,
})

const binE = (
  op: Binary['op'],
  left: Expression,
  right: Expression,
  span: Span,
): Expression => ({ form: 'binary', op, left, right, span })

// substitute a variable everywhere in an expression
function subst(
  e: Expression,
  name: string,
  repl: Expression,
): Expression {
  switch (e.form) {
    case 'variable':
      return e.name === name ? repl : e
    case 'binary':
      return {
        ...e,
        left: subst(e.left, name, repl),
        right: subst(e.right, name, repl),
      }
    case 'unary':
      return { ...e, operand: subst(e.operand, name, repl) }
    case 'call':
      return {
        ...e,
        callee: subst(e.callee, name, repl),
        args: e.args.map(a => subst(a, name, repl)),
      }
    case 'conditional':
      return {
        ...e,
        branches: e.branches.map(b => ({
          cond: subst(b.cond, name, repl),
          value: subst(b.value, name, repl),
        })),
        otherwise: e.otherwise
          ? subst(e.otherwise, name, repl)
          : undefined,
      }
    default:
      return e
  }
}

// replace every call `f(arg)` whose single argument satisfies `match` with `build(arg)`
function replaceCall(
  e: Expression,
  fname: string,
  match: (a: Expression) => boolean,
  build: (arg: Expression) => Expression,
): Expression {
  switch (e.form) {
    case 'call': {
      const args = e.args.map(a => replaceCall(a, fname, match, build))

      if (
        e.callee.form === 'variable' &&
        e.callee.name === fname &&
        args.length === 1 &&
        match(args[0]!)
      ) {
        return build(args[0]!)
      }

      return {
        ...e,
        callee: replaceCall(e.callee, fname, match, build),
        args,
      }
    }

    case 'binary':
      return {
        ...e,
        left: replaceCall(e.left, fname, match, build),
        right: replaceCall(e.right, fname, match, build),
      }
    case 'unary':
      return {
        ...e,
        operand: replaceCall(e.operand, fname, match, build),
      }
    case 'conditional':
      return {
        ...e,
        branches: e.branches.map(b => ({
          cond: replaceCall(b.cond, fname, match, build),
          value: replaceCall(b.value, fname, match, build),
        })),
        otherwise: e.otherwise
          ? replaceCall(e.otherwise, fname, match, build)
          : undefined,
      }
    default:
      return e
  }
}

// the recurrence of a simple base-at-zero recursive function: a single parameter, body `send back (conditional)`,
// with a branch `param == 0 -> zero` and an `otherwise` that recurses on `param - 1`.
function recurrence(
  program: Program,
  fname: string,
): { param: string; zero: Expression; otherwise: Expression } | null {
  const fn = program.find(
    (s): s is Fn => s.form === 'function' && s.name === fname,
  )

  if (fn?.params.length !== 1 || fn.body.length !== 1) {
    return null
  }

  const ret = fn.body[0]!

  if (ret.form !== 'return' || ret.value?.form !== 'conditional') {
    return null
  }

  const param = fn.params[0]!.name
  const base = ret.value.branches.find(
    b =>
      b.cond.form === 'binary' &&
      b.cond.op === '==' &&
      b.cond.left.form === 'variable' &&
      b.cond.left.name === param &&
      b.cond.right.form === 'integer' &&
      Number(b.cond.right.value) === 0,
  )

  if (!base || !ret.value.otherwise) {
    return null
  }

  return { param, zero: base.value, otherwise: ret.value.otherwise }
}

// the first recursive function (with a usable recurrence) whose call appears in the goal
function goalFunction(e: Expression, program: Program): string | null {
  let found: string | null = null

  const walk = (x: Expression): void => {
    if (found) {
      return
    }

    if (
      x.form === 'call' &&
      x.callee.form === 'variable' &&
      recurrence(program, x.callee.name)
    ) {
      found = x.callee.name

      return
    }

    if (x.form === 'binary') {
      walk(x.left)
      walk(x.right)
    } else if (x.form === 'call') {
      x.args.forEach(walk)
    }
  }

  walk(e)

  return found
}

// prove `goal` (an `==` expression) by induction on `inductVar`. Returns true iff both the base case and the step are
// discharged by the ring normalizer. Sound (Peano induction); incomplete (the m = 1 step certificate, simple
// recurrences).
export function checkFold(
  program: Program,
  goal: Expression,
  inductVar: string,
): boolean {
  if (goal.form !== 'binary' || goal.op !== '==') {
    return false
  }

  const span = goal.span
  const fname = goalFunction(goal, program)

  if (!fname) {
    return false
  }

  const rec = recurrence(program, fname)

  if (!rec) {
    return false
  }

  const { param, zero, otherwise } = rec

  // base: n := 0, f(0) := zero
  const goal0 = subst(goal, inductVar, intE(0, span)) as Binary
  const base = replaceCall(
    goal0,
    fname,
    a => ringEqual(a, intE(0, span)),
    () => zero,
  ) as Binary

  if (base.form !== 'binary' || !ringEqual(base.left, base.right)) {
    return false
  }

  // step: n := k+1, f(k+1) := otherwise[param := k+1] (which recurses to f(k)); abstract f(k) as S in both the step
  // goal and the induction hypothesis, then ring-check that the two differences agree.
  const kPlus1 = binE('+', varE(inductVar, span), intE(1, span), span)
  const expansion = subst(otherwise, param, kPlus1)
  const goalStep = subst(goal, inductVar, kPlus1) as Binary
  const expanded = replaceCall(
    goalStep,
    fname,
    a => ringEqual(a, kPlus1),
    () => expansion,
  )

  const S = varE('__induction_hypothesis', span)
  const matchK = (a: Expression): boolean =>
    ringEqual(a, varE(inductVar, span))

  const stepGoal = replaceCall(
    expanded,
    fname,
    matchK,
    () => S,
  ) as Binary

  const ih = replaceCall(goal, fname, matchK, () => S) as Binary

  if (stepGoal.form !== 'binary' || ih.form !== 'binary') {
    return false
  }

  const stepDiff = binE('-', stepGoal.left, stepGoal.right, span)
  const ihDiff = binE('-', ih.left, ih.right, span)

  return ringEqual(stepDiff, ihDiff)
}

// ---- induction for ORDER goals ----
//
// `fold n` on a goal that is a comparison (or a `meet and` of comparisons) about a recursive function f, proved for
// every integer n >= 0 by Peano induction, each case discharged by the product prover (check/product.ts) from facts:
//
//   base : n := 0, f(.., 0, ..) := f's zero branch. Facts: the rule's hypotheses.
//   step : n := k + 1, f(.., k + 1, ..) := f's otherwise branch, whose recursive call f(.., k, ..) becomes a fresh
//          variable S. Facts: the hypotheses, k >= 0, and the induction hypothesis (every conjunct of the goal at k,
//          with f(.., k, ..) := S).
//
// Sound: this is Peano induction over the naturals, the recurrence is f's own definition (its `otherwise` branch is
// what f computes at any argument other than 0), and every case is closed by a certificate the product checker
// replays. The hypotheses may not mention n except as the bound `n >= 0` the induction ranges over: a hypothesis about
// n would change from case to case, and is refused rather than misused.

type Recurrence = { counter: number; params: string[]; zero: Expression; otherwise: Expression }

// a base-at-zero recursive function of any number of parameters: body `send back (conditional)`, a branch
// `p == 0 -> zero` on one parameter p (the counter), and an `otherwise`
function recurrenceOf(program: Program, fname: string): Recurrence | null {
  const fn = program.find((s): s is Fn => s.form === 'function' && s.name === fname)

  if (!fn || fn.params.length === 0 || fn.body.length !== 1) {
    return null
  }

  const ret = fn.body[0]!

  if (ret.form !== 'return' || ret.value?.form !== 'conditional' || !ret.value.otherwise) {
    return null
  }

  const params = fn.params.map(p => p.name)

  for (const b of ret.value.branches) {
    if (
      b.cond.form === 'binary' &&
      b.cond.op === '==' &&
      b.cond.left.form === 'variable' &&
      params.includes(b.cond.left.name) &&
      b.cond.right.form === 'integer' &&
      Number(b.cond.right.value) === 0 &&
      ret.value.branches.length === 1
    ) {
      return {
        counter: params.indexOf(b.cond.left.name),
        params,
        zero: b.value,
        otherwise: ret.value.otherwise,
      }
    }
  }

  return null
}

// replace every call of f whose counter argument satisfies `match`, building from its arguments
function replaceCounted(
  e: Expression,
  fname: string,
  counter: number,
  match: (a: Expression) => boolean,
  build: (args: Expression[]) => Expression,
): Expression {
  switch (e.form) {
    case 'call': {
      const args = e.args.map(a => replaceCounted(a, fname, counter, match, build))

      if (e.callee.form === 'variable' && e.callee.name === fname && args[counter] && match(args[counter]!)) {
        return build(args)
      }

      return { ...e, args }
    }
    case 'binary':
      return {
        ...e,
        left: replaceCounted(e.left, fname, counter, match, build),
        right: replaceCounted(e.right, fname, counter, match, build),
      }
    case 'unary':
      return { ...e, operand: replaceCounted(e.operand, fname, counter, match, build) }
    default:
      return e
  }
}

// the body of f at given arguments: every parameter substituted
function instantiate(rec: Recurrence, body: Expression, args: Expression[]): Expression {
  let out = body

  rec.params.forEach((p, i) => {
    out = subst(out, p, args[i]!)
  })

  return out
}

// an expression over + - * integers and variables as an exact polynomial, NUL-joined monomial keys as product.ts
// reads them; null on anything else (a call left over, a division, a number past 2^53)
function polynomialOf(e: Expression): Polynomial | null {
  switch (e.form) {
    case 'integer': {
      const n = typeof e.value === 'bigint' ? e.value : Number.isSafeInteger(e.value) ? BigInt(e.value) : null

      return n === null ? null : new Map(n === 0n ? [] : [['', rational(n)]])
    }
    case 'variable':
      return new Map([[e.name, rational(1n)]])
    case 'unary':
      if (e.op === '-') {
        const inner = polynomialOf(e.operand)

        return inner && new Map([...inner].map(([k, c]) => [k, rational(-c.n, c.d)]))
      }

      return null
    case 'binary': {
      const l = polynomialOf(e.left)
      const r = polynomialOf(e.right)

      if (!l || !r) {
        return null
      }

      if (e.op === '*') {
        return multiplyPolynomial(l, r)
      }

      if (e.op === '+' || e.op === '-') {
        const out = new Map(l)

        for (const [k, c] of r) {
          const prev = out.get(k) ?? rational(0n)
          const next = e.op === '+' ? rational(prev.n * c.d + c.n * prev.d, prev.d * c.d) : rational(prev.n * c.d - c.n * prev.d, prev.d * c.d)

          if (next.n === 0n) {
            out.delete(k)
          } else {
            out.set(k, next)
          }
        }

        return out
      }

      return null
    }
    default:
      return null
  }
}

// a comparison as a fact `polynomial (>= 0 | > 0 | == 0)`, or a conjunction as several
function factsOf(e: Expression): Fact[] | null {
  if (e.form === 'binary' && e.op === '&&') {
    const l = factsOf(e.left)
    const r = factsOf(e.right)

    return l && r ? [...l, ...r] : null
  }

  if (e.form !== 'binary' || !['<', '<=', '>', '>=', '=='].includes(e.op)) {
    return null
  }

  const l = polynomialOf(e.left)
  const r = polynomialOf(e.right)

  if (!l || !r) {
    return null
  }

  const minus = (a: Polynomial, b: Polynomial): Polynomial => {
    const out = new Map(a)

    for (const [k, c] of b) {
      const prev = out.get(k) ?? rational(0n)
      const next = rational(prev.n * c.d - c.n * prev.d, prev.d * c.d)

      if (next.n === 0n) {
        out.delete(k)
      } else {
        out.set(k, next)
      }
    }

    return out
  }

  switch (e.op) {
    case '>=':
      return [{ polynomial: minus(l, r), relation: 'nonnegative' }]
    case '>':
      return [{ polynomial: minus(l, r), relation: 'positive' }]
    case '<=':
      return [{ polynomial: minus(r, l), relation: 'nonnegative' }]
    case '<':
      return [{ polynomial: minus(r, l), relation: 'positive' }]
    default:
      return [{ polynomial: minus(l, r), relation: 'zero' }]
  }
}

// every conjunct of a goal proven from the facts
function provesAll(goal: Expression, facts: Fact[]): boolean {
  if (goal.form === 'binary' && goal.op === '&&') {
    return provesAll(goal.left, facts) && provesAll(goal.right, facts)
  }

  const want = factsOf(goal)

  if (!want || want.length !== 1) {
    return false
  }

  const { polynomial, relation } = want[0]!

  if (relation === 'zero') {
    const negative = new Map([...polynomial].map(([k, c]) => [k, rational(-c.n, c.d)]))

    return productProves(facts, polynomial, false) && productProves(facts, negative, false)
  }

  return productProves(facts, polynomial, relation === 'positive')
}

// does an expression read a variable
function mentions(e: Expression, name: string): boolean {
  switch (e.form) {
    case 'variable':
      return e.name === name
    case 'binary':
      return mentions(e.left, name) || mentions(e.right, name)
    case 'unary':
      return mentions(e.operand, name)
    case 'call':
      return e.args.some(a => mentions(a, name))
    default:
      return false
  }
}

// is a guard exactly the induction's own range, `n >= 0` (or `0 <= n`)
function isRangeOf(e: Expression, n: string): boolean {
  if (e.form !== 'binary') {
    return false
  }

  const zero = (x: Expression): boolean => x.form === 'integer' && Number(x.value) === 0
  const isN = (x: Expression): boolean => x.form === 'variable' && x.name === n

  return (e.op === '>=' && isN(e.left) && zero(e.right)) || (e.op === '<=' && zero(e.left) && isN(e.right))
}

// the first function with a usable recurrence called in the goal
function orderFunction(e: Expression, program: Program): string | null {
  if (e.form === 'call' && e.callee.form === 'variable' && recurrenceOf(program, e.callee.name)) {
    return e.callee.name
  }

  if (e.form === 'binary') {
    return orderFunction(e.left, program) ?? orderFunction(e.right, program)
  }

  if (e.form === 'call') {
    for (const a of e.args) {
      const found = orderFunction(a, program)

      if (found) {
        return found
      }
    }
  }

  return null
}

// prove an order goal by induction on `n`, given the rule's hypotheses (its `have` guards)
export function checkFoldOrder(program: Program, goal: Expression, n: string, guards: Expression[]): boolean {
  if (goal.form !== 'binary' || !['<', '<=', '>', '>=', '&&'].includes(goal.op)) {
    return false
  }

  const fname = orderFunction(goal, program)
  const rec = fname ? recurrenceOf(program, fname) : null

  if (!fname || !rec) {
    return false
  }

  // hypotheses: the range of n is supplied by the induction itself, and any other mention of n is refused
  const fixed: Fact[] = []

  for (const g of guards) {
    if (isRangeOf(g, n)) {
      continue
    }

    if (mentions(g, n)) {
      return false
    }

    const facts = factsOf(g)

    if (!facts) {
      return false
    }

    fixed.push(...facts)
  }

  const span = goal.span
  const isAt = (value: Expression) => (a: Expression) => ringEqual(a, value)

  // BASE: n := 0, f(.., 0, ..) := its zero branch
  const zero = intE(0, span)
  const base = replaceCounted(subst(goal, n, zero), fname, rec.counter, isAt(zero), args =>
    instantiate(rec, rec.zero, args),
  )

  if (!provesAll(base, fixed)) {
    return false
  }

  // STEP: n := k + 1 (k is n itself, now ranging over the naturals), f(.., k + 1, ..) := its otherwise branch, and
  // f(.., k, ..) := S in both the step goal and the induction hypothesis
  const k = varE(n, span)
  const kPlus1 = binE('+', k, intE(1, span), span)
  const S = varE('__induction_value', span)
  const expanded = replaceCounted(subst(goal, n, kPlus1), fname, rec.counter, isAt(kPlus1), args =>
    instantiate(rec, rec.otherwise, args),
  )
  const step = replaceCounted(expanded, fname, rec.counter, isAt(k), () => S)
  const hypothesis = replaceCounted(goal, fname, rec.counter, isAt(k), () => S)
  const ih = factsOf(hypothesis)

  if (!ih) {
    return false
  }

  const range: Fact = { polynomial: new Map([[n, rational(1n)]]), relation: 'nonnegative' }

  return provesAll(step, [...fixed, range, ...ih])
}
