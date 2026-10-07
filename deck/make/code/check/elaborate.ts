// Elaboration: the bridge that makes the sound dependent kernel (judge.ts) the single type-checking authority. The
// surface pass (resolve + infer) is the inference front-end; here the annotated surface AST becomes explicit kernel terms
// and the KERNEL verifies them (note/research/vibe/computation/plans/12-type-systems.md, step 5).
//
// The elaborator is Term (self-hosting, 2026-10-06), in ten parts under check/, each a module with a header that says
// what it does and what it decided: elaborating-data (the program's types, data and signature), -rewrite (term
// rewriting), -cases (what an eliminator decides: no-confusion, the truth table, ring and order cases), -terms
// (`expr` and `body`), -proof (an explicit proof and the lemmas), -commands (the effect layer), -theorems (what a hold
// asks of its theorem), -induction, -holds (one hold) and -main (the loop over the tasks). The kernel is
// check/judging.tree, called through `kernel-call` and the `attempt` steps wherever the original caught its errors.
//
// This face keeps what reads a node by reflection or by identity, what is `JSON.stringify` in key order, and what
// another session's modules answer, and hands each in as a task: `collectNumberLiteralValues`, `kindsApart`,
// `sameValueArgs`, `carriedBodies`, `callsItself`, `containsMemberWrite`, `readsMember`, `etaPair`, check/facts.ts
// (a face with an identity cache), check/unfold.ts's table, check/induct.ts (the product prover's budget) and
// check/holds.ts's `isLinearGoal` and `orderFollows`. A raise from a part reaches TypeScript through judge.ts's
// `kernel`, as the original's class, and a `decline:` failure becomes `Decline` here.

import type {
  Diagnostic,
  Span,
} from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import { transparentAliases } from '@term/make/code/check/alias'
import * as elaborating from '@term/make/code/check/elaborating-data'
import * as cases from '@term/make/code/check/elaborating-cases'
import * as terms from '@term/make/code/check/elaborating-terms'
import * as proofs from '@term/make/code/check/elaborating-proof'
import * as induction from '@term/make/code/check/elaborating-induction'
import * as holds from '@term/make/code/check/elaborating-holds'
import * as main from '@term/make/code/check/elaborating-main'
import type {
  Expression,
  Program,
  Statement,
} from '@term/make/code/compile/node'
import type { Context, Term } from '@term/make/code/check/judge'
import {
  contextWithSignature,
  defineConstant,
  registerTruncation,
  evaluate,
  infer,
  judgeState,
  kernel,
  litLevel,
  resetDefinitions,
  resetMetas,
} from '@term/make/code/check/judge'
import { terminatingFunctions } from '@term/make/code/check/totality'
import { isLinearGoal, orderFollows } from '@term/make/code/check/holds'
import { checkFold, checkFoldOrder } from '@term/make/code/check/induct'
import { unfoldDefinitions } from '@term/make/code/check/unfold'
import {
  callsImpure,
  EVERYTHING,
  functionNames,
  localNames,
  pureFunctions,
  readNames,
  readsAny,
  readsState,
  rootName,
  volatileNames,
  writtenNames,
} from '@term/make/code/check/facts'
import { integerText } from '@term/make/code/compile/type-text'

const TYPE0: Term = { tag: 'type', level: litLevel(0) }

// the base signature's constant names, which a task of the program must not take (`kindsApart`)
const BASE_SIGNATURE = elaborating.baseSignature() as { name: string; type: Term }[]

// the program's transparent aliases, and the ones being read through right now, one state per elaboration
let aliasState = elaborating.newAliasState(new Map())

// two lists of value arguments, compared as written (spans, resolved types and bindings set aside)
function sameValueArgs(
  a: Expression[] | undefined,
  b: Expression[] | undefined,
): boolean {
  const text = (e: Expression[] | undefined): string =>
    JSON.stringify(e ?? [], (key, value) =>
      key === 'span' || key === 'type' || key === 'binding' ? undefined : value,
    )

  return text(a) === text(b)
}

