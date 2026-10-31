// The effect checker: tracks the async effect across the program and enforces a consistent async / await
// discipline. This is the surface-level slice of the effect system (the deeper, kernel-level treatment ties
// effects and mutation to the `1` multiplicity / linear regions; see plans/18-type-theory-gaps.md). The rules,
// given the model where `mark async` marks a task async and a call to one is awaited by default:
//   1. `await` may only appear inside an async task.
//   2. `await` may only target an asynchronous task (awaiting a synchronous one is meaningless).
//   3. an asynchronous call in a synchronous task must be awaited or ticked (otherwise its result escapes unhandled).
//   4. `tick` may only start an asynchronous task.
//   5. outside every task, an asynchronous call must be ticked (checkCallsOutsideTasks, behind its switch).
// Browser-safe, no host APIs.

import type {
  Diagnostic,
  Span,
} from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import type {
  Expression,
  Program,
  Statement,
  Type,
} from '@term/make/code/compile/node'
import {
  exceptionForm,
  isGenericException,
} from '@term/make/code/check/extend'

const EXCEPTION_FORM = exceptionForm()

// the inferred effect row of each function: the set of effects it may perform. `async` is the marker effect
// (resolved at an await, so it does not propagate). `throw` propagates transitively through the call graph (a
// caller of a throwing function may itself throw). This is effect-row inference -- the typed core of the effect
// system; row-variable polymorphism over task-typed callbacks is the further step (it needs effect annotations on
// those parameters).
export function effectRows(program: Program): Map<string, string[]> {
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

  const rows = new Map<string, Set<string>>()
  const calls = new Map<string, Set<string>>()

  for (const [name, statement] of functions) {
    const row = new Set<string>()

    if (statement.async) {
      row.add('async')
    }

    if (bodyThrows(statement.body)) {
      row.add('throw')
    }

    // effect-row polymorphism through callbacks: a function that calls an effectful callback parameter inherits
    // that callback's declared effects (its row depends on the callback it is given)
    const paramNames = new Set(statement.params.map(p => p.name))
    const calledParams = calledNames(statement.body, paramNames)

    for (const param of statement.params) {
      if (
        calledParams.has(param.name) &&
        param.type?.kind === 'function' &&
        param.type.effects
      ) {
        // a declared raise (`halt <form>`) is the raise sets' to read, never an effect of the row
        for (const effect of param.type.effects) {
          if (!isSlotHalt(effect)) {
            row.add(effect)
          }
        }
      }
    }

    rows.set(name, row)

    // a call to one of its own parameters is that parameter, whose effects were added just above, never the
    // top-level task of the same name: `list/find-index` calling its `test` read as `file/test`, and a native backend
    // then put `?` on a callback that returns a plain `bool` (2026-10-04). A local it binds is the same (`boundNames`)
    const bound = boundNames(statement.body)
    calls.set(
      name,
      new Set(
        [...calledNames(statement.body, names)].filter(
          callee => !paramNames.has(callee) && !bound.has(callee),
        ),
      ),
    )
  }

  // least fixed point: a function throws if it calls (transitively) a throwing function
  let changed = true

  while (changed) {
    changed = false

    for (const [name, callees] of calls) {
      const row = rows.get(name)!

      for (const callee of callees) {
        if (rows.get(callee)?.has('throw') && !row.has('throw')) {
          row.add('throw')
          changed = true
        }
      }
    }
  }

  // each row a list, in the order its effects were found (check/effects.tree)
  return new Map([...rows].map(([name, row]) => [name, [...row]]))
}

// EVERY NAME A TASK'S BODY BINDS FOR ITSELF, at any depth and inside its closures: a `let`, a walk's item and index, a
// closure's parameters, the names an arm's `link` lines give, a caught value's name. A call through one of them is
// never the task of that name, for the effect rows, the raise sets, or Rust's `?` (compile/rust-emit.tree
// `bound-names-into`, the same set): site's reactive.tree walks its cleanups as `take site, name run` / `call run`, and
// the walk local took the raises of a test entry task `run` (seam-0026). The set is the whole body's, as async
// resolution's `shadowed` is, so the three passes agree on every call. Twin: check/effects.tree `bound-names`
function boundNames(body: Statement[]): Set<string> {
  const bound = new Set<string>()

  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') {
      return
    }

    if (Array.isArray(node)) {
      node.forEach(visit)

      return
    }

    const record = node as Record<string, unknown>

    switch (record.form) {
      case 'let':
        bound.add(record.name as string)
        break
      case 'for-each':
        bound.add(record.item as string)

        if (typeof record.index === 'string' && record.index !== '') {
          bound.add(record.index)
        }

        break
      case 'match':
        for (const arm of record.cases as { binds?: string[] }[]) {
          arm.binds?.forEach(name => bound.add(name))
        }

        break

      case 'guard': {
        const caught = record.catch as { name: string } | undefined

        if (caught) {
          bound.add(caught.name)
        }

        break
      }

      case 'closure':
        for (const param of record.params as { name: string }[]) {
          bound.add(param.name)
        }

        break
      default:
        break
    }

    for (const [key, value] of Object.entries(record)) {
      if (key !== 'span' && key !== 'type') {
        visit(value)
      }
    }
  }

  visit(body)

  return bound
}

// does the body contain a throw statement anywhere? A guarded body's throws are caught by its handler, so only
// the handler's own throws escape a guard that has one.
function bodyThrows(body: Statement[]): boolean {
  for (const node of body) {
    switch (node.form) {
      case 'throw':
        return true
      case 'guard':
        if (
          node.catch
            ? bodyThrows(node.catch.body)
            : bodyThrows(node.body)
        ) {
          return true
        }

        break
      case 'while':
      case 'for-each':
        if (bodyThrows(node.body)) {
          return true
        }

        break
      case 'if':
        if (
          node.branches.some(b => bodyThrows(b.body)) ||
          (node.otherwise && bodyThrows(node.otherwise))
        ) {
          return true
        }

        break
      case 'match':
        if (
          node.cases.some(c => bodyThrows(c.body)) ||
          (node.otherwise && bodyThrows(node.otherwise))
        ) {
          return true
        }

        break
      default:
        break
    }
  }

  return false
}

// the names of functions (within `known`) called anywhere in the body
// what a body reaches beyond the functions it names: a call through a MASK method (left unresolved by dispatch
// because the receiver is generic) counts as a call to every implementation of that method in the program, and a
// member call on a `dock load` alias is a call into foreign code, which `onNative` reports (04-reach.md, masks and
// natives)
type CallReach = {
  implementations?: Map<string, Set<string>>
  natives?: Set<string>
  onNative?: () => void
  // A CALL THROUGH A TASK-TYPED SLOT raises the slot's declared set (decision 086 rule 2): `slots` holds the scanned
  // task's own parameters' sets by name, `shadowed` the names its body binds, and `onSlot` hears what each call through
  // a slot raises. A call through a local or a field raises its type's set
  slots?: Map<string, string[]>
  shadowed?: Set<string>
  onSlot?: (raised: string[]) => void
  // PASS-THROUGH (decision 089 rule 1): each task's pass-through parameters and parameter names, and `onBinding`
  // hears, at each call to such a task, what the argument at a pass-through parameter raises
  passes?: Map<string, string[]>
  paramLists?: Map<string, string[]>
  onBinding?: (binding: PassBinding) => void
  // JOBS (decision 092): the tasks that wait a handle, and `onWait` hears each call to one
  waits?: Set<string>
  onWait?: () => void
}

