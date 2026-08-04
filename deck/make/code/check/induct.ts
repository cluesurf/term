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
