// The hold-checker: closes refinement layer 2 end to end. It translates each function's `hold` clauses (the
// goals) and its parameters' refinements (the assumptions, e.g. natural-number means n >= 0) into linear
// constraints, then discharges the goals with the Fourier-Motzkin prover in refine.ts. An unprovable hold is a
// diagnostic. See note/research/vibe/computation/plans/04-typecheck.md. Browser-safe.

import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import type {
  Expression,
  HoldOrigin,
  Program,
  Statement,
  Type,
} from '@term/make/code/compile/node'
import type { Linear } from '@term/make/code/check/refine'
import {
  callsImpure,
  EVERYTHING,
  freshNames,
  functionNames,
  IMMUTABLE,
  lengthKeepingFunctions,
  localNames,
  pureFunctions,
  READ_ONLY_LIST_METHODS,
  returnsFreshFunctions,
  stateFreeFunctions,
  readNames,
  readsAny,
  readsState,
  rootName,
  volatileNames,
  writtenNames,
} from '@term/make/code/check/facts'
import {
  above,
  atLeast,
  atMost,
  below,
  linear,
  noteUncertified,
  proves,
} from '@term/make/code/check/refine'
import { checkGram, gramKey } from '@term/make/code/check/certificate'
import type { Fact } from '@term/make/code/check/product'
import { fromNumbers, productProves } from '@term/make/code/check/product'
import {
  positiveEverywhere as sturmPositiveEverywhere,
  nonNegativeEverywhere as sturmNonNegativeEverywhere,
} from '@term/make/code/check/sturm'
import {
  bivariateNonNegative,
  type Bivariate,
} from '@term/make/code/check/cad'
import {
  nonNegativeEverywhereNvar,
  nPoly,
} from '@term/make/code/check/cad-nvar'

let modCounter = 0

// the extremum each name computes in the program being checked: the intrinsics `max` / `min` when the program does
// not define a task of that name, and any task whose whole body is `send back, call max (or min) a b` of its own two
// parameters in order. Set by checkHolds for each program.
let extrema = new Map<string, 'max' | 'min'>()

function extremumOf(name: string): 'max' | 'min' | undefined {
  return extrema.get(name)
}

function extremaOf(program: Program): Map<string, 'max' | 'min'> {
  const defined = new Map<string, Extract<Statement, { form: 'function' }>>()

  for (const statement of program) {
    if (statement.form === 'function') {
      defined.set(statement.name, statement)
    }
  }

  const table = new Map<string, 'max' | 'min'>()

  for (const intrinsic of ['max', 'min'] as const) {
    if (!defined.has(intrinsic)) {
      table.set(intrinsic, intrinsic)
    }
  }

  // a native module's `min` / `max` handed the task's own two parameters (the stdlib's `min` is `call math/min a b`
  // over the host `Math` global). This rests on the trust every native call already carries, which `term hold`
  // prints: the host's `Math.min` is a minimum
  // (the target is a module name: neither a task of the program nor one of the task's own parameters, which could be a
  // record with a `min` method of its own)
  const hostModule = (
    callee: Expression,
    params: { name: string }[],
  ): 'max' | 'min' | undefined =>
    callee.form === 'member' &&
    !callee.index &&
    (callee.name === 'min' || callee.name === 'max') &&
    callee.target.form === 'variable' &&
    !defined.has(callee.target.name) &&
    !params.some(p => p.name === (callee.target as { name: string }).name)
      ? callee.name
      : undefined

  // twice, so a task over a task recognized in the first pass (`minimum` over the native-backed `min`) is found
  for (let pass = 0; pass < 2; pass++) {
    for (const [name, fn] of defined) {
      const only = fn.body.length === 1 ? fn.body[0] : undefined

      if (
        table.has(name) ||
        fn.params.length !== 2 ||
        only?.form !== 'return' ||
        only.value?.form !== 'call' ||
        only.value.args.length !== 2
      ) {
        continue
      }

      const callee = only.value.callee
      const inner =
        callee.form === 'variable' ? table.get(callee.name) : hostModule(callee, fn.params)
      const [a, b] = only.value.args

      if (
        inner &&
        a?.form === 'variable' &&
        b?.form === 'variable' &&
        a.name === fn.params[0]!.name &&
        b.name === fn.params[1]!.name
      ) {
        table.set(name, inner)
      }
    }
  }

  return table
}

// each remainder atom's dividend, and its divisor when that is not a constant, each as a SNAPSHOT atom equal to the
// value at the `%` (snapshot): a truncated remainder has the sign of its dividend, and is smaller than its divisor in
// size
const modDividends = new Map<string, Linear>()
const modDivisors = new Map<string, Linear>()
// each quotient atom's dividend (a snapshot) and its constant divisor
const quotients = new Map<string, { dividend: Linear; k: number }>()
// each max / min atom's two arguments, as snapshots taken where it was read
const extremumArguments = new Map<string, { kind: 'max' | 'min'; a: Linear; b: Linear }>()

// a fresh atom equal to `value` now, which no later write can change
function snapshot(value: Linear, side: Inequality[]): Linear {
  const atom = linear({ [`__was${modCounter++}`]: 1 })
  side.push(atMost(atom, value), atLeast(atom, value))

  return atom
}

// does an expression call something impure OUTSIDE a masked value? `bitwise-and(x, k)` with a constant mask is read as a
// fresh atom in [0, k] whatever x is (toLinear), so an impure call inside x is never compared with anything, and two
// such reads are never taken to be equal: the reason impure goals are refused does not apply to it
function impureOutsideMasks(expr: unknown, walk: Walk): boolean {
  if (expr === null || typeof expr !== 'object') {
    return false
  }

  if (Array.isArray(expr)) {
    return expr.some(e => impureOutsideMasks(e, walk))
  }

  const node = expr as Expression

  if (
    node.form === 'call' &&
    node.callee.form === 'variable' &&
    node.callee.name === 'bitwise-and' &&
    node.args.length === 2
  ) {
    const mask = toLinear(node.args[1]!, [])
    const k = mask ? constantOf(mask) : undefined

    if (k !== undefined && Number.isInteger(k) && k >= 0 && k <= Number.MAX_SAFE_INTEGER) {
      return false
    }
  }

  if (node.form === 'call' && callsImpure({ ...node, args: [] }, walk.pure, walk.functions, walk.local)) {
    return true
  }

  if (
    node.form === 'variable' &&
    walk.functions.has(node.name) &&
    !walk.pure.has(node.name)
  ) {
    return true
  }

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key !== 'type' && key !== 'span' && key !== 'binding' && impureOutsideMasks(value, walk)) {
      return true
    }
  }

  return false
}

// the facts the signs decide, for every remainder atom among these: `m >= 0` where the dividend was non-negative,
// and `-(d - 1) <= m <= d - 1` where the divisor d was positive (`d + 1 <= m <= -d - 1` where it was negative)
function signedRemainders(all: Inequality[], goals: Inequality[] = []): Inequality[] {
  const extra: Inequality[] = []
  const zero = linear({}, 0)
  const one = linear({}, 1)

  // the atoms to bound come from the facts AND the goal (a quotient read only in the goal, `get(xs, i / 2)`, is in no
  // fact); what is proven about them comes from the facts alone, never from the goal
  for (const q of [...all, ...goals]) {
    for (const key of q.linear.terms.keys()) {
      const m = linear({ [key]: 1 })
      const dividend = modDividends.get(key)

      if (dividend && proves(all, atLeast(dividend, zero))) {
        extra.push(atLeast(m, zero))
      }

      const quotient = quotients.get(key)

      if (quotient) {
        const kq = scale(m, quotient.k)
        const slack = linear({}, quotient.k - 1)

        if (proves(all, atLeast(quotient.dividend, zero))) {
          // k·q <= x <= k·q + k - 1
          extra.push(atMost(kq, quotient.dividend), atMost(quotient.dividend, add(kq, slack)))
        } else if (proves(all, atMost(quotient.dividend, zero))) {
          // k·q - (k - 1) <= x <= k·q
          extra.push(atLeast(kq, quotient.dividend), atLeast(quotient.dividend, add(kq, scale(slack, -1))))
        }
      }

      const divisor = modDivisors.get(key)

      if (divisor && proves(all, atLeast(divisor, one))) {
        extra.push(atMost(m, add(divisor, linear({}, -1))), atLeast(m, add(scale(divisor, -1), one)))
      } else if (divisor && proves(all, atMost(divisor, linear({}, -1)))) {
        extra.push(atMost(m, add(scale(divisor, -1), linear({}, -1))), atLeast(m, add(divisor, one)))
      }
    }
  }

  // twice, so `min(min(r, g), b)` can use what the first pass found about the inner min
  for (let pass = 0; pass < 2; pass++) {
    extra.push(...extremumBounds([...all, ...extra], goals))
  }

  return extra
}

// the far side of every max / min atom among these facts: `max(a, b) <= c` when both a and b are, `min(a, b) >= c`
// when both are. The candidates for c are the constants the facts mention, each confirmed by the prover for both
function extremumBounds(all: Inequality[], goals: Inequality[] = []): Inequality[] {
  const out: Inequality[] = []
  const candidates = new Set<number>([0])

  // the constants, and the atoms to bound, from the facts and the goal; the proofs from the facts alone
  for (const q of [...all, ...goals]) {
    if (Number.isInteger(q.linear.constant)) {
      candidates.add(q.linear.constant)
      candidates.add(-q.linear.constant)
    }
  }

  const tried = [...candidates].sort((a, b) => Math.abs(a) - Math.abs(b)).slice(0, 16)

  for (const q of [...all, ...goals]) {
    for (const key of q.linear.terms.keys()) {
      const extremum = extremumArguments.get(key)

      if (!extremum) {
        continue
      }

      const e = linear({ [key]: 1 })

      // the tightest c both arguments meet: the greatest lower bound for a min, the least upper bound for a max
      const ordered = [...tried].sort((x, y) => (extremum.kind === 'min' ? y - x : x - y))

      for (const c of ordered) {
        const bound = linear({}, c)
        const both =
          extremum.kind === 'min'
            ? proves(all, atLeast(extremum.a, bound)) && proves(all, atLeast(extremum.b, bound))
            : proves(all, atMost(extremum.a, bound)) && proves(all, atMost(extremum.b, bound))

        if (both) {
          out.push(extremum.kind === 'min' ? atLeast(e, bound) : atMost(e, bound))
          break
        }
      }
    }
  }

  return out
}

// translate a compile-AST expression into a linear form, or undefined if it is not linear. Side constraints (for
// `mod`, whose result is known to lie in [0, k-1]) are pushed into `side` and become extra assumptions.
function toLinear(
  expr: Expression,
  side: Inequality[],
): Linear | undefined {
  switch (expr.form) {
    case 'integer':
      // a literal past 2^53 rounds in Number(), and the rounded value is a different number: decline it
      return within(linear({}, Number(expr.value)))
    case 'variable':
      return linear({ [expr.name]: 1 })

    // a list's length is an ATOM the prover may name, never negative: `xs/length`, and `size` / `array-size` of a
    // plain path, which the stdlib defines as it. Keyed `@length:<path>`, and forgotten with the path's root.
    case 'member':
    case 'call': {
      const applied = applicationKey(expr)

      if (applied !== undefined) {
        return linear({ [applied]: 1 })
      }

      if (expr.form === 'call' && expr.callee.form === 'variable') {
        const name = expr.callee.name

        // the built-in `increment` / `decrement` (compile/surface.ts UNARY_BUILTIN) are x + 1 and x - 1
        if ((name === 'increment' || name === 'decrement') && expr.args.length === 1) {
          const inner = toLinear(expr.args[0]!, side)

          return inner
            ? add(inner, linear({}, name === 'increment' ? 1 : -1))
            : undefined
        }

        // `max a b` is at least each argument and `min a b` at most each. Read off the intrinsic, or off a task whose
        // whole body is that intrinsic applied to its own two parameters in order (the stdlib's `maximum` and
        // `minimum`), recognized by its SHAPE, never by its name, so a task of the same name that does something
        // else gets nothing (extremumOf)
        const extremum = extremumOf(name)

        if (extremum && expr.args.length === 2) {
          const a = toLinear(expr.args[0]!, side)
          const b = toLinear(expr.args[1]!, side)

          if (a && b) {
            const key = `__ext${modCounter++}`
            const e = linear({ [key]: 1 })

            if (extremum === 'max') {
              side.push(atLeast(e, a), atLeast(e, b))
            } else {
              side.push(atMost(e, a), atMost(e, b))
            }

            // and the bound on the other side, decided where the arguments' bounds are known (signedRemainders):
            // a max is at most any c both arguments are at most, a min at least any c both are at least
            extremumArguments.set(key, {
              kind: extremum,
              a: snapshot(a, side),
              b: snapshot(b, side),
            })

            return e
          }
        }

        // `bitwise-and x k` with a constant mask 0 <= k lies in [0, k] for every x: the result has no bit k does not
        // have. The stdlib's bit operations are 64-bit on every backend (the `bit` global, through BigInt on the JS
        // hosts, deck/base/code/native/*/bit.tree), never JavaScript's signed 32-bit `&`, so the mask may be any
        // exact integer. It was held below 2^31 on the 32-bit assumption, which left `x & 0xffffffff` unbounded.
        if (name === 'bitwise-and' && expr.args.length === 2) {
          const constant = (e: Expression): number | undefined => {
            const l = toLinear(e, [])

            return l ? constantOf(l) : undefined
          }
          const mask = constant(expr.args[1]!) ?? constant(expr.args[0]!)

          if (
            mask !== undefined &&
            Number.isInteger(mask) &&
            mask >= 0 &&
            mask <= Number.MAX_SAFE_INTEGER
          ) {
            const bits = linear({ [`__and${modCounter++}`]: 1 })
            side.push(atLeast(bits, linear({}, 0)))
            side.push(atMost(bits, linear({}, mask)))

            return bits
          }
        }
      }

      // a NUMBER FIELD of a record reached by a plain path (`self/capacity`, `color/red`) is an atom too, keyed
      // `@field:<path>`. It is state, so it goes where a length goes: with a write through any member, with an
      // impure call that may reach a record, and with its root name (keyRoot). Unlike a length it may be negative
      const field = fieldAtom(expr)

      if (field !== undefined) {
        return linear({ [field]: 1 })
      }

      const key = lengthAtom(expr)

      if (key === undefined) {
        return undefined
      }

      const atom = linear({ [key]: 1 })
      side.push(atLeast(atom, linear({}, 0)))

      return atom
    }

    case 'binary': {
      const left = toLinear(expr.left, side)
      const right = toLinear(expr.right, side)

      // a remainder whose dividend is not linear still has a known size, from the divisor: |m| < |d|. Its sign is
      // the dividend's, which is unknown here, so no dividend is recorded and only the size is ever concluded
      if (expr.op === '%' && !left && right) {
        const k = constantOf(right)
        const key = `__mod${modCounter++}`
        const m = linear({ [key]: 1 })

        if (k === undefined) {
          modDivisors.set(key, snapshot(right, side))

          return m
        }

        if (Number.isInteger(k) && k > 0) {
          side.push(atLeast(m, linear({}, -(k - 1))), atMost(m, linear({}, k - 1)))

          return m
        }

        return undefined
      }

      if (!left || !right) {
        return undefined
      }

      if (expr.op === '+') {
        return within(add(left, right))
      }

      if (expr.op === '-') {
        return within(add(left, scale(right, -1)))
      }

      if (expr.op === '*') {
        const lc = constantOf(left)
        const rc = constantOf(right)

        if (rc !== undefined) {
          return within(scale(left, rc))
        }

        if (lc !== undefined) {
          return within(scale(right, lc))
        }

        return undefined // non-linear (variable * variable)
      }

      // `x / k` for a positive integer constant k: a fresh atom q, the quotient TRUNCATED toward zero (every backend,
      // note/term/proof-by-default/numbers.md). Where x is non-negative, k·q <= x <= k·q + k - 1, and where it is
      // non-positive the mirror; decided at the goal from a snapshot of x (signedRemainders)
      if (expr.op === '/') {
        const k = constantOf(right)

        // never a float quotient, which is not an integer and must not be tightened as one
        if (
          k !== undefined &&
          Number.isInteger(k) &&
          k > 0 &&
          expr.type?.kind !== 'float' &&
          expr.left.type?.kind !== 'float'
        ) {
          const key = `__div${modCounter++}`
          quotients.set(key, { dividend: snapshot(left, side), k })

          return linear({ [key]: 1 })
        }

        return undefined
      }

      if (expr.op === '%') {
        // x mod k, for a positive integer constant k, is a fresh variable in [-(k-1), k-1]. NOT [0, k-1]: every
        // backend TRUNCATES (JavaScript, Rust, Swift and Kotlin all give -7 % 3 == -1), so the remainder takes the
        // sign of x. Until 2026-10-02 this said [0, k-1], and `n % 3 >= 0` was proven for an integer n that may be
        // negative (test/check/soundness.ts).
        const k = constantOf(right)
        const key = `__mod${modCounter++}`
        const m = linear({ [key]: 1 })
        // the dividend AS IT WAS at this `%`: a fresh atom equal to it, so a later write to a name it reads cannot
        // change what the remainder's sign is decided from. Keeping the expression itself let `x = 5` after
        // `r = x % 3` with x < 0 prove r >= 0 (test/check/soundness.ts)
        modDividends.set(key, snapshot(left, side))

        if (k !== undefined && Number.isInteger(k) && k > 0) {
          side.push(atLeast(m, linear({}, -(k - 1)))) // m >= -(k-1)
          side.push(atMost(m, linear({}, k - 1))) // m <= k-1

          return m
        }

        // a divisor that is not a constant: |m| < |divisor|, decided where its sign is known (signedRemainders)
        if (k === undefined) {
          modDivisors.set(key, snapshot(right, side))

          return m
        }

        return undefined
      }

      return undefined
    }

    default:
      return undefined
  }
}

// a plain path (`xs`, `self/line`) as dotted text, or undefined when any step is computed
function plainPath(expr: Expression): string | undefined {
  if (expr.form === 'variable') {
    return expr.name
  }

  if (expr.form === 'member' && !expr.index) {
    const inner = plainPath(expr.target)

    return inner === undefined ? undefined : `${inner}.${expr.name}`
  }

  return undefined
}

const LENGTH_CALLS = new Set(['size', 'array-size', 'list_size'])

// the atom key for a list length, or undefined when the expression is not one
function lengthAtom(expr: Expression): string | undefined {
  if (expr.form === 'member' && !expr.index && expr.name === 'length') {
    const path = plainPath(expr.target)

    // a TEXT's length is a property of an immutable value: no call and no write can change it while the name holds
    // the same text, so it is keyed apart (`@text:`), forgotten only with its name, never as state. An untyped read (a
    // contract's, which inference never types) is a text when it names a parameter declared one
    const text =
      expr.target.type?.kind === 'string' ||
      (expr.target.type === undefined &&
        expr.target.form === 'variable' &&
        textParams.has(expr.target.name))

    if (path !== undefined && text) {
      return `@text:${path}`
    }

    return path === undefined ? undefined : `@length:${path}`
  }

  if (
    expr.form === 'call' &&
    expr.callee.form === 'variable' &&
    LENGTH_CALLS.has(expr.callee.name) &&
    expr.args.length === 1
  ) {
    const path = plainPath(expr.args[0]!)

    return path === undefined ? undefined : `@length:${path}`
  }

  return undefined
}

// the variable a fact key reads: itself for a plain name, the root of the path for a length atom
function keyRoot(key: string): string {
  for (const prefix of ['@length:', '@field:', '@text:']) {
    if (key.startsWith(prefix)) {
      return key.slice(prefix.length).split('.')[0]!
    }
  }

  return key
}

// a key that stands for STATE, which calls and writes can change: a list's length or a record's field. A text's
// length (`@text:`) is not state, and neither is an auxiliary atom (`__`)
function isStateAtom(key: string): boolean {
  return /[^a-z0-9_#-]/.test(key) && !key.startsWith('__') && !key.startsWith('@text:')
}

// each record form's number fields, and the record form of each parameter of the task being walked. A contract's
// expression is never typed by inference (it is lowered after it), so `read c/count` in a `have` carries no type,
// and its field is read off the declaration instead: never guessed, since an untyped `float` field read as an
// integer atom would be tightened as one
let numberFields = new Map<string, Set<string>>()

// the quantified FUNCTIONS of the theorem being walked: a rule's `mark x, like task ...`. A theorem holds for every
// function, so a call of one is a pure application: the same argument gives the same value, and nothing else is
// known. Each call becomes an atom keyed by the function and its argument's canonical polynomial (applicationKey), so
// `x(n + 1)` and `x(1 + n)` are one atom and `x(n)` and `x(n + 1)` are two.
let appliedFunctions = new Set<string>()

// the theorem's UNIVERSAL hypotheses (`have h / mark t / <proposition>`): each true for every value of its binders
let universalHypotheses: { binders: string[]; expr: Expression }[] = []
let paramForms = new Map<string, string>()
// the parameters of the task being walked that are declared text
let textParams = new Set<string>()

function numberFieldsOf(program: Program): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()

  for (const statement of program) {
    if (statement.form === 'record-type') {
      out.set(
        statement.name,
        new Set(statement.fields.filter(f => f.type?.kind === 'number').map(f => f.name)),
      )
    }
  }

  return out
}

function paramFormsOf(params: { name: string; type?: Type }[]): Map<string, string> {
  return new Map(
    params.flatMap(p => (p.type?.kind === 'named' ? [[p.name, p.type.name] as [string, string]] : [])),
  )
}