// what an argument given at a pass-through parameter raises. Twin: effects.tree `argument-raises`
function argumentRaises(
  arg: Expression,
  known: Set<string>,
  reach: CallReach,
): string[] {
  if (arg.form === 'variable') {
    if (reach.slots?.has(arg.name)) {
      return reach.slots.get(arg.name)!
    }

    if (known.has(arg.name) && !reach.shadowed?.has(arg.name)) {
      return [`task ${arg.name}`]
    }

    return slotHalts(arg.type)
  }

  if (arg.form === 'closure') {
    return []
  }

  return slotHalts((arg as { type?: Type }).type)
}

// a declared raise on a task type: the effect `halt <form>` the mill writes for each childless `halt <form>` line
function isSlotHalt(effect: string): boolean {
  return effect.length > 5 && effect.slice(0, 5) === 'halt '
}

// A TASK TYPE'S RAISE SET: the forms its childless `halt <form>` lines name. None means the slot raises nothing
// (decision 086 of note/project/term/self-host/change/001-finish-self-host, rule 1). Twin: check/effects.tree
// `slot-halts`
export function slotHalts(type: Type | undefined): string[] {
  const out: string[] = []

  if (type?.kind === 'function') {
    for (const effect of type.effects ?? []) {
      const raised = effect.slice(5)

      if (
        isSlotHalt(effect) &&
        effect !== 'halt kink' &&
        !out.includes(raised)
      ) {
        out.push(raised)
      }
    }
  }

  return out
}

// whether a task type says `halt kink`: the slot passes its raises on (decision 089 rule 3). Twin: effects.tree
// `slot-kinks`
export function slotKinks(type: Type | undefined): boolean {
  return (
    type?.kind === 'function' &&
    (type.effects ?? []).includes('halt kink')
  )
}

// A PASS-THROUGH PARAMETER'S MEMBER of a raise set: `kink <i>` stands for whatever the argument given at parameter
// `i` raises, put in its place at each call (decision 089 rule 1). `task <name>` in a binding is a task given by
// name, and a stub's `pass <i>` names a pass-through parameter. Never an exception's name, which has no space
const isKink = (raised: string): boolean =>
  raised.length > 5 && raised.startsWith('kink ')
const isTaskMember = (raised: string): boolean =>
  raised.length > 5 && raised.startsWith('task ')
const isPassMember = (raised: string): boolean =>
  raised.length > 5 && raised.startsWith('pass ')

// a task written in a backend's own folder: its parameters are never inferred, only declared (decision 089 rule 4)
function isNativeFile(statement: Extract<Statement, { form: 'function' }>): boolean {
  return statement.span?.file?.includes('/native/') ?? false
}

// A JOB'S STAND-IN: the raises of every job a task makes, charged where the task waits a handle (decision 092)
const jobName = (name: string): string => `${name} job`
const isJobName = (name: string): boolean =>
  name.length > 4 && name.endsWith(' job')
const isSpawn = (name: string): boolean => written(name) === 'spawn'

// at a call to `callee`, the argument at its pass-through parameter `at`, and what it raises
type PassBinding = { callee: string; at: number; given: string[] }

// the parameter a call's argument `i` fills: the one its name names, else its position
function argumentPosition(
  params: string[],
  names: string[],
  i: number,
): number {
  if (i < names.length && names[i] !== '') {
    const at = params.indexOf(names[i]!)

    return at < 0 ? params.length : at
  }

  return i
}

// the pass-through parameters of every task, and where each dropped one is kept, keyed `<task> <parameter>`
type PassTable = {
  passes: Map<string, string[]>
  kept: Map<string, Span>
}

type FunctionStatement = Extract<Statement, { form: 'function' }>

// PASS-THROUGH, INFERRED (decision 089 rules 1 and 4). Twin: effects.tree `pass-through-of`
export function passThroughOf(program: Program): PassTable {
  const functions = new Map<string, FunctionStatement>()

  for (const statement of program) {
    if (statement.form === 'function') {
      functions.set(statement.name, statement)
    }
  }

  const passes = new Map<string, string[]>()
  const kept = new Map<string, Span>()
  const inferred: string[] = []

  for (const [name, statement] of functions) {
    const chosen: string[] = []

    if (statement.stub && statement.stubRaises) {
      statement.params.forEach((param, i) => {
        if (statement.stubRaises!.includes(`pass ${i}`)) {
          chosen.push(param.name)
        }
      })
    } else if (statement.body.length > 0 && !isNativeFile(statement)) {
      for (const param of statement.params) {
        if (
          param.type?.kind === 'function' &&
          slotHalts(param.type).length === 0
        ) {
          chosen.push(param.name)
        }
      }

      if (chosen.length > 0) {
        inferred.push(name)
      }
    } else {
      for (const param of statement.params) {
        if (slotKinks(param.type)) {
          chosen.push(param.name)
        }
      }
    }

    passes.set(name, chosen)
  }

  let changed = true

  while (changed) {
    changed = false

    for (const name of inferred) {
      const statement = functions.get(name)!
      const remaining: string[] = []

      for (const param of passes.get(name)!) {
        const at = keepingMention(functions, passes, statement, param)

        if (at) {
          kept.set(`${name} ${param}`, at)
          changed = true
        } else {
          remaining.push(param)
        }
      }

      passes.set(name, remaining)
    }
  }

  return { passes, kept }
}

// the first mention of `param` in `statement` that keeps it. Twin: effects.tree `keeping-mention`
function keepingMention(
  functions: Map<string, FunctionStatement>,
  passes: Map<string, string[]>,
  statement: FunctionStatement,
  param: string,
): Span | undefined {
  const bound = boundNames(statement.body)

  if (bound.has(param)) {
    return statement.span
  }

  for (const own of statement.params) {
    bound.add(own.name)
  }

  let found: Span | undefined

  const keep = (at: Span | undefined): void => {
    if (!found) {
      found = at ?? statement.span
    }
  }

  const closureBinds = (node: Extract<Expression, { form: 'closure' }>) =>
    node.params.some(p => p.name === param)

  const visit = (value: unknown, escaping: boolean): void => {
    if (found || !value || typeof value !== 'object') {
      return
    }

    if (Array.isArray(value)) {
      for (const one of value) {
        visit(one, escaping)
      }

      return
    }

    const record = value as Record<string, unknown>

    if (record.form === 'variable' && typeof record.name === 'string') {
      if (record.name === param) {
        keep(record.span as Span | undefined)
      }

      return
    }

    if (record.form === 'closure' && Array.isArray(record.body)) {
      const closure = record as unknown as Extract<
        Expression,
        { form: 'closure' }
      >

      if (!closureBinds(closure)) {
        visit(closure.body, true)
      }

      return
    }

    if (
      record.form === 'call' &&
      record.callee &&
      typeof record.callee === 'object' &&
      Array.isArray(record.args)
    ) {
      const call = record as unknown as Extract<Expression, { form: 'call' }>
      const free = !escaping && !call.background
      let passing: string[] = []
      let params: string[] = []
      let job = false

      if (call.callee.form === 'variable') {
        const name = call.callee.name

        if (name === param) {
          if (!free) {
            keep(call.callee.span)
          }
        } else if (functions.has(name) && !bound.has(name)) {
          job = isSpawn(name)
          params = functions.get(name)!.params.map(p => p.name)
          passing = passes.get(name) ?? []
        }
      } else {
        visit(call.callee, escaping)
      }

      const names = call.names ?? []

      call.args.forEach((arg, i) => {
        let allowed = false

        if (free) {
          if (job) {
            allowed = true
          } else {
            const at = argumentPosition(params, names, i)

            allowed = at < params.length && passing.includes(params[at]!)
          }
        }

        if (arg.form === 'variable') {
          if (arg.name === param && !allowed) {
            keep(arg.span)
          }
        } else if (arg.form === 'closure') {
          if (!closureBinds(arg)) {
            visit(arg.body, !allowed)
          }
        } else {
          visit(arg, escaping)
        }
      })

      return
    }

    for (const [key, child] of Object.entries(record)) {
      if (key !== 'type' && key !== 'span') {
        visit(child, escaping)
      }
    }
  }

  visit(statement.body, false)

  return found
}