// thrown to abandon checking a construct the effect layer cannot represent yet (distinct from a real type error,
// which surfaces as the kernel's TypeError). A declined function is left to the surface checker and counted, with
// the reason, in the report's `declined`.
class Decline extends Error {
  constructor(readonly reason: string = 'an expression the kernel cannot represent') {
    super(reason)
  }
}

// a Term part's decline (a `failure` whose note is `decline:` and the reason, check/judging.tree `decline`) as the
// original's `Decline`, and any other raise as it came
function asDecline(error: unknown): unknown {
  const raised = error as { form?: unknown; note?: unknown } | undefined

  if (raised && raised.form === 'failure' && typeof raised.note === 'string' && raised.note.startsWith('decline:')) {
    return new Decline(raised.note.slice('decline:'.length))
  }

  return error
}

// the elaboration result: kernel diagnostics, plus which functions the kernel actually verified (versus declined
// as outside the covered fragment). The `verified` set is what proves the kernel did the work, not a rubber stamp.
export type ElaborationReport = {
  diagnostics: Diagnostic[]
  verified: string[]
  // the tasks whose WHOLE BODY elaborated to one kernel term checked against the declared type. This is the only
  // kind of verification that is a proof: a body the command checker accepts is type-safe statement by statement,
  // but nothing there checks that every path returns a value, so a body with no return at all passed it. A claim's
  // fill must be in this set (check/claim.ts).
  proven: string[]
  // every task the kernel did not verify, with the reason, so "the kernel checked it" and "the kernel never looked"
  // can be told apart and counted (proof-by-default-0005)
  declined: { name: string; reason: string }[]
  discharged: Span[]
}

// deep-walk the program collecting every integer / float literal value, so each can be postulated in the signature
// before checking (an unregistered constant is a type error in the kernel). A generic walk avoids hard-coding the
// expression AST shape; a seen-set guards against any shared / cyclic references introduced by resolution.
function collectNumberLiteralValues(program: Program): Set<string> {
  const values = new Set<string>()
  const seen = new Set<unknown>()

  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object' || seen.has(node)) {
      return
    }

    seen.add(node)

    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item)
      }

      return
    }

    const form = (node as { form?: unknown }).form

    // an integer by its EXACT text, the name every use of it is elaborated to (`integerText`): past 2^53 its `value`
    // is the rounded number, so registering that left `numberValue#9007199254740993` unknown (test/compile/guide-gaps.ts,
    // "a literal past 2^53"). A float has no exact text but its value
    if (form === 'integer') {
      values.add(integerText(node as Parameters<typeof integerText>[0]))
    } else if (form === 'float') {
      values.add(String((node as { value?: unknown }).value))
    }

    for (const key of Object.keys(node)) {
      visit((node as Record<string, unknown>)[key])
    }
  }

  visit(program)

  return values
}

export function elaborate(
  program: Program,
  file: string,
): Diagnostic[] {
  return elaborateReport(program, file).diagnostics
}