// a member read whose field is declared a number: by its inferred type, or, untyped, by its parameter's form
function numberMember(expr: Extract<Expression, { form: 'member' }>): boolean {
  if (expr.type !== undefined) {
    return expr.type.kind === 'number'
  }

  // the record's form: from its own type when it carries one (a caller's argument, a promise's `back`), else from the
  // parameter or result it names
  const form =
    expr.target.type?.kind === 'named'
      ? expr.target.type.name
      : expr.target.form === 'variable'
        ? paramForms.get(expr.target.name)
        : undefined

  return form !== undefined && numberFields.get(form)?.has(expr.name) === true
}

// the atom key for a number field read through a plain path, or undefined for anything else (a computed step, a
// list's element, its length, a field that is not a number)
function fieldAtom(expr: Expression): string | undefined {
  if (
    expr.form !== 'member' ||
    expr.index ||
    expr.name === 'length' ||
    /^[0-9]+$/.test(expr.name) ||
    !numberMember(expr) ||
    expr.target.type?.kind === 'array'
  ) {
    return undefined
  }

  const path = plainPath(expr)

  return path === undefined ? undefined : `@field:${path}`
}

// a linear form whose every number is still exact: below 2^53 in size. A number past it has rounded (two different
// products can land on one double), so the form is declined, which is sound: the goal is left unproven
function within(a: Linear): Linear | undefined {
  const fits = (n: number): boolean => Math.abs(n) <= Number.MAX_SAFE_INTEGER

  return fits(a.constant) && [...a.terms.values()].every(fits) ? a : undefined
}

function add(a: Linear, b: Linear): Linear {
  const terms = new Map(a.terms)

  for (const [v, c] of b.terms) {
    terms.set(v, (terms.get(v) ?? 0) + c)
  }

  return { terms, constant: a.constant + b.constant }
}

function scale(a: Linear, k: number): Linear {
  const terms = new Map<string, number>()

  for (const [v, c] of a.terms) {
    terms.set(v, c * k)
  }

  return { terms, constant: a.constant * k }
}

// the greatest common divisor of two non-negative integers (Euclid). Used by the omega gcd test on disequality goals;
// gcd(0, n) = n folds a coefficient list from a 0 seed.
function greatestCommonDivisor(a: number, b: number): number {
  let x = Math.abs(Math.round(a))
  let y = Math.abs(Math.round(b))

  while (y !== 0) {
    ;[x, y] = [y, x % y]
  }

  return x
}

// if a linear form is a pure constant (no variables), return it
function constantOf(a: Linear): number | undefined {
  for (const c of a.terms.values()) {
    if (Math.abs(c) > 1e-12) {
      return undefined
    }
  }

  return a.constant
}

// ===== structural positivity (the nonlinear companion the linear prover lacks) =====
// A SQUARE `a * a` is >= 0 for any value of `a`, and sums / products of non-negative parts stay non-negative. These
// facts are outside the linear fragment (a square is variable*variable, which `toLinear` rejects) yet trivially true,
// and the kernel cannot see them either (opaque literals). Sound over any ordered ring.

// syntactic equality on the arithmetic fragment, so `a * a` is recognised as a square (`a` matched against `a`).
function sameExpression(a: Expression, b: Expression): boolean {
  if (a.form !== b.form) {
    return false
  }

  if (a.form === 'integer' && b.form === 'integer') {
    return a.value === b.value
  }

  if (a.form === 'variable' && b.form === 'variable') {
    return a.name === b.name
  }

  if (a.form === 'binary' && b.form === 'binary') {
    return (
      a.op === b.op &&
      sameExpression(a.left, b.left) &&
      sameExpression(a.right, b.right)
    )
  }

  return false
}

// is `expr` structurally >= 0: a non-negative literal, a square, or a sum / product of non-negative parts.
function nonNegativeExpression(expr: Expression): boolean {
  if (expr.form === 'integer') {
    return Number(expr.value) >= 0
  }

  if (expr.form === 'binary') {
    // a SQUARE is non-negative regardless of the sign of its base
    if (expr.op === '*' && sameExpression(expr.left, expr.right)) {
      return true
    }

    if (expr.op === '+' || expr.op === '*') {
      return (
        nonNegativeExpression(expr.left) &&
        nonNegativeExpression(expr.right)
      )
    }
  }

  return false
}

// is `expr` structurally > 0: a positive literal, a product of positives, or a sum with a positive part. (A square is
// only >= 0 -- its base may be zero -- so it does not certify strict positivity.)
function positiveExpression(expr: Expression): boolean {
  if (expr.form === 'integer') {
    return Number(expr.value) > 0
  }

  if (expr.form === 'binary') {
    if (expr.op === '+') {
      return (
        (positiveExpression(expr.left) &&
          nonNegativeExpression(expr.right)) ||
        (nonNegativeExpression(expr.left) &&
          positiveExpression(expr.right))
      )
    }

    if (expr.op === '*') {
      return (
        positiveExpression(expr.left) && positiveExpression(expr.right)
      )
    }
  }

  return false
}

// a POSITIVITY goal proven structurally: `e >= 0` / `0 <= e` (non-negativity) or `e > 0` / `0 < e` (positivity), where
// the non-zero side is a recognised non-negative / positive arithmetic expression. Returns false when it does not apply
// (so the caller falls through to the linear prover, which still owns every linear non-negativity goal).
function positivityProves(expr: Expression): boolean {
  if (expr.form !== 'binary') {
    return false
  }

  const isZero = (e: Expression): boolean =>
    e.form === 'integer' && Number(e.value) === 0

  switch (expr.op) {
    case '>=':
      return isZero(expr.right) && nonNegativeExpression(expr.left)
    case '<=':
      return isZero(expr.left) && nonNegativeExpression(expr.right)
    case '>':
      return isZero(expr.right) && positiveExpression(expr.left)
    case '<':
      return isZero(expr.left) && positiveExpression(expr.right)
    default:
      return false
  }
}

// ===== multivariate quadratic non-negativity (the nonlinear `nia` decision via positive-semidefiniteness) =====
// A real quadratic q(x) = x^T M x + b^T x + c is >= 0 for ALL x iff the augmented symmetric matrix A = [[M, b/2],
// [(b/2)^T, c]] is positive SEMIDEFINITE, and q > 0 everywhere iff A is positive DEFINITE. PSD is decided exactly by
// "every principal minor >= 0" and PD by "every LEADING principal minor > 0" (Sylvester). We scale A by 2 to keep an
// integer matrix (PSD/PD are invariant under a positive scaling), so the minors are exact integer determinants -- no
// floating-point unsoundness. Real non-negativity implies integer non-negativity, so the verdict is sound for Seed's
// integer variables, and it is COMPLETE for the quadratic fragment in any number of variables. It catches forms not
// written as a square -- `(x-1)^2` as `x^2 + 1 >= 2x`, `(a-b)^2` as `a^2 + b^2 >= 2 a b` -- i.e. a sum-of-squares
// certificate without naming the squares.

// a polynomial of degree <= 2 as a map from a canonical monomial key to its integer coefficient. The key is the sorted
// variable list joined by NUL: '' = constant, 'x' = linear, 'x\0x' = a square, 'x\0y' = a cross term.
type Poly = Map<string, number>

const monomialKey = (vars: string[]): string => [...vars].sort().join(' ')

const monomialVars = (key: string): string[] =>
  key === '' ? [] : key.split(' ')

// expand an arithmetic expression into its polynomial, or null if it is not a polynomial of degree <= 2 (a degree-3+
// monomial appears). Coefficients stay exact integers.
// THE ATOMS an application of a quantified function becomes. The linear and polynomial engines key their unknowns by
// strings, so an application needs a key, and the key is built canonically from the function and its arguments'
// polynomials so that equal arguments name one atom. Nothing reads structure back out of a key: what an atom IS (an
// application, of which function, reading which variables) is recorded here when its key is made, and every question
// about a key is a lookup in this table.
type Atom = { function: string; variables: Set<string> }

const applications = new Map<string, Atom>()

// is this key an application of a quantified function
function isApplication(key: string): boolean {
  return applications.has(key)
}

// the variables an application's arguments read, through nested applications
function applicationVariables(key: string): Set<string> {
  return applications.get(key)?.variables ?? new Set()
}

// the key of an application, registered in `applications`, or undefined for any other expression or an argument outside
// the polynomial fragment
function applicationKey(expr: Expression): string | undefined {
  if (expr.form !== 'call' || expr.callee.form !== 'variable' || !appliedFunctions.has(expr.callee.name)) {
    return undefined
  }

  const args: string[] = []

  for (const arg of expr.args) {
    const poly = expandPolynomial(arg)

    if (!poly) {
      return undefined
    }

    args.push(
      [...poly]
        .filter(([, c]) => c !== 0)
        .map(([key, c]) => `${c}*${monomialVars(key).join('.')}`)
        .sort()
        .join('+') || '0',
    )
  }

  const key = `@apply:${expr.callee.name}(${args.join(',')})`

  if (!applications.has(key)) {
    const variables = new Set<string>()

    for (const arg of expr.args) {
      for (const monomial of expandPolynomial(arg)!.keys()) {
        for (const v of monomialVars(monomial)) {
          if (isApplication(v)) {
            applicationVariables(v).forEach(inner => variables.add(inner))
          } else {
            variables.add(v)
          }
        }
      }
    }

    applications.set(key, { function: expr.callee.name, variables })
  }

  return key
}

function expandPolynomial(expr: Expression): Poly | null {
  const applied = applicationKey(expr)

  if (applied !== undefined) {
    return new Map([[applied, 1]])
  }

  // every coefficient must stay a safe integer: past 2^53 a number rounds, and a rounded coefficient is a different
  // polynomial (ring.ts exact). Declining with null is always sound
  if (expr.form === 'integer') {
    const n = Number(expr.value)

    return Number.isSafeInteger(n) && BigInt(n) === BigInt(expr.value) ? new Map([['', n]]) : null
  }

  if (expr.form === 'variable') {
    return new Map([[expr.name, 1]])
  }

  if (expr.form === 'binary') {
    const left = expandPolynomial(expr.left)
    const right = expandPolynomial(expr.right)

    if (!left || !right) {
      return null
    }

    if (expr.op === '+' || expr.op === '-') {
      const sign = expr.op === '+' ? 1 : -1
      const out: Poly = new Map(left)

      for (const [key, value] of right) {
        const next = (out.get(key) ?? 0) + sign * value

        if (!Number.isSafeInteger(next)) {
          return null
        }

        out.set(key, next)
      }

      return out
    }

    if (expr.op === '*') {
      const out: Poly = new Map()

      for (const [k1, v1] of left) {
        for (const [k2, v2] of right) {
          const key = monomialKey([
            ...monomialVars(k1),
            ...monomialVars(k2),
          ])
          const next = (out.get(key) ?? 0) + v1 * v2

          if (!Number.isSafeInteger(v1 * v2) || !Number.isSafeInteger(next)) {
            return null
          }

          out.set(key, next)
        }
      }

      return out
    }
  }

  return null
}

// the degree of a polynomial: the largest number of variables (with multiplicity) in any monomial with a non-zero
// coefficient.
function polynomialDegree(poly: Poly): number {
  let degree = 0

  for (const [key, coefficient] of poly) {
    if (coefficient !== 0) {
      degree = Math.max(degree, monomialVars(key).length)
    }
  }

  return degree
}

// is every monomial of `poly` manifestly non-negative -- each variable to an EVEN power (so the monomial is a perfect
// square, e.g. a^2 b^4 = (a b^2)^2) with a non-negative coefficient? Then the whole polynomial is a sum of non-negative
// terms, hence >= 0 everywhere, at ANY degree (a diagonal sum-of-squares certificate). For STRICT positivity the
// constant term must be positive (at the origin every non-constant monomial vanishes). Sound over any ordered ring.
function evenMonomialNonNegative(poly: Poly, strict: boolean): boolean {
  let constant = 0

  for (const [key, coefficient] of poly) {
    if (coefficient === 0) {
      continue
    }

    if (coefficient < 0) {
      return false
    }

    const counts = new Map<string, number>()

    for (const v of monomialVars(key)) {
      counts.set(v, (counts.get(v) ?? 0) + 1)
    }

    for (const c of counts.values()) {
      if (c % 2 !== 0) {
        return false // an odd power can be negative, so the monomial is not manifestly non-negative
      }
    }

    if (key === '') {
      constant = coefficient
    }
  }

  return strict ? constant > 0 : true
}

// the integer augmented symmetric matrix (2A, scaled to integers) of a quadratic polynomial: variables index the
// leading rows/columns, the final row/column carries the linear and constant terms.
function quadraticMatrix(poly: Poly): number[][] {
  const variables = new Set<string>()

  for (const key of poly.keys()) {
    for (const v of monomialVars(key)) {
      variables.add(v)
    }
  }

  const order = [...variables].sort()
  const index = new Map(order.map((v, i) => [v, i]))
  const size = order.length + 1 // the extra index is the constant component
  const last = order.length

  const matrix = Array.from({ length: size }, () =>
    new Array<number>(size).fill(0),
  )

  for (const [key, coefficient] of poly) {
    const vars = monomialVars(key)

    if (vars.length === 0) {
      matrix[last]![last]! += 2 * coefficient // constant c -> A[last][last] = c, scaled by 2
    } else if (vars.length === 1) {
      const i = index.get(vars[0]!)!
      matrix[i]![last]! += coefficient // linear b_i -> A[i][last] = b_i/2, scaled by 2
      matrix[last]![i]! += coefficient
    } else {
      const i = index.get(vars[0]!)!
      const j = index.get(vars[1]!)!

      if (i === j) {
        matrix[i]![i]! += 2 * coefficient // square x_i^2 -> A[i][i] = coeff, scaled by 2
      } else {
        matrix[i]![j]! += coefficient // cross x_i x_j -> A[i][j] = coeff/2, scaled by 2
        matrix[j]![i]! += coefficient
      }
    }
  }

  return matrix
}

// the exact integer determinant of a small integer matrix (cofactor expansion; sizes here are tiny -- the variable
// count of one goal). `Math.round` removes any floating drift from the multiply/add on integer inputs.
// The SIGN of an integer matrix's determinant, computed EXACTLY by Bareiss fraction-free elimination in BigInt, or
// NaN when an entry is not a safe integer (refused rather than rounded). Until 2026-10-02 this was a floating cofactor
// expansion rounded at the end, exact only while every product stayed under 2^53: with a = 2^30 - 1, b = 2^30,
// d = 2^30 + 1 the minor a·d - b² is -1 and came out 0, so `a x² + 2b xy + d y² >= 0` was PROVEN for a quadratic that
// is -1073741823 at x = 2^30, y = -(2^30 - 1) (test/check/soundness.ts). Every caller only compares the result with 0.
function determinant(matrix: number[][]): number {
  const n = matrix.length

  if (n === 0) {
    return 1
  }

  if (!matrix.every(row => row.every(v => Number.isSafeInteger(v)))) {
    return Number.NaN
  }

  const m = matrix.map(row => row.map(v => BigInt(v)))
  let sign = 1n
  let previous = 1n

  for (let k = 0; k < n - 1; k++) {
    if (m[k]![k] === 0n) {
      const swap = m.findIndex((row, r) => r > k && row[k] !== 0n)

      if (swap < 0) {
        return 0
      }

      ;[m[k], m[swap]] = [m[swap]!, m[k]!]
      sign = -sign
    }

    for (let i = k + 1; i < n; i++) {
      for (let j = k + 1; j < n; j++) {
        // exact: Bareiss's theorem says this division leaves no remainder
        m[i]![j] = (m[i]![j]! * m[k]![k]! - m[i]![k]! * m[k]![j]!) / previous
      }
    }

    previous = m[k]![k]!
  }

  const value = sign * m[n - 1]![n - 1]!

  return value > 0n ? 1 : value < 0n ? -1 : 0
}

const submatrix = (matrix: number[][], indices: number[]): number[][] =>
  indices.map(i => indices.map(j => matrix[i]![j]!))

// positive SEMIDEFINITE: every principal minor (every diagonal-aligned square submatrix's determinant) is >= 0.
function isPositiveSemidefinite(matrix: number[][]): boolean {
  const n = matrix.length

  for (let mask = 1; mask < 1 << n; mask++) {
    const indices: number[] = []

    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) indices.push(i)
    }

    // NaN (an entry that is not a safe integer) is refused: `NaN < 0` is false, and it must not read as a pass
    const minor = determinant(submatrix(matrix, indices))

    if (Number.isNaN(minor) || minor < 0) {
      return false
    }
  }

  return true
}

// positive DEFINITE (Sylvester): every LEADING principal minor is > 0.
function isPositiveDefinite(matrix: number[][]): boolean {
  for (let k = 1; k <= matrix.length; k++) {
    const indices = Array.from({ length: k }, (_, i) => i)

    const minor = determinant(submatrix(matrix, indices))

    if (Number.isNaN(minor) || minor <= 0) {
      return false
    }
  }

  return true
}

// a goal `L >= R` / `L > R` (and the flipped `<=` / `<`) proven by the PSD test: the difference `L - R` (resp. `R - L`)
// is a non-negative (resp. positive) quadratic in any number of variables. Returns false when the fragment does not
// apply (a non-polynomial sub-term, or degree above 2).
function quadraticProves(expr: Expression): boolean {
  if (
    expr.form !== 'binary' ||
    !['>=', '>', '<=', '<'].includes(expr.op)
  ) {
    return false
  }

  const upper = expr.op === '>=' || expr.op === '>' ? expr.left : expr.right
  const lower = expr.op === '>=' || expr.op === '>' ? expr.right : expr.left
  const strict = expr.op === '>' || expr.op === '<'

  const high = expandPolynomial(upper)
  const low = expandPolynomial(lower)

  if (!high || !low) {
    return false
  }

  // difference = upper - lower, the polynomial the claim asserts is non-negative (or positive)
  const difference: Poly = new Map(high)

  for (const [key, value] of low) {
    difference.set(key, (difference.get(key) ?? 0) - value)
  }

  // a manifestly non-negative diagonal sum of squares works at ANY degree (a^4 + b^4, (a^2+b^2)^2, ...)
  if (evenMonomialNonNegative(difference, strict)) {
    return certified(diagonalGram(difference), difference, strict)
  }

  // the COMPLETE quadratic decision (positive-(semi)definiteness) applies only at degree <= 2; a higher-degree form
  // that is not a diagonal SOS is left to a future genuine SOS / SDP procedure rather than mishandled.
  if (polynomialDegree(difference) > 2) {
    return false
  }

  const matrix = quadraticMatrix(difference)
  const found = strict
    ? isPositiveDefinite(matrix)
    : isPositiveSemidefinite(matrix)

  // the matrix is over the variables in sorted order and then the constant, the order quadraticMatrix builds it in
  const variables = new Set<string>()

  for (const key of difference.keys()) {
    for (const v of monomialVars(key)) {
      variables.add(v)
    }
  }

  return found && certified({ basis: [...[...variables].sort(), ''], matrix }, difference, strict)
}

// what a polynomial prover found, replayed by the Gram checker (certificate.ts): the basis as monomial keys, M = 2Q,
// and the polynomial it claims is a sum of squares. A search whose answer does not replay is counted (refine.ts) and
// the goal is reported unproven.
function certified(
  gram: { basis: string[]; matrix: number[][] },
  poly: Poly,
  strict: boolean,
): boolean {
  const target = new Map<string, number>()

  for (const [key, coefficient] of poly) {
    if (coefficient !== 0) {
      const at = gramKey(monomialVars(key))
      target.set(at, (target.get(at) ?? 0) + 2 * coefficient)
    }
  }

  const ok = checkGram({
    basis: gram.basis.map(monomialVars),
    matrix: gram.matrix,
    target,
    strict,
  })

  if (!ok) {
    noteUncertified()
  }

  return ok
}

// the diagonal Gram matrix of a sum of even monomials: each monomial is the square of its half, with weight 2c
function diagonalGram(poly: Poly): { basis: string[]; matrix: number[][] } {
  const terms = [...poly].filter(([, c]) => c !== 0)
  const basis = terms.map(([key]) => halfMonomial(key) ?? key)
  const matrix = terms.map((_, i) => terms.map(([, c], j) => (i === j ? 2 * c : 0)))

  return { basis, matrix }
}