// the work of every `spawn` call in a body, at any depth. Twin: effects.tree `spawned-works`
function spawnedWorks(body: Statement[]): Expression[] {
  const found: Expression[] = []

  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(visit)

      return
    }

    const record = value as Record<string, unknown>

    if (
      record.form === 'call' &&
      record.callee &&
      typeof record.callee === 'object' &&
      Array.isArray(record.args)
    ) {
      const call = record as unknown as Extract<Expression, { form: 'call' }>

      if (
        call.callee.form === 'variable' &&
        isSpawn(call.callee.name) &&
        call.args.length === 1
      ) {
        found.push(call.args[0]!)
      }
    }

    for (const [key, child] of Object.entries(record)) {
      if (key !== 'type' && key !== 'span') {
        visit(child)
      }
    }
  }

  visit(body)

  return found
}

// what a call through `callee` raises when the callee is a slot: a parameter's declared set, or the type's set of a
// local, a field, or any name that is no task of the program. Twin: check/effects.tree `slot-call-raises`
function slotCallRaises(
  callee: Expression,
  known: Set<string>,
  reach: CallReach,
): string[] {
  if (callee.form === 'variable') {
    if (reach.slots?.has(callee.name)) {
      return reach.slots.get(callee.name)!
    }

    if (!known.has(callee.name) || reach.shadowed?.has(callee.name)) {
      return slotHalts(callee.type)
    }

    return []
  }

  if (callee.form === 'member') {
    return slotHalts(callee.type)
  }

  return []
}

function calledNames(
  body: Statement[],
  known: Set<string>,
  reach?: CallReach,
): Set<string> {
  const found = new Set<string>()

  const expr = (node: Expression): void => {
    switch (node.form) {
      case 'call':
        // A STATEMENT TICK RAISES INTO NO TASK: its raise ends the program, so it is charged to no task and a guard
        // around it catches nothing (decision 092 rule 5). Its arguments are worked out here
        if (node.background && reach?.onSlot) {
          node.args.forEach(expr)
          break
        }

        if (reach?.onSlot) {
          reach.onSlot(slotCallRaises(node.callee, known, reach))
        }

        if (
          reach &&
          node.callee.form === 'variable' &&
          known.has(node.callee.name) &&
          !reach.shadowed?.has(node.callee.name) &&
          !reach.slots?.has(node.callee.name)
        ) {
          const callee = node.callee.name
          const passing = reach.passes?.get(callee) ?? []

          if (passing.length > 0 && reach.onBinding) {
            const params = reach.paramLists?.get(callee) ?? []
            const names = node.names ?? []

            node.args.forEach((arg, i) => {
              const at = argumentPosition(params, names, i)

              if (at < params.length && passing.includes(params[at]!)) {
                const given = argumentRaises(arg, known, reach)

                if (given.length > 0) {
                  reach.onBinding!({ callee, at, given })
                }
              }
            })
          }
        }

        if (
          node.callee.form === 'variable' &&
          reach?.waits?.has(node.callee.name)
        ) {
          reach.onWait?.()
        }

        if (
          node.callee.form === 'variable' &&
          known.has(node.callee.name)
        ) {
          found.add(node.callee.name)
        } else if (
          node.callee.form === 'variable' &&
          reach?.implementations?.has(node.callee.name)
        ) {
          for (const implementation of reach.implementations.get(
            node.callee.name,
          )!) {
            found.add(implementation)
          }
        } else if (
          node.callee.form === 'member' &&
          node.callee.target.form === 'variable' &&
          reach?.natives?.has(node.callee.target.name)
        ) {
          reach.onNative?.()
        }

        expr(node.callee)
        node.args.forEach(expr)
        break
      case 'binary':
        expr(node.left)
        expr(node.right)
        break
      case 'unary':
        expr(node.operand)
        break
      case 'member':
        expr(node.target)
        break
      case 'template':
        for (const part of node.parts) {
          if (part.form === 'value') {
            expr(part.value)
          }
        }

        break
      case 'await':
        expr(node.expr)
        break
      case 'array':
        node.items.forEach(expr)
        break
      case 'map':
        node.entries.forEach(e => {
          expr(e.key)
          expr(e.value)
        })
        break
      case 'record':
        node.fields.forEach(f => expr(f.value))
        break
      case 'conditional':
        node.branches.forEach(b => {
          expr(b.cond)
          expr(b.value)
        })

        if (node.otherwise) {
          expr(node.otherwise)
        }

        break
      default:
        break
    }
  }

  const stmt = (node: Statement): void => {
    switch (node.form) {
      case 'let':
        expr(node.init)
        break
      case 'assign':
        expr(node.target)
        expr(node.value)
        break
      case 'expression':
        expr(node.expr)
        break
      case 'return':
        if (node.value) {
          expr(node.value)
        }

        break
      case 'throw':
        expr(node.value)
        break
      case 'hold':
        expr(node.expr)
        break
      case 'while':
        expr(node.cond)
        node.body.forEach(stmt)
        break
      case 'guard':
        node.body.forEach(stmt)
        node.catch?.body.forEach(stmt)
        break
      case 'for-each':
        expr(node.iterable)
        node.body.forEach(stmt)
        break
      case 'if':
        node.branches.forEach(b => {
          expr(b.cond)
          b.body.forEach(stmt)
        })
        node.otherwise?.forEach(stmt)
        break
      case 'match':
        expr(node.subject)
        node.cases.forEach(c => c.body.forEach(stmt))
        node.otherwise?.forEach(stmt)
        break
      default:
        break
    }
  }

  body.forEach(stmt)

  return found
}

