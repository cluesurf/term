// Totality: the two checks that keep the logic sound once definitions become proof-relevant.
//
// 1. Strict positivity (hard error). A datatype may not refer to itself in a negative position (to the left of an
//    arrow) within its own fields. Negative occurrences let you build a non-terminating loop and thus a proof of
//    falsehood, so they are rejected outright. See note/research/vibe/computation/plans/18-type-theory-gaps.md.
// 2. Termination (warning). A recursive function should decrease some argument on every self-call, so it cannot
//    spin forever. We verify the structural / numeric-descent fragment; recursion we cannot show terminating is
//    flagged (a warning today, because functions are still opaque postulates to the kernel, so a non-terminating
//    function cannot yet corrupt definitional equality; it becomes a hard error once functions are made
//    transparent / usable as proofs).
//
// Both walk the surface AST. Browser-safe, no host APIs.

import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import { EVERYTHING, localNames, writtenNames } from '@term/make/code/check/facts'
import { atLeast, linear, proves } from '@term/make/code/check/refine'
import type { Linear } from '@term/make/code/check/refine'
import type {
  Expression,
  Program,
  Statement,
  Type,
} from '@term/make/code/compile/node'

export type TotalityReport = {
  errors: Diagnostic[]
  warnings: Diagnostic[]
}

export function checkTotality(
  program: Program,
  file: string,
): TotalityReport {
  const errors: Diagnostic[] = []
  const warnings: Diagnostic[] = []

  for (const statement of program) {
    if (statement.form === 'record-type') {
      checkPositivity(statement, file, errors)
    }
  }

  // Termination analysis is best-effort and warnings-only: it must never crash
  // the build. A bug or a malformed/partial AST degrades to "no termination
  // warnings" rather than taking down an otherwise-valid compile. (Positivity
  // above is a soundness error and is intentionally not wrapped.)
  try {
    checkTermination(program, file, warnings)
  } catch {
    // swallow: a failed termination pass yields no warnings, never an error.
  }

  return { errors, warnings }
}

// ---- strict positivity ----

// does `name` occur in `type` at a negative position, given the current polarity? Positive (true) is fine;
// negative (false) is the violation. Function parameters flip polarity; array elements and results keep it.
function negativeOccurrence(
  name: string,
  type: Type,
  positive: boolean,
): boolean {
  switch (type.kind) {
    case 'named':
      return type.name === name && !positive
    case 'array':
      return negativeOccurrence(name, type.element, positive)
    case 'function':
      // a parameter is contravariant (its polarity flips); the result keeps the current polarity
      return (
        type.params.some(p => negativeOccurrence(name, p, !positive)) ||
        negativeOccurrence(name, type.result, positive)
      )
    default:
      return false
  }
}

function checkPositivity(
  statement: Extract<Statement, { form: 'record-type' }>,
  file: string,
  errors: Diagnostic[],
): void {
  const name = statement.name
  const fields = [
    ...statement.fields,
    ...statement.variants.flatMap(variant => variant.fields),
  ]

  for (const field of fields) {
    if (negativeOccurrence(name, field.type, true)) {
      errors.push(
        diagnose('non-positive', {
          file,
          span: statement.span,
          message: `"${name}" occurs in a non-positive position in field "${field.name}"`,
        }),
      )
    }
  }
}

// ---- termination ----

