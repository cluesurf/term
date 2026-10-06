// Definitional unfolding for the ring prover. A goal like `norm(a, b) * norm(c, d) == norm(p, q)` names a task whose
// body is one polynomial, but the ring normalizer only reads `+`, `-`, `*`, literals and variables, so a call is opaque
// to it and the identity had to be written out by hand at every use. This replaces each call to such a task with its
// body, the arguments substituted for the parameters (delta then beta reduction), so the task can be defined once and
// used by name in any ring identity.
//
// Sound: a task that is not recursive and whose whole body is `send back <expression>` denotes exactly that expression
// with its parameters bound to the arguments. Nothing else is unfolded, and a task with a `natural-number` parameter is
// never unfolded, because its `subtract` truncates at zero. A task that recurses (directly or through
// another), branches, has more than one statement, or reads a name that is not one of its parameters is left as a call,
// so the goal stays outside the fragment and is left to the other provers, which is the behavior before this existed.

import type {
  Expression,
  Program,
  Statement,
} from '@term/make/code/compile/node'

type Fn = Extract<Statement, { form: 'function' }>

// the deepest chain of nested unfoldings followed, a backstop against a cycle the recursion test missed
const UNFOLD_DEPTH_LIMIT = 32

// the names an expression reads, for the closed-body test
function freeNames(e: Expression, into: Set<string>): void {
  switch (e.form) {
    case 'variable':
      into.add(e.name)

      return
    case 'binary':
      freeNames(e.left, into)
      freeNames(e.right, into)

      return
    case 'unary':
      freeNames(e.operand, into)

      return
    case 'call':
      // the callee is a function name, not a value the body reads
      e.args.forEach(a => freeNames(a, into))

      return
    // `u/x` reads `u`, and a construction reads each value it is built from. Missed, a body over records read as
    // closed, and its unfolding kept the callee's parameter names in the caller's goal
    case 'member':
      freeNames(e.target, into)

      if (e.index) {
        freeNames(e.index, into)
      }

      return
    case 'record':
      e.fields.forEach(f => freeNames(f.value, into))
      e.positional?.forEach(p => freeNames(p, into))

      return
    default:
      return
  }
}

// the functions a body calls by name
function calledNames(e: Expression, into: Set<string>): void {
  switch (e.form) {
    case 'binary':
      calledNames(e.left, into)
      calledNames(e.right, into)

      return
    case 'unary':
      calledNames(e.operand, into)

      return
    case 'call':
      if (e.callee.form === 'variable') {
        into.add(e.callee.name)
      }

      e.args.forEach(a => calledNames(a, into))

      return
    case 'member':
      calledNames(e.target, into)

      return
    case 'record':
      e.fields.forEach(f => calledNames(f.value, into))
      e.positional?.forEach(p => calledNames(p, into))

      return
    default:
      return
  }
}

// the body of a task that may be unfolded: one `send back <expression>` whose free names are all parameters
function unfoldableBody(
  fn: Fn,
): { params: string[]; body: Expression } | null {
  // a claim (a `rule` with no `show`) declares a name without defining it. A separate-compilation stub carries its
  // one statement as `stubShape` when its body was one, which is all an unfolding reads
  const body = fn.stub ? (fn.stubShape ? [fn.stubShape] : []) : fn.body

  if (fn.claim || !Array.isArray(body) || body.length !== 1) {
    return null
  }

  if (!Array.isArray(fn.params)) {
    return null
  }

  const only = body[0]!

  if (only.form !== 'return' || !only.value) {
    return null
  }

  // a `natural-number` parameter means `subtract` in the body is truncated (monus), not the ring's minus, so the body
  // is not the polynomial it reads as. Only tasks over the integers are unfolded.
  if (fn.params.some(p => p.refine === 'natural')) {
    return null
  }

  const params = fn.params.map(p => p.name)
  const names = new Set<string>()
  freeNames(only.value, names)

  for (const name of names) {
    if (!params.includes(name)) {
      return null
    }
  }

  return { params, body: only.value }
}

// does `name` reach itself through the call graph of unfoldable bodies (so unfolding it would not terminate)
function isRecursive(
  name: string,
  bodies: Map<string, { params: string[]; body: Expression }>,
): boolean {
  const seen = new Set<string>()
  const stack = [name]

  while (stack.length > 0) {
    const current = stack.pop()!
    const entry = bodies.get(current)

    if (!entry) {
      continue
    }

    const called = new Set<string>()
    calledNames(entry.body, called)

    for (const next of called) {
      if (next === name) {
        return true
      }

      if (!seen.has(next)) {
        seen.add(next)
        stack.push(next)
      }
    }
  }

  return false
}