export function checkEffects(
  program: Program,
  file: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = []

  const asyncFunctions = new Set<string>()
  const allFunctions = new Set<string>()

  for (const statement of program) {
    if (statement.form !== 'function') {
      continue
    }

    allFunctions.add(statement.name)

    if (statement.async) {
      asyncFunctions.add(statement.name)
    }
  }

  for (const statement of program) {
    if (statement.form !== 'function') {
      continue
    }

    const inAsync = statement.async === true

    // callback parameters annotated async (`like task` with `wait true`): calling one is an async call too. This is
    // effect-row polymorphism through the callback -- the caller inherits the callback's async effect.
    const asyncParams = new Set(
      statement.params
        .filter(
          p =>
            p.type?.kind === 'function' &&
            p.type.effects?.includes('async'),
        )
        .map(p => p.name),
    )

    // a parameter or local of a task's name shadows it, the way async resolution reads it (check/async-resolve.ts
    // inScope): a call to a callback named `test` is a call to the callback, never to the stdlib's async `test`
    const shadowed = new Set(statement.params.map(p => p.name))

    const lets = (node: unknown): void => {
      if (!node || typeof node !== 'object') {
        return
      }

      if (Array.isArray(node)) {
        node.forEach(lets)

        return
      }

      const record = node as Record<string, unknown>

      if (record.form === 'let' && typeof record.name === 'string') {
        shadowed.add(record.name)
      }

      if (record.form !== 'closure') {
        for (const [key, value] of Object.entries(record)) {
          if (key !== 'span' && key !== 'type') {
            lets(value)
          }
        }
      }
    }

    lets(statement.body)

    // a local holding an async task (`save work, read one/work`) is async by its type, as async resolution reads it
    // (check/async-resolve.tree calls-async, term-compiler-0062)
    const isAsyncName = (name: string, type?: Type): boolean =>
      (asyncFunctions.has(name) && !shadowed.has(name)) ||
      asyncParams.has(name) ||
      (type?.kind === 'function' &&
        type.effects?.includes('async') === true)

    const isKnownSyncName = (name: string): boolean =>
      (allFunctions.has(name) && !asyncFunctions.has(name)) ||
      (statement.params.some(
        p => p.name === name && p.type?.kind === 'function',
      ) &&
        !asyncParams.has(name))

    const visitExpression = (
      node: Expression,
      awaited: boolean,
    ): void => {
      switch (node.form) {
        case 'await': {
          if (!inAsync) {
            diagnostics.push(
              diagnose('effect-error', {
                file,
                span: node.span,
                message:
                  'await is only allowed inside an async task (mark this task `mark async`)',
              }),
            )
          }

          if (
            node.expr.form === 'call' &&
            node.expr.callee.form === 'variable' &&
            isKnownSyncName(node.expr.callee.name)
          ) {
            diagnostics.push(
              diagnose('effect-error', {
                file,
                span: node.span,
                message: `"${node.expr.callee.name}" is not async, so it cannot be awaited`,
              }),
            )
          }

          visitExpression(node.expr, true)
          break
        }

        case 'call':
          // `tick f(x)` (and the older `wait false`) is fire-and-forget: an async call deliberately left un-awaited,
          // so it is exempt. Otherwise async resolution awaits async calls by default; a leftover un-awaited async
          // call in a sync context is an error only when it was not ticked.
          if (
            !awaited &&
            !inAsync &&
            !node.background &&
            node.callee.form === 'variable' &&
            isAsyncName(node.callee.name, node.callee.type)
          ) {
            diagnostics.push(
              asyncFromSync(file, node.span, node.callee.name),
            )
          }

          // `tick` on a task that is not async starts nothing: the call runs to its end before the next line
          if (
            node.background &&
            node.callee.form === 'variable' &&
            isKnownSyncName(node.callee.name)
          ) {
            diagnostics.push(
              tickOnSync(file, node.span, node.callee.name),
            )
          }

          visitExpression(node.callee, false)
          node.args.forEach(argument =>
            visitExpression(argument, false),
          )
          break
        case 'binary':
          visitExpression(node.left, false)
          visitExpression(node.right, false)
          break
        case 'unary':
          visitExpression(node.operand, false)
          break
        case 'member':
          visitExpression(node.target, false)
          break
        case 'array':
          node.items.forEach(item => visitExpression(item, false))
          break
        case 'map':
          node.entries.forEach(entry => {
            visitExpression(entry.key, false)
            visitExpression(entry.value, false)
          })
          break
        case 'record':
          node.fields.forEach(field =>
            visitExpression(field.value, false),
          )
          break
        case 'conditional':
          node.branches.forEach(branch => {
            visitExpression(branch.cond, false)
            visitExpression(branch.value, false)
          })

          if (node.otherwise) {
            visitExpression(node.otherwise, false)
          }

          break
        default:
          break
      }
    }

    const visitBody = (body: Statement[]): void => {
      for (const node of body) {
        switch (node.form) {
          case 'let':
            visitExpression(node.init, false)
            break
          case 'assign':
            visitExpression(node.target, false)
            visitExpression(node.value, false)
            break
          case 'expression':
            visitExpression(node.expr, false)
            break
          case 'return':
            if (node.value) {
              visitExpression(node.value, false)
            }

            break
          case 'throw':
            visitExpression(node.value, false)
            break
          case 'hold':
            visitExpression(node.expr, false)
            break
          case 'while':
            visitExpression(node.cond, false)
            visitBody(node.body)
            break
          case 'for-each':
            visitExpression(node.iterable, false)
            visitBody(node.body)
            break
          case 'if':
            for (const branch of node.branches) {
              visitExpression(branch.cond, false)
              visitBody(branch.body)
            }

            if (node.otherwise) {
              visitBody(node.otherwise)
            }

            break
          case 'match':
            visitExpression(node.subject, false)

            for (const branch of node.cases) {
              visitBody(branch.body)
            }

            if (node.otherwise) {
              visitBody(node.otherwise)
            }

            break
          default:
            break
        }
      }
    }

    visitBody(statement.body)
  }

  return diagnostics
}

// a task's name as it was written: a name defined in more than one file is split by file (`name__in<g>_<k>`,
// check/overload.ts) before this runs
function written(name: string): string {
  return name.replace(/__in\d+_\d+$/, '')
}

// a call to an async task, not waited for, from a place that is not async
function asyncFromSync(
  file: string,
  span: Span,
  called: string,
): Diagnostic {
  const name = written(called)

  return diagnose('effect-error', {
    file,
    span,
    message: `"${name}" is async, and this call is in a task that is not: mark the task \`mark async\`, or write \`tick ${name}\` to start it without waiting`,
  })
}

// `tick` on a task that is not async
function tickOnSync(
  file: string,
  span: Span,
  called: string,
): Diagnostic {
  const name = written(called)

  return diagnose('effect-error', {
    file,
    span,
    message: `\`tick\` starts an async task and goes on, and "${name}" is not async: call it without \`tick\``,
  })
}

// ---- the switch: a call to an async task outside any task ----
//
// AWAIT BY DEFAULT (note/project/term/await-by-default-and-mark-metadata.md, section 1). Inside a task, a call to an
// async task is awaited and the task becomes async (check/async-resolve.ts). OUTSIDE every task, in a top-level
// `host` or statement, in a component's body, or in a closure written in either that is not itself `mark async`,
// nothing can wait, and the call used to hand back a pending value with no message: `host config, read-config()`
// bound a promise typed as the config. Under the switch that is an error naming `tick`, which is how a place that
// cannot wait says it means the pending value.
//
// ON since 2026-10-03, after `pnpm term:await-migrate --commit` rewrote every such call in the repository to `tick`,
// each file proven to emit what it emitted before. The switch is compile/compile.ts's (`setAwaitOutsideTasks`), which
// asks this only while it is on.