// the combined nonlinear non-negativity check: higher-degree sums/products of squares (`positivityProves`, e.g.
// `(a*a)*(b*b) >= 0`) OR a quadratic-fragment goal by positive-semidefiniteness (`quadraticProves`). Both are
// assumption-free and sound over the reals / any ordered ring; together they discharge the common nonlinear `>= 0` /
// `>` goals the linear prover cannot.
// is a UNIVARIATE polynomial a perfect square q^2 (hence >= 0 everywhere)? This catches non-diagonal forms the
// even-monomial test misses -- `x^4 - 2x^3 + 3x^2 - 2x + 1 = (x^2 - x + 1)^2` -- by recovering q from the top
// coefficients and VERIFYING q^2 == p exactly (the verification is the soundness guarantee). Restricted to a single
// variable with an integer square root; a non-perfect-square or multivariate polynomial declines (sound, incomplete).
function univariatePerfectSquare(poly: Poly): boolean {
  const variables = new Set<string>()

  for (const key of poly.keys()) {
    for (const v of monomialVars(key)) {
      variables.add(v)
    }
  }

  if (variables.size !== 1) {
    return false // multivariate perfect squares need a full SOS / SDP search
  }

  const coefficientOfDegree = new Map<number, number>()
  let degree = 0

  for (const [key, coefficient] of poly) {
    const d = monomialVars(key).length

    coefficientOfDegree.set(d, coefficient)

    if (coefficient !== 0 && d > degree) {
      degree = d
    }
  }

  if (degree < 2 || degree % 2 !== 0) {
    return false
  }

  const c = (k: number): number => coefficientOfDegree.get(k) ?? 0
  const d = degree / 2
  const top = c(degree)
  const root = Math.round(Math.sqrt(top))

  if (top <= 0 || root * root !== top) {
    return false // leading coefficient is not a positive perfect square
  }

  // recover q (degree d) from the top d+1 coefficients: coeff of x^(d+i) is 2 q[d] q[i] + (terms among q[i+1..d-1])
  const q = new Array<number>(d + 1).fill(0)
  q[d] = root

  for (let i = d - 1; i >= 0; i--) {
    let known = 0

    for (let j = i + 1; j <= d - 1; j++) {
      known += q[j]! * q[d + i - j]!
    }

    const numerator = c(d + i) - known

    if (numerator % (2 * root) !== 0) {
      return false // q would need a non-integer coefficient
    }

    q[i] = numerator / (2 * root)
  }

  // the remaining coefficients (x^0 .. x^(d-1)) must agree with q^2, or p is not q^2
  for (let m = 0; m < d; m++) {
    let sum = 0

    for (let j = 0; j <= m; j++) {
      sum += q[j]! * q[m - j]!
    }

    if (sum !== c(m)) {
      return false
    }
  }

  return true
}

// a goal `L >= R` (or `R <= L`) whose difference is a univariate perfect square. A square is >= 0 but not strictly
// > 0, so only the non-strict directions qualify.
function perfectSquareProves(expr: Expression): boolean {
  if (expr.form !== 'binary' || (expr.op !== '>=' && expr.op !== '<=')) {
    return false
  }

  const upper = expr.op === '>=' ? expr.left : expr.right
  const lower = expr.op === '>=' ? expr.right : expr.left
  const high = expandPolynomial(upper)
  const low = expandPolynomial(lower)

  if (!high || !low) {
    return false
  }

  const difference: Poly = new Map(high)

  for (const [key, value] of low) {
    difference.set(key, (difference.get(key) ?? 0) - value)
  }

  return univariatePerfectSquare(difference)
}

// ===== general multivariate sum-of-squares (the nonlinear `nia` / SOS decision via a Gram matrix) =====
// p is a sum of squares (hence >= 0) iff p = z^T Q z for the monomial vector z and a PSD matrix Q. We search for such a
// Q over the NEWTON basis (the half of each even-exponent monomial of p) and -- crucially -- VERIFY the candidate: it
// is accepted only if Q is positive-semidefinite AND z^T Q z equals p exactly. So a wrong search NEVER yields a false
// positive (it can only miss an SOS). This catches the non-diagonal multivariate cases the perfect-square / diagonal
// tests miss, e.g. (a^2 - b^2)^2 written as a^4 + b^4 >= 2 a^2 b^2. The matrix M below is 2Q, kept integer.

// half of a monomial (each exponent halved), or null if any exponent is odd
function halfMonomial(key: string): string | null {
  const counts = new Map<string, number>()

  for (const v of monomialVars(key)) {
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }

  const half: string[] = []

  for (const [v, c] of counts) {
    if (c % 2 !== 0) {
      return null
    }

    for (let i = 0; i < c / 2; i++) {
      half.push(v)
    }
  }

  return monomialKey(half)
}

const multiplyMonomial = (a: string, b: string): string =>
  monomialKey([...monomialVars(a), ...monomialVars(b)])

// the cartesian product of a list of option-lists (for the bounded ambiguous-monomial search)
function cartesian(lists: number[][]): number[][] {
  let out: number[][] = [[]]

  for (const list of lists) {
    const next: number[][] = []

    for (const prefix of out) {
      for (const item of list) {
        next.push([...prefix, item])
      }
    }

    out = next
  }

  return out
}

function multivariateSOS(poly: Poly): boolean {
  const p = new Map([...poly].filter(([, c]) => c !== 0))

  if (p.size === 0) {
    return true // 0 is a sum of squares
  }

  // the Newton basis: the half of each even-exponent monomial of p
  const basisSet = new Set<string>()

  for (const key of p.keys()) {
    const half = halfMonomial(key)

    if (half !== null) {
      basisSet.add(half)
    }
  }

  const basis = [...basisSet]
  const n = basis.length

  if (n === 0 || n > 8) {
    return false // empty or too large for the bounded search
  }

  // the basis pairs (i <= j) that produce each monomial
  const pairsFor = new Map<string, [number, number][]>()

  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const product = multiplyMonomial(basis[i]!, basis[j]!)
      const list = pairsFor.get(product) ?? []
      list.push([i, j])
      pairsFor.set(product, list)
    }
  }

  // every monomial of p must be representable by some pair
  for (const key of p.keys()) {
    if (!pairsFor.has(key)) {
      return false
    }
  }

  const ambiguous = [...p.keys()].filter(
    key => (pairsFor.get(key) ?? []).length > 1,
  )

  if (ambiguous.length > 3) {
    return false // bound the discrete search
  }

  // try assigning each ambiguous monomial's coefficient to one of its producing pairs (the determined ones use their
  // single pair). Build M = 2Q, then VERIFY identity + positive-semidefiniteness.
  for (const combo of cartesian(
    ambiguous.map(key => (pairsFor.get(key) ?? []).map((_, i) => i)),
  )) {
    const matrix = Array.from({ length: n }, () =>
      new Array<number>(n).fill(0),
    )

    for (const [key, coefficient] of p) {
      const pairs = pairsFor.get(key)!
      const [i, j] =
        pairs.length === 1
          ? pairs[0]!
          : pairs[combo[ambiguous.indexOf(key)]!]!

      if (i === j) {
        matrix[i]![i]! += 2 * coefficient
      } else {
        matrix[i]![j]! += coefficient
        matrix[j]![i]! += coefficient
      }
    }

    // VERIFY z^T M z == 2p exactly (every produced monomial matches): the soundness guarantee.
    const produced = new Map<string, number>()

    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        const product = multiplyMonomial(basis[i]!, basis[j]!)
        const contribution = i === j ? matrix[i]![i]! : 2 * matrix[i]![j]!
        produced.set(product, (produced.get(product) ?? 0) + contribution)
      }
    }

    let identity = true

    for (const key of new Set([...produced.keys(), ...p.keys()])) {
      if ((produced.get(key) ?? 0) !== 2 * (p.get(key) ?? 0)) {
        identity = false
        break
      }
    }

    if (identity && isPositiveSemidefinite(matrix)) {
      return certified({ basis, matrix }, p, false)
    }
  }

  return false
}

// a goal `L >= R` / `R <= L` whose difference is a sum of squares.
function sosProves(expr: Expression): boolean {
  if (expr.form !== 'binary' || (expr.op !== '>=' && expr.op !== '<=')) {
    return false
  }

  const upper = expr.op === '>=' ? expr.left : expr.right
  const lower = expr.op === '>=' ? expr.right : expr.left
  const high = expandPolynomial(upper)
  const low = expandPolynomial(lower)

  if (!high || !low) {
    return false
  }

  const difference: Poly = new Map(high)

  for (const [key, value] of low) {
    difference.set(key, (difference.get(key) ?? 0) - value)
  }

  return multivariateSOS(difference)
}

// ===== univariate real positivity via STURM (the one-dimensional CAD base case) =====

// the single-variable coefficient list of a polynomial (`coeff[power]`), or null if it mentions more than one variable.
// A monomial key is the variables joined by spaces, so its power is the number of parts and it is univariate when every
// part is the same variable.
function univariateCoefficients(poly: Poly): number[] | null {
  let only: string | null = null
  const byPower = new Map<number, number>()

  for (const [key, coefficient] of poly) {
    if (coefficient === 0) {
      continue
    }

    const vars = monomialVars(key)

    for (const v of vars) {
      if (only === null) {
        only = v
      } else if (only !== v) {
        return null
      }
    }

    const power = vars.length
    byPower.set(power, (byPower.get(power) ?? 0) + coefficient)
  }

  let degree = 0

  for (const power of byPower.keys()) {
    degree = Math.max(degree, power)
  }

  const coefficients: number[] = new Array(degree + 1).fill(0)

  for (const [power, coefficient] of byPower) {
    coefficients[power] = coefficient
  }

  return coefficients
}

// a goal `L > R` / `R < L` (strict) or `L >= R` / `R <= L` (non-strict) whose UNIVARIATE difference `L - R` is strictly
// positive for all reals, decided exactly by Sturm's theorem (zero real roots and a positive sample). Strict positivity
// implies the non-strict goal too, so one test covers both. This reaches positivity the sum-of-squares and quadratic
// certificates miss -- e.g. `x^4 - 3x^2 + 3 > 0` (no real root, yet not a sum of square monomials) -- and is sound: a
// polynomial with a genuine real root has zero `realRootCount` only when it has none, so it is never falsely certified.
function sturmProves(expr: Expression): boolean {
  if (expr.form !== 'binary') {
    return false
  }

  let upper: Expression
  let lower: Expression
  let strict: boolean

  switch (expr.op) {
    case '>':
      upper = expr.left
      lower = expr.right
      strict = true
      break
    case '>=':
      upper = expr.left
      lower = expr.right
      strict = false
      break
    case '<':
      upper = expr.right
      lower = expr.left
      strict = true
      break
    case '<=':
      upper = expr.right
      lower = expr.left
      strict = false
      break
    default:
      return false
  }

  const high = expandPolynomial(upper)
  const low = expandPolynomial(lower)

  if (!high || !low) {
    return false
  }

  const difference: Poly = new Map(high)

  for (const [key, value] of low) {
    difference.set(key, (difference.get(key) ?? 0) - value)
  }

  const coefficients = univariateCoefficients(difference)

  if (!coefficients) {
    return false
  }

  // a STRICT goal (`>` / `<`) needs the difference strictly positive for all reals; a NON-STRICT goal (`>=` / `<=`)
  // needs it non-negative everywhere, decided completely by the cell decomposition (so it also accepts the touching-zero
  // cases like `(x-1)^2 (x-2)^2 >= 0` that strict positivity cannot, while still rejecting any polynomial that dips
  // below zero).
  return strict
    ? sturmPositiveEverywhere(coefficients)
    : sturmNonNegativeEverywhere(coefficients)
}

// the bivariate coefficient table of a polynomial (`table[i][j]` = coefficient of `var0^i var1^j`), or null if it does
// not mention exactly two variables. A monomial key is the variables joined by spaces, so the power of each variable is
// the count of its occurrences.
function bivariateCoefficients(poly: Poly): Bivariate | null {
  const vars: string[] = []

  for (const [key, coefficient] of poly) {
    if (coefficient === 0) {
      continue
    }

    for (const v of monomialVars(key)) {
      if (!vars.includes(v)) {
        vars.push(v)
      }
    }
  }

  if (vars.length !== 2) {
    return null
  }

  vars.sort()
  const [v0, v1] = vars as [string, string]
  const table: bigint[][] = []

  for (const [key, coefficient] of poly) {
    if (coefficient === 0) {
      continue
    }

    let i = 0
    let j = 0

    for (const v of monomialVars(key)) {
      if (v === v0) {
        i++
      } else {
        j++
      }
    }

    while (table.length <= i) {
      table.push([])
    }

    const row = table[i]!

    while (row.length <= j) {
      row.push(0n)
    }

    row[j] = (row[j] ?? 0n) + BigInt(Math.round(coefficient))
  }

  return table
}

// a NON-STRICT goal `L >= R` / `R <= L` whose two-variable difference `L - R` is non-negative for ALL real values,
// decided exactly by the bivariate cylindrical algebraic decomposition (`cad.ts`). This proves nonlinear positivity with
// NO sum-of-squares certificate -- including the Motzkin polynomial `x^4 y^2 + x^2 y^4 - 3 x^2 y^2 + 1 >= 0`, which is
// non-negative yet provably not a sum of squares, so the SOS / quadratic-form routes cannot reach it. Strict goals are
// not handled here (the decision accepts the touching-zero cases, which are not strictly positive).
function bivariateProves(expr: Expression): boolean {
  if (expr.form !== 'binary') {
    return false
  }

  let upper: Expression
  let lower: Expression

  switch (expr.op) {
    case '>=':
      upper = expr.left
      lower = expr.right
      break
    case '<=':
      upper = expr.right
      lower = expr.left
      break
    default:
      return false
  }

  const high = expandPolynomial(upper)
  const low = expandPolynomial(lower)

  if (!high || !low) {
    return false
  }

  const difference: Poly = new Map(high)

  for (const [key, value] of low) {
    difference.set(key, (difference.get(key) ?? 0) - value)
  }

  const table = bivariateCoefficients(difference)

  if (!table) {
    return false
  }

  return bivariateNonNegative(table)
}

// a NON-STRICT goal `L >= R` / `R <= L` whose THREE-OR-MORE-variable difference is non-negative for all real values,
// decided by the recursive n-variable cylindrical algebraic decomposition (`cad-nvar.ts`). This reaches multivariate
// positivity with no sum-of-squares certificate -- including the trivariate Choi-Lam form. Gated to a modest variable
// count and total degree, since the projection cost grows with both; larger goals are left to the other routes.
function nvarProves(expr: Expression): boolean {
  if (expr.form !== 'binary') {
    return false
  }

  let upper: Expression
  let lower: Expression

  switch (expr.op) {
    case '>=':
      upper = expr.left
      lower = expr.right
      break
    case '<=':
      upper = expr.right
      lower = expr.left
      break
    default:
      return false
  }

  const high = expandPolynomial(upper)
  const low = expandPolynomial(lower)

  if (!high || !low) {
    return false
  }

  const difference: Poly = new Map(high)

  for (const [key, value] of low) {
    difference.set(key, (difference.get(key) ?? 0) - value)
  }

  // collect the distinct variables and the total degree
  const vars: string[] = []
  let totalDegree = 0

  for (const [key, coefficient] of difference) {
    if (coefficient === 0) {
      continue
    }

    const monomial = monomialVars(key)
    totalDegree = Math.max(totalDegree, monomial.length)

    for (const v of monomial) {
      if (!vars.includes(v)) {
        vars.push(v)
      }
    }
  }

  // bound the work: 3 to 4 variables, total degree up to 6 (covers Choi-Lam); anything larger is left unproven here
  if (vars.length < 3 || vars.length > 4 || totalDegree > 6) {
    return false
  }

  vars.sort()
  const index = new Map(vars.map((v, i) => [v, i]))
  const terms: [number[], bigint][] = []

  for (const [key, coefficient] of difference) {
    if (coefficient === 0) {
      continue
    }

    const exps = new Array(vars.length).fill(0)

    for (const v of monomialVars(key)) {
      exps[index.get(v)!]++
    }

    terms.push([exps, BigInt(Math.round(coefficient))])
  }

  return nonNegativeEverywhereNvar(nPoly(terms), vars.length)
}

function nonlinearProves(expr: Expression): boolean {
  return (
    positivityProves(expr) ||
    quadraticProves(expr) ||
    perfectSquareProves(expr) ||
    sosProves(expr) ||
    sturmProves(expr) ||
    bivariateProves(expr) ||
    nvarProves(expr)
  )
}

type Inequality = ReturnType<typeof atMost>

// the atom a monomial of degree two or more becomes among the linear facts
const POLY = '@poly:'

// a polynomial as a linear form over monomial atoms: a variable stays itself, a higher monomial is `@poly:<key>`
function polynomialLinear(poly: Poly): Linear {
  const terms = new Map<string, number>()
  let constant = 0

  for (const [key, c] of poly) {
    if (c === 0) {
      continue
    }

    if (key === '') {
      constant += c
    } else {
      const at = monomialVars(key).length === 1 ? key : POLY + key
      terms.set(at, (terms.get(at) ?? 0) + c)
    }
  }

  return { terms, constant }
}

// the negation of a disjunct as facts: the linear ones when it has them, else its polynomial ones
function orPolynomial(linearFacts: Inequality[], disjunct: Expression): Inequality[] {
  return linearFacts.length > 0 ? linearFacts : polynomialFacts(disjunct, true)
}

// ---- universal hypotheses, by instantiation ----
//
// A hypothesis `for every t, P(t)` is used at terms: each binder is replaced by an argument some quantified function is
// applied to in the goal (and, for a second round, in the instances that produced), every combination, up to a
// bound. Each instance is a fact, so every use is sound (an instance of a universal statement is true). A disjunction
// `A || P` (how a guarded hypothesis `t >= 1 -> P` is written) contributes P where the facts in hand refute A.
// The goal is then decided by the product prover over an ordered field, first by linear combination of the facts
// alone (Farkas), then with products of the facts most relevant to it.

function substituteName(e: Expression, name: string, repl: Expression): Expression {
  switch (e.form) {
    case 'variable':
      return e.name === name ? repl : e
    case 'binary':
      return { ...e, left: substituteName(e.left, name, repl), right: substituteName(e.right, name, repl) }
    case 'unary':
      return { ...e, operand: substituteName(e.operand, name, repl) }
    case 'call':
      return { ...e, args: e.args.map(a => substituteName(a, name, repl)) }
    default:
      return e
  }
}

// the arguments quantified functions are applied to, keyed canonically so one term is counted once
function appliedArguments(e: Expression, into: Map<string, Expression>): void {
  if (e.form === 'call') {
    if (e.callee.form === 'variable' && appliedFunctions.has(e.callee.name)) {
      for (const arg of e.args) {
        const poly = expandPolynomial(arg)

        // an argument that is itself an application (`pt(n)` in `bigf(pt(n))`) is a value, not an index a binder
        // ranges over, and offering it would crowd the indices out of the bounded candidate list
        if (poly && ![...poly.keys()].some(k => monomialVars(k).some(isApplication))) {
          const key = [...poly].filter(([, c]) => c !== 0).map(([k, c]) => `${c}*${k}`).sort().join('+') || '0'
          into.set(key, arg)
        }
      }
    }

    e.args.forEach(a => appliedArguments(a, into))
  } else if (e.form === 'binary') {
    appliedArguments(e.left, into)
    appliedArguments(e.right, into)
  } else if (e.form === 'unary') {
    appliedArguments(e.operand, into)
  }
}

// every instance of the universals over the candidate terms, as expressions
function instances(candidates: Expression[]): Expression[] {
  const out: Expression[] = []

  for (const u of universalHypotheses) {
    const tuples: Expression[][] = [[]]

    for (let i = 0; i < u.binders.length; i++) {
      const next: Expression[][] = []

      for (const t of tuples) {
        for (const c of candidates) {
          next.push([...t, c])
        }
      }

      tuples.splice(0, tuples.length, ...next)
    }

    if (tuples.length > 512) {
      continue
    }

    for (const tuple of tuples) {
      let e = u.expr

      u.binders.forEach((b, i) => {
        e = substituteName(e, b, tuple[i]!)
      })

      out.push(e)
    }
  }

  return out
}

// the facts an instance contributes: a conjunction both sides, a disjunction its one disjunct the others are refuted
// for, and a comparison its linear or polynomial facts
function instanceFacts(e: Expression, available: Inequality[]): Inequality[] {
  if (e.form === 'binary' && e.op === '&&') {
    return [...instanceFacts(e.left, available), ...instanceFacts(e.right, available)]
  }

  if (e.form === 'binary' && e.op === '||') {
    const parts: Expression[] = []
    const flatten = (x: Expression): void => {
      if (x.form === 'binary' && x.op === '||') {
        flatten(x.left)
        flatten(x.right)
      } else {
        parts.push(x)
      }
    }

    flatten(e)

    // a disjunct is refuted when the facts prove its negation, over an ordered field (no integer rounding, which could
    // refute `x(n) < 1` from `x(n) > 0` for a rational x)
    const flip: Record<string, '<' | '<=' | '>' | '>=' | undefined> = { '<': '>=', '<=': '>', '>': '<=', '>=': '<' }
    const open = parts.filter(part => {
      if (part.form !== 'binary' || !flip[part.op]) {
        return true
      }

      return !productGoalLinear({ ...part, op: flip[part.op]! } as Expression, available)
    })

    return open.length === 1 ? instanceFacts(open[0]!, available) : []
  }

  // the instance AS STATED: its linear facts, or else its polynomial ones. (Not orPolynomial, which gives a disjunct's
  // NEGATION for refuting it, and here would assume the opposite of the hypothesis)
  const side: Inequality[] = []
  const linearFacts = assumptionInequalities(e, false, side)

  return linearFacts.length > 0 ? [...side, ...linearFacts] : polynomialFacts(e, false)
}

function universalGoal(expr: Expression, available: Inequality[], seeds: Expression[] = []): boolean {
  if (expr.form === 'binary' && expr.op === '&&') {
    return universalGoal(expr.left, available, seeds) && universalGoal(expr.right, available, seeds)
  }

  // the candidate terms: the goal's applied arguments (and those of the `seeds`, the statements the goal is proved
  // from, such as an induction hypothesis), then those of the first round of instances
  const terms = new Map<string, Expression>()
  appliedArguments(expr, terms)
  seeds.forEach(seed => appliedArguments(seed, terms))
  // and the goal's plain variables, which a hypothesis may need where no call names them (cosh(x + w) needs the
  // addition formula at x and w, and only x + w is an argument)
  plainVariables(expr).forEach(name => terms.set(`1*${name}`, { form: 'variable', name, span: expr.span }))
  // and 0, where a recurrence starts: an induction's base names t(1) and needs the step from t(0)
  if (!terms.has('0')) {
    terms.set('0', { form: 'integer', value: 0, span: expr.span })
  }

  // a first round over the goal's own terms, and a second over the terms its instances name, tried in that order so
  // the smaller fact set is asked first
  for (let round = 0; round < 2; round++) {
    const candidates = [...terms.values()].slice(0, 8)
    const made = instances(candidates)
    const facts = [...available]

    for (const instance of made) {
      facts.push(...instanceFacts(instance, available))
    }


    if (productGoalLinear(expr, facts) || productGoal(expr, facts) || productGoalBridged(expr, facts)) {
      return true
    }

    for (const instance of made) {
      appliedArguments(instance, terms)
    }
  }

  return false
}