// ONE NAME, TWO KINDS (module-scope-0005). A task and a form may share a name, told apart by where it stands, but the
// kernel keeps one namespace of constants: the form's type former and the task's definition were both `point`, and a
// type position found the task (`kernel: expected a type`). So, on the kernel's OWN copy of the program, a form whose
// name a task also has is renamed `<name>__form` everywhere it stands as a type: a named type, a construction, a raise,
// a method's owner. Tasks keep their names. The emitted program never sees this copy.
//
// A PARAMETER is the same collision one scope down (self-hosting, 2026-10-04): a task is a Π type, so its result type
// sits under its parameters' binders, and `take box, like box` / `like box` found the PARAMETER `box` where the result
// type named the form, `kernel: type mismatch: expected box, found box`. The ir/net port met it as `take net, like net`.
// So a form whose name any parameter has is renamed the same way. test/check/form-parameter.ts holds it.
//
// And a TASK named like one of the kernel's own constants (BASE_SIGNATURE: `equal`, `notequal`, `cond`, ...) is renamed
// `<name>__task` on the kernel's copy, at its definition and every call of it. The kernel lowers `is-equal` to its
// `equal`, so a user task `equal` took the comparison over: every `is-equal` in the module failed as
// `expected <form>, found Type 0`, pointing at a task that had nothing wrong with it (the check/cubical port,
// 2026-10-04). test/check/builtin-name.ts holds it
function kindsApart(program: Program): Program {
  const tasks = new Set(program.flatMap(s => (s.form === 'function' && !s.method ? [s.name] : [])))
  const params = new Set(program.flatMap(s => (s.form === 'function' ? s.params.map(p => p.name) : [])))
  // and a form named `type` is the same collision with the kernel's UNIVERSE, which `like type` names when no form
  // does: the compiler's own AST declares one (compile/node.tree), and every task answering it failed as `kernel: type
  // mismatch` (2026-10-05, test/check/form-named-type.ts)
  const shared = new Set(
    program.flatMap(s =>
      s.form === 'record-type' && (tasks.has(s.name) || params.has(s.name) || s.name === 'type') ? [s.name] : [],
    ),
  )
  const kernelNames = new Set(BASE_SIGNATURE.map(entry => entry.name))
  const clashing = new Set([...tasks].filter(name => kernelNames.has(name)))

  if (shared.size === 0 && clashing.size === 0) {
    return program
  }

  const copy = structuredClone(program)
  const apart = (name: string): string => (shared.has(name) ? `${name}__form` : name)
  const task = (name: string): string => (clashing.has(name) ? `${name}__task` : name)

  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') {
      return
    }

    if (Array.isArray(node)) {
      node.forEach(visit)

      return
    }

    const record = node as Record<string, unknown>

    if (record.kind === 'named' && typeof record.name === 'string') {
      record.name = apart(record.name)
    }

    if ((record.form === 'record' || record.form === 'record-type') && typeof record.name === 'string') {
      record.name = apart(record.name)
    }

    if (record.form === 'throw' && typeof record.raise === 'string') {
      record.raise = apart(record.raise)
    }

    if (record.form === 'function' && record.method && typeof (record.method as { form?: unknown }).form === 'string') {
      const method = record.method as { form: string }
      method.form = apart(method.form)
    }

    // a top-level task named like a kernel constant, and every call of it
    if (record.form === 'function' && !record.method && typeof record.name === 'string') {
      record.name = task(record.name)
    }

    if (record.form === 'call') {
      const callee = record.callee as { form?: string; name?: unknown } | undefined

      if (callee?.form === 'variable' && typeof callee.name === 'string') {
        callee.name = task(callee.name)
      }
    }

    for (const [key, value] of Object.entries(record)) {
      if (key !== 'span') {
        visit(value)
      }
    }
  }

  visit(copy)

  return copy
}