// is `arg` a strictly smaller value than the parameter `paramName`? Structural (a member of the parameter, including a
// variable bound by matching the parameter, e.g. `prior` in `case succ` on `a`) or numeric descent (param minus a
// positive literal, or param divided by an integer above one). `memberOf` maps a match-bound field variable to the
// subject variable it was destructured from.
function strictlyDecreases(
  arg: Expression,
  paramName: string,
  memberOf: Map<string, string>,
  // the conditions known true on the path to this call (walkCalls): what a NUMERIC descent needs to be well-founded
  guards: Expression[] = [],
): boolean {
  // a field bound by matching the parameter is structurally smaller than it (this is what makes a recursive function
  // over an inductive type, like `plus` recursing on `succ`'s predecessor, provably terminating). The relation is
  // TRANSITIVE: a field of a field of the parameter is still smaller, so a two-step recursion (Fibonacci, matching
  // `succ (succ k)` and recursing on the inner `k`) is recognized as descending. A visited set guards against cycles.
  if (arg.form === 'variable') {
    const seen = new Set<string>()

    let current: string | undefined = arg.name

    while (current !== undefined && !seen.has(current)) {
      seen.add(current)
      current = memberOf?.get(current)

      if (current === paramName) {
        return true
      }
    }
  }

  if (arg.form === 'member') {
    return (
      arg.target.form === 'variable' && arg.target.name === paramName
    )
  }

  // a W-TYPE / function-field recursion: applying a FIELD obtained by matching the parameter (`kids` from a `node kids`,
  // `step` from an `mkacc step`) yields a structural CHILD of the parameter. For an inductive type whose constructor
  // carries a function-typed field, this child is strictly smaller -- the standard elimination principle for W-types and
  // for accessibility (`Acc`), so recursing on it is well-founded. Sound because the type is inductive (no infinite
  // value is finitely constructible, and a non-terminating producer is itself left opaque).
  if (arg.form === 'call' && arg.callee.form === 'variable') {
    const seen = new Set<string>()
    let current: string | undefined = arg.callee.name

    while (current !== undefined && !seen.has(current)) {
      seen.add(current)
      current = memberOf?.get(current)

      if (current === paramName) {
        return true
      }
    }
  }

  // NUMERIC descent is well-founded only above a floor, and the floor must hold on the path to the call. Until
  // 2026-10-05 `n - 1`, `n / 2` and `n % k` were each a descent with no condition at all, so a proof that recursed on
  // one at every step and never reached a base case was "terminating", and proved any claim (test/check/soundness.ts):
  //   n - c   (c > 0)   needs n - c >= 0, so n is a natural number that falls by at least 1 each step
  //   n / k   (k > 1)   needs n >= 1, so n at least halves each step and stops below 1
  //   n % k   (k >= 1)  needs n >= k, so the result, below k, is below n
  if (
    arg.form === 'binary' &&
    arg.left.form === 'variable' &&
    arg.left.name === paramName &&
    arg.right.form === 'integer'
  ) {
    const by = Number(arg.right.value)
    const n = linear({ [paramName]: 1 })
    const facts = sharpened(guardFacts(guards), guards)

    if (arg.op === '-' && by > 0) {
      return proves(facts, atLeast(n, linear({}, by)))
    }

    if (arg.op === '/' && by > 1) {
      return proves(facts, atLeast(n, linear({}, 1)))
    }

    if (arg.op === '%' && by >= 1) {
      return proves(facts, atLeast(n, linear({}, by)))
    }
  }

  return false
}

// ---- path conditions, for numeric descent ----

// a linear expression over variables and integer literals, or null
function linearOf(e: Expression): Linear | null {
  switch (e.form) {
    case 'variable':
      return linear({ [e.name]: 1 })
    case 'integer':
      return linear({}, Number(e.value))
    case 'unary': {
      const inner = e.op === '-' ? linearOf(e.operand) : null

      return inner && { terms: new Map([...inner.terms].map(([k, c]) => [k, -c])), constant: -inner.constant }
    }
    case 'binary': {
      const left = linearOf(e.left)
      const right = linearOf(e.right)

      if (!left || !right) {
        return null
      }

      if (e.op === '+' || e.op === '-') {
        const sign = e.op === '+' ? 1 : -1
        const terms = new Map(left.terms)

        for (const [k, c] of right.terms) {
          terms.set(k, (terms.get(k) ?? 0) + sign * c)
        }

        return { terms, constant: left.constant + sign * right.constant }
      }

      if (e.op === '*' && (left.terms.size === 0 || right.terms.size === 0)) {
        const [k, v] = left.terms.size === 0 ? [left.constant, right] : [right.constant, left]

        return { terms: new Map([...v.terms].map(([name, c]) => [name, k * c])), constant: k * v.constant }
      }

      return null
    }
    default:
      return null
  }
}