// the plain variables an expression reads (not the quantified functions it calls)
function plainVariables(e: Expression): string[] {
  const out = new Set<string>()
  const walk = (x: Expression): void => {
    if (x.form === 'variable' && !appliedFunctions.has(x.name)) {
      out.add(x.name)
    } else if (x.form === 'binary') {
      walk(x.left)
      walk(x.right)
    } else if (x.form === 'unary') {
      walk(x.operand)
    } else if (x.form === 'call') {
      x.args.forEach(walk)
    }
  }

  walk(e)

  return [...out]
}

// the application atoms a fact reads, alone or inside a monomial
function factApplications(q: Inequality): string[] {
  return [...q.linear.terms.keys()].flatMap(k =>
    (k.startsWith(POLY) ? monomialVars(k.slice(POLY.length)) : [k]).filter(isApplication),
  )
}

// PRODUCTS over a small fact set chosen around one BRIDGE: an instance that shares an application with the goal. The
// set is the bridge and every fact whose applications all lie among the goal's and the bridge's, so the products
// stay few. Tried for each bridge in turn. Sound for the same reason productGoal is: only facts, combined by the
// product prover's checked certificate
function productGoalBridged(expr: Expression, facts: Inequality[]): boolean {
  const goalApps = new Set<string>()
  const goalFacts = orPolynomial(assumptionInequalities(expr, true, []), expr)
  goalFacts.forEach(q => factApplications(q).forEach(a => goalApps.add(a)))

  // the facts, each once
  const unique = new Map<string, Inequality>()

  for (const q of facts) {
    const key = [...q.linear.terms].filter(([, c]) => c !== 0).map(([k, c]) => `${k}:${c}`).sort().join(',')
      + `|${q.linear.constant}|${q.strict}`
    unique.set(key, q)
  }

  const all = [...unique.values()]
  // the bridges most tied to the goal first (the most applications in common), and a fixed few of them: a goal that
  // is false would otherwise try every one, each a product search, and the answer must not depend on a time limit
  const shared = (q: Inequality): number => factApplications(q).filter(a => goalApps.has(a)).length
  const bridges = all
    .filter(q => shared(q) > 0)
    .map((q, at) => ({ q, at, score: shared(q) }))
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .map(b => b.q)

  for (const bridge of bridges.slice(0, 6)) {
    const allowed = new Set([...goalApps, ...factApplications(bridge)])
    const chosen = all.filter(q => factApplications(q).every(a => allowed.has(a)))

    if (chosen.length <= 13 && productGoal(expr, chosen)) {
      return true
    }
  }

  return false
}

// PEANO INDUCTION over n >= 0 for a goal about quantified functions, whose recurrences are universal hypotheses:
// the base is the goal at 0, and the step is the goal at n + 1 from the goal at n (as facts) and n >= 0. Both are
// decided by universalGoal, so each instantiates the hypotheses at the terms its own goal names
function universalInduction(goal: Expression, available: Inequality[], n: string): boolean {
  const span = goal.span
  const zero: Expression = { form: 'integer', value: 0, span }
  const next: Expression = {
    form: 'binary',
    op: '+',
    left: { form: 'variable', name: n, span },
    right: { form: 'integer', value: 1, span },
    span,
  }

  // a fact about n is not a fact about 0 or n + 1, so the cases start from the facts that do not read n
  const fixed = available.filter(q => ![...q.linear.terms.keys()].some(k => keyMentions(k, n)))
  const range = atLeast(linear({ [n]: 1 }), linear({}, 0))

  // a BOUNDED induction (`m <= n` beside `fold m`): a guard on the counter that reads it only as itself, linearly, is
  // kept at each case, shifted there: at 0 for the base and at n + 1 for the step. The step's hypothesis P(n) is only
  // available where the guards held at n, so this is sound when the guards at n + 1 imply the guards at n, which is
  // checked (an upper bound on the counter does; a lower bound other than its range does not)
  const counterGuards = available.filter(q => {
    const keys = [...q.linear.terms.keys()].filter(k => keyMentions(k, n))

    return keys.length > 0 && keys.every(k => k === n)
  })
  const shifted = (q: Inequality, by: number): Inequality => ({
    linear: { terms: new Map(q.linear.terms), constant: q.linear.constant + (q.linear.terms.get(n) ?? 0) * by },
    strict: q.strict,
  })
  const atZero = (q: Inequality): Inequality => ({
    linear: { terms: new Map([...q.linear.terms].filter(([k]) => k !== n)), constant: q.linear.constant },
    strict: q.strict,
  })
  const atNext = counterGuards.map(q => shifted(q, 1))
  const downward = counterGuards.every(g => proves([...fixed, range, ...atNext], g))
  const guardsAtZero = downward ? counterGuards.map(atZero) : []
  const guardsAtNext = downward ? atNext : []

  // THE BASE CASE: the goal at 0. Without it this would prove anything the step carries
  if (!universalGoal(substituteName(goal, n, zero), [...fixed, ...guardsAtZero])) {
    return false
  }

  const hypothesis = instanceFacts(goal, [...fixed, range, ...guardsAtNext])

  return universalGoal(substituteName(goal, n, next), [...fixed, range, ...guardsAtNext, ...hypothesis], [goal])
}

// does an atom key read the variable n: the name itself, a monomial holding it, or an application whose arguments
// read it (recorded when the application's key was made)
function keyMentions(key: string, n: string): boolean {
  if (key === n) {
    return true
  }

  if (key.startsWith(POLY)) {
    return monomialVars(key.slice(POLY.length)).some(v => keyMentions(v, n))
  }

  return applicationVariables(key).has(n)
}

// the goal from the facts by linear combination alone (product.ts linear mode), over an ordered field
function productGoalLinear(expr: Expression, available: Inequality[]): boolean {
  if (expr.form !== 'binary' || !['<', '<=', '>', '>=', '=='].includes(expr.op)) {
    return false
  }

  const left = expandPolynomial(expr.left)
  const right = expandPolynomial(expr.right)
  const all = productFacts(available)

  if (!left || !right || !all) {
    return false
  }

  const difference: Poly = new Map(left)

  for (const [key, c] of right) {
    difference.set(key, (difference.get(key) ?? 0) - c)
  }

  const exact = fromNumbers(difference)

  if (!exact) {
    return false
  }

  const negative = new Map([...exact].map(([k, c]) => [k, { n: -c.n, d: c.d }]))

  // an equation may be multiplied by any plain variable the facts or the goal read (an index such as n), never by an
  // application, whose sign and size are unknown
  const multipliers = new Set<string>()

  for (const fact of all) {
    for (const monomial of fact.polynomial.keys()) {
      monomialVars(monomial).filter(v => !isApplication(v)).forEach(v => multipliers.add(v))
    }
  }

  for (const monomial of exact.keys()) {
    monomialVars(monomial).filter(v => !isApplication(v)).forEach(v => multipliers.add(v))
  }

  const linear = { multipliers: [...multipliers] }

  switch (expr.op) {
    case '>=':
      return productProves(all, exact, false, linear)
    case '>':
      return productProves(all, exact, true, linear)
    case '<=':
      return productProves(all, negative, false, linear)
    case '<':
      return productProves(all, negative, true, linear)
    default:
      return productProves(all, exact, false, linear) && productProves(all, negative, false, linear)
  }
}

// the facts a polynomial comparison contributes, in the same `<= 0` / `< 0` shape as assumptionInequalities
function polynomialFacts(cond: Expression, negated: boolean): Inequality[] {
  if (cond.form !== 'binary') {
    return []
  }

  const left = expandPolynomial(cond.left)
  const right = expandPolynomial(cond.right)

  if (!left || !right) {
    return []
  }

  const l = polynomialLinear(left)
  const r = polynomialLinear(right)

  switch (cond.op) {
    case '<':
      return negated ? [atLeast(l, r)] : [below(l, r)]
    case '<=':
      return negated ? [above(l, r)] : [atMost(l, r)]
    case '>':
      return negated ? [atMost(l, r)] : [above(l, r)]
    case '>=':
      return negated ? [below(l, r)] : [atLeast(l, r)]
    case '==':
      return negated ? [] : [atMost(l, r), atLeast(l, r)]
    default:
      return []
  }
}

// a linear fact `l <= 0` (`< 0`) as the product prover's `-l >= 0` (`> 0`), its atoms read back as monomials. A pair
// `l <= 0`, `-l <= 0` is the equation `l == 0`, and is given as one, so products with it keep their sign free.
function productFacts(available: Inequality[]): Fact[] | undefined {
  const out: Fact[] = []
  const used = new Set<number>()

  for (let i = 0; i < available.length; i++) {
    if (used.has(i)) {
      continue
    }

    const q = available[i]!
    const poly = new Map<string, number>()

    for (const [key, c] of q.linear.terms) {
      if (c !== 0) {
        const at = key.startsWith(POLY) ? key.slice(POLY.length) : key

        // a key holding the monomial separator that is not a monomial would be misread as one
        if (!key.startsWith(POLY) && key.includes('\u0000')) {
          return undefined
        }

        poly.set(at, (poly.get(at) ?? 0) - c)
      }
    }

    if (q.linear.constant !== 0) {
      poly.set('', -q.linear.constant)
    }

    const exact = fromNumbers(poly)

    if (!exact) {
      return undefined
    }

    const partner = q.strict
      ? -1
      : available.findIndex((b, j) => j > i && !used.has(j) && !b.strict && negatesLinear(q.linear, b.linear))

    if (partner >= 0) {
      used.add(partner)
      out.push({ polynomial: exact, relation: 'zero' })
    } else {
      out.push({ polynomial: exact, relation: q.strict ? 'positive' : 'nonnegative' })
    }
  }

  return out
}

// the variables a fact or goal mentions, for keeping only the facts connected to the goal
function factVariables(fact: Fact): string[] {
  return [...fact.polynomial.keys()].flatMap(monomialVars)
}

// a comparison goal proven by products of the facts (product.ts): `L >= R` is `L - R >= 0`, an equation is both.
// Only the facts that share a variable with the goal, directly or through other facts, are given, at most twelve.
function productGoal(expr: Expression, available: Inequality[]): boolean {
  if (expr.form !== 'binary' || !['<', '<=', '>', '>=', '=='].includes(expr.op)) {
    return false
  }

  const left = expandPolynomial(expr.left)
  const right = expandPolynomial(expr.right)

  if (!left || !right) {
    return false
  }

  const nonlinear =
    polynomialDegree(left) > 1 ||
    polynomialDegree(right) > 1 ||
    available.some(q => [...q.linear.terms.keys()].some(k => k.startsWith(POLY)))

  if (!nonlinear) {
    return false
  }

  const all = productFacts(available)

  if (!all) {
    return false
  }

  const difference: Poly = new Map(left)

  for (const [key, c] of right) {
    difference.set(key, (difference.get(key) ?? 0) - c)
  }

  const exact = fromNumbers(difference)

  if (!exact) {
    return false
  }

  // keep the facts connected to the goal's variables
  const reach = new Set([...exact.keys()].flatMap(monomialVars))
  let kept: Fact[] = []

  for (let grew = true; grew; ) {
    grew = false
    kept = all.filter(f => factVariables(f).some(v => reach.has(v)))

    for (const f of kept) {
      for (const v of factVariables(f)) {
        if (!reach.has(v)) {
          reach.add(v)
          grew = true
        }
      }
    }
  }

  if (kept.length > 13) {
    return false
  }

  const negative = new Map([...exact].map(([k, c]) => [k, { n: -c.n, d: c.d }]))

  switch (expr.op) {
    case '>=':
      return productProves(kept, exact, false)
    case '>':
      return productProves(kept, exact, true)
    case '<=':
      return productProves(kept, negative, false)
    case '<':
      return productProves(kept, negative, true)
    default:
      return productProves(kept, exact, false) && productProves(kept, negative, false)
  }
}

// two linear forms that are exact negatives (b == -a): the pair of non-strict constraints `a <= 0` and `-a <= 0` is
// how an equality `a == 0` is recorded among the assumptions.
function negatesLinear(a: Linear, b: Linear): boolean {
  if (Math.abs(a.constant + b.constant) > 1e-9) {
    return false
  }

  const keys = new Set<string>([...a.terms.keys(), ...b.terms.keys()])

  for (const k of keys) {
    if (Math.abs((a.terms.get(k) ?? 0) + (b.terms.get(k) ?? 0)) > 1e-9) {
      return false
    }
  }

  return true
}

// are the assumptions INTEGER-INCONSISTENT? A pair `a <= 0`, `-a <= 0` encodes `a == 0`, i.e. `sum ci*xi == -const`; by
// Bezout that has no integer solution when gcd(|ci|) does not divide the constant. Such an assumption can never hold,
// so the branch is unreachable and EVERY goal in it is vacuously true (ex falso). Sound for the same reason as the
// disequality gcd test: Seed's binary +/-/* are integer-only, so any coefficient |c| > 1 (the only case the gcd test
// fires) guarantees integer variables. This catches contradictions the rational Fourier-Motzkin prover cannot (it
// reads `2 a == 3` as satisfiable at a = 3/2).
function integerInconsistent(assumptions: Inequality[]): boolean {
  for (let i = 0; i < assumptions.length; i++) {
    const a = assumptions[i]!

    if (a.strict) {
      continue
    }

    const isEquality = assumptions.some(
      (b, j) => j !== i && !b.strict && negatesLinear(a.linear, b.linear),
    )

    if (!isEquality) {
      continue
    }

    const coefficients = [...a.linear.terms.values()]
      .map(Math.abs)
      .filter(c => c > 1e-12)
      .map(Math.round)

    if (coefficients.length === 0) {
      // a pure constant equation `const == 0` is contradictory exactly when the constant is non-zero
      if (Math.abs(a.linear.constant) > 1e-9) {
        return true
      }

      continue
    }

    const divisor = coefficients.reduce(greatestCommonDivisor, 0)

    if (divisor > 1 && Math.round(a.linear.constant) % divisor !== 0) {
      return true
    }
  }

  return false
}

// a hold goal: the list of inequalities that must ALL hold (an equality goal splits into two), or null if the
// comparison is outside the linear fragment (then it cannot be discharged here). Mod side-constraints go in `side`.
// whether a hold's goal lies in the decidable linear fragment (both sides translate to linear forms). The kernel
// proof layer (elaborate) skips these so the linear prover here is the single authority for arithmetic, which is what
// keeps it from wrongly discharging a value-false claim like `add 3 3 == add 4 4` (the kernel treats number literals
// opaquely, so it cannot tell 6 from 8; the linear prover can).
export function isLinearGoal(expr: Expression): boolean {
  // a nonlinear non-negativity goal (`x*x >= 0`, a sum/product of non-negatives, or a univariate quadratic by its
  // discriminant) is outside both the linear translation and the kernel; claim the ones we actually prove here.
  if (nonlinearProves(expr)) {
    return true
  }

  // a DISEQUALITY `L != R` is in the arithmetic fragment when both sides translate to linear forms. The kernel cannot
  // prove arithmetic disequalities (it views number literals opaquely, so it can never tell 6 from 8), so claiming
  // these here is the right division of labor and never steals a constructor disequality (`succ n != zero`, whose
  // sides are `make`/`call` terms `toLinear` rejects) from the kernel's no-confusion.
  if (expr.form === 'binary' && expr.op === '!=') {
    const side: Inequality[] = []

    return toLinear(expr.left, side) !== undefined &&
      toLinear(expr.right, side) !== undefined
  }

  return goalInequalities(expr, []) !== null
}

function goalInequalities(
  expr: Expression,
  side: Inequality[],
): Inequality[] | null {
  if (expr.form !== 'binary') {
    return null
  }

  // a CONJUNCTION goal (`meet and` -> `P && Q`, ∧) holds when both conjuncts hold: gather every inequality from each
  // side, so the prover must discharge them all. Null if either side falls outside the linear fragment.
  if (expr.op === '&&') {
    const leftGoal = goalInequalities(expr.left, side)
    const rightGoal = goalInequalities(expr.right, side)

    if (leftGoal === null || rightGoal === null) {
      return null
    }

    return [...leftGoal, ...rightGoal]
  }

  const left = toLinear(expr.left, side)
  const right = toLinear(expr.right, side)

  if (!left || !right) {
    return null
  }

  switch (expr.op) {
    case '<':
      return [below(left, right)]
    case '<=':
      return [atMost(left, right)]
    case '>':
      return [above(left, right)]
    case '>=':
      return [atLeast(left, right)]
    case '==':
      return [atMost(left, right), atLeast(left, right)] // a == b  is  a <= b and a >= b
    default:
      return null // != is a disequality, and other operators are non-linear: not provable here
  }
}

// decide whether a goal is provable from the assumptions, handling the propositional structure: a DISJUNCTION
// (`meet or` -> P || Q, ∨) is provable when either disjunct is; a conjunction and the comparisons go through
// goalInequalities (which gathers the inequalities that must ALL hold). Returns true (provable), false (in the linear
// fragment but not provable), or null (outside the fragment -> an unchecked hold, not a failure).
function goalProvable(
  expr: Expression,
  available: Inequality[],
): boolean | null {
  // a theorem with universal hypotheses is decided by instantiating them, over an ordered field and nothing else
  // (universalGoal), so what it proves holds for rational and real values and not only for integers
  if (universalHypotheses.length > 0) {
    return universalGoal(expr, available)
  }

  // EX FALSO: if the assumptions have no integer solution, the branch is unreachable and every goal holds vacuously.
  if (integerInconsistent(available)) {
    return true
  }

  if (expr.form === 'binary' && expr.op === '||') {
    const left = goalProvable(expr.left, available)

    if (left === true) {
      return true
    }

    const right = goalProvable(expr.right, available)

    if (right === true) {
      return true
    }

    // a disjunctive TAUTOLOGY (excluded middle / trichotomy): P || Q holds whenever assuming NOT P proves Q (or
    // assuming NOT Q proves P), since then one side must hold for every value. This is the sound case-split, done by
    // the linear prover: negate one disjunct, add it as an assumption, and try the other. So `n < 0 or n >= 0` proves
    // because not(n < 0) is n >= 0, which is exactly the right disjunct.
    // a polynomial disjunct the linear translation drops is assumed as its monomial atoms (polynomialFacts)
    const notLeft = orPolynomial(assumptionInequalities(expr.left, true, []), expr.left)

    if (
      notLeft.length > 0 &&
      goalProvable(expr.right, [...available, ...notLeft]) === true
    ) {
      return true
    }

    const notRight = orPolynomial(assumptionInequalities(expr.right, true, []), expr.right)

    if (
      notRight.length > 0 &&
      goalProvable(expr.left, [...available, ...notRight]) === true
    ) {
      return true
    }

    // both outside the fragment -> outside; otherwise it is in-fragment but unproven
    return left === null && right === null ? null : false
  }

  // a nonlinear non-negativity goal (`x*x >= 0`, a univariate quadratic, etc.) is discharged directly: it holds for
  // every assignment, no assumptions needed. Tried before the linear translation, which cannot represent it.
  if (nonlinearProves(expr)) {
    return true
  }

  // a DISEQUALITY goal `L != R` is provable when the assumptions force a STRICT SEPARATION: `L < R` everywhere, or
  // `L > R` everywhere. Two values that are strictly ordered are never equal, so this is sound over any ordered
  // domain (rationals and integers alike), and it discharges the recurring arithmetic "unequal" facts (`n + 1 != 0`
  // for a natural n, `i != i + 1`) without a manual case split. The full integer (omega) disequality via a gcd /
  // tightening certificate is a later rung; strict separation is the common, cheap case and never unsound.
  if (expr.form === 'binary' && expr.op === '!=') {
    const dside: Inequality[] = []
    const left = toLinear(expr.left, dside)
    const right = toLinear(expr.right, dside)

    if (!left || !right) {
      return null
    }

    // with the same goal-time facts every other goal gets: remainder signs and sizes, and the far side of max / min.
    // Without them a division owed `d != 0` never saw that `d` is a max of positives
    const facts = [...available, ...dside]
    const all = [...facts, ...signedRemainders(facts, [below(left, right)])]

    if (proves(all, below(left, right)) || proves(all, above(left, right))) {
      return true
    }

    // the integer (omega) gcd test, for disequalities NOT settled by strict separation (e.g. `2 a + 4 b != 3`). The
    // equation `L == R` rearranges to `sum ci*xi == -const`; by Bezout it has an integer solution iff gcd(|ci|)
    // divides the constant. When it does NOT, `L == R` is unsatisfiable over the integers, so `L != R` holds for
    // every assignment. SOUND here because Seed's binary +/-/* are integer-only (rationals/reals are constructed and
    // never reach `toLinear`), so any coefficient with |c| > 1 -- the sole case where the gcd can exceed 1 and the
    // test fire -- guarantees its variable ranges over the integers. With all unit coefficients the gcd is 1, divides
    // everything, and the test never fires, so a bare rational variable comparison is untouched.
    const diff = add(left, scale(right, -1))
    const coefficients = [...diff.terms.values()]
      .map(Math.abs)
      .filter(c => c !== 0)

    if (coefficients.length === 0) {
      // no variables remain: a pure-constant disequality holds exactly when the constants differ
      return diff.constant !== 0
    }

    const divisor = coefficients.reduce(greatestCommonDivisor, 0)

    // `L == R` has no integer solution when the shared factor of the variable coefficients does not divide the
    // constant term; then `L != R` is a theorem.
    return divisor > 1 && diff.constant % divisor !== 0
  }

  const side: Inequality[] = []
  const goals = goalInequalities(expr, side)

  if (!goals) {
    // a polynomial goal is proven, when it can be, by products of the facts
    return productGoal(expr, available) ? true : null
  }

  const facts = [...available, ...side]
  const all = [...facts, ...signedRemainders(facts, goals)]

  return goals.every(goal => proves(all, goal)) || productGoal(expr, available)
}