// Every un-awaited, un-ticked call to an async task outside a task body. Runs after async resolution, so a task's
// own body is already awaited and is not walked here. A closure inside a task is the task's business (resolution
// awaits inside it); a closure outside one is walked, and is exempt only when it is itself async.
export function checkCallsOutsideTasks(
  program: Program,
  file: string,
): Diagnostic[] {
  const asyncFunctions = new Set<string>()

  for (const statement of program) {
    // a bind marked `mark async` is waited like an async task (decision 053 of
    // note/project/term/self-host/change/001-finish-self-host)
    if (
      (statement.form === 'function' || statement.form === 'bind') &&
      statement.async
    ) {
      asyncFunctions.add(statement.name)
    }
  }

  const diagnostics: Diagnostic[] = []

  let owner = file

  // `waiting`: inside an async closure, where an awaited call is in place and an un-awaited one is still the
  // pending value nobody asked for. `bound`: names a closure's parameters and locals bind, which shadow a task
  const visit = (
    value: unknown,
    waiting: boolean,
    bound: Set<string>,
  ): void => {
    if (!value || typeof value !== 'object') {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(item => visit(item, waiting, bound))

      return
    }

    const record = value as Record<string, unknown>

    if (record.form === 'await') {
      // awaited already, by `wait true` or a `wait` prefix. Its arguments are still walked
      const inner = record.expr as Record<string, unknown> | undefined

      if (inner?.form === 'call') {
        visit(inner.args, waiting, bound)
        visit(inner.callee, waiting, bound)

        return
      }
    }

    if (record.form === 'closure') {
      const closure = record as unknown as Extract<
        Expression,
        { form: 'closure' }
      >

      const inner = new Set(bound)

      for (const param of closure.params) {
        inner.add(param.name)
      }

      visit(closure.body, closure.async === true, inner)

      return
    }

    if (record.form === 'let' && typeof record.name === 'string') {
      bound.add(record.name)
    }

    // an EXPRESSION call: a view's setup statement is also `form: 'call'`, holding its call under `value`, and is
    // walked through to that call below
    if (
      record.form === 'call' &&
      record.callee &&
      typeof record.callee === 'object'
    ) {
      const call = record as unknown as Extract<
        Expression,
        { form: 'call' }
      >

      if (
        !call.background &&
        call.callee.form === 'variable' &&
        asyncFunctions.has(call.callee.name) &&
        !bound.has(call.callee.name)
      ) {
        const name = written(call.callee.name)

        diagnostics.push(
          diagnose('async-outside-task', {
            file: owner,
            span: { ...call.span, file: owner },
            message: waiting
              ? `"${name}" is async, and a call to it here is not waited for: write \`wait ${name}(...)\` to wait, or \`tick ${name}\` to start it and go on`
              : `"${name}" is async, and this call is outside any task, where nothing can wait for it: move it into a task, or write \`tick ${name}\` to start it without waiting`,
          }),
        )
      }
    }

    for (const [key, child] of Object.entries(record)) {
      if (
        key !== 'span' &&
        key !== 'type' &&
        key !== 'result' &&
        key !== 'declared'
      ) {
        visit(child, waiting, bound)
      }
    }
  }

  for (const statement of program) {
    if (statement.form === 'function') {
      continue
    }

    // the module the statement came from: a merged program records it on each top-level statement's span, and an
    // expression inside carries a position only, so a finding is placed in its own file rather than the entry's
    owner =
      ('span' in statement ? statement.span?.file : undefined) ?? file
    visit(statement, false, new Set())
  }

  return diagnostics
}

// the closure literals an expression makes, outermost first: a closure inside another closure's body is found when
// that body is scanned, so each is visited once
function closuresIn(
  node: Expression,
): Extract<Expression, { form: 'closure' }>[] {
  const found: Extract<Expression, { form: 'closure' }>[] = []

  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(visit)

      return
    }

    const record = value as Record<string, unknown>

    if (record.form === 'closure') {
      found.push(record as Extract<Expression, { form: 'closure' }>)

      return
    }

    // a job's closure (`spawn`'s work, a value-position tick) is charged where the job is waited, not where it is
    // written (decision 092 rule 2)
    const job =
      record.form === 'call' &&
      (record.callee as { form?: string; name?: string } | undefined)
        ?.form === 'variable' &&
      isSpawn((record.callee as { name: string }).name)

    for (const [key, child] of Object.entries(record)) {
      if (key !== 'type' && key !== 'span' && key !== 'result') {
        if (job && key === 'args' && Array.isArray(child)) {
          child
            .filter(
              (arg: { form?: string } | undefined) => arg?.form !== 'closure',
            )
            .forEach(visit)
        } else {
          visit(child)
        }
      }
    }
  }

  visit(node)

  return found
}

// ---- raise sets ----
//
// The exceptions each function can raise: every `halt <form>` in its body outside a guarded body, plus what every
// callee raises (least fixed point over the call graph), minus what a `mark unsafe` / `halt take` catches, plus
// what the handler itself raises. A thrown text is `failure`. A guard with no handler catches everything. This is
// the raise set of note/project/term/hive/04-reach.md, and it is what the roll reports per task and per route.
//
// `via` records, for each function and each exception, the callee that first brought it in (undefined for a direct
// raise), so a reader can walk one call path from an entry point to the raise site.
type RaiseSetsWith = {
  raises: Map<string, Set<string>>
  via: Map<string, Map<string, string | undefined>>
  // the native shims: the functions that call into a `dock load` module, which raise `failure` by construction
  native: Set<string>
  // each task's pass-through parameters `pass <i>` and the members `kink <i>` its set holds (decision 089)
  through: Map<string, string[]>
  // what the jobs each task makes can raise, where it makes any (decision 092)
  jobs: Map<string, string[]>
}

// the raise sets as check/effects.tree answers them: each set a list in the order it was filled, a direct raise's
// `via` the empty text
export type RaiseSets = {
  raises: Map<string, string[]>
  via: Map<string, Map<string, string>>
  native: string[]
  through: Map<string, string[]>
  jobs: Map<string, string[]>
}

// `checkedDivision` is the one place the emitters tell the raise sets which integer `/` and `%` they write checked
// (divisor/spec.md section 3.1, 4.1). Swift and Rust compute it from their interval facts and pass it, so a task
// raises `defect` on account of a division if and only if its emitted body holds one. Every check-time caller passes
// nothing, and nothing changes for it
export function raiseSetsOf(
  program: Program,
  exceptions: string[],
  checkedDivision?: (node: Expression) => boolean,
): RaiseSets {
  const sets = raiseSetsWith(
    program,
    new Set(exceptions),
    checkedDivision,
  )

  return {
    raises: new Map(
      [...sets.raises].map(([name, raised]) => [name, [...raised]]),
    ),
    via: new Map(
      [...sets.via].map(([name, from]) => [
        name,
        new Map([...from].map(([e, callee]) => [e, callee ?? ''])),
      ]),
    ),
    native: [...sets.native],
    through: sets.through,
    jobs: sets.jobs,
  }
}