// substitute each parameter by its argument, simultaneously (an argument is never re-substituted)
function substitute(
  e: Expression,
  binding: Map<string, Expression>,
): Expression {
  switch (e.form) {
    case 'variable':
      return binding.get(e.name) ?? e
    case 'binary':
      return {
        ...e,
        left: substitute(e.left, binding),
        right: substitute(e.right, binding),
      }
    case 'unary':
      return { ...e, operand: substitute(e.operand, binding) }
    // THE CALLEE TOO: a body that calls a parameter (`back s(x)` for a set `s`) is a call of the argument. Left as
    // written it kept the callee's own name, so `has(union(s, t), x)` and `has(s, x)` both unfolded to `s(x)` and the
    // ring proved a false set law (2026-10-05, test/check/record-ring.ts)
    case 'call':
      return { ...e, callee: substitute(e.callee, binding), args: e.args.map(a => substitute(a, binding)) }
    case 'member':
      return { ...e, target: substitute(e.target, binding), ...(e.index ? { index: substitute(e.index, binding) } : {}) }
    case 'record':
      return {
        ...e,
        fields: e.fields.map(f => ({ ...f, value: substitute(f.value, binding) })),
        ...(e.positional ? { positional: e.positional.map(p => substitute(p, binding)) } : {}),
      }
    default:
      return e
  }
}

// A FIELD READ, as the ring reads it. Of a construction it is the field's value (`make pair(a, b)/left` is `a`). Of a
// name it is an ATOM named by its path, `u/x`, which no name in a program can spell, so two reads of one field are one
// atom and reads of two fields are two. Anything else is left as it is, outside the ring's fragment
function readField(e: Extract<Expression, { form: 'member' }>): Expression {
  if (e.index) {
    return e
  }

  if (e.target.form === 'record') {
    const field = e.target.fields.find(f => f.name === e.name)

    return field ? field.value : e
  }

  const path = pathOf(e)

  return path ? { form: 'variable', name: path, span: e.span } : e
}

// `u/x/y` as a path, when every link of it is a plain field read of a name
function pathOf(e: Expression): string | undefined {
  if (e.form === 'variable') {
    return e.name
  }

  if (e.form === 'member' && !e.index) {
    const target = pathOf(e.target)

    return target ? `${target}/${e.name}` : undefined
  }

  return undefined
}

// the unfoldable, non-recursive tasks of a program, by name
function unfoldTable(
  program: Program,
): Map<string, { params: string[]; body: Expression }> {
  const bodies = new Map<string, { params: string[]; body: Expression }>()

  for (const statement of program) {
    if (statement.form === 'function') {
      const entry = unfoldableBody(statement)

      if (entry) {
        bodies.set(statement.name, entry)
      }
    }
  }

  for (const name of [...bodies.keys()]) {
    if (isRecursive(name, bodies)) {
      bodies.delete(name)
    }
  }

  return bodies
}

// The table of the LAST program asked about. One slot answers the whole hit pattern, because the prover unfolds
// many goals against one program before it moves on, and one slot holds at most one program alive, where an
// unbounded map keyed by program would hold every one. That bound is all the WeakMap it replaces was buying. A
// module-level WeakMap keyed by object identity has no Term spelling and no Rust one (self-hosting-0022), the way
// the two lint memos did not either.
let last:
  | { program: Program; table: Map<string, { params: string[]; body: Expression }> }
  | undefined

// unfold every call to a non-recursive single-expression task, innermost arguments first
export function unfoldDefinitions(
  e: Expression,
  program: Program,
): Expression {
  if (last?.program !== program) {
    last = { program, table: unfoldTable(program) }
  }

  const table = last.table

  const walk = (x: Expression, depth: number): Expression => {
    switch (x.form) {
      case 'binary':
        return {
          ...x,
          left: walk(x.left, depth),
          right: walk(x.right, depth),
        }
      case 'unary':
        return { ...x, operand: walk(x.operand, depth) }
      // a field read of what the walk unfolds: `times(m, n)/a` is the `a` of the record `times` builds
      case 'member':
        return readField({ ...x, target: walk(x.target, depth) })
      case 'record':
        return { ...x, fields: x.fields.map(f => ({ ...f, value: walk(f.value, depth) })) }
      case 'call': {
        const args = x.args.map(a => walk(a, depth))
        const entry =
          x.callee.form === 'variable'
            ? table!.get(x.callee.name)
            : undefined

        if (
          !entry ||
          entry.params.length !== args.length ||
          depth >= UNFOLD_DEPTH_LIMIT
        ) {
          return { ...x, args }
        }

        const binding = new Map<string, Expression>()
        entry.params.forEach((p, i) => binding.set(p, args[i]!))

        return walk(substitute(entry.body, binding), depth + 1)
      }
      default:
        return x
    }
  }

  return walk(e, 0)
}