// a condition used as a path assumption: the inequalities it contributes, optionally negated (for an else branch).
// Conjunctions (&&) contribute both sides; anything outside the linear fragment contributes nothing (sound).
function assumptionInequalities(
  expr: Expression,
  negated: boolean,
  side: Inequality[],
): Inequality[] {
  // `!c` assumes the negation of c, and the negation of `!c` is c. This is how the condition of a finished walk
  // reaches what follows it (check/contract.ts).
  if (expr.form === 'unary' && expr.op === '!') {
    return assumptionInequalities(expr.operand, !negated, side)
  }

  if (expr.form !== 'binary') {
    return []
  }

  if (expr.op === '&&' && !negated) {
    return [
      ...assumptionInequalities(expr.left, false, side),
      ...assumptionInequalities(expr.right, false, side),
    ]
  }

  // not (a or b) is (not a) and (not b)
  if (expr.op === '||' && negated) {
    return [
      ...assumptionInequalities(expr.left, true, side),
      ...assumptionInequalities(expr.right, true, side),
    ]
  }

  const left = toLinear(expr.left, side)
  const right = toLinear(expr.right, side)

  if (!left || !right) {
    return []
  }

  // op, then its negation in parentheses
  switch (expr.op) {
    case '<':
      return negated ? [atLeast(left, right)] : [below(left, right)] //  not(a<b) = a>=b
    case '<=':
      return negated ? [above(left, right)] : [atMost(left, right)] //  not(a<=b) = a>b
    case '>':
      return negated ? [atMost(left, right)] : [above(left, right)]
    case '>=':
      return negated ? [below(left, right)] : [atLeast(left, right)]
    case '==':
      return negated
        ? nonEmpty(left, right)
        : [atMost(left, right), atLeast(left, right)]
    case '!=':
      return negated ? [atMost(left, right), atLeast(left, right)] : nonEmpty(left, right)
    default:
      return []
  }
}

// what a branch condition lets the branch assume, conjunct by conjunct: a conjunction that held makes each of its
// conjuncts hold, so a pure one is assumed even beside one that calls something impure (`left < length and
// get(items, left) < get(items, small)` still gives `left < length`). A negated disjunction is a conjunction of
// negations, and the same goes for it. An impure conjunct alone contributes nothing
function conditionFacts(
  cond: Expression,
  negated: boolean,
  side: Inequality[],
  walk: Walk,
  known: Inequality[] = [],
): Inequality[] {
  if (cond.form === 'unary' && cond.op === '!') {
    return conditionFacts(cond.operand, !negated, side, walk, known)
  }

  if (
    cond.form === 'binary' &&
    ((cond.op === '&&' && !negated) || (cond.op === '||' && negated))
  ) {
    return [
      ...conditionFacts(cond.left, negated, side, walk, known),
      ...conditionFacts(cond.right, negated, side, walk, known),
    ]
  }

  if (callsImpure(cond, walk.pure, walk.functions, walk.local)) {
    return []
  }

  const facts = assumptionInequalities(cond, negated, side)

  // a comparison of POLYNOMIALS the linear translation dropped (`x*x <= y*y`) is kept with each monomial as an atom
  // of its own (`@poly:x x`), for the product prover (product.ts). The linear prover reads such an atom as one more
  // unknown, which only relaxes what it knows, and `forget` projects it out when any of its variables is written.
  if (facts.length === 0) {
    facts.push(...polynomialFacts(cond, negated))
  }

  // `a != b` where what is known already orders them is strict: `small >= i` and `small != i` give `small >= i + 1`
  if (
    cond.form === 'binary' &&
    ((cond.op === '==' && negated) || (cond.op === '!=' && !negated)) &&
    known.length > 0
  ) {
    const left = toLinear(cond.left, side)
    const right = toLinear(cond.right, side)

    if (left && right) {
      const all = [...known, ...side]

      if (proves(all, atLeast(left, right))) {
        facts.push(atLeast(left, add(right, linear({}, 1))))
      } else if (proves(all, atMost(left, right))) {
        facts.push(atMost(left, add(right, linear({}, -1))))
      }
    }
  }

  return facts
}

// A disequality is a disjunction and is not assumed, with ONE exact exception: a length is never negative, so
// `length != 0` is `length >= 1`. That is the `fork` that guards every division by a list's length.
function nonEmpty(left: Linear, right: Linear): Inequality[] {
  const difference = add(left, scale(right, -1))
  const terms = [...difference.terms].filter(([, c]) => c !== 0)

  if (
    terms.length === 1 &&
    difference.constant === 0 &&
    terms[0]![0].startsWith('@length:') &&
    Math.abs(terms[0]![1]) === 1
  ) {
    return [atLeast(linear({ [terms[0]![0]]: 1 }), linear({}, 1))]
  }

  return []
}

// equality assumptions from an immutable binding `x = e` (only when e is linear): x <= e and x >= e
function bindingEqualities(
  name: string,
  value: Expression,
  side: Inequality[],
): Inequality[] {
  const rhs = toLinear(value, side)

  if (!rhs) {
    // a POLYNOMIAL value (an existential witness `find n / (c * c + 1) * b`) is kept over monomial atoms, the way a
    // polynomial condition is (polynomialFacts), so the product prover can use it. A write to the name or to any
    // variable of the value forgets it (`forget` projects out a `@poly:` atom that reads a written name)
    const poly = expandPolynomial(value)

    // a value that reads the name it defines (a shadowing `x = x * x`) is not an equation about one value
    if (!poly || [...poly.keys()].some(key => monomialVars(key).includes(name))) {
      return []
    }

    const lhs = linear({ [name]: 1 })
    const value_ = polynomialLinear(poly)

    return [atMost(lhs, value_), atLeast(lhs, value_)]
  }

  const lhs = linear({ [name]: 1 })

  return [atMost(lhs, rhs), atLeast(lhs, rhs)]
}

export function checkHolds(
  program: Program,
  file: string,
  options: {
    originOnly?: boolean
    tally?: Tally
    only?: Set<string>
    // tasks NOT to walk here, because another pass checks them (compile.ts: the file's own tasks, in the copy)
    skip?: Set<string>
    // the pure tasks, when the caller already knows them (the checker's copy has the real program's answer)
    pure?: Set<string>
    // and the state-free ones, likewise
    stateFree?: Set<string>
    // and the length-keeping ones, and the ones that hand back a list they made
    keeping?: Set<string>
    returning?: Set<string>
  } = {},
): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const pure = options.pure ?? pureFunctions(program)
  const stateFree = options.stateFree ?? stateFreeFunctions(program)
  const keeping = options.keeping ?? lengthKeepingFunctions(program)
  const returning = options.returning ?? returnsFreshFunctions(program)
  const functions = functionNames(program)
  const tables = constantTableLengths(program, pure)
  extrema = extremaOf(program)
  numberFields = numberFieldsOf(program)
  listPops = listPopsOf(program)
  listPushes = listPushesOf(program)
  const globals = new Set(
    program.flatMap(s => (s.form === 'let' ? [s.name] : [])),
  )
  const constants = new Set(
    program.flatMap(s => (s.form === 'let' && !s.mutable ? [s.name] : [])),
  )

  for (const statement of program) {
    if (
      statement.form === 'function' &&
      (!options.only || options.only.has(statement.name)) &&
      !options.skip?.has(statement.name)
    ) {
      // base assumptions from parameter refinements: a natural-number parameter is >= 0. And the lengths of the
      // constant tables, unless a parameter shadows one.
      const shadowed = new Set(statement.params.map(p => p.name))
      const base = [
        ...statement.params
          .filter(p => p.refine === 'natural')
          .map(p => atLeast(linear({ [p.name]: 1 }), linear({}, 0))),
        ...tables.filter(
          q => ![...q.linear.terms.keys()].some(k => shadowed.has(keyRoot(k))),
        ),
      ]

      // and `back`, the value a `must` speaks of, as the declared result
      appliedFunctions = statement.theorem
        ? new Set(statement.params.filter(p => p.type?.kind === 'function').map(p => p.name))
        : new Set()
      universalHypotheses = statement.theorem ? (statement.universals ?? []) : []
      paramForms = paramFormsOf([
        ...statement.params,
        ...(statement.result ? [{ name: 'back', type: statement.result }] : []),
      ])
      textParams = new Set([
        ...statement.params.filter(p => p.type?.kind === 'string').map(p => p.name),
        ...(statement.result?.kind === 'string' ? ['back'] : []),
      ])
      walkHolds(statement.body, base, {
        diagnostics,
        file,
        pure,
        functions,
        // a theorem's quantified functions are pure applications, not locals that may hold anything (see above)
        local: new Set([...localNames(statement)].filter(name => !appliedFunctions.has(name))),
        volatile: volatileNames(statement.body),
        originOnly: options.originOnly,
        tally: options.tally,
        globals,
        stateFree,
        keeping,
        fresh: freshNames(statement, returning),
        returning,
        params: steadyParams(statement),
        constants,
        scalars: scalarLocals(statement.body, statement.params),
        task: statement.method
          ? `${statement.method.form}/${statement.method.name}`
          : statement.name,
      })
    } else if (statement.form === 'hold' && !options.only) {
      // (a pass limited to some tasks leaves the module-level holds to the pass over the whole program)
      // a top-level `hold` declared at module scope: prove it with no assumptions (it has no enclosing parameters).
      // This is what lets a value-arithmetic obligation at the top level (e.g. `add 3 3 == 6`) be discharged by the
      // linear prover, the same as one inside a function body. The kernel pass (elaborate) handles the definitional
      // fragment and records its discharges, which the caller drops from these diagnostics.
      walkHolds([statement], [], {
        diagnostics,
        file,
        pure,
        functions,
        local: new Set(),
        volatile: new Set(),
        originOnly: options.originOnly,
        globals,
        stateFree,
        keeping,
      })
    }
  }

  return diagnostics
}

// what a walk needs besides its assumptions: where to report, which tasks are pure, which names the enclosing task
// binds itself, and which names a closure may write behind the walk's back (facts about those are never kept)
type Walk = {
  diagnostics: Diagnostic[]
  file: string
  pure: Set<string>
  functions: Set<string>
  local: Set<string>
  volatile: Set<string>
  // report only the holds the checker wrote (an `origin`), in its copy of the program
  originOnly?: boolean
  // where tier-0 obligations are counted, instead of being reported as errors
  tally?: Tally
  // the task being walked, for naming a tier-0 failure
  task?: string
  // module-level bindings, and the tasks that touch no Term state (facts.ts stateFreeFunctions)
  globals: Set<string>
  stateFree: Set<string>
  // the tasks that change no list's length anywhere (facts.ts lengthKeepingFunctions)
  keeping: Set<string>
  // the task's names bound only to fresh lists and maps (facts.ts freshNames): two of them never hold one list
  fresh?: Set<string>
  // the tasks that hand back only a list they made (facts.ts returnsFreshFunctions)
  returning?: Set<string>
  // the task's parameters that its body never rebinds
  params?: Set<string>
  // the module's bindings that nothing can rebind (`host`, a `save` that is not mutable): bound before the task ran
  constants?: Set<string>
  // the task's locals that only ever hold scalars (scalarLocals)
  scalars?: Set<string>
}

// the tier-0 count for one compile: how many obligations, how many proven, and the ones that were not, each with
// the task it is in and what it was owed for, which is how a baseline names it without a line number
export type Tally = {
  total: number
  proven: number
  // `ordinal` counts EVERY obligation of that kind in that task, proven or not, in the order they are met. A count
  // of failures alone renumbered every later one when an earlier one became proven, and a baseline keyed on it
  // churned with no change to the code it named.
  failed: {
    task: string
    origin: HoldOrigin
    ordinal: number
    diagnostic: Diagnostic
  }[]
  // the running count per `<task> <kind>`, for the ordinal
  seen?: Map<string, number>
}

// what a checker-written hold was owed for, as the start of its failure message
const OWED: Record<HoldOrigin, string> = {
  must: "this task's `must` is not proven where it sends back",
  need: "the called task's `have` is not proven at this call",
  'keep-entry': "this walk's `must` is not proven before the walk",
  'keep-turn': "this walk's `must` is not proven at the end of a turn",
  down: 'this `down` measure is not shown to stay a natural number and fall',
  index: 'this read is not shown to be inside the list',
  zero: 'this division is not shown to be by something other than zero',
  ends: 'this walk is not shown to end (give it a `down` measure, or note why it runs forever)',
  given: 'a promised fact',
}

// forget these names: their values changed, so a fact about the old value is no longer a fact. But what the facts
// said about OTHER names through them still holds, so each name is PROJECTED out (Fourier-Motzkin: every upper bound
// on it added to every lower bound, which cancels it) rather than its facts dropped. `len - i == 0` and `i == 25`
// leave `len == 25` when `i` is reset, where dropping them left nothing. Over the rationals the projection is exactly
// "some old value existed", so it is sound for integers too; it only gives up the integer tightening. A projection
// that would make too many rows falls back to dropping, which is weaker and still sound. A write whose root has no
// name (EVERYTHING) drops them all.
function forget(current: Inequality[], names: Set<string>): Inequality[] {
  if (names.size === 0) {
    return current
  }

  if (names.has(EVERYTHING)) {
    return []
  }

  let facts = current
  const keys = new Set<string>()

  for (const q of current) {
    for (const key of q.linear.terms.keys()) {
      if (
        names.has(keyRoot(key)) ||
        (key.startsWith(POLY) && monomialVars(key.slice(POLY.length)).some(v => names.has(v)))
      ) {
        keys.add(key)
      }
    }
  }

  for (const key of keys) {
    facts = eliminate(facts, key)
  }

  return facts
}

// WHAT A BODY WRITES, split by what it can change. A name written (`save x`, a binding, a loop's item) is forgotten
// whole. A FIELD written through a plain path (`save self/size`) changes the value at that field of whatever record
// the path reaches, which any other name may also reach, so it is every atom whose path passes through a field of
// that NAME that goes, whatever its root: `@field:t.size`, `@length:q.size.items`. `self/state/length` survives a
// write to `self/size`. A write through a computed index or a list position may grow a list or land anywhere, and
// every state atom goes, as before.
function forgetWrites(current: Inequality[], statement: unknown): Inequality[] {
  const names = new Set<string>()
  const fields = new Set<string>()
  let everything = false

  const visit = (node: unknown): void => {
    if (everything || node === null || typeof node !== 'object') {
      return
    }

    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }

    const record = node as Record<string, unknown>

    switch (record.form) {
      case 'assign': {
        const target = record.target as Expression

        if (target.form === 'variable') {
          names.add(target.name)
        } else if (target.form === 'member' && !target.index && !/^[0-9]+$/.test(target.name) && plainPath(target)) {
          fields.add(target.name)
        } else {
          everything = true
        }

        break
      }
      case 'let':
        names.add(record.name as string)
        break
      case 'for-each':
        names.add(record.item as string)

        if (typeof record.index === 'string') {
          names.add(record.index)
        }

        break
      case 'closure':
      case 'function':
        for (const param of (record.params as { name: string }[] | undefined) ?? []) {
          names.add(param.name)
        }

        break
      case 'guard': {
        const handler = record.catch as { name: string } | undefined

        if (handler) {
          names.add(handler.name)
        }

        break
      }
      default:
        break
    }

    for (const key of Object.keys(record)) {
      if (key !== 'type' && key !== 'span' && key !== 'binding') {
        visit(record[key])
      }
    }
  }

  visit(statement)

  if (everything) {
    return forget(current, names).filter(q => !mentionsAtom(q))
  }

  return dropFields(forget(current, names), fields)
}

// `x = y` with y a record: the two names hold ONE record, so every fact over a field or a length reached through y is
// a fact through x too, copied with x as the root. It stays true under every later change: a write to a field drops
// the facts through that field whatever their root (forgetWrites), a call that may reach a record drops them all,
// and rebinding either name forgets that name's copies
function aliasFacts(
  current: Inequality[],
  name: string,
  value: Expression,
  walk: Walk,
): Inequality[] {
  if (
    value.form !== 'variable' ||
    value.name === name ||
    walk.volatile.has(name) ||
    value.type?.kind !== 'named'
  ) {
    return []
  }

  const from = value.name
  const rename = (key: string): string | undefined => {
    for (const prefix of ['@field:', '@length:']) {
      if (key.startsWith(`${prefix}${from}.`)) {
        return `${prefix}${name}.${key.slice(prefix.length + from.length + 1)}`
      }
    }

    return undefined
  }

  const out: Inequality[] = []

  for (const q of current) {
    const keys = [...q.linear.terms.keys()]

    if (!keys.some(key => rename(key) !== undefined)) {
      continue
    }

    const terms = new Map<string, number>()

    for (const [key, coefficient] of q.linear.terms) {
      const renamed = rename(key) ?? key
      terms.set(renamed, (terms.get(renamed) ?? 0) + coefficient)
    }

    out.push({ ...q, linear: { terms, constant: q.linear.constant } })
  }

  return out
}

// drop every fact over a state atom whose path passes through one of these field names after its root
function dropFields(current: Inequality[], fields: Set<string>): Inequality[] {
  if (fields.size === 0) {
    return current
  }

  return current.filter(q => {
    for (const key of q.linear.terms.keys()) {
      const path = key.startsWith('@field:')
        ? key.slice('@field:'.length)
        : key.startsWith('@length:')
          ? key.slice('@length:'.length)
          : undefined

      if (path !== undefined && path.split('.').slice(1).some(step => fields.has(step))) {
        return false
      }
    }

    return true
  })
}

// a task's parameters that nothing in its body rebinds (a closure's included), so each still holds what it was handed
function steadyParams(fn: { params: { name: string }[]; body: Statement[] }): Set<string> {
  const written = writtenNames(fn.body)

  return new Set(fn.params.map(p => p.name).filter(name => !written.has(name)))
}

// the most rows one elimination may produce before it gives up and drops instead
const MAX_PROJECTED = 200

// Fourier-Motzkin elimination of one atom: the facts that do not mention it, and every sum of an upper and a lower
// bound on it scaled so it cancels
function eliminate(facts: Inequality[], key: string): Inequality[] {
  const kept: Inequality[] = []
  const upper: Inequality[] = []
  const lower: Inequality[] = []

  for (const q of facts) {
    const c = q.linear.terms.get(key) ?? 0

    if (c > 0) {
      upper.push(q)
    } else if (c < 0) {
      lower.push(q)
    } else {
      kept.push(q)
    }
  }

  if (upper.length * lower.length > MAX_PROJECTED) {
    return kept
  }

  const seen = new Set(kept.map(rowKey))

  for (const u of upper) {
    for (const l of lower) {
      const a = u.linear.terms.get(key)!
      const b = -l.linear.terms.get(key)!
      // b*u + a*l: the key's coefficients are a*b and -b*a
      const sum = add(scale(u.linear, b), scale(l.linear, a))
      sum.terms.delete(key)

      for (const [k, v] of [...sum.terms]) {
        if (v === 0) {
          sum.terms.delete(k)
        }
      }

      const row: Inequality = { linear: sum, strict: u.strict || l.strict }

      // a row with no atoms is either always true (drop it) or a contradiction the path already carried (keep it)
      if (sum.terms.size === 0 && (sum.constant < 0 || (sum.constant === 0 && !row.strict))) {
        continue
      }

      const id = rowKey(row)

      if (!seen.has(id)) {
        seen.add(id)
        kept.push(row)
      }
    }
  }

  return kept
}

function rowKey(q: Inequality): string {
  const terms = [...q.linear.terms].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  return `${terms.map(([k, v]) => `${v}*${k}`).join('+')}${q.strict ? '<' : '<='}${-q.linear.constant}`
}

// A WALK THAT ONLY COUNTS UP. Before a loop, every fact about a name its body writes is dropped, because a later
// turn sees a value an earlier turn wrote. That throws away `i >= 0` for a counter that only ever grows, which is
// exactly the fact every index into a list needs. So: when every write to x in the body is `x = x + c` (or
// `x += c`) for a constant c >= 0, a LOWER bound on x stays true however many turns run, and is kept. Counting down
// keeps an upper bound the same way. A fact keeps only if every written name in it moves the way that preserves it.
// Inequalities are `L <= 0` (or `< 0`): a coefficient below zero on x is a lower bound on x, above zero an upper one.
function keepAcrossTurns(
  current: Inequality[],
  body: Statement[],
  walk: Walk,
): Inequality[] {
  return [
    ...keepMonotone(current, body, walk),
    ...relationalInvariants(current, body, walk),
  ]
}