type Guard = ReturnType<typeof atLeast>

// what a condition says, or its negation says, as linear facts. A condition it cannot read says nothing
function conditionFacts(cond: Expression, negated: boolean): Guard[] {
  if (cond.form === 'unary' && cond.op === '!') {
    return conditionFacts(cond.operand, !negated)
  }

  if (cond.form !== 'binary') {
    return []
  }

  if ((cond.op === '&&' && !negated) || (cond.op === '||' && negated)) {
    return [...conditionFacts(cond.left, negated), ...conditionFacts(cond.right, negated)]
  }

  const left = linearOf(cond.left)
  const right = linearOf(cond.right)

  if (!left || !right) {
    return []
  }

  // integers: a strict comparison is a non-strict one shifted by 1
  const op = negated
    ? ({ '<': '>=', '<=': '>', '>': '<=', '>=': '<', '==': '!=', '!=': '==' } as Record<string, string>)[cond.op]
    : cond.op
  const plus = (l: Linear, c: number): Linear => ({ terms: l.terms, constant: l.constant + c })

  switch (op) {
    case '>=':
      return [atLeast(left, right)]
    case '>':
      return [atLeast(left, plus(right, 1))]
    case '<=':
      return [atLeast(right, left)]
    case '<':
      return [atLeast(right, plus(left, 1))]
    case '==':
      return [atLeast(left, right), atLeast(right, left)]
    default:
      return []
  }
}

function guardFacts(guards: Expression[]): Guard[] {
  return guards.flatMap(g => conditionFacts(g, false))
}

// A DISEQUALITY BESIDE A BOUND IS A TIGHTER BOUND, over the integers: `n != 0` where `n >= 0` is known gives `n >= 1`.
// It is how the `miss` arm of `n == 0` on a natural number reads, the commonest recursion in the library (every sum of
// number/sum.tree), whose `n - 1` was not seen to descend. A disequality says nothing by itself, so it is only read
// against a bound the facts already prove at its constant
function sharpened(facts: Guard[], guards: Expression[]): Guard[] {
  const out = [...facts]

  for (const guard of guards) {
    const differs =
      guard.form === 'binary' && guard.op === '!='
        ? guard
        : guard.form === 'unary' && guard.op === '!' && guard.operand.form === 'binary' && guard.operand.op === '=='
          ? guard.operand
          : undefined

    if (differs?.form !== 'binary') {
      continue
    }

    const left = linearOf(differs.left)
    const right = linearOf(differs.right)

    if (!left || !right) {
      continue
    }

    const plus = (l: Linear, c: number): Linear => ({ terms: l.terms, constant: l.constant + c })

    if (proves(out, atLeast(left, right))) {
      out.push(atLeast(left, plus(right, 1)))
    } else if (proves(out, atLeast(right, left))) {
      out.push(atLeast(right, plus(left, 1)))
    }
  }

  return out
}

// `n >= 0` for each natural-number parameter: the bound its type promises, which a descent on it may use
function naturalGuards(statement: Extract<Statement, { form: 'function' }>): Expression[] {
  return statement.params
    .filter(p => p.refine === 'natural')
    .map(p => ({
      form: 'binary',
      op: '>=',
      left: { form: 'variable', name: p.name, span: statement.span },
      right: { form: 'integer', value: 0, span: statement.span },
      span: statement.span,
    }))
}

// does an expression read the name?
function mentions(e: Expression, name: string): boolean {
  switch (e.form) {
    case 'variable':
      return e.name === name
    case 'binary':
      return mentions(e.left, name) || mentions(e.right, name)
    case 'unary':
      return mentions(e.operand, name)
    case 'call':
      return mentions(e.callee, name) || e.args.some(a => mentions(a, name))
    case 'member':
      return mentions(e.target, name)
    default:
      return true
  }
}

// the guards that still speak of the same values once `names` are rebound
function without(guards: Expression[], names: Iterable<string>): Expression[] {
  const gone = [...names]

  return gone.length === 0 ? guards : guards.filter(g => !gone.some(name => mentions(g, name)))
}