function raiseSetsWith(
  program: Program,
  // the record-types that are exceptions, by name
  exceptions: Set<string>,
  checkedDivision?: (node: Expression) => boolean,
): RaiseSetsWith {
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
  const raises = new Map<string, Set<string>>()
  const via = new Map<string, Map<string, string | undefined>>()
  const calls = new Map<string, Set<string>>()

  // a mask method's implementations: every `wear` / `suit` body desugars to a `<target>_<method>` function tagged with
  // the bare method name, so a call the dispatcher left bare reaches all of them
  const maskMethods = new Set<string>()
  const implementations = new Map<string, Set<string>>()
  // the `dock load` aliases: a member call on one is a call into code the compiler does not see
  const natives = new Set<string>()

  for (const statement of program) {
    if (statement.form === 'mask') {
      statement.methods.forEach(m => maskMethods.add(m))
    } else if (
      statement.form === 'native' &&
      statement.kind !== 'type'
    ) {
      natives.add(statement.alias)
    }
  }

  for (const statement of functions.values()) {
    if (statement.method && maskMethods.has(statement.method.name)) {
      const set =
        implementations.get(statement.method.name) ?? new Set<string>()

      set.add(statement.name)
      implementations.set(statement.method.name, set)
    }
  }

  let sawNative = false
  // what the calls through slots met by the last `calledNames` raise, in the order met
  let slotRaised: string[] = []
  // the pass-through bindings of the task being scanned, and whether the last `calledNames` met a wait on a handle
  let bindings: PassBinding[] = []
  let waited = false

  // the pass-through parameters (decision 089 rule 1), each task's parameter names, and the tasks that wait a
  // handle: `wait` and `wait-within` of @term/base/task's `handle` (decision 092 rule 2)
  const table = passThroughOf(program)
  const paramLists = new Map<string, string[]>()
  const waits = new Set<string>()

  for (const [name, statement] of functions) {
    paramLists.set(
      name,
      statement.params.map(p => p.name),
    )

    if (
      statement.method &&
      written(statement.method.form) === 'handle' &&
      (statement.method.name === 'wait' ||
        statement.method.name === 'wait-within')
    ) {
      waits.add(name)
    }
  }

  const reach: CallReach = {
    implementations,
    natives,
    onNative: () => {
      sawNative = true
    },
    slots: new Map(),
    shadowed: new Set(),
    onSlot: raised => {
      for (const one of raised) {
        if (!slotRaised.includes(one)) {
          slotRaised.push(one)
        }
      }
    },
    passes: table.passes,
    paramLists,
    onBinding: binding => {
      bindings.push(binding)
    },
    waits,
    onWait: () => {
      waited = true
    },
  }

  // each task's pass-through bindings, by the task that made the calls
  const boundCalls = new Map<string, PassBinding[]>()
  // the stand-in of the jobs the task being scanned makes, '' when it makes none
  let jobs = ''

  // whether a declared or passed-on raise counts in a set. Twin: effects.tree `is-raise-member`
  const isRaiseMember = (raised: string): boolean =>
    exceptions.has(raised) ||
    isKink(raised) ||
    raised === 'failure' ||
    raised === 'exception'

  const nativeShims = new Set<string>()

  // the exceptions a body raises directly, honoring guards, and the functions it calls outside a guarded body
  const scan = (
    body: Statement[],
    direct: Set<string>,
    called: Set<string>,
  ): void => {
    for (const node of body) {
      switch (node.form) {
        case 'throw':
          if (node.raise) {
            direct.add(node.raise)
          } else if (
            node.value.form === 'record' &&
            exceptions.has(node.value.name)
          ) {
            direct.add(node.value.name)
          } else if (
            node.value.form === 'string' ||
            node.value.form === 'template'
          ) {
            // `halt <text>` raises `failure`, and so does one whose text interpolates (`halt <at {position}>`), which
            // was counted as a re-raise of an unknown exception
            direct.add('failure')
          } else {
            // a re-raised value: what it is was decided where it was first raised
            direct.add('exception')
          }

          // a division in the thrown value is written checked like any other
          markDivisions(node.value, direct)

          break
        case 'guard':
          if (node.catch) {
            scan(node.catch.body, direct, called)
          } else {
            // no handler: the body's raises are caught and dropped, its calls still matter for nothing
          }

          break
        case 'while':
          expressionCalls(node.cond, called, direct)
          scan(node.body, direct, called)
          break
        case 'for-each':
          expressionCalls(node.iterable, called, direct)
          scan(node.body, direct, called)
          break
        case 'if':
          for (const branch of node.branches) {
            expressionCalls(branch.cond, called, direct)
            scan(branch.body, direct, called)
          }

          if (node.otherwise) {
            scan(node.otherwise, direct, called)
          }

          break
        case 'match':
          expressionCalls(node.subject, called, direct)

          for (const branch of node.cases) {
            scan(branch.body, direct, called)
          }

          if (node.otherwise) {
            scan(node.otherwise, direct, called)
          }

          break
        case 'let':
          expressionCalls(node.init, called, direct)
          break
        case 'assign':
          expressionCalls(node.target, called, direct)
          expressionCalls(node.value, called, direct)
          break
        case 'expression':
          expressionCalls(node.expr, called, direct)
          break
        case 'return':
          if (node.value) {
            expressionCalls(node.value, called, direct)
          }

          break
        case 'hold':
          expressionCalls(node.expr, called, direct)
          break
        default:
          break
      }
    }
  }

  // A CLOSURE'S RAISES ARE ITS MAKER'S. A closure's type carries no raise set, so what its body raises surfaces
  // wherever it is called: through `wait` and `gather` its raise is re-raised unchanged, and through any other
  // call it unwinds the caller. Attributing it to the task that MAKES the closure keeps the set sound for the usual
  // shape (make the work, spawn or gather it, wait in the same task), and it is what holds a signature bound to the
  // exceptions its spawned work can raise: before, a `halt conflict` inside a gathered task reached no raise set at
  // all, so `halt outage` on the gatherer's signature passed while `conflict` escaped. A handle handed to another
  // task and waited there is the case this over-approximates rather than tracks
  // (note/project/term/research/beam-otp-lessons.md, design 3)
  const expressionCalls = (
    node: Expression,
    called: Set<string>,
    direct?: Set<string>,
  ): void => {
    slotRaised = []
    waited = false

    for (const name of calledNames(
      [{ form: 'expression', expr: node, span: node.span }],
      names,
      reach,
    )) {
      called.add(name)
    }

    // a wait on a handle raises every job the task makes (decision 092 rule 2)
    if (waited && jobs !== '') {
      called.add(jobs)
    }

    if (direct) {
      // a call through a slot raises the slot's declared set, as a direct raise: a form the program holds, `failure`
      // (raised by text even with no form), or `exception` (any), or the member of a pass-through parameter
      for (const raised of slotRaised) {
        if (isRaiseMember(raised)) {
          direct.add(raised)
        }
      }

      markDivisions(node, direct)

      for (const closure of closuresIn(node)) {
        scan(closure.body, direct, called)
      }
    }
  }

  // AN INTEGER DIVISION OR REMAINDER THE EMITTER WRITES CHECKED RAISES `defect`, added by name the way `failure` is for
  // a native shim, so a program whose tree shaking dropped the `defect` form still has it in the set. A closure's body
  // is not entered: `scan` reaches it through `closuresIn`, and the closure's maker takes what it raises
  const markDivisions = (
    node: Expression,
    direct: Set<string>,
  ): void => {
    if (!checkedDivision) {
      return
    }

    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') {
        return
      }

      if (Array.isArray(value)) {
        value.forEach(visit)

        return
      }

      const record = value as Record<string, unknown>

      if (record.form === 'closure') {
        return
      }

      if (
        record.form === 'binary' &&
        (record.op === '/' || record.op === '%') &&
        checkedDivision(record as Expression)
      ) {
        direct.add('defect')
      }

      for (const [key, child] of Object.entries(record)) {
        if (key !== 'type' && key !== 'span' && key !== 'result') {
          visit(child)
        }
      }
    }

    visit(node)
  }

  for (const [name, statement] of functions) {
    // a separately compiled task: the set its own unit closed over its body and callees (`stubRaises`)
    if (statement.stub && statement.stubRaises) {
      // `pass <i>` names a pass-through parameter, read by `passThroughOf`, never a raise
      const known = new Set(statement.stubRaises.filter(r => !isPassMember(r)))

      if (statement.stubFacts?.includes('native')) {
        nativeShims.add(name)
      }

      // a task that raises `failure` once it is counted raises it here when this program counts it, as its own body's
      // scan would: its stored set was closed over its own unit, which may not have held the form (`fails`,
      // compile/stub.ts)
      if (
        exceptions.has('failure') &&
        statement.stubFacts?.includes('fails')
      ) {
        known.add('failure')
      }

      raises.set(name, known)
      via.set(name, new Map([...known].map(d => [d, undefined])))
      calls.set(name, new Set())
      continue
    }

    sawNative = false
    // each parameter typed as a task raises its declared set when called (decision 086 rule 2), and a pass-through
    // one its argument's, `kink <i>` until a call puts the argument in its place (decision 089)
    const passing = table.passes.get(name) ?? []

    reach.slots = new Map(
      statement.params.map((param, i) => [
        param.name,
        passing.includes(param.name) ? [`kink ${i}`] : slotHalts(param.type),
      ]),
    )
    reach.shadowed = boundNames(statement.body)
    bindings = []

    const ownParams = new Set(statement.params.map(p => p.name))
    const bound = boundNames(statement.body)

    // THE JOBS THE TASK MAKES, scanned apart into its stand-in, which each wait in the task calls (decision 092 rules
    // 1 and 2): a guard around the start subtracts nothing, a guard around the wait does
    jobs = ''

    const works = spawnedWorks(statement.body)

    if (works.length > 0) {
      const standIn = jobName(name)
      const jobDirect = new Set<string>()
      const jobCalled = new Set<string>()

      for (const work of works) {
        if (work.form === 'closure') {
          scan(work.body, jobDirect, jobCalled)
        } else {
          for (const raised of argumentRaises(work, names, reach)) {
            if (isTaskMember(raised)) {
              jobCalled.add(raised.slice(5))
            } else if (isRaiseMember(raised)) {
              jobDirect.add(raised)
            }
          }
        }
      }

      for (const callee of [...jobCalled]) {
        if (ownParams.has(callee) || bound.has(callee)) {
          jobCalled.delete(callee)
        }
      }

      raises.set(standIn, jobDirect)
      via.set(standIn, new Map([...jobDirect].map(d => [d, undefined])))
      calls.set(standIn, jobCalled)
      boundCalls.set(standIn, bindings)
      jobs = standIn
      bindings = []
    }

    const direct = new Set<string>()
    const called = new Set<string>()

    scan(statement.body, direct, called)
    boundCalls.set(name, bindings)

    // a task that calls into a `dock load` module is a native shim: foreign code can fail in ways nobody listed, so
    // the runtime boundary wraps any foreign throw into `failure`, and the `halt` lines on its signature are the shim
    // author's contract, added to the set rather than checked against it (03-exception.md, natives)
    if (sawNative) {
      nativeShims.add(name)

      // only when the program holds the `failure` form. The shake keeps it as a root in any program that docks a
      // module (compile/compile.ts, term/compiler decision 001), so a guard around a native call must cover `failure`
      // shaken or not. The roll asks with `failure` always in its set (compile/roll.ts), so a task's roll entry is
      // the same whichever entry built it
      if (exceptions.has('failure')) {
        direct.add('failure')
      }

      for (const declared of statement.raises ?? []) {
        if (exceptions.has(declared)) {
          direct.add(declared)
        }
      }
    }

    // `call fill / <data> / like <form>` raises the data package's `data-mismatch` when the value does not fit
    if (calledNames(statement.body, new Set(['fill-form'])).size > 0) {
      direct.add('data-mismatch')
    }

    // a call to one of its own parameters is that parameter, not the task of the same name (see the effect rows above),
    // and a call to a local it binds is that local (`boundNames`)
    for (const param of statement.params) {
      called.delete(param.name)
    }

    for (const local of boundNames(statement.body)) {
      called.delete(local)
    }

    raises.set(name, direct)
    via.set(name, new Map([...direct].map(d => [d, undefined])))
    calls.set(name, called)
  }

  let changed = true

  while (changed) {
    changed = false

    for (const [name, callees] of calls) {
      const set = raises.get(name)!
      const from = via.get(name)!

      for (const callee of callees) {
        // a callee's pass-through member is its own parameter's, put in place by the bindings below, except the
        // task's own jobs', which are the task's parameters
        const raw = callee === jobName(name)

        for (const exception of raises.get(callee) ?? []) {
          if (!set.has(exception) && (raw || !isKink(exception))) {
            set.add(exception)
            from.set(exception, callee)
            changed = true
          }
        }
      }

      // A CALL TO A TASK THAT PASSES AN ARGUMENT'S RAISES THROUGH raises what that argument raises, where the
      // callee's set holds the parameter's member (decision 089 rule 1)
      for (const binding of boundCalls.get(name) ?? []) {
        if (!raises.get(binding.callee)?.has(`kink ${binding.at}`)) {
          continue
        }

        for (const given of binding.given) {
          if (isTaskMember(given)) {
            const task = given.slice(5)

            if (!callees.has(task) && raises.has(task)) {
              callees.add(task)
              changed = true
            }
          } else if (!set.has(given) && isRaiseMember(given)) {
            set.add(given)
            from.set(given, binding.callee)
            changed = true
          }
        }
      }
    }
  }

  // EACH TASK'S JOBS FOLD INTO IT: a raise that reached it through its stand-in reads through to the job's own path,
  // and the job's callees are its own
  const jobsOf = new Map<string, string[]>()

  for (const name of functions.keys()) {
    const standIn = jobName(name)

    if (!raises.has(standIn)) {
      continue
    }

    const made = [...raises.get(standIn)!].filter(r => !isKink(r))

    if (made.length > 0) {
      jobsOf.set(name, made)
    }

    if (calls.has(name)) {
      const from = via.get(name)!
      const theirs = via.get(standIn)!

      for (const [raised, callee] of [...from]) {
        if (callee === standIn) {
          from.set(raised, theirs.get(raised))
        }
      }

      const folded = new Set<string>()

      for (const callee of [...calls.get(name)!, ...calls.get(standIn)!]) {
        if (callee !== standIn) {
          folded.add(callee)
        }
      }

      calls.set(name, folded)
    }
  }

  // what is answered: no stand-in, no pass-through member, and each task's pass-through parameters beside its set
  const finalRaises = new Map<string, Set<string>>()
  const finalVia = new Map<string, Map<string, string | undefined>>()
  const finalCalls = new Map<string, Set<string>>()
  const through = new Map<string, string[]>()

  for (const name of calls.keys()) {
    if (isJobName(name)) {
      continue
    }

    const all = [...raises.get(name)!]
    const from = via.get(name)!

    finalRaises.set(name, new Set(all.filter(r => !isKink(r))))
    finalVia.set(
      name,
      new Map([...from].filter(([raised]) => !isKink(raised))),
    )
    finalCalls.set(name, calls.get(name)!)

    const passing = table.passes.get(name) ?? []
    const carried: string[] = []

    ;(paramLists.get(name) ?? []).forEach((param, i) => {
      if (passing.includes(param)) {
        carried.push(`pass ${i}`)
      }
    })
    carried.push(...all.filter(isKink))

    if (carried.length > 0) {
      through.set(name, carried)
    }
  }

  canonicalVia(finalCalls, finalRaises, finalVia)

  return {
    raises: finalRaises,
    via: finalVia,
    native: nativeShims,
    through,
    jobs: jobsOf,
  }
}

