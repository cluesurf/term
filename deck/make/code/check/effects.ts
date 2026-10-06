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

import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import type {
  Expression,
  Program,
  Statement,
} from '@term/make/code/compile/node'
import { exceptionForm, isGenericException } from '@term/make/code/check/extend'

const EXCEPTION_FORM = exceptionForm()

// the inferred effect row of each function: the set of effects it may perform. `async` is the marker effect
// (resolved at an await, so it does not propagate). `throw` propagates transitively through the call graph (a
// caller of a throwing function may itself throw). This is effect-row inference -- the typed core of the effect
// system; row-variable polymorphism over task-typed callbacks is the further step (it needs effect annotations on
// those parameters).
export function effectRows(program: Program): Map<string, Set<string>> {
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
        for (const effect of param.type.effects) {
          row.add(effect)
        }
      }
    }

    rows.set(name, row)
    // a call to one of its own parameters is that parameter, whose effects were added just above, never the
    // top-level task of the same name: `list/find-index` calling its `test` read as `file/test`, and a native backend
    // then put `?` on a callback that returns a plain `bool` (2026-10-04)
    calls.set(name, new Set([...calledNames(statement.body, names)].filter(callee => !paramNames.has(callee))))
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

  return rows
}

// does the body contain a throw statement anywhere? A guarded body's throws are caught by its handler, so only
// the handler's own throws escape a guard that has one.
function bodyThrows(body: Statement[]): boolean {
  for (const node of body) {
    switch (node.form) {
      case 'throw':
        return true
      case 'guard':
        if (node.catch ? bodyThrows(node.catch.body) : bodyThrows(node.body)) {
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
        if (
          node.callee.form === 'variable' &&
          known.has(node.callee.name)
        ) {
          found.add(node.callee.name)
        } else if (node.callee.form === 'variable' && reach?.implementations?.has(node.callee.name)) {
          for (const implementation of reach.implementations.get(node.callee.name)!) {
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

    const isAsyncName = (name: string): boolean =>
      (asyncFunctions.has(name) && !shadowed.has(name)) || asyncParams.has(name)

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
            isAsyncName(node.callee.name)
          ) {
            diagnostics.push(asyncFromSync(file, node.span, node.callee.name))
          }

          // `tick` on a task that is not async starts nothing: the call runs to its end before the next line
          if (
            node.background &&
            node.callee.form === 'variable' &&
            isKnownSyncName(node.callee.name)
          ) {
            diagnostics.push(tickOnSync(file, node.span, node.callee.name))
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
function asyncFromSync(file: string, span: Span, called: string): Diagnostic {
  const name = written(called)

  return diagnose('effect-error', {
    file,
    span,
    message: `"${name}" is async, and this call is in a task that is not: mark the task \`mark async\`, or write \`tick ${name}\` to start it without waiting`,
  })
}

// `tick` on a task that is not async
function tickOnSync(file: string, span: Span, called: string): Diagnostic {
  const name = written(called)

  return diagnose('effect-error', {
    file,
    span,
    message: `\`tick\` starts an async task and goes on, and "${name}" is not async: call it without \`tick\``,
  })
}

// ---- the switch: a call to an async task outside any task ----
//
// AWAIT BY DEFAULT (note/term/plan/await-by-default-and-mark-metadata.md, section 1). Inside a task, a call to an
// async task is awaited and the task becomes async (check/async-resolve.ts). OUTSIDE every task, in a top-level
// `host` or statement, in a component's body, or in a closure written in either that is not itself `mark async`,
// nothing can wait, and the call used to hand back a pending value with no message: `host config, read-config()`
// bound a promise typed as the config. Under the switch that is an error naming `tick`, which is how a place that
// cannot wait says it means the pending value.
//
// ON since 2026-10-03, after `pnpm term:await-migrate --commit` rewrote every such call in the repository to `tick`,
// each file proven to emit what it emitted before. The migration compiles under both settings, which is why it is a
// switch and not a constant. The compile cache keys on it (compile/compile.ts).
let awaitOutsideTasks = true

export function setAwaitOutsideTasks(on: boolean): void {
  awaitOutsideTasks = on
}

export function awaitsOutsideTasks(): boolean {
  return awaitOutsideTasks
}

// Every un-awaited, un-ticked call to an async task outside a task body. Runs after async resolution, so a task's
// own body is already awaited and is not walked here. A closure inside a task is the task's business (resolution
// awaits inside it); a closure outside one is walked, and is exempt only when it is itself async.
export function checkCallsOutsideTasks(program: Program, file: string): Diagnostic[] {
  if (!awaitOutsideTasks) {
    return []
  }

  const asyncFunctions = new Set<string>()

  for (const statement of program) {
    if (statement.form === 'function' && statement.async) {
      asyncFunctions.add(statement.name)
    }
  }

  const diagnostics: Diagnostic[] = []
  let owner = file

  // `waiting`: inside an async closure, where an awaited call is in place and an un-awaited one is still the
  // pending value nobody asked for. `bound`: names a closure's parameters and locals bind, which shadow a task
  const visit = (value: unknown, waiting: boolean, bound: Set<string>): void => {
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
      const closure = record as unknown as Extract<Expression, { form: 'closure' }>
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
    if (record.form === 'call' && record.callee && typeof record.callee === 'object') {
      const call = record as unknown as Extract<Expression, { form: 'call' }>

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
      if (key !== 'span' && key !== 'type' && key !== 'result' && key !== 'declared') {
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
    owner = ('span' in statement ? statement.span?.file : undefined) ?? file
    visit(statement, false, new Set())
  }

  return diagnostics
}

// the closure literals an expression makes, outermost first: a closure inside another closure's body is found when
// that body is scanned, so each is visited once
function closuresIn(node: Expression): Extract<Expression, { form: 'closure' }>[] {
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

    for (const [key, child] of Object.entries(record)) {
      if (key !== 'type' && key !== 'span' && key !== 'result') {
        visit(child)
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
// the raise set of note/term/hive/04-reach.md, and it is what the roll reports per task and per route.
//
// `via` records, for each function and each exception, the callee that first brought it in (undefined for a direct
// raise), so a reader can walk one call path from an entry point to the raise site.
export type RaiseSets = {
  raises: Map<string, Set<string>>
  via: Map<string, Map<string, string | undefined>>
  // the native shims: the functions that call into a `dock load` module, which raise `failure` by construction
  native: Set<string>
}

export function raiseSets(
  program: Program,
  // the record-types that are exceptions, by name
  exceptions: Set<string>,
): RaiseSets {
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
    } else if (statement.form === 'native' && statement.kind !== 'type') {
      natives.add(statement.alias)
    }
  }

  for (const statement of functions.values()) {
    if (statement.method && maskMethods.has(statement.method.name)) {
      const set = implementations.get(statement.method.name) ?? new Set<string>()
      set.add(statement.name)
      implementations.set(statement.method.name, set)
    }
  }

  let sawNative = false
  const reach: CallReach = { implementations, natives, onNative: () => { sawNative = true } }
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
          } else if (node.value.form === 'string' || node.value.form === 'template') {
            // `halt <text>` raises `failure`, and so does one whose text interpolates (`halt <at {position}>`), which
            // was counted as a re-raise of an unknown exception
            direct.add('failure')
          } else {
            // a re-raised value: what it is was decided where it was first raised
            direct.add('exception')
          }

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
  // (note/term/research/beam-otp-lessons.md, design 3)
  const expressionCalls = (node: Expression, called: Set<string>, direct?: Set<string>): void => {
    for (const name of calledNames([{ form: 'expression', expr: node, span: node.span }], names, reach)) {
      called.add(name)
    }

    if (direct) {
      for (const closure of closuresIn(node)) {
        scan(closure.body, direct, called)
      }
    }
  }

  for (const [name, statement] of functions) {
    // a separately compiled task: the set its own unit closed over its body and callees (`stubRaises`)
    if (statement.stub && statement.stubRaises) {
      const known = new Set(statement.stubRaises)

      if (statement.stubFacts?.includes('native')) {
        nativeShims.add(name)
      }

      // a task that raises `failure` once it is counted raises it here when this program counts it, as its own body's
      // scan would: its stored set was closed over its own unit, which may not have held the form (`fails`,
      // compile/stub.ts)
      if (exceptions.has('failure') && statement.stubFacts?.includes('fails')) {
        known.add('failure')
      }

      raises.set(name, known)
      via.set(name, new Map([...known].map(d => [d, undefined])))
      calls.set(name, new Set())
      continue
    }

    const direct = new Set<string>()
    const called = new Set<string>()
    sawNative = false
    scan(statement.body, direct, called)

    // a task that calls into a `dock load` module is a native shim: foreign code can fail in ways nobody listed, so
    // the runtime boundary wraps any foreign throw into `failure`, and the `halt` lines on its signature are the shim
    // author's contract, added to the set rather than checked against it (03-exception.md, natives)
    if (sawNative) {
      nativeShims.add(name)

      // only when the program holds the `failure` form, which a tree-shaken program drops unless something names it.
      // So whether a guard around a native call must cover `failure` depends on what the closure keeps: an open
      // question for the language (note/term/compiler/runtime-shaking.md). The roll asks with `failure` always in its
      // set (compile/roll.ts), so a task's roll entry is the same whichever entry built it
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

    // a call to one of its own parameters is that parameter, not the task of the same name (see the effect rows above)
    for (const param of statement.params) {
      called.delete(param.name)
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
        for (const exception of raises.get(callee) ?? []) {
          if (!set.has(exception)) {
            set.add(exception)
            from.set(exception, callee)
            changed = true
          }
        }
      }
    }
  }

  canonicalVia(calls, raises, via)

  return { raises, via, native: nativeShims }
}

// `via` CHOSEN BY RULE, NOT BY DISCOVERY. The fixed point recorded whichever callee brought an exception in first,
// which depended on the order it visited the functions, so one task's path read differently in a program holding more
// of them, and a unit's roll (its dependencies' stubs known from the start) could not equal the whole program's
// (note/term/plan/incremental-best-in-class.md, step 5). The rule: a call that leaves the task's cycle and reaches the
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
        const direct = from.has(exception) && from.get(exception) === undefined
        const leaves = [...calls.get(name)!].some(c => component.get(c) !== component.get(name) && raises.get(c)?.has(exception))

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
            const near = component.get(callee) === component.get(name) ? distance.get(callee)?.get(exception) : undefined

            if (near !== undefined && (own.get(exception) ?? Infinity) > near + 1) {
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

      const out = [...callees].find(c => component.get(c) !== component.get(name) && raises.get(c)?.has(exception))
      const inside = [...callees].find(
        c => component.get(c) === component.get(name) && (distance.get(c)?.get(exception) ?? Infinity) < (own.get(exception) ?? Infinity),
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
function cyclesOf(calls: Map<string, Set<string>>): Map<string, number> {
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

    const work: { name: string; next: string[] }[] = [{ name: start, next: [...calls.get(start)!].filter(c => calls.has(c)) }]
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
          work.push({ name: callee, next: [...calls.get(callee)!].filter(c => calls.has(c)) })
        } else if (onStack.has(callee)) {
          low.set(top.name, Math.min(low.get(top.name)!, index.get(callee)!))
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
    (s): s is Extract<Statement, { form: 'function' }> => s.form === 'function' && (s.raises?.length ?? 0) > 0,
  )

  if (bounded.length === 0) {
    return diagnostics
  }

  const sets = raiseSets(program, exceptions)

  for (const s of bounded) {
    const declared = new Set(s.raises)
    const at = s.span.file ?? file

    // a native shim raises `failure` whether or not it says so: foreign code fails in ways nobody listed
    if (sets.native.has(s.name)) {
      declared.add('failure')
    }

    for (const name of declared) {
      if (!exceptions.has(name)) {
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
              : { hint: 'a bound names a form that is like exception, or like one of the stdlib exceptions' }),
          }),
        )
      }
    }

    const beyond = [...(sets.raises.get(s.name) ?? [])].filter(e => !declared.has(e)).sort()

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
          hint: `add "halt ${beyond[0]}" to the signature, or handle it with mark unsafe / halt take`,
        }),
      )
    }
  }

  return diagnostics
}