function not(cond: Expression): Expression {
  return { form: 'unary', op: '!', operand: cond, span: cond.span } as Expression
}

// a body that always leaves (returns or raises) at its end
function exits(body: Statement[]): boolean {
  const last = body[body.length - 1]

  return last !== undefined && (last.form === 'return' || last.form === 'throw' || last.form === 'exit')
}

// a task's parameter names, with every one the body REBINDS replaced by a name nothing can match. A rebound
// parameter is a different value under the same name, so neither `n - 1` nor a field of `n` is smaller than what the
// task was called with: `save n, n + 5` then `call f(n - 1)` grows. Such a position carries no descent
const REBOUND = '\u0000rebound'

function steadyParams(statement: Extract<Statement, { form: 'function' }>): string[] {
  const written = writtenNames(statement.body)

  return statement.params.map(p => (written.has(p.name) || written.has(EVERYTHING) ? REBOUND : p.name))
}

// a function is terminating if it is non-recursive, or its direct recursion strictly decreases some argument on
// every self-call. Mutual-recursion cycles are conservatively treated as unverified. Returns the per-function
// verdict so both the warning pass and the transparency gate can use it.
function terminationVerdict(program: Program): Map<string, boolean> {
  const functions = new Map<
    string,
    Extract<Statement, { form: 'function' }>
  >()

  for (const statement of program) {
    if (statement.form === 'function') {
      functions.set(statement.name, statement)
    }
  }

  const names = new Set(functions.keys())

  // variant name -> its field names, so a recursion on a destructured field counts as structural descent
  const variantFields = new Map<string, string[]>()

  for (const statement of program) {
    if (statement.form === 'record-type') {
      for (const variant of statement.variants) {
        variantFields.set(
          variant.name,
          variant.fields.map(f => f.name),
        )
      }
    }
  }

  const edges = new Map<string, Set<string>>()
  // the tasks each task reads as a VALUE (`read f`, handed on or saved, not called by name). Such a task may be called
  // with any argument, so no descent can be shown for it: a recursion that passes through one is not verified. Until
  // 2026-10-05 these were no edges at all, so `save again, read p` then `call again` made p look non-recursive, and a
  // claim that any two values are equal was accepted with that loop as its proof (test/check/soundness.ts)
  const valueEdges = new Map<string, Set<string>>()

  for (const [name, statement] of functions) {
    const called = collectCalledNames(statement.body, names, variantFields)
    const locals = localNames(statement)
    const values = new Set<string>()

    walkCalls(statement.body, () => {}, variantFields, new Map(), value => {
      if (names.has(value) && !locals.has(value)) {
        values.add(value)
      }
    })

    valueEdges.set(name, values)
    edges.set(name, new Set([...called, ...values]))
  }

  const reaches = (from: string): Set<string> => {
    const seen = new Set<string>()
    const stack = [...(edges.get(from) ?? [])]

    while (stack.length > 0) {
      const next = stack.pop()!

      if (seen.has(next)) {
        continue
      }

      seen.add(next)

      for (const further of edges.get(next) ?? []) {
        stack.push(further)
      }
    }

    return seen
  }

  // the mutual-recursion group of `name`: every function mutually reachable with it (its strongly-connected component)
  const sccOf = (name: string): Set<string> => {
    const out = new Set<string>([name])
    const forward = reaches(name)

    for (const other of forward) {
      if (other !== name && reaches(other).has(name)) {
        out.add(other)
      }
    }

    return out
  }

  const verdict = new Map<string, boolean>()

  for (const [name, statement] of functions) {
    // a separately compiled task: its own unit, which had the body, judged it (`stubFacts`)
    if (statement.stub && statement.stubFacts) {
      verdict.set(name, statement.stubFacts.includes('ends'))
      continue
    }

    if (!reaches(name).has(name)) {
      verdict.set(name, true) // not recursive: trivially terminating
      continue
    }

    // a recursion through a task read as a value: some member of the group reads a member as a value, so a call may
    // reach it with any argument. Not verified, whatever the named calls do
    const group = sccOf(name)

    if ([...group].some(member => [...(valueEdges.get(member) ?? [])].some(target => group.has(target)))) {
      verdict.set(name, false)
      continue
    }

    // DIRECT recursion (the primary, pre-existing check): some single argument position strictly decreases on every
    // SELF-call. Tried first, so a function verified this way keeps its prior verdict exactly (no regression).
    const paramNames = steadyParams(statement)
    const selfCalls: SelfCall[] = []
    collectSelfCalls(statement.body, name, selfCalls, variantFields)

    let positions = new Set<number>(paramNames.map((_, i) => i))

    const bounds = naturalGuards(statement)

    for (const { args, memberOf, guards } of selfCalls) {
      const decreasing = new Set<number>()

      for (let i = 0; i < paramNames.length && i < args.length; i++) {
        if (strictlyDecreases(args[i]!, paramNames[i]!, memberOf, [...bounds, ...guards])) {
          decreasing.add(i)
        }
      }

      positions = new Set([...positions].filter(i => decreasing.has(i)))
    }

    if (
      selfCalls.length > 0 &&
      (positions.size > 0 ||
        lexicographicallyDescends(selfCalls, paramNames))
    ) {
      verdict.set(name, true)
      continue
    }

    const scc = sccOf(name)

    if (scc.size === 1) {
      verdict.set(name, false) // direct recursion that does not descend: not verified
      continue
    }

    // MUTUAL recursion (the SCC has more than one function, e.g. rose-tree count over a tree/forest pair). Sound
    // criterion: there is a FIXED argument position p such that EVERY call within the group passes, at position p, a
    // strict structural subterm of the CALLER's position-p argument. Then the structural size of the position-p
    // argument strictly decreases on every step of the cycle, a well-founded measure, so the group terminates. A
    // position where one call GROWS (no subterm) is rejected, which correctly rules out the size-constant loops.
    type GroupCall = {
      callerParams: string[]
      args: Expression[]
      memberOf: Map<string, string>
      guards: Expression[]
    }

    const groupCalls: GroupCall[] = []

    for (const member of scc) {
      const memberStatement = functions.get(member)!
      const memberParams = steadyParams(memberStatement)
      const calls: SelfCall[] = []
      collectGroupCalls(memberStatement.body, scc, calls, variantFields)

      for (const { args, memberOf, guards } of calls) {
        groupCalls.push({ callerParams: memberParams, args, memberOf, guards })
      }
    }

    const maxArity = Math.max(
      ...[...scc].map(g => functions.get(g)!.params.length),
    )

    let terminates = false

    for (let p = 0; p < maxArity && !terminates; p++) {
      const everyCallDescendsAtP = groupCalls.every(
        call =>
          p < call.callerParams.length &&
          p < call.args.length &&
          strictlyDecreases(
            call.args[p]!,
            call.callerParams[p]!,
            call.memberOf,
            call.guards,
          ),
      )

      if (groupCalls.length > 0 && everyCallDescendsAtP) {
        terminates = true
      }
    }

    verdict.set(name, terminates)
  }

  return verdict
}

