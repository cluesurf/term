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

import type { Diagnostic } from '@cluesurf/make/code/parser/diagnostic'
import { diagnose } from '@cluesurf/make/code/parser/diagnostic'
import type {
  Expression,
  Program,
  Statement,
  Type,
} from '@cluesurf/make/code/compile/node'

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

  if (
    arg.form === 'binary' &&
    arg.left.form === 'variable' &&
    arg.left.name === paramName
  ) {
    if (
      arg.op === '-' &&
      arg.right.form === 'integer' &&
      Number(arg.right.value) > 0
    ) {
      return true
    }

    if (
      arg.op === '/' &&
      arg.right.form === 'integer' &&
      Number(arg.right.value) > 1
    ) {
      return true
    }

    if (arg.op === '%') {
      return true
    }
  }

  return false
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

  for (const [name, statement] of functions) {
    edges.set(
      name,
      collectCalledNames(statement.body, names, variantFields),
    )
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
    if (!reaches(name).has(name)) {
      verdict.set(name, true) // not recursive: trivially terminating
      continue
    }

    // DIRECT recursion (the primary, pre-existing check): some single argument position strictly decreases on every
    // SELF-call. Tried first, so a function verified this way keeps its prior verdict exactly (no regression).
    const paramNames = statement.params.map(p => p.name)
    const selfCalls: SelfCall[] = []
    collectSelfCalls(statement.body, name, selfCalls, variantFields)

    let positions = new Set<number>(paramNames.map((_, i) => i))

    for (const { args, memberOf } of selfCalls) {
      const decreasing = new Set<number>()

      for (let i = 0; i < paramNames.length && i < args.length; i++) {
        if (strictlyDecreases(args[i]!, paramNames[i]!, memberOf)) {
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
    }

    const groupCalls: GroupCall[] = []

    for (const member of scc) {
      const memberStatement = functions.get(member)!
      const memberParams = memberStatement.params.map(p => p.name)
      const calls: SelfCall[] = []
      collectGroupCalls(memberStatement.body, scc, calls, variantFields)

      for (const { args, memberOf } of calls) {
        groupCalls.push({ callerParams: memberParams, args, memberOf })
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
type SelfCall = { args: Expression[]; memberOf: Map<string, string> }

function collectSelfCalls(
  body: Statement[],
  name: string,
  out: SelfCall[],
  variantFields: Map<string, string[]>,
): void {
  walkCalls(
    body,
    (callee, args, memberOf) => {
      if (callee === name) {
        out.push({ args, memberOf })
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

    if (strictlyDecreases(arg, paramNames[p]!, call.memberOf)) {
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
    (callee, args, memberOf) => {
      if (group.has(callee)) {
        out.push({ args, memberOf })
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
// as structural descent.
function walkCalls(
  body: Statement[],
  visit: (
    callee: string,
    args: Expression[],
    memberOf: Map<string, string>,
  ) => void,
  // both maps default so a malformed / partially-built AST can never deref an
  // undefined map here (a missing map degrades to "no structural info", at worst
  // a spurious non-fatal termination warning, never a compiler crash).
  variantFields = new Map<string, string[]>(),
  memberOf = new Map<string, string>(),
): void {
  const visitExpression = (node: Expression): void => {
    switch (node.form) {
      case 'call':
        if (node.callee.form === 'variable') {
          visit(node.callee.name, node.args, memberOf)
        }

        visitExpression(node.callee)
        node.args.forEach(visitExpression)
        break
      case 'binary':
        visitExpression(node.left)
        visitExpression(node.right)
        break
      case 'unary':
        visitExpression(node.operand)
        break
      case 'member':
        visitExpression(node.target)
        break
      case 'await':
        visitExpression(node.expr)
        break
      case 'array':
        node.items.forEach(visitExpression)
        break
      case 'map':
        node.entries.forEach(entry => {
          visitExpression(entry.key)
          visitExpression(entry.value)
        })
        break
      case 'record':
        node.fields.forEach(field => visitExpression(field.value))
        break
      case 'conditional':
        node.branches.forEach(branch => {
          visitExpression(branch.cond)
          visitExpression(branch.value)
        })

        if (node.otherwise) {
          visitExpression(node.otherwise)
        }

        break
      default:
        break
    }
  }

  const visitStatement = (node: Statement): void => {
    switch (node.form) {
      case 'let':
        visitExpression(node.init)
        break
      case 'assign':
        visitExpression(node.target)
        visitExpression(node.value)
        break
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
      case 'while':
        visitExpression(node.cond)
        walkCalls(node.body, visit, variantFields, memberOf)
        break
      case 'for-each':
        visitExpression(node.iterable)
        walkCalls(node.body, visit, variantFields, memberOf)
        break
      case 'if':
        for (const branch of node.branches) {
          visitExpression(branch.cond)
          walkCalls(branch.body, visit, variantFields, memberOf)
        }

        if (node.otherwise) {
          walkCalls(node.otherwise, visit, variantFields, memberOf)
        }

        break

      case 'match': {
        visitExpression(node.subject)

        // if the match is on a plain variable, the matched fields of each branch are members of that variable
        const subjectVar =
          node.subject.form === 'variable'
            ? node.subject.name
            : undefined

        for (const branch of node.cases) {
          let branchMembers = memberOf

          if (subjectVar) {
            branchMembers = new Map(memberOf)

            // honor a `binds` field-rename so a recursion on the renamed field is still seen as structural descent
            for (const fieldName of branch.binds ??
              variantFields?.get(branch.label) ??
              []) {
              branchMembers.set(fieldName, subjectVar)
            }
          }

          walkCalls(branch.body, visit, variantFields, branchMembers)
        }

        if (node.otherwise) {
          walkCalls(node.otherwise, visit, variantFields, memberOf)
        }

        break
      }

      default:
        break
    }
  }

  body.forEach(visitStatement)
}