export function elaborateReport(
  written: Program,
  file: string,
): ElaborationReport {
  resetMetas()
  resetDefinitions()
  const program = kindsApart(written)

  // transparent aliases, read through wherever the kernel reads a type, as the checker reads them when it unifies
  aliasState = elaborating.newAliasState(transparentAliases(program))

  // gate for transparent definitions. Best-effort: a failure here just means no function is treated as transparent (a
  // sound, conservative fallback), never a compiler crash.
  let terminating: Set<string>

  try {
    terminating = terminatingFunctions(program)
  } catch {
    terminating = new Set<string>()
  }

  // which tasks are pure, and for the task being checked, the names it binds itself, the names a closure inside it may
  // write at any time, and its marks when it is a rule (a task-typed mark ranges over the kernel's pure functions, so a
  // call to one is a value). The command checker reads these to decide which path facts survive. check/facts.ts.
  const factsPure = pureFunctions(program)
  const factsFunctions = functionNames(program)
  let factsLocal = new Set<string>()
  let factsVolatile = new Set<string>()
  let ruleMarks = new Set<string>()
  // the tasks with a `natural-number` parameter, whose subtraction truncates: never unfolded for the ring
  const truncating = program.flatMap(s =>
    s.form === 'function' && s.params.some(p => p.refine === 'natural') ? [s.name] : [],
  )
  const withoutRuleMarks = (locals: Set<string>): Set<string> => new Set([...locals].filter(name => !ruleMarks.has(name)))
  const impure = (node: Statement | Statement[] | Expression): boolean =>
    callsImpure(node, factsPure, factsFunctions, withoutRuleMarks(factsLocal))

  const diagnostics: Diagnostic[] = []
  const verified: string[] = []
  const proven: string[] = []
  const declined: { name: string; reason: string }[] = []
  const discharged: Span[] = [] // holds the kernel proved by definitional equality (the non-linear fallback)
  // the named, proven lemmas, their rewrite rules, and the program's theorems (check/elaborating-proof.tree)
  const lemmaState = proofs.newLemmaState(
    new Map(program.flatMap(s => (s.form === 'function' && s.theorem ? [[s.name, true] as const] : []))),
  )

  // the program's types and data as the kernel reads them (check/elaborating-data.tree)
  const elaborated = elaborating.elaborationDataOf(
    program as never,
    aliasState,
    [...collectNumberLiteralValues(program)],
    (left, right) =>
      sameValueArgs(
        (left as { valueArgs?: Expression[] }).valueArgs,
        (right as { valueArgs?: Expression[] }).valueArgs,
      ),
  )

  // a PROPOSITIONAL TRUNCATION's constructors are registered for proof irrelevance and kept rigid, each with its arity
  for (const entry of elaborated.truncations) {
    registerTruncation(entry.name, entry.arity)
  }

  const recordFields = elaborated.recordFields
  const baseContext = contextWithSignature(elaborated.signature as never)

  // make each enum transparently equal to its derived self-type encoding, but only if that encoding type-checks as a
  // well-formed type (otherwise leave it as the postulated opaque type). The fuel-bounded delta keeps the recursive
  // reference safe.
  for (const { name, term: encoding } of elaborated.enumEncodings as { name: string; term: Term }[]) {
    try {
      if (infer(baseContext, encoding).type.v === 'type') {
        defineConstant(name, evaluate([], encoding))
      }
    } catch {
      // the encoding did not form: keep the postulated type, no derivation
    }
  }

  // register the computing constructor / eliminator definitions so the kernel REDUCES a match on a constructor. These
  // are closed terms (no free variables), so they evaluate in the empty environment.
  for (const { name, term } of elaborated.enumDefs as { name: string; term: Term }[]) {
    try {
      defineConstant(name, evaluate([], term))
    } catch {
      // a malformed encoding: leave the constructor / eliminator as an opaque postulate
    }
  }

  // every part is called through judge.ts's `kernel`, so a raise reaches this face as the original's class
  const viaKernel = <T,>(call: () => T): T => {
    try {
      return kernel(call)
    } catch (error) {
      throw asDecline(error)
    }
  }

  // the states of the parts: the terms', the fold's case and counterexample, induction's
  const termState = terms.newTermState(
    judgeState(),
    elaborated as never,
    aliasState,
    program as never,
    evaluate([], TYPE0) as never,
  )
  const caseState = cases.newCaseState()
  const inductionState = induction.newInductionState(
    termState,
    lemmaState as never,
    caseState as never,
    truncating,
    NO_SPAN as never,
    (goal, facts) => orderFollows(goal as never, facts as never),
  )

  // RECORD ETA, for the ring normalizer: a value of a form with no cases IS the construction of its fields. So when one
  // side of an equation unfolds to `make vector-two(...)` and the other is a name, the name is read as
  // `make vector-two(v/x, v/y)`, each field an unknown of its own, spelled as check/unfold.ts spells a field read
  const etaPair = (left: Expression, right: Expression): [Expression, Expression] => {
    const expand = (named: Expression, record: Extract<Expression, { form: 'record' }>): Expression => {
      const fields = recordFields.get(record.name)

      return fields && named.form === 'variable'
        ? {
            ...record,
            fields: fields.map(field => ({
              name: field,
              value: { form: 'variable', name: `${named.name}/${field}`, span: record.span },
            })),
          }
        : named
    }

    if (left.form === 'record' && right.form !== 'record') {
      return [left, expand(right, left)]
    }

    if (right.form === 'record' && left.form !== 'record') {
      return [expand(left, right), right]
    }

    return [left, right]
  }

  function containsMemberWrite(body: Statement[]): boolean {
    let found = false
    const stack: unknown[] = [body]

    while (stack.length > 0 && !found) {
      const node = stack.pop()

      if (node === null || typeof node !== 'object') {
        continue
      }

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

  function readsMember(expression: Expression): boolean {
    let found = false
    const stack: unknown[] = [expression]

    while (stack.length > 0 && !found) {
      const node = stack.pop()

      if (node === null || typeof node !== 'object') {
        continue
      }

      if (Array.isArray(node)) {
        stack.push(...node)
        continue
      }

      const record = node as Record<string, unknown>

      if (record.form === 'member') {
        found = true
      }

      for (const key of Object.keys(record)) {
        if (key !== 'type' && key !== 'span') {
          stack.push(record[key])
        }
      }
    }

    return found
  }

  // a task whose body holds a call of its own name, found by walking every node of it
  function callsItself(s: Extract<Statement, { form: 'function' }>): boolean {
    const stack: unknown[] = [s.body]

    while (stack.length > 0) {
      const node = stack.pop()

      if (node === null || typeof node !== 'object') {
        continue
      }

      if (Array.isArray(node)) {
        stack.push(...node)
        continue
      }

      const record = node as Record<string, unknown>
      const callee = record.callee as { form?: string; name?: string } | undefined

      if (record.form === 'call' && callee?.form === 'variable' && callee.name === s.name) {
        return true
      }

      stack.push(...Object.values(record))
    }

    return false
  }

  // what the effect layer and a hold ask of this face (check/elaborating-commands.tree, check/elaborating-holds.tree)
  const commandHost = {
    callsImpureStatement: (statement: unknown) => impure(statement as Statement),
    callsImpureBody: (body: unknown) => impure(body as Statement[]),
    callsImpureExpression: (expression: unknown) => impure(expression as Expression),
    readsState: (expression: unknown) => readsState(expression as Expression),
    readsAny: (expression: unknown, names: string[]) => readsAny(expression as Expression, new Set(names)),
    readsName: (expression: unknown, name: string) => readNames(expression as Expression).has(name),
    writtenNames: (statement: unknown) => [...writtenNames(statement as Statement)],
    writtenNamesBody: (body: unknown) => [...writtenNames(body as Statement[])],
    rootName: (expression: unknown) => rootName(expression as Expression) ?? EVERYTHING,
    everything: EVERYTHING,
    volatileNames: () => [...factsVolatile],
    containsMemberWrite: (body: unknown) => containsMemberWrite(body as Statement[]),
    readsMember: (expression: unknown) => readsMember(expression as Expression),
    checkHold: (statement: unknown, scope: Map<string, number>, ctx: unknown, assumptions: unknown) => {
      viaKernel(() => holds.checkHold(holdState as never, statement as never, scope, ctx as never, assumptions as never))

      return true
    },
  }
  const holdState = {
    is: inductionState,
    host: {
      callsImpureExpression: (expression: unknown) => impure(expression as Expression),
      unfoldDefinitions: (expression: unknown) => unfoldDefinitions(expression as Expression, program),
      checkFold: (goal: unknown, inductVar: string) => checkFold(program, goal as Expression, inductVar),
      checkFoldOrder: (goal: unknown, inductVar: string, guards: unknown) =>
        checkFoldOrder(program, goal as Expression, inductVar, guards as Expression[]),
      isLinearGoal: (goal: unknown) => isLinearGoal(goal as Expression),
      etaPair: (left: unknown, right: unknown) => {
        const [l, r] = etaPair(left as Expression, right as Expression)

        return { left: l, right: r }
      },
      diagnose: (name: string, span: unknown, message: string, hint: string) =>
        diagnose(name as never, { file, span: span as Span, message, ...(hint ? { hint } : {}) }),
      callsItself: (statement: unknown) => callsItself(statement as Extract<Statement, { form: 'function' }>),
    },
    program,
    diagnostics,
    discharged,
  }

  // The loop over the tasks and the top-level holds (check/elaborating-main.tree). This face sets each task's fact
  // names (`enterTask`: a stub's carried body spread over its own, as the original's `task` was) and prints the
  // `TERM_KERNEL_TRACE` line; the stubs whose carried body this unit reaches stay here (a reflective walk)
  const toSet = (names: Set<string>): Map<string, boolean> => new Map([...names].map(name => [name, true]))
  const mainState = {
    ts: termState,
    hs: holdState,
    commands: commandHost,
    host: {
      enterTask: (statement: unknown, stub: boolean) => {
        const fn = statement as Extract<Statement, { form: 'function' }>
        const task = stub ? { ...fn, body: fn.stubBody! } : fn
        factsLocal = localNames(task)
        factsVolatile = volatileNames(task.body)
        ruleMarks = fn.theorem ? new Set(fn.params.map(param => param.name)) : new Set()

        return true
      },
      leaveTask: () => {
        factsLocal = new Set()
        factsVolatile = new Set()
        ruleMarks = new Set()

        return true
      },
      trace: (name: string, message: string) => {
        // TERM_KERNEL_TRACE=1 prints where the kernel failed on a task, which the decline reason alone cannot say
        if (typeof process !== 'undefined' && process.env?.TERM_KERNEL_TRACE) {
          console.error(`kernel trace for ${name}:`, message)
        }

        return true
      },
    },
    baseContext: baseContext as Context,
    terminating: toSet(terminating),
    pure: toSet(factsPure),
    carried: toSet(carriedBodies(program)),
    verified,
    proven,
    declined,
  }

  viaKernel(() => main.checkProgram(mainState as never, program as never, file))

  return { diagnostics, verified, proven, declined, discharged }
}

// the span of an expression the kernel builds for the ring from its own terms (`ringCase`), which no source wrote
const NO_SPAN = { start: { line: 0, column: 0, offset: 0 }, end: { line: 0, column: 0, offset: 0 } }

// THE STUBS WHOSE CARRIED BODY THIS UNIT REACHES: named by one of its own statements, or by a body reached so. A unit
// reaches a few tasks of its dependency closure, so elaborating every carried body of the closure in every unit would
// pay for thousands to use a handful. Read by name, every text in a statement, as compile/stub.ts `namesUsed` does,
// which may take a few more than are called and never fewer
function carriedBodies(program: Program): Set<string> {
  const bodies = new Map<string, Statement[]>()

  for (const statement of program) {
    if (statement.form === 'function' && statement.stub && statement.stubBody) {
      bodies.set(statement.name, statement.stubBody)
    }
  }

  const reached = new Set<string>()

  if (bodies.size === 0) {
    return reached
  }

  const queue: unknown[] = program.filter(statement => !(statement.form === 'function' && statement.stub))

  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      const body = bodies.get(node)

      if (body && !reached.has(node)) {
        reached.add(node)
        queue.push(body)
      }
    } else if (Array.isArray(node)) {
      node.forEach(walk)
    } else if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key !== 'span') {
          walk(value)
        }
      }
    }
  }

  while (queue.length > 0) {
    walk(queue.pop())
  }

  return reached
}