// the set of functions whose termination is verified (used to gate transparent definitions in the elaborator)
export function terminatingFunctions(program: Program): Set<string> {
  const verdict = terminationVerdict(program)

  return new Set(
    [...verdict].filter(([, ok]) => ok).map(([name]) => name),
  )
}

function checkTermination(
  program: Program,
  file: string,
  warnings: Diagnostic[],
): void {
  const verdict = terminationVerdict(program)
  const byName = new Map<
    string,
    Extract<Statement, { form: 'function' }>
  >()

  for (const statement of program) {
    if (statement.form === 'function') {
      byName.set(statement.name, statement)
    }
  }

  for (const [name, ok] of verdict) {
    if (ok) {
      continue
    }

    const statement = byName.get(name)!

    // each module reports its own. A task merged in from another file carries that file's span, and stamping it with
    // this one put 11 of @term/host's tasks at `code/boot.tree:1054` in a 22-line file (guides: language/data)
    if (statement.span.file !== undefined && statement.span.file !== file) {
      continue
    }

    const calls: SelfCall[] = []
    collectSelfCalls(statement.body, name, calls, new Map())

    const reason =
      calls.length === 0
        ? `"${name}" is part of a mutual-recursion cycle whose termination is not verified`
        : `"${name}" calls itself without an argument that provably decreases`

    warnings.push(
      diagnose('non-terminating', {
        file,
        span: statement.span,
        message: reason,
      }),
    )
  }
}