// RELATIONS THAT NO TURN CHANGES. When every turn runs the whole body (no `turn next`, `halt`, `send back` or raise
// anywhere in it) and each of two names moves by a FIXED amount per turn (written only at the top level of the
// body, by `x = x + c`, or a list grown only by top-level pushes), then `dy*x - dx*y` is the same at the top of
// every turn and after the walk. Its value is read off the facts at entry, when both are known exactly. This is the
// counter and the list it fills, stepping together: `i` and `rk/length` both +1 a turn give `length - i == c`.
function relationalInvariants(
  current: Inequality[],
  body: Statement[],
  walk: Walk,
): Inequality[] {
  if (exitsEarly(body)) {
    return []
  }

  const deltas = exactDeltas(body, walk)

  if (deltas.size < 2) {
    return []
  }

  const known = new Map<string, number>()

  for (const key of deltas.keys()) {
    const value = exactValue(current, key)

    if (value !== undefined) {
      known.set(key, value)
    }
  }

  const keys = [...known.keys()]
  const out: Inequality[] = []

  for (let a = 0; a < keys.length; a++) {
    for (let b = a + 1; b < keys.length; b++) {
      const x = keys[a]!
      const y = keys[b]!
      const dx = deltas.get(x)!
      const dy = deltas.get(y)!

      if (dx === 0 && dy === 0) {
        continue
      }

      // dy*x - dx*y never changes, and at entry it is dy*x0 - dx*y0
      const combination = linear({ [x]: dy, [y]: -dx })
      const value = linear({}, dy * known.get(x)! - dx * known.get(y)!)
      out.push(atMost(combination, value), atLeast(combination, value))
    }
  }

  return out
}

// THE COUNTER'S CEILING. A walk `while x < e` (or `x <= e`) whose body moves x by exactly +1 per turn and changes
// nothing e reads keeps `x <= e` (resp. `x <= e + 1`) at the top of every turn and after the walk, provided it held on
// entry: a turn starts with x < e and ends one higher. With the negated condition after the walk, that pins
// x == e, which is what lets a list filled to the count be known exactly and a second walk build on it.
function boundInvariant(
  current: Inequality[],
  statement: Extract<Statement, { form: 'while' }>,
  walk: Walk,
): Inequality[] {
  const cond = statement.cond

  if (
    cond.form !== 'binary' ||
    (cond.op !== '<' && cond.op !== '<=') ||
    exitsEarly(statement.body)
  ) {
    return []
  }

  const left = toLinear(cond.left, [])
  const right = toLinear(cond.right, [])

  if (!left || !right || left.terms.size !== 1) {
    return []
  }

  const [name, coefficient] = [...left.terms][0]!

  if (coefficient !== 1 || exactDeltas(statement.body, walk).get(name) !== 1) {
    return []
  }

  // e must not move: nothing the body writes appears in it
  const written = writtenNames(statement.body)

  for (const key of right.terms.keys()) {
    // (a text's length moves only with its name, which the written check covers)
    if (written.has(keyRoot(key)) || isStateAtom(key)) {
      return []
    }
  }

  // x <= e  (or x <= e + 1 for `<=`), as  x - e - c <= 0
  const ceiling = cond.op === '<' ? right : add(right, linear({}, 1))
  const fact = atMost(left, ceiling)

  return proves(current, fact) ? [fact] : []
}

// does a body leave a turn before its end, anywhere in it (a nested walk's own `halt` included, conservatively)
function exitsEarly(body: Statement[]): boolean {
  let found = false
  const stack: unknown[] = [body]
  const seen = new Set<unknown>()

  while (stack.length > 0 && !found) {
    const node = stack.pop()

    if (node === null || typeof node !== 'object' || seen.has(node)) {
      continue
    }

    seen.add(node)

    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }

    const record = node as Record<string, unknown>

    if (record.form === 'closure' || record.form === 'function') {
      continue
    }

    if (
      record.form === 'break' ||
      record.form === 'continue' ||
      record.form === 'return' ||
      record.form === 'throw' ||
      record.form === 'exit'
    ) {
      found = true
    }

    for (const key of Object.keys(record)) {
      if (key !== 'type' && key !== 'span' && key !== 'binding') {
        stack.push(record[key])
      }
    }
  }

  return found
}

// the fixed per-turn change of every name the body writes ONLY at its top level by a constant step, and of every
// list it grows ONLY by top-level pushes. A name or list touched anywhere else gets no entry.
function exactDeltas(
  body: Statement[],
  walk: Walk,
): Map<string, number> {
  const deltas = new Map<string, number>()
  const disqualified = new Set<string>()
  // names the body has just set to a constant, at its top level, with nothing writing them since
  const reset = new Map<string, number>()
  // pushes made inside nested counted walks whose growth is already in `deltas`
  let countedPushes = 0

  for (const statement of body) {
    if (statement.form === 'assign' && statement.target.form === 'variable') {
      const name = statement.target.name
      const step = stepOf(name, statement)
      const constant =
        statement.op === '=' ? constantOfExpression(statement.value) : undefined

      reset.delete(name)

      if (constant !== undefined && !walk.volatile.has(name)) {
        reset.set(name, constant)
      }

      if (step === undefined || walk.volatile.has(name)) {
        disqualified.add(name)
      } else {
        deltas.set(name, (deltas.get(name) ?? 0) + step)
      }

      continue
    }

    // a binding made afresh each turn is no step, but a constant one is a reset a nested walk can count from
    if (statement.form === 'let') {
      const constant = constantOfExpression(statement.init)

      disqualified.add(statement.name)
      reset.delete(statement.name)

      if (constant !== undefined && !walk.volatile.has(statement.name)) {
        reset.set(statement.name, constant)
      }

      continue
    }

    const pushed = pushedPath(statement, walk)

    if (pushed !== undefined) {
      const key = `@length:${pushed}`
      deltas.set(key, (deltas.get(key) ?? 0) + 1)
      continue
    }

    // A NESTED COUNTED WALK. `r = r0` just before, then `walk while r < K` with K a constant, r moving by exactly +1
    // a turn and the inner body leaving no turn early: it runs K - r0 turns every time, so whatever moves by a fixed
    // step per inner turn moves by that step times K - r0 per outer turn. This is the 4 x 4 walk that fills a block.
    const nested = statement.form === 'while' ? countedTurns(statement, reset, walk) : undefined

    if (nested !== undefined) {
      for (const [key, step] of nested.deltas) {
        if (key === nested.counter) {
          continue
        }

        deltas.set(key, (deltas.get(key) ?? 0) + step * nested.turns)
      }

      countedPushes += nested.pushes

      // the counter ends at K, which is a reset, not a step
      disqualified.add(nested.counter)
      reset.set(nested.counter, nested.turns + reset.get(nested.counter)!)

      for (const name of writtenNames(statement)) {
        if (!nested.deltas.has(name)) {
          disqualified.add(name)
          reset.delete(name)
        }
      }

      continue
    }

    for (const name of writtenNames(statement)) {
      reset.delete(name)
    }

    // any other statement: whatever it writes, nested, is not a fixed step
    for (const name of writtenNames(statement)) {
      disqualified.add(name)
    }
  }

  // a list touched by anything but those pushes (a nested push, an impure call, a member write) has no fixed step
  const allPushes = bodyOnlyPushes(body, walk)
  const otherState = allPushes === false || writesThroughMember(body)
  const topPushes =
    body.filter(s => pushedPath(s, walk) !== undefined).length + countedPushes
  // a push somewhere below the top level runs on some turns and not others
  const nestedPushes = allPushes !== false && allPushes !== topPushes

  for (const key of [...deltas.keys()]) {
    if (disqualified.has(key)) {
      deltas.delete(key)
    } else if (key.startsWith('@') && (otherState || nestedPushes)) {
      deltas.delete(key)
    }
  }

  return deltas
}

// the integer an expression always is, when it reads nothing (`code 0`, `call add(code 2, code 2)`)
function constantOfExpression(expr: Expression): number | undefined {
  const side: Inequality[] = []
  const value = toLinear(expr, side)

  return value && side.length === 0 && value.terms.size === 0 && Number.isInteger(value.constant)
    ? value.constant
    : undefined
}

// how many turns a walk `while r < K` (or `r <= K`) takes when r was just reset to a constant, K is a constant, r
// moves by exactly +1 a turn and no turn ends early, with the fixed per-turn steps of its body and the pushes they
// account for. Undefined for any walk not of that shape, or one whose pushes are not all fixed steps.
function countedTurns(
  statement: Extract<Statement, { form: 'while' }>,
  reset: Map<string, number>,
  walk: Walk,
): { counter: string; turns: number; deltas: Map<string, number>; pushes: number } | undefined {
  const cond = statement.cond

  if (
    cond.form !== 'binary' ||
    (cond.op !== '<' && cond.op !== '<=') ||
    cond.left.form !== 'variable' ||
    exitsEarly(statement.body) ||
    callsImpure(cond, walk.pure, walk.functions, walk.local)
  ) {
    return undefined
  }

  const counter = cond.left.name
  const start = reset.get(counter)
  const limit = constantOfExpression(cond.right)

  if (start === undefined || limit === undefined || walk.volatile.has(counter)) {
    return undefined
  }

  const deltas = exactDeltas(statement.body, walk)

  if (deltas.get(counter) !== 1) {
    return undefined
  }

  const pushes = bodyOnlyPushes(statement.body, walk)

  if (pushes === false) {
    return undefined
  }

  // every push in the body must be a fixed step, or the lengths it grows are not known
  if (pushes > 0 && ![...deltas.keys()].some(key => key.startsWith('@'))) {
    return undefined
  }

  const turns = Math.max(0, (cond.op === '<' ? limit : limit + 1) - start)

  return { counter, turns, deltas, pushes }
}

// the constant a key equals in these facts, when they pin it: some fact bounds it above and some below by the same
// constant, and the prover confirms both
function exactValue(facts: Inequality[], key: string): number | undefined {
  const atom = linear({ [key]: 1 })
  const pinned = (candidate: number): boolean =>
    Number.isInteger(candidate) &&
    proves(facts, atMost(atom, linear({}, candidate))) &&
    proves(facts, atLeast(atom, linear({}, candidate)))

  // a value pinned only THROUGH other facts (`length - i == 0` and `i == 16`) has no fact of its own to read, so the
  // constants the facts mention are tried as candidates, each confirmed by the prover
  const candidates = new Set<number>([0])

  for (const q of facts) {
    candidates.add(q.linear.constant)
    candidates.add(-q.linear.constant)
  }

  for (const candidate of candidates) {
    if (pinned(candidate)) {
      return candidate
    }
  }

  for (const q of facts) {
    if (q.linear.terms.size !== 1 || q.strict) {
      continue
    }

    const coefficient = q.linear.terms.get(key)

    if (coefficient === undefined || Math.abs(coefficient) !== 1) {
      continue
    }

    // `c*key + k <= 0` gives the candidate key = -k/c
    const candidate = -q.linear.constant / coefficient
    const atom = linear({ [key]: 1 })
    const value = linear({}, candidate)

    if (
      Number.isInteger(candidate) &&
      proves(facts, atMost(atom, value)) &&
      proves(facts, atLeast(atom, value))
    ) {
      return candidate
    }
  }

  return undefined
}

function keepMonotone(
  current: Inequality[],
  body: Statement[],
  walk: Walk,
): Inequality[] {
  const written = writtenNames(body)

  if (written.has(EVERYTHING)) {
    return []
  }

  const direction = new Map<string, 'up' | 'down' | 'any'>()

  for (const name of written) {
    direction.set(name, walk.volatile.has(name) ? 'any' : directionOf(name, body))
  }

  // STATE ACROSS TURNS. A later turn sees every list an earlier turn changed. When the body only ever PUSHES (with
  // pure arguments), lengths only grow, so a LOWER bound on a length survives every turn and anything else about a
  // length does not. Any other impure call, or any write through a member, and no length fact survives at all.
  // a body whose impure calls are all `set`s (or tasks that only make them) changes no length and no field, so the
  // state facts survive every turn whole: only what was known THROUGH a position goes, which dropElementPaths takes
  const pushes = bodyOnlyPushes(body, walk)
  const changesState =
    !(onlyKeepsLengths(body, walk) && !writesThroughMember(body)) &&
    (pushes === false || pushes > 0 || writesThroughMember(body))

  // any impure call at all may change a list that is not local to this task, so no such length survives a turn,
  // unless every one is a call that changes no length (keepsLengths) or a push onto a list this task made
  // a `set` anywhere in the body may change what a list position holds
  if (callsImpure(body, walk.pure, walk.functions, walk.local)) {
    current = dropElementPaths(current)
  }

  if (
    callsImpure(body, walk.pure, walk.functions, walk.local) &&
    !onlyKeepsLengths(body, walk, true)
  ) {
    current = current.filter(q => {
      for (const key of q.linear.terms.keys()) {
        if (isStateAtom(key) && key.startsWith('@') && !walk.local.has(keyRoot(key))) {
          return false
        }
      }

      return true
    })
  }

  if (changesState) {
    // the lists the body pushes to, when pushes are all it does: a length of a list provably not one of them is not
    // changed at all, so its facts survive whole (the inner walks of MD5 push to `w`, never to `m`)
    const pushedTo = pushes !== false && !writesThroughMember(body) ? pushTargets(body, walk) : undefined
    const untouched = (key: string): boolean => {
      if (!pushedTo || !key.startsWith('@length:')) {
        return false
      }

      const other = key.slice('@length:'.length)

      return (
        !other.includes('.') &&
        [...pushedTo].every(
          target =>
            target !== other &&
            walk.fresh?.has(target) === true &&
            (walk.fresh.has(other) ||
              walk.params?.has(other) === true ||
              (walk.constants?.has(other) === true && !walk.local.has(other))),
        )
      )
    }

    current = current.filter(q => {
      for (const [key, coefficient] of q.linear.terms) {
        if (!key.startsWith('@') || key.startsWith('@text:') || untouched(key)) {
          continue
        }

        // a push changes a length and no field: a field fact goes only when something else changes state
        if (key.startsWith('@field:')) {
          if (pushes === false || writesThroughMember(body)) {
            return false
          }

          continue
        }

        if (pushes === false || writesThroughMember(body) || coefficient >= 0) {
          return false
        }
      }

      return true
    })
  }

  return current.filter(q => {
    for (const [key, coefficient] of q.linear.terms) {
      const way = direction.get(keyRoot(key))

      if (way === undefined) {
        continue
      }

      // a length atom moves with whatever the body does to its list, which this does not track (a text's length
      // moves only with its name, and a written name drops it here too)
      if (key.startsWith('@')) {
        return false
      }

      if (way === 'any') {
        return false
      }

      if (way === 'up' && coefficient >= 0) {
        return false
      }

      if (way === 'down' && coefficient <= 0) {
        return false
      }
    }

    return true
  })
}

// how a body moves a name: 'up' when every write is an increment by a constant >= 0, 'down' for decrements, 'any'
// otherwise (a rebinding, a computed step, a write inside a closure, a member write)
function directionOf(name: string, body: Statement[]): 'up' | 'down' | 'any' {
  let ups = 0
  let downs = 0
  let other = false
  const stack: unknown[] = [body]
  const seen = new Set<unknown>()

  while (stack.length > 0 && !other) {
    const node = stack.pop()

    if (node === null || typeof node !== 'object' || seen.has(node)) {
      continue
    }

    seen.add(node)

    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }

    const record = node as Record<string, unknown>

    if (record.form === 'closure' || record.form === 'function') {
      if (writtenNames(record.body).has(name)) {
        other = true
      }

      continue
    }

    if (record.form === 'let' && record.name === name) {
      other = true
    }

    if (record.form === 'for-each' && (record.item === name || record.index === name)) {
      other = true
    }

    if (record.form === 'assign') {
      const statement = record as Extract<Statement, { form: 'assign' }>

      if (rootName(statement.target) === name || rootName(statement.target) === undefined) {
        const step = stepOf(name, statement)

        if (step === undefined || statement.target.form !== 'variable') {
          other = true
        } else if (step >= 0) {
          ups++
        } else {
          downs++
        }
      }
    }

    for (const key of Object.keys(record)) {
      if (key !== 'type' && key !== 'span' && key !== 'binding') {
        stack.push(record[key])
      }
    }
  }

  if (other) {
    return 'any'
  }

  if (downs === 0) {
    return 'up'
  }

  if (ups === 0) {
    return 'down'
  }

  return 'any'
}

// the constant an assignment adds to a name (`x = x + 2` is 2, `x -= 1` is -1), or undefined when it is not one
function stepOf(
  name: string,
  statement: Extract<Statement, { form: 'assign' }>,
): number | undefined {
  const side: Inequality[] = []
  const value = toLinear(statement.value, side)

  if (!value || side.length > 0) {
    return undefined
  }

  if (statement.op === '=') {
    if ((value.terms.get(name) ?? 0) !== 1 || value.terms.size !== 1) {
      return undefined
    }

    return value.constant
  }

  if (statement.op === '+=' || statement.op === '-=') {
    if (value.terms.size !== 0) {
      return undefined
    }

    return statement.op === '+=' ? value.constant : -value.constant
  }

  return undefined
}

// the equality a binding or an assignment `x = e` contributes, or nothing when it is not a stable fact: `e` reads `x`
// itself (the old value, which is now gone), or `x` is volatile. State is safe here because `toLinear` reads no state
// but a list's length, which is an atom forgotten with its list and after every impure call.
function definingEqualities(
  name: string,
  value: Expression,
  walk: Walk,
): Inequality[] {
  if (walk.volatile.has(name) || readsAny(value, walk.volatile)) {
    return []
  }

  // `x = e` where e reads the OLD x: an equation `x == e` would be about two values under one name. But when e's
  // linear form does not mention x (`x = bitwise-and(x * 33, mask)` is a bounded atom, whatever x was), the new x is
  // that form, and every side fact that mentions the old x is dropped
  if (readNames(value).has(name)) {
    const side: Inequality[] = []
    const v = toLinear(value, side)
    const mentions = (q: Inequality): boolean =>
      [...q.linear.terms.keys()].some(key => keyRoot(key) === name)

    if (!v || [...v.terms.keys()].some(key => keyRoot(key) === name)) {
      return []
    }

    const atom = linear({ [name]: 1 })

    return [...side.filter(q => !mentions(q)), atMost(atom, v), atLeast(atom, v)]
  }

  // a list literal: its length is the number of items written, a fact about the atom `@length:name`, which every
  // write through a member and every impure call forgets
  if (value.form === 'array') {
    return literalLength(name, value.items.length)
  }

  // a record built in place: each number field is its value, and each list field written as a literal has that
  // literal's length. `make hash-table / bind capacity, read capacity / bind state, make list` gives
  // `table/capacity == capacity` and `table/state/length == 0`. Those are state atoms, forgotten as fields are
  if (value.form === 'record') {
    const out: Inequality[] = []
    const numbers = numberFields.get(value.name)

    for (const field of value.fields) {
      if (field.value.form === 'array') {
        out.push(...literalLength(`${name}.${field.name}`, field.value.items.length))
        continue
      }

      // a list field given a list held by a name: the record's list IS that list, so the lengths are equal
      if (field.value.form === 'variable' && field.value.type?.kind === 'array') {
        const same = linear({
          [`@length:${name}.${field.name}`]: 1,
          [`@length:${field.value.name}`]: -1,
        })
        out.push(atMost(same, linear({}, 0)), atLeast(same, linear({}, 0)))
        continue
      }

      if (!numbers?.has(field.name) || readsAny(field.value, walk.volatile)) {
        continue
      }

      const side: Inequality[] = []
      const v = toLinear(field.value, side)

      if (v) {
        const atom = linear({ [`@field:${name}.${field.name}`]: 1 })
        out.push(...side, atMost(atom, v), atLeast(atom, v))
      }
    }

    return out
  }

  // `x = y` with y a list: the two names hold ONE list, so their lengths are equal. Sound under every later change:
  // a push to either rewrites that one's length and forgets every other length fact, this one included
  if (value.form === 'variable' && value.type?.kind === 'array') {
    const same = linear({ [`@length:${name}`]: 1, [`@length:${value.name}`]: -1 })

    return [atMost(same, linear({}, 0)), atLeast(same, linear({}, 0))]
  }

  const side: Inequality[] = []
  const equalities = bindingEqualities(name, value, side)

  return [...side, ...equalities]
}