// `via` CHOSEN BY RULE, NOT BY DISCOVERY. The fixed point recorded whichever callee brought an exception in first,
// which depended on the order it visited the functions, so one task's path read differently in a program holding more
// of them, and a unit's roll (its dependencies' stubs known from the start) could not equal the whole program's
// (note/project/term/incremental-best-in-class.md, step 5). The rule: a call that leaves the task's cycle and reaches the
// exception comes first, in the order the body makes its calls; inside a cycle, the first callee strictly nearer a
// raise. The path then never loops, and it is the same in a unit, where calls between units never form a cycle and a
// stub calls nothing
function canonicalVia(
  calls: Map<string, Set<string>>,
  raises: Map<string, Set<string>>,
  via: Map<string, Map<string, string | undefined>>,
): void {
  const component = cyclesOf(calls)

  // within each cycle, each member's distance to a raise of each exception: 0 for a direct raise or a call out of
  // the cycle that raises it, else one more than the nearest member it calls
  const distance = new Map<string, Map<string, number>>()
  const members = new Map<number, string[]>()

  for (const [name, at] of component) {
    members.set(at, [...(members.get(at) ?? []), name])
  }

  for (const group of members.values()) {
    for (const name of group) {
      const own = new Map<string, number>()
      const from = via.get(name)!

      for (const exception of raises.get(name)!) {
        // after the fixed point a callee is recorded for every raise but the task's own, so an unrecorded one is direct
        const direct =
          from.has(exception) && from.get(exception) === undefined

        const leaves = [...calls.get(name)!].some(
          c =>
            component.get(c) !== component.get(name) &&
            raises.get(c)?.has(exception),
        )

        if (direct || leaves) {
          own.set(exception, 0)
        }
      }

      distance.set(name, own)
    }

    // relax inside the cycle until nothing nears
    let moved = true

    while (moved) {
      moved = false

      for (const name of group) {
        const own = distance.get(name)!

        for (const exception of raises.get(name)!) {
          for (const callee of calls.get(name)!) {
            const near =
              component.get(callee) === component.get(name)
                ? distance.get(callee)?.get(exception)
                : undefined

            if (
              near !== undefined &&
              (own.get(exception) ?? Infinity) > near + 1
            ) {
              own.set(exception, near + 1)
              moved = true
            }
          }
        }
      }
    }
  }

  for (const [name, callees] of calls) {
    const from = via.get(name)!
    const own = distance.get(name)!

    for (const exception of raises.get(name)!) {
      // a direct raise stays direct
      if (from.has(exception) && from.get(exception) === undefined) {
        continue
      }

      const out = [...callees].find(
        c =>
          component.get(c) !== component.get(name) &&
          raises.get(c)?.has(exception),
      )

      const inside = [...callees].find(
        c =>
          component.get(c) === component.get(name) &&
          (distance.get(c)?.get(exception) ?? Infinity) <
            (own.get(exception) ?? Infinity),
      )

      const chosen = out ?? inside

      if (chosen !== undefined) {
        from.set(exception, chosen)
      }
    }
  }
}