// collect the names of all functions called within the body (restricted to the given set), for the call graph
function collectCalledNames(
  body: Statement[],
  names: Set<string>,
  variantFields: Map<string, string[]>,
): Set<string> {
  const found = new Set<string>()
  collectAllCalls(
    body,
    callee => {
      if (names.has(callee)) {
        found.add(callee)
      }
    },
    variantFields,
  )

  return found
}

// the argument lists of every call to `name` within the body (direct self-recursion)
// a self-call with the field-origin context (which variables are destructured fields of which subject) at the call site
type SelfCall = { args: Expression[]; memberOf: Map<string, string>; guards: Expression[] }

function collectSelfCalls(
  body: Statement[],
  name: string,
  out: SelfCall[],
  variantFields: Map<string, string[]>,
): void {
  walkCalls(
    body,
    (callee, args, memberOf, guards) => {
      if (callee === name) {
        out.push({ args, memberOf, guards })
      }
    },
    variantFields,
  )
}

// LEXICOGRAPHIC termination (the foetus criterion): a recursive function terminates if its argument positions can be
// ordered so that on every self-call the tuple strictly decreases lexicographically -- the first position that is not
// EQUAL is strictly smaller, with no "unknown" (possible-increase) position above it. Greedy: repeatedly pick a
// position that is `<`-or-`=` on every remaining call and `<` on at least one (it handles those calls, which descend at
// it with all higher positions equal); the calls where it is `=` continue with the remaining positions. Sound, since a
// lexicographic descent over the well-founded structural order cannot go forever. Subsumes the single-position check.
function lexicographicallyDescends(
  calls: SelfCall[],
  paramNames: string[],
): boolean {
  if (calls.length === 0) {
    return false
  }

  const classify = (call: SelfCall, p: number): '<' | '=' | '?' => {
    const arg = call.args[p]

    if (p >= paramNames.length || arg === undefined) {
      return '?'
    }

    if (strictlyDecreases(arg, paramNames[p]!, call.memberOf, call.guards)) {
      return '<'
    }

    // the argument is the parameter passed UNCHANGED (a non-increase at this position)
    if (arg.form === 'variable' && arg.name === paramNames[p]) {
      return '='
    }

    return '?'
  }

  let remaining = calls.map((_, i) => i)
  const usedPosition = new Set<number>()

  while (remaining.length > 0) {
    let chosen = -1

    for (let p = 0; p < paramNames.length; p++) {
      if (usedPosition.has(p)) {
        continue
      }

      const noUnknown = remaining.every(ci => classify(calls[ci]!, p) !== '?')
      const someStrict = remaining.some(ci => classify(calls[ci]!, p) === '<')

      if (noUnknown && someStrict) {
        chosen = p
        break
      }
    }

    if (chosen === -1) {
      return false
    }

    usedPosition.add(chosen)
    remaining = remaining.filter(ci => classify(calls[ci]!, chosen) !== '<')
  }

  return true
}

// calls to ANY function in `group` (a mutual-recursion SCC), keeping the call's argument terms and match-bindings, so
// mutual structural recursion can be verified (the rose-tree `count-rose` <-> `count-forest` shape).
function collectGroupCalls(
  body: Statement[],
  group: Set<string>,
  out: SelfCall[],
  variantFields: Map<string, string[]>,
): void {
  walkCalls(
    body,
    (callee, args, memberOf, guards) => {
      if (group.has(callee)) {
        out.push({ args, memberOf, guards })
      }
    },
    variantFields,
  )
}