// walk a body in order, threading the path assumptions: branch conditions refine their branches, the else branch
// assumes the negation, and a binding or assignment contributes its defining equality to what follows. Every write
// first drops the facts about the name it writes, and every compound statement drops, afterwards, the facts about
// every name its bodies may have written. A loop drops them BEFORE its body too, because a later turn sees values an
// earlier turn wrote.
function walkHolds(
  body: Statement[],
  assumptions: Inequality[],
  walk: Walk,
): Inequality[] | null {
  const { diagnostics, file } = walk
  let current = forget(assumptions, walk.volatile)

  for (const statement of body) {
    // what was known before this statement, for the effects that depend on it (a pop off a list known non-empty)
    const before = current

    switch (statement.form) {
      case 'hold': {
        // a callee's `must`, assumed where the call returns (check/contract.ts promisedBy): it is proven where the
        // callee is checked, so here it is a fact, in line, and the statements after it keep their place in the body
        if (statement.origin === 'given') {
          if (!callsImpure(statement.expr, walk.pure, walk.functions, walk.local)) {
            const side: Inequality[] = []
            const facts = assumptionInequalities(statement.expr, false, side)
            current = [...current, ...side, ...facts]
          }

          break
        }

        // in a pass over the checker's copy (check/contract.ts), a hold the programmer wrote was already checked in
        // the real program, and only the ones the checker wrote are this pass's to report
        if (walk.originOnly && !statement.origin) {
          break
        }

        // a goal that calls something two calls may disagree on cannot be decided by any prover here: the linear
        // and polynomial engines read a call as an atom, and an atom is equal to itself
        // (an impure call inside a masked value is not a reason: impureOutsideMasks)
        // `fold n` in a theorem with universal hypotheses: induction over n here, each case decided the way such a
        // goal is (universalInduction). The kernel pass leaves these to this one
        const induction =
          universalHypotheses.length > 0 && statement.proof?.[0]?.head === 'fold' ? statement.proof[0].arg : undefined

        const verdict = impureOutsideMasks(statement.expr, walk)
          ? null
          : induction
            ? universalInduction(statement.expr, current, induction)
            : goalProvable(statement.expr, current)

        const owed = statement.origin ? OWED[statement.origin] : undefined
        // a tier-0 obligation is COUNTED, not failed: nobody wrote it, so the gate holds it to a baseline (term
        // hold) rather than the build refusing code that was fine yesterday. note/term/proof-by-default/obligations.md
        const tier0 =
          statement.origin === 'index' ||
          statement.origin === 'zero' ||
          statement.origin === 'ends'
        let ordinal = 0

        if (tier0 && walk.tally) {
          walk.tally.seen ??= new Map()
          const kind = `${walk.task ?? ''} ${statement.origin}`
          ordinal = walk.tally.seen.get(kind) ?? 0
          walk.tally.seen.set(kind, ordinal + 1)
        }

        const report: { push: (d: Diagnostic) => void } =
          tier0 && walk.tally
            ? {
                push: d =>
                  walk.tally!.failed.push({
                    task: walk.task ?? '',
                    origin: statement.origin!,
                    ordinal,
                    diagnostic: d,
                  }),
              }
            : diagnostics

        if (tier0 && walk.tally) {
          walk.tally.total++
        }

        if (verdict === true && tier0 && walk.tally) {
          walk.tally.proven++
        }

        if (verdict === null) {
          report.push(
            diagnose('unchecked-hold', {
              file,
              span: statement.span,
              message: owed
                ? `${owed}, and it is outside what the provers decide`
                : 'this hold is outside the decidable linear fragment and was not proven',
            }),
          )
        } else if (verdict === false) {
          report.push(
            diagnose('unproven', {
              file,
              span: statement.span,
              message: owed
                ? `${owed}: it does not follow from what is known here`
                : 'this hold could not be proven from the available assumptions',
            }),
          )
        }

        break
      }

      case 'let':
        // a binding, `host` or `save`, is a new value under its name: the old facts go, the defining equality comes.
        // A `save` binding used to contribute nothing, because nothing retracted it when it was reassigned. Now the
        // assignment below retracts it, so it may.
        current = forget(current, new Set([statement.name]))
        current = [
          ...current,
          ...definingEqualities(statement.name, statement.init, walk),
          ...aliasFacts(current, statement.name, statement.init, walk),
        ]
        holdsInExpression(statement.init, walk)
        break

      case 'assign': {
        const root = rootName(statement.target) ?? EVERYTHING
        // `x = x + c` (or `x += c`) does not lose what was known about x: the old value is the new one less c, so
        // every fact about the old value is rewritten as a fact about the new one. This is what a fresh name per
        // assignment gives for free, and it is what lets a walk's `down` measure be shown to fall.
        const shifted =
          statement.target.form === 'variable'
            ? shiftFacts(current, root, statement, walk)
            : undefined

        // `x = e` where e reads the OLD x (`y = x % y`): the old x is renamed to a fresh atom in every fact, e's own
        // facts are added with it, the new x is e, and then the old one is projected out. Nothing true of the old
        // value is lost on the way, which dropping the facts that mention it lost (the snapshot of `y` that bounds
        // `x % y` is exactly such a fact)
        const reread =
          shifted === undefined &&
          statement.op === '=' &&
          statement.target.form === 'variable' &&
          !walk.volatile.has(root) &&
          readNames(statement.value).has(root)

        if (reread) {
          const old = `${root}#was${modCounter++}`
          const renamed = (q: Inequality): Inequality => {
            if (!q.linear.terms.has(root)) {
              return q
            }

            const terms = new Map(q.linear.terms)
            terms.set(old, terms.get(root)!)
            terms.delete(root)

            return { ...q, linear: { terms, constant: q.linear.constant } }
          }
          const side: Inequality[] = []
          const v = toLinear(statement.value, side)

          if (v) {
            const now = linear({ [root]: 1 })
            const value = renamed({ linear: v, strict: false }).linear

            current = forget(
              [...current.map(renamed), ...side.map(renamed), atMost(now, value), atLeast(now, value)],
              new Set([old]),
            )
            holdsInExpression(statement.value, walk)
            break
          }
        }

        // a write through a member changes the field it names (or, through an index, anything): forgetWrites. The
        // record's own name still holds the same record, so it is not forgotten whole
        current =
          statement.target.form === 'member'
            ? forgetWrites(current, statement)
            : (shifted ?? forget(current, new Set([root])))

        // a plain `x = e` (not `x += e`, not a member write) is the same kind of fact a binding is
        if (
          shifted === undefined &&
          statement.op === '=' &&
          statement.target.form === 'variable'
        ) {
          current = [
            ...current,
            ...definingEqualities(root, statement.value, walk),
          ]
        }

        holdsInExpression(statement.value, walk)
        break
      }

      case 'expression':
        holdsInExpression(statement.expr, walk)
        break

      case 'return':
        if (statement.value) {
          holdsInExpression(statement.value, walk)
        }

        break

      case 'if': {
        // the conditions run before any branch (each before the next): what their impure calls may change goes first
        for (const branch of statement.branches) {
          current = impureEffect(current, branch.cond, walk)
        }

        const negations: Inequality[] = []
        // the facts at the end of every path that reaches the join (joinFacts)
        const ends: Inequality[][] = []

        for (const branch of statement.branches) {
          const side: Inequality[] = []
          const conditions = conditionFacts(branch.cond, false, side, walk, [...current, ...negations])

          const end = walkHolds(
            branch.body,
            [...current, ...negations, ...side, ...conditions],
            walk,
          )

          if (end) {
            ends.push(end)
          }

          negations.push(...conditionFacts(branch.cond, true, [], walk, [...current, ...negations]))
        }

        if (statement.otherwise) {
          const end = walkHolds(statement.otherwise, [...current, ...negations], walk)

          if (end) {
            ends.push(end)
          }
        } else {
          // no `else`: the path that took no branch reaches the join with every condition false
          ends.push([...current, ...negations])
        }

        const written = writtenNames(statement)

        if (ends.length === 1) {
          // when only ONE path reaches the join (every branch but one leaves: `if i < 0, halt`), what follows knows
          // exactly what that path ends with, the negated conditions included
          current = ends[0]!
        } else {
          // every path's facts already carry its own effects (a push in one branch, a write in another), so a fact
          // from before survives only when untouched by any branch (no written name, no state) or proven on every
          // path; this replaces dropping every state fact because some branch made some impure call
          const stable = (q: Inequality): boolean =>
            !mentionsAtom(q) && ![...q.linear.terms.keys()].some(k => written.has(keyRoot(k)))
          const augmented = ends.map(end => [...end, ...signedRemainders(end)])

          current = [
            ...current.filter(stable),
            ...current.filter(q => !stable(q) && augmented.every(path => proves(path, q))),
            ...joinFacts(ends, written),
          ]
        }

        break
      }

      case 'while': {
        // the loop body runs only when the condition holds, about the values at the top of THIS turn: a fact from
        // before the loop about a name the body writes is not true on the second turn, unless the body only ever
        // moves that name the way that keeps the fact (keepAcrossTurns)
        const before = [
          ...keepAcrossTurns(current, statement.body, walk),
          ...boundInvariant(current, statement, walk),
        ]
        const side: Inequality[] = []
        const conditions = conditionFacts(statement.cond, false, side, walk)

        walkHolds(statement.body, [...before, ...side, ...conditions], walk)

        // a walk that never leaves a turn early ends only when its condition is false, so that is a fact after it
        const ended = !exitsEarly(statement.body)
          ? conditionFacts(statement.cond, true, [], walk)
          : []

        current = [...before, ...ended]
        break
      }

      case 'for-each': {
        const before = forget(
          keepAcrossTurns(current, statement.body, walk),
          new Set([statement.item, ...(statement.index ? [statement.index] : [])]),
        )

        walkHolds(statement.body, before, walk)
        current = before
        break
      }

      case 'match':
        for (const branch of statement.cases) {
          walkHolds(
            branch.body,
            forget(current, new Set(branch.binds ?? [])),
            walk,
          )
        }

        if (statement.otherwise) {
          walkHolds(statement.otherwise, current, walk)
        }

        current = forgetWrites(current, statement)
        break

      case 'guard': {
        // the body may stop at any statement and land in the handler, so the handler knows only what was true
        // before the body began, less whatever the body may have written
        walkHolds(statement.body, current, walk)

        const after = forgetWrites(current, statement.body)

        if (statement.catch) {
          walkHolds(
            statement.catch.body,
            forget(after, new Set([statement.catch.name])),
            walk,
          )
        }

        current = forgetWrites(current, statement)
        break
      }

      case 'function': {
        // a nested task is its own scope: its holds are checked from its own parameters, never from the facts of
        // the task around it, which may have changed by the time it runs
        const outer = paramForms
        paramForms = new Map([...outer, ...paramFormsOf(statement.params)])
        walkHolds(statement.body, [], {
          ...walk,
          local: localNames(statement),
          volatile: volatileNames(statement.body),
          fresh: freshNames(statement, walk.returning),
          params: steadyParams(statement),
        })
        paramForms = outer
        break
      }

      default:
        break
    }

    // a statement that calls an impure task may have written through any record and changed any function's result,
    // so every fact that reads a member or a call goes. Facts about plain locals stay: no callee can reach them,
    // except through a closure, and a name a closure writes is volatile and never had a fact to begin with.
    //
    // ONE EXCEPTION, `p/push v` on a plain path with a pure argument: the list's length grows by exactly one, so
    // the facts about `@length:p` are rewritten (old length is new length less one) rather than forgotten. Every
    // OTHER length still goes, because another name may hold the same list.
    // `p/pop` on a list the facts show is not empty takes exactly one item off: the old length is the new one plus one,
    // so every fact about it is rewritten rather than forgotten. Every other length goes unless provably a different
    // list, as for a push. A list that may be empty is left to the general rule below, which forgets it
    const shrunk = poppedPath(statement)
    const shrunkKey = shrunk !== undefined ? `@length:${shrunk}` : undefined
    const nonEmpty =
      shrunkKey !== undefined &&
      proves(before, atLeast(linear({ [shrunkKey]: 1 }), linear({}, 1)))

    if (shrunkKey !== undefined && nonEmpty) {
      current = current
        .filter(q => {
          for (const k of q.linear.terms.keys()) {
            // a pop changes one list's length and no record's field
            if (k !== shrunkKey && isStateAtom(k) && !k.startsWith('@field:')) {
              return false
            }
          }

          return true
        })
        .map(q => {
          const a = q.linear.terms.get(shrunkKey) ?? 0

          return a === 0
            ? q
            : { ...q, linear: { ...q.linear, constant: q.linear.constant + a } }
        })

      continue
    }

    const grown = pushedPath(statement, walk)

    if (grown !== undefined) {
      const key = `@length:${grown}`
      // a push to a name bound only to fresh lists leaves the length of every list that is not that one: another such
      // name (each holds lists only it made), a parameter the task never rebinds, or a module binding nothing can
      // rebind (both held their list before the fresh one existed: MD5's round tables). A path into a list is not
      // covered: the fresh list may have been pushed into it.
      const apart = (k: string): boolean => {
        const other = k.startsWith('@length:') ? k.slice('@length:'.length) : undefined

        // a path is dotted (plainPath): `@length:rows.0`
        return (
          other !== undefined &&
          !other.includes('.') &&
          other !== grown &&
          walk.fresh?.has(grown) === true &&
          (walk.fresh.has(other) ||
            walk.params?.has(other) === true ||
            (walk.constants?.has(other) === true && !walk.local.has(other)))
        )
      }

      current = [
        ...current
          .filter(q => {
            for (const k of q.linear.terms.keys()) {
              // a push changes one list's length and no record's field
              if (
                k !== key &&
                isStateAtom(k) &&
                !k.startsWith('@field:') &&
                !apart(k)
              ) {
                return false
              }
            }

            return true
          })
          .map(q => {
            const a = q.linear.terms.get(key) ?? 0

            return a === 0
              ? q
              : {
                  ...q,
                  linear: { ...q.linear, constant: q.linear.constant - a },
                }
          }),
        // and whatever it was before, a list just pushed onto holds at least one item
        atLeast(linear({ [key]: 1 }), linear({}, 1)),
      ]
    } else if (statement.form !== 'function' && statement.form !== 'if') {
      // (an `if` has had its effects applied path by path, and its conditions' before its branches: the `if` case)
      current = impureEffect(current, statement, walk)
    }
  }

  // what is known at the end of the body, for a join to merge (the `if` case), or null when the body's last statement
  // leaves it, so that no path through it reaches what follows. A body that leaves only some of the time returns its
  // facts, which is weaker for the join and so still sound
  const last = body[body.length - 1]

  return last && LEAVES.has(last.form) ? null : current
}

const LEAVES = new Set(['return', 'throw', 'break', 'continue', 'exit'])

// what a statement's (or expression's) impure calls leave of the facts: a `set`, or a call to a task that only does
// such things, changes no length and no field, so only what was known THROUGH a list position goes. Any other impure
// call may change any state, except that one which cannot reach a LOCAL list (it was handed only scalars, and it is a
// task of the program rather than a function value) leaves local lengths alone
function impureEffect(current: Inequality[], node: unknown, walk: Walk): Inequality[] {
  if (!callsImpure(node, walk.pure, walk.functions, walk.local)) {
    return current
  }

  if (onlyKeepsLengths(node, walk)) {
    return dropElementPaths(current)
  }

  if (onlyPushingLoop(node as Statement, walk)) {
    return current
  }

  const reached = reachesLists(node, walk)

  return current.filter(q => {
    if (!mentionsAtom(q)) {
      return true
    }

    if (reached) {
      return false
    }

    for (const key of q.linear.terms.keys()) {
      if (isStateAtom(key) && key.startsWith('@') && !walk.local.has(keyRoot(key))) {
        return false
      }
    }

    return true
  })
}

// THE JOIN AFTER A BRANCH. Each path that reaches the end of the `if` ends with its own facts. A fact about a name
// the branches write survives only when EVERY such path proves it: `d = t` on one path and `d = 510 - t` under
// `t > 255` on the other leave `d >= 1` when each path shows it. The candidates are the facts the paths themselves
// end with, so nothing is invented, and each is confirmed by the prover in every path
function joinFacts(ends: Inequality[][], written: Set<string>): Inequality[] {
  if (ends.length === 0) {
    return []
  }

  // each path with what a goal there would also know (remainder bounds, the far side of max / min)
  const paths = ends.map(end => [...end, ...signedRemainders(end)])

  const mentionsWritten = (q: Inequality): boolean =>
    [...q.linear.terms.keys()].some(key => written.has(keyRoot(key)))

  const seen = new Set<string>()
  const candidates: Inequality[] = []

  for (const path of paths) {
    for (const q of path) {
      const id = rowKey(q)

      if (mentionsWritten(q) && !seen.has(id) && candidates.length < 40) {
        seen.add(id)
        candidates.push(q)
      }
    }
  }

  // and a bound on each written name, which is often what the paths agree on when their equations do not: `d = t`
  // and `d = 510 - t` share no row, and both give `d >= 1`. The constants tried are the ones the paths mention
  const constants = new Set<number>([0, 1, -1])

  for (const path of paths) {
    for (const q of path) {
      if (Number.isInteger(q.linear.constant) && Math.abs(q.linear.constant) < 2 ** 31) {
        constants.add(q.linear.constant)
        constants.add(-q.linear.constant)
      }
    }
  }

  const names = [...written].filter(n => n !== EVERYTHING).slice(0, 6)
  // the smallest constants first: a bound like 15 is what an index needs, and a module full of 32-bit constants
  // (MD5's sine table) would otherwise crowd it out of the first dozen
  const tried = [...constants].sort((a, b) => Math.abs(a) - Math.abs(b)).slice(0, 16)

  for (const name of names) {
    const x = linear({ [name]: 1 })
    // the tightest lower bound every path shows, and the tightest upper bound
    const lower = [...tried].sort((a, b) => b - a).find(c => paths.every(p => proves(p, atLeast(x, linear({}, c)))))
    const upper = [...tried].sort((a, b) => a - b).find(c => paths.every(p => proves(p, atMost(x, linear({}, c)))))

    if (lower !== undefined) {
      candidates.push(atLeast(x, linear({}, lower)))
    }

    if (upper !== undefined) {
      candidates.push(atMost(x, linear({}, upper)))
    }

    // and the name against each atom it appears with: `small < length` when one path set small to i and another to
    // a child index, each below the length. Only atoms the paths already relate to it, against -1, 0 and 1
    // the atoms the paths relate it to, and the atoms THOSE are related to (`small = left`, `left < length`)
    const near = (of: Set<string>): Set<string> => {
      const out = new Set<string>()

      for (const path of ends) {
        for (const q of path) {
          if ([...of].some(k => q.linear.terms.has(k))) {
            for (const key of q.linear.terms.keys()) {
              if (!of.has(key) && !key.startsWith('__')) {
                out.add(key)
              }
            }
          }
        }
      }

      return out
    }

    const first = near(new Set([name]))
    const partners = new Set([...first, ...near(new Set([name, ...first]))])
    partners.delete(name)

    for (const partner of [...partners].slice(0, 12)) {
      const difference = linear({ [name]: 1, [partner]: -1 })

      for (const c of [-1, 0]) {
        const below = atMost(difference, linear({}, c))

        if (paths.every(p => proves(p, below))) {
          candidates.push(below)
          break
        }
      }

      for (const c of [1, 0]) {
        const above = atLeast(difference, linear({}, c))

        if (paths.every(p => proves(p, above))) {
          candidates.push(above)
          break
        }
      }
    }
  }

  return candidates.filter(q => paths.every(path => proves(path, q)))
}

// the facts after `x = x + d` (or `x += d`, `x -= d`) where d is linear and does not read x: the old x is the new x
// less d, so a fact `a*x + rest` about the old value is `a*x + rest - a*d` about the new one. Undefined when the
// assignment is not such a shift, and the caller forgets x instead.
function shiftFacts(
  current: Inequality[],
  name: string,
  statement: Extract<Statement, { form: 'assign' }>,
  walk: Walk,
): Inequality[] | undefined {
  if (
    walk.volatile.has(name) ||
    readsAny(statement.value, walk.volatile)
  ) {
    return undefined
  }

  const side: Inequality[] = []
  const value = toLinear(statement.value, side)

  if (!value || side.length > 0) {
    return undefined
  }

  let delta: Linear

  if (statement.op === '=') {
    if ((value.terms.get(name) ?? 0) !== 1) {
      return undefined
    }

    const terms = new Map(value.terms)
    terms.delete(name)
    delta = { terms, constant: value.constant }
  } else if (statement.op === '+=' || statement.op === '-=') {
    if (value.terms.has(name)) {
      return undefined
    }

    delta = statement.op === '+=' ? value : scale(value, -1)
  } else {
    return undefined
  }

  return current.map(q => {
    const a = q.linear.terms.get(name) ?? 0

    return a === 0
      ? q
      : { ...q, linear: add(q.linear, scale(delta, -a)) }
  })
}

// `@length:name == n`
function literalLength(name: string, n: number): Inequality[] {
  const atom = linear({ [`@length:${name}`]: 1 })
  const count = linear({}, n)

  return [atMost(atom, count), atLeast(atom, count)]
}