// each function's strongly connected component over the calls, by Tarjan's algorithm, iteratively: a call chain
// thousands deep would overflow a recursive walk
function cyclesOf(
  calls: Map<string, Set<string>>,
): Map<string, number> {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const component = new Map<string, number>()

  let counter = 0
  let groups = 0

  for (const start of calls.keys()) {
    if (index.has(start)) {
      continue
    }

    const work: { name: string; next: string[] }[] = [
      {
        name: start,
        next: [...calls.get(start)!].filter(c => calls.has(c)),
      },
    ]

    index.set(start, counter)
    low.set(start, counter++)
    stack.push(start)
    onStack.add(start)

    while (work.length > 0) {
      const top = work[work.length - 1]!

      if (top.next.length > 0) {
        const callee = top.next.shift()!

        if (!index.has(callee)) {
          index.set(callee, counter)
          low.set(callee, counter++)
          stack.push(callee)
          onStack.add(callee)
          work.push({
            name: callee,
            next: [...calls.get(callee)!].filter(c => calls.has(c)),
          })
        } else if (onStack.has(callee)) {
          low.set(
            top.name,
            Math.min(low.get(top.name)!, index.get(callee)!),
          )
        }

        continue
      }

      work.pop()

      if (work.length > 0) {
        const parent = work[work.length - 1]!.name
        low.set(parent, Math.min(low.get(parent)!, low.get(top.name)!))
      }

      if (low.get(top.name) === index.get(top.name)) {
        let member: string

        do {
          member = stack.pop()!
          onStack.delete(member)
          component.set(member, groups)
        } while (member !== top.name)

        groups++
      }
    }
  }

  return component
}

// A task that declares `halt <form>` lines on its signature is held to them: every name must be an exception form,
// and everything the body can raise (inferred, through its callees) must be among them. The declaration is a
// contract, so a raise added deep in a callee surfaces here, at the signature that promised less. 03-exception.md.
export function checkRaiseBounds(
  program: Program,
  file: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const exceptions = new Set<string>()

  for (const s of program) {
    if (s.form === 'record-type' && s.chain?.includes(EXCEPTION_FORM)) {
      exceptions.add(s.name)
    }
  }

  const bounded = program.filter(
    (s): s is Extract<Statement, { form: 'function' }> =>
      s.form === 'function' && (s.raises?.length ?? 0) > 0,
  )

  if (bounded.length === 0) {
    return diagnostics
  }

  const sets = raiseSetsWith(program, exceptions)

  for (const s of bounded) {
    const declared = new Set(s.raises)
    const at = s.span.file ?? file

    // a native shim raises `failure` whether or not it says so: foreign code fails in ways nobody listed
    if (sets.native.has(s.name)) {
      declared.add('failure')
    }

    const raised = sets.raises.get(s.name)

    for (const name of declared) {
      // `failure` the body does raise is bound rightly with no form for it: a `halt <text>` raises it, and the build
      // holds no `failure` form when nothing loads @term/base/exception (item term-self-host-001-0315)
      if (
        !exceptions.has(name) &&
        !(name === 'failure' && raised?.has(name))
      ) {
        // a stdlib exception the build dropped is one nothing here raises: the bound is wider than the body, not
        // a misspelling, and saying "not an exception form" named the wrong problem
        diagnostics.push(
          diagnose('raise-bound', {
            file: at,
            span: s.span,
            message: isGenericException(name)
              ? `"${s.name}" declares "halt ${name}" on its signature, but nothing it calls raises "${name}"`
              : `"${s.name}" declares "halt ${name}" on its signature, but "${name}" is not an exception form`,
            ...(isGenericException(name)
              ? {}
              : {
                  hint: 'a bound names a form that is like exception, or like one of the stdlib exceptions',
                }),
          }),
        )
      }
    }

    const beyond = [...(sets.raises.get(s.name) ?? [])]
      .filter(e => !declared.has(e))
      .sort()

    if (beyond.length > 0) {
      const chains = beyond.map(e => {
        const chain: string[] = []

        let cur = s.name

        while (chain.length < 64) {
          const next = sets.via.get(cur)?.get(e)

          if (next === undefined) {
            break
          }

          chain.push(next)
          cur = next
        }

        return chain.length ? `${e} (through ${chain.join(' > ')})` : e
      })

      diagnostics.push(
        diagnose('raise-bound', {
          file: at,
          span: s.span,
          message: `"${s.name}" can raise ${chains.join(', ')}, which its signature does not declare`,
          hint: `add "halt ${beyond[0]}" to the signature, or handle it in a fork marked mark unsafe, with halt take after it`,
        }),
      )
    }
  }

  return diagnostics
}