// every called function name within the body, passed to `onCall`, for building the call graph
function collectAllCalls(
  body: Statement[],
  onCall: (callee: string) => void,
  variantFields: Map<string, string[]>,
): void {
  walkCalls(body, callee => onCall(callee), variantFields)
}

// walk a statement body, invoking `visit` for every call expression with a variable callee. `memberOf` tracks, within
// a `case <variant>` branch, each bound field's origin subject variable, so a recursion on a destructured field is seen
// as structural descent. `guards` are the conditions true on the path to each call (an enclosing branch, or an earlier
// branch that returned), which a NUMERIC descent needs (strictlyDecreases).
//
// A NAME IS A VALUE ONLY UNTIL IT IS REBOUND. A `save`, an assignment, a closure's or a walk's parameter, or a field of
// a match on something other than a plain variable, gives a name a new value, so from there on it is no longer the field
// it was (`link prior` then `save prior, read n` made `prior` be `n` itself, and `call f(prior)` read as a descent until
// 2026-10-05), and no guard about its old value holds. Each walk keeps its own copy of both, so a rebinding is seen by
// what follows it and by the bodies nested in it, and never by a sibling.
function walkCalls(
  body: Statement[],
  visit: (
    callee: string,
    args: Expression[],
    memberOf: Map<string, string>,
    guards: Expression[],
  ) => void,
  // both maps default so a malformed / partially-built AST can never deref an
  // undefined map here (a missing map degrades to "no structural info", at worst
  // a spurious non-fatal termination warning, never a compiler crash).
  variantFields = new Map<string, string[]>(),
  memberOf = new Map<string, string>(),
  // every name read as a VALUE, not called: a task handed on as a function may be called with any argument
  onValue?: (name: string) => void,
  guards: Expression[] = [],
): void {
  const members = new Map(memberOf)
  let path = [...guards]

  const forget = (names: Iterable<string>): void => {
    for (const name of names) {
      members.delete(name)
    }

    path = without(path, names)
  }

  // the members a nested body sees once `names` are bound afresh in it
  const membersWithout = (names: Iterable<string>): Map<string, string> => {
    const out = new Map(members)

    for (const name of names) {
      out.delete(name)
    }

    return out
  }

  const visitExpression = (node: Expression, at: Expression[] = path): void => {
    switch (node.form) {
      case 'variable':
        onValue?.(node.name)
        break
      case 'call':
        // a named callee is a call, not a value: `visit` has it, and reading it as a value would count every call twice
        if (node.callee.form === 'variable') {
          visit(node.callee.name, node.args, members, at)
        } else {
          visitExpression(node.callee, at)
        }

        node.args.forEach(arg => visitExpression(arg, at))
        break
      case 'binary':
        visitExpression(node.left, at)
        visitExpression(node.right, at)
        break
      case 'unary':
        visitExpression(node.operand, at)
        break
      case 'member':
        visitExpression(node.target, at)
        break
      case 'await':
        visitExpression(node.expr, at)
        break
      case 'template':
        for (const part of node.parts) {
          if (part.form === 'value') {
            visitExpression(part.value, at)
          }
        }

        break
      case 'array':
        node.items.forEach(item => visitExpression(item, at))
        break
      case 'map':
        node.entries.forEach(entry => {
          visitExpression(entry.key, at)
          visitExpression(entry.value, at)
        })
        break
      case 'record':
        node.fields.forEach(field => visitExpression(field.value, at))
        break
      case 'conditional': {
        // a branch's value is reached when its condition holds and every earlier one failed
        const failed: Expression[] = []

        node.branches.forEach(branch => {
          visitExpression(branch.cond, [...at, ...failed])
          visitExpression(branch.value, [...at, ...failed, branch.cond])
          failed.push(not(branch.cond))
        })

        if (node.otherwise) {
          visitExpression(node.otherwise, [...at, ...failed])
        }

        break
      }
      case 'closure': {
        // a self-call inside an inline function value (the continuation of a well-founded recursor, `\y pf. wf-rec f y
        // (step y pf)`) is still a recursion. Walk the closure body with the SAME members, so a field destructured in
        // the enclosing match (`step` from `mkacc step`) is still seen as the parameter's child at the recursive call,
        // less the names its own parameters rebind. A closure may run long after the path that made it, so it carries
        // no guard
        const params = node.params.map(param => param.name)
        walkCalls(node.body, visit, variantFields, membersWithout(params), onValue, [])
        break
      }
      default:
        break
    }
  }

  const visitStatement = (node: Statement): void => {
    switch (node.form) {
      case 'let':
        visitExpression(node.init)
        forget([node.name])
        break
      case 'assign': {
        visitExpression(node.target)
        visitExpression(node.value)
        forget(writtenNames(node))
        break
      }
      case 'expression':
        visitExpression(node.expr)
        break
      case 'return':
        if (node.value) {
          visitExpression(node.value)
        }

        break
      case 'throw':
        visitExpression(node.value)
        break
      case 'hold':
        visitExpression(node.expr)
        break
      case 'while': {
        // a later turn sees what an earlier one wrote, so neither a member nor a guard about a name the loop writes
        // holds inside it, beyond the condition each turn tests
        const written = writtenNames(node.body)
        visitExpression(node.cond, without(path, written))
        walkCalls(node.body, visit, variantFields, membersWithout(written), onValue, [...without(path, written), node.cond])
        forget(written)
        break
      }
      case 'guard':
        walkCalls(node.body, visit, variantFields, members, onValue, path)

        if (node.catch) {
          walkCalls(node.catch.body, visit, variantFields, membersWithout([node.catch.name]), onValue, without(path, [node.catch.name]))
        }

        forget(writtenNames(node))
        break
      case 'for-each': {
        visitExpression(node.iterable)

        const bound = [node.item, ...(node.index ? [node.index] : []), ...writtenNames(node.body)]
        walkCalls(node.body, visit, variantFields, membersWithout(bound), onValue, without(path, bound))
        forget(writtenNames(node.body))
        break
      }
      case 'if': {
        const failed: Expression[] = []

        for (const branch of node.branches) {
          visitExpression(branch.cond, [...path, ...failed])
          walkCalls(branch.body, visit, variantFields, members, onValue, [...path, ...failed, branch.cond])
          failed.push(not(branch.cond))
        }

        if (node.otherwise) {
          walkCalls(node.otherwise, visit, variantFields, members, onValue, [...path, ...failed])
        }

        // what a branch wrote is a new value after the `if`
        forget(writtenNames(node))

        // AN EARLY RETURN: past an `if` whose first branches all leave, none of their conditions held. (Only a
        // leading run: past a branch that does not leave, a later one's condition may have held after all)
        for (const branch of node.branches) {
          if (!exits(branch.body)) {
            break
          }

          path = [...path, not(branch.cond)]
        }

        break
      }

      case 'match': {
        visitExpression(node.subject)

        // if the match is on a plain variable, the matched fields of each branch are members of that variable
        const subjectVar =
          node.subject.form === 'variable'
            ? node.subject.name
            : undefined

        for (const branch of node.cases) {
          const fields = branch.binds ?? variantFields?.get(branch.label) ?? []
          // the fields are bound afresh in the branch: members of the subject when it is a plain variable, and of
          // nothing a parameter is when it is not (a field of `g(x)` named `prior` is not the `prior` of an outer match)
          const branchMembers = membersWithout(fields)

          if (subjectVar) {
            // honor a `binds` field-rename so a recursion on the renamed field is still seen as structural descent
            for (const fieldName of fields) {
              branchMembers.set(fieldName, subjectVar)
            }
          }

          walkCalls(branch.body, visit, variantFields, branchMembers, onValue, without(path, fields))
        }

        if (node.otherwise) {
          walkCalls(node.otherwise, visit, variantFields, members, onValue, path)
        }

        forget(writtenNames(node))
        break
      }

      default:
        break
    }
  }

  body.forEach(visitStatement)
}