// The lengths of the program's CONSTANT TABLES: a module-level `host` bound to a list literal (an S-box, a round
// constant table) that nothing anywhere could change. Nothing writes it, passes it to a call that is not pure
// (which could push to it), or calls a method on it. A PURE task cannot change its argument (facts.ts: a write
// through a parameter makes a task impure), so handing the table to one is a read. Every task may assume those
// lengths from its first line.
function constantTableLengths(
  program: Program,
  pure: Set<string>,
): Inequality[] {
  const functions = functionNames(program)
  const tables = new Map<string, number>()

  // a task's promised constant length, `must back/length == K`, which its own check proves
  const promisedLength = (name: string): number | undefined => {
    const fn = program.find(
      s => s.form === 'function' && s.name === name,
    ) as Extract<Statement, { form: 'function' }> | undefined

    // read the way any condition is read, so `call is-equal / read back/length / code 256` and `==` are one thing:
    // a promise that pins `@length:back` to a constant
    for (const m of fn?.must ?? []) {
      const facts = assumptionInequalities(m, false, [])
      const n = exactValue(facts, '@length:back')

      if (n !== undefined) {
        return n
      }
    }

    return undefined
  }

  for (const statement of program) {
    if (statement.form === 'let' && !statement.mutable && statement.init.form === 'array') {
      tables.set(statement.name, statement.init.items.length)
    } else if (
      statement.form === 'let' &&
      !statement.mutable &&
      statement.init.form === 'call' &&
      statement.init.callee.form === 'variable'
    ) {
      // a table BUILT by a task that promises its length (`host table, call make-table` over `must back/length ==
      // 256`): the promise is proven where the task is checked, so the binding has that length while untouched
      const n = promisedLength(statement.init.callee.name)

      if (n !== undefined) {
        tables.set(statement.name, n)
      }
    }
  }

  if (tables.size === 0) {
    return []
  }

  const touched = new Set<string>()
  const stack: unknown[] = [program]
  const seen = new Set<unknown>()

  while (stack.length > 0) {
    const node = stack.pop()

    if (node === null || typeof node !== 'object' || seen.has(node)) {
      continue
    }

    seen.add(node)

    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }

    const record = node as Record<string, unknown>

    if (record.form === 'assign') {
      const root = rootName(record.target as Expression)

      if (root !== undefined) {
        touched.add(root)
      }
    }

    // a let of the same name elsewhere is a different binding, and shadows the table where it is in scope
    if (record.form === 'let' && tables.has(record.name as string)) {
      const at = program.indexOf(record as unknown as Statement)

      if (at < 0) {
        touched.add(record.name as string)
      }
    }

    // another dialect's node may also be called `call` and carry no arguments, so the shape is checked, not assumed
    if (record.form === 'call' && Array.isArray(record.args)) {
      const call = record as unknown as Extract<Expression, { form: 'call' }>
      // a pure task of the program reads its arguments and never writes them, and when it answers a SCALAR it cannot
      // hand the table back under another name for someone else to push to. Anything else might.
      const scalar = new Set(['number', 'float', 'boolean', 'string', 'unit', 'bytes'])
      const reads =
        call.callee?.form === 'variable' &&
        functions.has(call.callee.name) &&
        pure.has(call.callee.name) &&
        scalar.has(call.type?.kind ?? '')

      for (const argument of reads ? [] : call.args) {
        // one number read out of the table is not the table: a scalar argument cannot carry it off
        if (scalarValue(argument)) {
          continue
        }

        const root =
          argument.form === 'variable' || argument.form === 'member'
            ? rootName(argument)
            : undefined

        if (root !== undefined) {
          touched.add(root)
        }
      }

      // a method on the table touches it, unless it only reads one position (`table/get i`, `table/at i`) or reads
      // the list whole without changing it
      const readsOne =
        call.callee?.form === 'member' &&
        !call.callee.index &&
        call.callee.target.type?.kind === 'array' &&
        (call.callee.name === 'get' ||
          call.callee.name === 'at' ||
          READ_ONLY_LIST_METHODS.has(call.callee.name))

      if (call.callee?.form === 'member' && !readsOne) {
        const root = rootName(call.callee)

        if (root !== undefined) {
          touched.add(root)
        }
      }
    }

    for (const key of Object.keys(record)) {
      if (key !== 'type' && key !== 'span' && key !== 'binding') {
        stack.push(record[key])
      }
    }
  }

  return [...tables]
    .filter(([name]) => !touched.has(name))
    .flatMap(([name, n]) => literalLength(name, n))
}

const SCALAR_KINDS = new Set(['number', 'float', 'boolean', 'string', 'unit', 'bytes'])

// does an expression carry no reference to a Term value: its type is a scalar, it reads one element out of a list
// whose elements are scalars (the generic `get` often comes back typed unknown though its list is `list, number`), or
// it reads a local that only ever holds such values (scalarLocals)
function scalarValue(e: Expression, locals?: Set<string>): boolean {
  if (SCALAR_KINDS.has(e.type?.kind ?? '')) {
    return true
  }

  if (e.form === 'variable' && locals?.has(e.name)) {
    return true
  }

  // arithmetic and comparison of scalars is a scalar, whatever type the checker left on the node
  if (e.form === 'binary') {
    return scalarValue(e.left, locals) && scalarValue(e.right, locals)
  }

  if (e.form === 'integer' || e.form === 'boolean' || e.form === 'string') {
    return true
  }

  const fromList = (target: Expression): boolean =>
    target.type?.kind === 'array' &&
    SCALAR_KINDS.has(target.type.element.kind)

  // `read xs/{i}`, and `read xs/0` with its index written as a plain segment
  if (e.form === 'member' && (e.index || /^[0-9]+$/.test(e.name))) {
    return fromList(e.target)
  }

  return (
    e.form === 'call' &&
    e.callee.form === 'member' &&
    (e.callee.name === 'get' || e.callee.name === 'at') &&
    fromList(e.callee.target)
  )
}

// The locals of a task that only ever hold scalars: every `save` / `host` of the name, and every plain assignment to
// it, is a scalar value given the others (a fixed point from "all of them" down). A read out of a list the checker
// left typed unknown is the common case: `save p0, read rk/{i}` over a list of numbers.
function scalarLocals(body: Statement[], params: { name: string; type?: { kind: string } }[]): Set<string> {
  const values = new Map<string, Expression[]>()
  const disqualified = new Set<string>()
  const stack: unknown[] = [body]
  const seen = new Set<unknown>()

  while (stack.length > 0) {
    const node = stack.pop()

    if (node === null || typeof node !== 'object' || seen.has(node)) {
      continue
    }

    seen.add(node)

    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }

    const record = node as Record<string, unknown>

    if (record.form === 'let') {
      const list = values.get(record.name as string) ?? []
      list.push(record.init as Expression)
      values.set(record.name as string, list)
    } else if (record.form === 'assign') {
      const target = record.target as Expression

      if (target.form === 'variable') {
        const list = values.get(target.name) ?? []
        list.push(record.value as Expression)
        values.set(target.name, list)
      }
    } else if (record.form === 'for-each') {
      // a loop item holds whatever the sequence holds, which this does not track
      disqualified.add(record.item as string)
    } else if (record.form === 'closure' || record.form === 'function') {
      // a name a closure writes, or a closure's own parameter, is not tracked here
      for (const name of writtenNames(record.body)) {
        disqualified.add(name)
      }
    }

    for (const key of Object.keys(record)) {
      if (key !== 'type' && key !== 'span' && key !== 'binding') {
        stack.push(record[key])
      }
    }
  }

  // a parameter typed as a scalar is one; a parameter of any other type is not, and is never assigned a scalar view
  for (const param of params) {
    if (!SCALAR_KINDS.has(param.type?.kind ?? '')) {
      disqualified.add(param.name)
    }
  }

  const scalars = new Set(
    [...values.keys()].filter(name => !disqualified.has(name)),
  )
  let changed = true

  while (changed) {
    changed = false

    for (const name of [...scalars]) {
      if (!values.get(name)!.every(v => scalarValue(v, scalars))) {
        scalars.delete(name)
        changed = true
      }
    }
  }

  return scalars
}

// could an impure call in this statement reach a list the task holds? Only through what it is handed, a method
// called on a value, or a function value (which may close over anything). Native code cannot reach a Term local any
// other way. So an impure call to a TASK OF THE PROGRAM, handed only scalars, reaches no local list. A closure the
// statement builds is walked into, since it may be what gets called.
function reachesLists(statement: unknown, walk: Walk): boolean {
  let reached = false
  const stack: unknown[] = [statement]
  const seen = new Set<unknown>()

  while (stack.length > 0 && !reached) {
    const node = stack.pop()

    if (node === null || typeof node !== 'object' || seen.has(node)) {
      continue
    }

    seen.add(node)

    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }

    const record = node as Record<string, unknown>

    if (
      record.form === 'call' &&
      Array.isArray(record.args) &&
      record.callee !== undefined &&
      callsImpure({ ...record, args: [] }, walk.pure, walk.functions, walk.local)
    ) {
      const callee = record.callee as Expression
      const readsAList =
        callee.form === 'member' &&
        !callee.index &&
        READ_ONLY_LIST_METHODS.has(callee.name) &&
        callee.target.type?.kind === 'array' &&
        (record.args as Expression[]).every(a =>
          SCALAR_KINDS.has(a.type?.kind ?? ''),
        )

      const scalars = (record.args as Expression[]).every(a =>
        scalarValue(a, walk.scalars),
      )
      const root = callee.form === 'member' ? rootName(callee) : undefined
      // a function of a native module: a name that is neither a local, a module-level binding nor a task
      const onModule =
        root !== undefined &&
        !walk.local.has(root) &&
        !walk.globals.has(root) &&
        !walk.functions.has(root)

      if (readsAList || keepsLengths(record, walk)) {
        // reading a list changes nothing, and neither a `set` inside one nor a length-keeping task changes a length
      } else if (callee.form === 'variable' && walk.functions.has(callee.name)) {
        // a task of the program reaches no list it is not handed only when it touches no Term state at all
        // (facts.ts stateFreeFunctions); handed a list, it may change that list
        if (!(walk.stateFree.has(callee.name) && scalars)) {
          reached = true
        }
      } else if (onModule && scalars) {
        // native code handed only scalars holds no Term value: the assumption the trust ledger names
      } else {
        reached = true
      }
    }

    for (const key of Object.keys(record)) {
      if (key !== 'type' && key !== 'span' && key !== 'binding') {
        stack.push(record[key])
      }
    }
  }

  return reached
}

// a call that changes no list's length: `xs/get i` or `xs/at i` on a list, `xs/set i, v` on a list of scalars (it owes
// `0 <= i < xs/length` as a tier-0 obligation, so it lands inside), or a task that only ever does such things
// (facts.ts lengthKeepingFunctions). What it is handed may still change other ways, which the caller checks.
function keepsLengths(call: Record<string, unknown>, walk: Walk): boolean {
  const callee = call.callee as Expression | undefined
  const args = (call.args as Expression[] | undefined) ?? []

  if (callee?.form === 'variable') {
    return walk.functions.has(callee.name) && walk.keeping.has(callee.name)
  }

  // a method on a value no method can change (a text, a number), handed only such values: `input/concat other`
  if (
    callee?.form === 'member' &&
    IMMUTABLE.has(callee.target.type?.kind ?? '') &&
    args.every(a => IMMUTABLE.has(a.type?.kind ?? ''))
  ) {
    return true
  }

  if (callee?.form !== 'member' || callee.index || callee.target.type?.kind !== 'array') {
    return false
  }

  // a `set` replaces what one position holds: no list or record anywhere changes its length or its fields, though a
  // path read THROUGH a position (`xs.0.length`) now means a different value, which dropElementPaths forgets
  return (
    ((callee.name === 'get' || callee.name === 'at') && args.length === 1) ||
    (callee.name === 'set' && args.length === 2)
  )
}

// forget every fact over a state atom whose path goes through a list position (`@length:rows.0`, `@field:xs.3.size`):
// after a `set`, or a call to a task that may make one, that position may hold a different value
function dropElementPaths(current: Inequality[]): Inequality[] {
  return current.filter(q => {
    for (const key of q.linear.terms.keys()) {
      const path = key.startsWith('@field:')
        ? key.slice('@field:'.length)
        : key.startsWith('@length:')
          ? key.slice('@length:'.length)
          : undefined

      if (path !== undefined && path.split('.').some(step => /^[0-9]+$/.test(step))) {
        return false
      }
    }

    return true
  })
}

// does every impure call in a statement change no length (keepsLengths), with none passing a function value on.
// With `besidesFresh`, a push onto a name bound only to fresh lists is allowed too: it changes that list's length
// and no other, which is what a caller asking about the lengths of lists it did not make needs.
function onlyKeepsLengths(statement: unknown, walk: Walk, besidesFresh = false): boolean {
  let other = false
  const stack: unknown[] = [statement]
  const seen = new Set<unknown>()

  while (stack.length > 0 && !other) {
    const node = stack.pop()

    if (node === null || typeof node !== 'object' || seen.has(node)) {
      continue
    }

    seen.add(node)

    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }

    const record = node as Record<string, unknown>

    if (record.form === 'closure' || record.form === 'function') {
      // a function made here may be called anywhere
      other = true
      continue
    }

    if (
      record.form === 'variable' &&
      walk.functions.has(record.name as string) &&
      !walk.pure.has(record.name as string)
    ) {
      // an impure task passed as a value: callsImpure reads it as a call
      other = true
      continue
    }

    if (record.form === 'call' && record.callee !== undefined) {
      const head = { ...record, args: [] }
      const callee = record.callee as Expression

      const freshPush =
        besidesFresh &&
        callee.form === 'member' &&
        !callee.index &&
        callee.name === 'push' &&
        callee.target.form === 'variable' &&
        callee.target.type?.kind === 'array' &&
        walk.fresh?.has(callee.target.name) === true

      if (
        callsImpure(head, walk.pure, walk.functions, walk.local) &&
        !keepsLengths(record, walk) &&
        !freshPush &&
        !(callee.form === 'member' &&
          !callee.index &&
          READ_ONLY_LIST_METHODS.has(callee.name) &&
          callee.target.type?.kind === 'array')
      ) {
        other = true
      }

      // the callee itself was judged; only the arguments are left to look at
      stack.push(record.args)

      if (callee.form === 'member') {
        stack.push(callee.target)
      }

      continue
    }

    for (const key of Object.keys(record)) {
      if (key !== 'type' && key !== 'span' && key !== 'binding') {
        stack.push(record[key])
      }
    }
  }

  return !other
}

// the plain paths every `p/push v` in a body pushes to, nested walks and branches included
function pushTargets(body: Statement[], walk: Walk): Set<string> {
  const out = new Set<string>()
  const stack: unknown[] = [body]
  const seen = new Set<unknown>()

  while (stack.length > 0) {
    const node = stack.pop()

    if (node === null || typeof node !== 'object' || seen.has(node)) {
      continue
    }

    seen.add(node)

    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }

    const record = node as Record<string, unknown>

    if (record.form === 'expression') {
      const target = pushedPath(record as unknown as Statement, walk)

      if (target !== undefined) {
        out.add(target)
      }
    }

    for (const key of Object.keys(record)) {
      if (key !== 'type' && key !== 'span' && key !== 'binding') {
        stack.push(record[key])
      }
    }
  }

  return out
}

// how a loop body changes state: the number of `p/push v` statements (pure arguments) when those are its ONLY
// impure calls, or false when it makes any other impure call. A closure's body counts, because it may run here.
function bodyOnlyPushes(body: Statement[], walk: Walk): number | false {
  let pushes = 0
  let other = false
  const stack: unknown[] = [body]
  const seen = new Set<unknown>()

  while (stack.length > 0 && !other) {
    const node = stack.pop()

    if (node === null || typeof node !== 'object' || seen.has(node)) {
      continue
    }

    seen.add(node)

    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }

    const record = node as Record<string, unknown>

    if (record.form === 'expression' && pushedPath(record as unknown as Statement, walk) !== undefined) {
      pushes++
      // the pushed value was checked pure by pushedPath; nothing under it needs walking
      continue
    }

    // an impure call that cannot reach a local list (reachesLists) is not a change to any length this walk tracks;
    // keepMonotone drops what it may have changed (the lengths of lists that are not local) separately
    if (
      record.form === 'call' &&
      Array.isArray(record.args) &&
      record.callee !== undefined &&
      reachesLists(record, walk)
    ) {
      other = true
    }

    for (const key of Object.keys(record)) {
      if (key !== 'type' && key !== 'span' && key !== 'binding') {
        stack.push(record[key])
      }
    }
  }

  return other ? false : pushes
}

// a walk whose only change to state is pushes with pure arguments, from a condition or sequence that calls nothing
// impure: keepAcrossTurns has already kept exactly the length facts such a walk preserves, so the blanket rule for
// impure statements must not forget them after it
function onlyPushingLoop(statement: Statement, walk: Walk): boolean {
  if (statement.form === 'while') {
    return (
      !callsImpure(statement.cond, walk.pure, walk.functions, walk.local) &&
      bodyOnlyPushes(statement.body, walk) !== false &&
      !writesThroughMember(statement.body)
    )
  }

  if (statement.form === 'for-each') {
    return (
      !callsImpure(statement.iterable, walk.pure, walk.functions, walk.local) &&
      bodyOnlyPushes(statement.body, walk) !== false &&
      !writesThroughMember(statement.body)
    )
  }

  return false
}

// does a body write through a member anywhere (a closure's body included)
function writesThroughMember(body: Statement[]): boolean {
  let found = false
  const stack: unknown[] = [body]
  const seen = new Set<unknown>()

  while (stack.length > 0 && !found) {
    const node = stack.pop()

    if (node === null || typeof node !== 'object' || seen.has(node)) {
      continue
    }

    seen.add(node)

    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }

    const record = node as Record<string, unknown>

    if (
      record.form === 'assign' &&
      (record.target as { form?: string } | undefined)?.form === 'member'
    ) {
      found = true
    }

    for (const key of Object.keys(record)) {
      if (key !== 'type' && key !== 'span' && key !== 'binding') {
        stack.push(record[key])
      }
    }
  }

  return found
}

// the path a statement pops one item off: `call p/pop` or the list method `call pop, p`, alone or as the value of a
// binding, with `p` a plain path to a list. Undefined for anything else
function poppedPath(statement: Statement): string | undefined {
  const value =
    statement.form === 'expression'
      ? statement.expr
      : statement.form === 'let'
        ? statement.init
        : statement.form === 'assign' && statement.target.form === 'variable'
          ? statement.value
          : undefined

  if (value?.form !== 'call') {
    return undefined
  }

  const list =
    value.callee.form === 'member' && value.callee.name === 'pop' && !value.callee.index && value.args.length === 0
      ? value.callee.target
      : value.callee.form === 'variable' && listPops.has(value.callee.name) && value.args.length === 1
        ? value.args[0]!
        : undefined

  return list?.type?.kind === 'array' ? plainPath(list) : undefined
}

// the tasks that ARE a list's push: the whole body is `send back, call p/push v` with p and v the task's own two
// parameters in order (the stdlib's list method `push`)
let listPushes = new Set<string>()

function listPushesOf(program: Program): Set<string> {
  const out = new Set<string>()

  for (const statement of program) {
    if (statement.form !== 'function' || statement.params.length !== 2 || statement.body.length !== 1) {
      continue
    }

    const only = statement.body[0]!
    const value = only.form === 'return' ? only.value : undefined
    const [list, item] = statement.params

    if (
      value?.form === 'call' &&
      value.callee.form === 'member' &&
      value.callee.name === 'push' &&
      value.args.length === 1 &&
      value.callee.target.form === 'variable' &&
      value.callee.target.name === list!.name &&
      value.args[0]!.form === 'variable' &&
      value.args[0]!.name === item!.name
    ) {
      out.add(statement.name)
    }
  }

  return out
}

// the tasks that ARE a list's pop, recognized by shape, never by name: the whole body is `send back, call p/pop` on
// the task's only parameter (the stdlib's list method `pop`). Set by checkHolds per program
let listPops = new Set<string>()

function listPopsOf(program: Program): Set<string> {
  const out = new Set<string>()

  for (const statement of program) {
    if (statement.form !== 'function' || statement.params.length !== 1 || statement.body.length !== 1) {
      continue
    }

    const only = statement.body[0]!
    const value = only.form === 'return' ? only.value : undefined

    if (
      value?.form === 'call' &&
      value.callee.form === 'member' &&
      value.callee.name === 'pop' &&
      value.args.length === 0 &&
      value.callee.target.form === 'variable' &&
      value.callee.target.name === statement.params[0]!.name
    ) {
      out.add(statement.name)
    }
  }

  return out
}

// the path a statement pushes one item onto, when it is exactly `call p/push, <value>` with `p` a plain path and the
// value calling nothing impure; undefined for anything else
function pushedPath(statement: Statement, walk: Walk): string | undefined {
  if (statement.form !== 'expression' || statement.expr.form !== 'call') {
    return undefined
  }

  const call = statement.expr

  // the list method `push(xs, v)`, recognized by its shape (listPushesOf), is the same one-item push
  if (
    call.callee?.form === 'variable' &&
    listPushes.has(call.callee.name) &&
    Array.isArray(call.args) &&
    call.args.length === 2 &&
    call.args[0]!.type?.kind === 'array' &&
    !reachesLists([call.args[1]], walk)
  ) {
    return plainPath(call.args[0]!)
  }

  // only the native list's `push` adds exactly one item: a form may define its own `push` (the stdlib's heap does)
  // over a `length` field, so the receiver must be typed as a list. What is pushed may be computed by anything that
  // cannot reach a list (a native bit operation, say), since only lengths are tracked.
  if (
    call.callee?.form !== 'member' ||
    call.callee.name !== 'push' ||
    call.callee.index ||
    call.callee.target.type?.kind !== 'array' ||
    !Array.isArray(call.args) ||
    call.args.length !== 1 ||
    reachesLists(call.args, walk)
  ) {
    return undefined
  }

  return plainPath(call.callee.target)
}

// a fact over an atom that stands for state (`__mod` atoms are only bounds and stay)
function mentionsAtom(q: Inequality): boolean {
  for (const key of q.linear.terms.keys()) {
    if (isStateAtom(key)) {
      return true
    }
  }

  return false
}

// the holds inside the closures an expression builds. A closure may run at any later time, so its holds are checked
// with nothing assumed about the world around it, and with its own parameters and writes as its locals.
function holdsInExpression(expression: Expression, walk: Walk): void {
  const closures: Extract<Expression, { form: 'closure' }>[] = []
  const stack: unknown[] = [expression]
  const seen = new Set<unknown>()

  while (stack.length > 0) {
    const node = stack.pop()

    if (node === null || typeof node !== 'object' || seen.has(node)) {
      continue
    }

    seen.add(node)

    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }

    const record = node as Record<string, unknown>

    if (record.form === 'closure') {
      // nested closures inside this one are reached by walking its body, not here
      closures.push(record as Extract<Expression, { form: 'closure' }>)
      continue
    }

    for (const key of Object.keys(record)) {
      if (key !== 'type' && key !== 'span') {
        stack.push(record[key])
      }
    }
  }

  for (const closure of closures) {
    const local = writtenNames(closure.body)

    for (const param of closure.params) {
      local.add(param.name)
    }

    for (const name of walk.local) {
      local.add(name)
    }

    walkHolds(closure.body, [], {
      ...walk,
      local,
      volatile: volatileNames(closure.body),
    })
  }
}
