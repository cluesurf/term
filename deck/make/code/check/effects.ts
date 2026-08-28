// The effect checker: tracks the async effect across the program and enforces a consistent async / await
// discipline. This is the surface-level slice of the effect system (the deeper, kernel-level treatment ties
// effects and mutation to the `1` multiplicity / linear regions; see plans/18-type-theory-gaps.md). The three
// sound rules, given the model where `wait true` marks a task async and an awaited call:
//   1. `await` may only appear inside an async task.
//   2. `await` may only target an asynchronous task (awaiting a synchronous one is meaningless).
//   3. an asynchronous call in a synchronous task must be awaited (otherwise its result escapes unhandled).
// Browser-safe, no host APIs.

import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import type {
  Expression,
  Program,
  Statement,
} from '@term/make/code/compile/node'

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
    calls.set(name, calledNames(statement.body, names))
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
function calledNames(
  body: Statement[],
  known: Set<string>,
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

    const isAsyncName = (name: string): boolean =>
      asyncFunctions.has(name) || asyncParams.has(name)

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
                  'await is only allowed inside an async task (mark this task with `wait true`)',
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
          // `wait false` is fire-and-forget: an async call deliberately left un-awaited, so it is exempt. Otherwise
          // async resolution awaits async calls by default; a leftover un-awaited async call in a sync context is an
          // error only when it was not marked background.
          if (
            !awaited &&
            !inAsync &&
            !node.background &&
            node.callee.form === 'variable' &&
            isAsyncName(node.callee.name)
          ) {
            diagnostics.push(
              diagnose('effect-error', {
                file,
                span: node.span,
                message: `"${node.callee.name}" is async; await it, or mark it fire-and-forget with \`wait false\``,
              }),
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


// ---- raise sets ----
//
// The exceptions each function can raise: every `halt <form>` in its body outside a guarded body, plus what every
// callee raises (least fixed point over the call graph), minus what a `note unsafe` / `halt take` catches, plus
// what the handler itself raises. A thrown text is `failure`. A guard with no handler catches everything. This is
// the raise set of note/term/hive/04-reach.md, and it is what the roll reports per task and per route.
//
// `via` records, for each function and each exception, the callee that first brought it in (undefined for a direct
// raise), so a reader can walk one call path from an entry point to the raise site.
export type RaiseSets = {
  raises: Map<string, Set<string>>
  via: Map<string, Map<string, string | undefined>>
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
          } else if (node.value.form === 'string') {
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
          expressionCalls(node.cond, called)
          scan(node.body, direct, called)
          break
        case 'for-each':
          expressionCalls(node.iterable, called)
          scan(node.body, direct, called)
          break
        case 'if':
          for (const branch of node.branches) {
            expressionCalls(branch.cond, called)
            scan(branch.body, direct, called)
          }

          if (node.otherwise) {
            scan(node.otherwise, direct, called)
          }

          break
        case 'match':
          expressionCalls(node.subject, called)

          for (const branch of node.cases) {
            scan(branch.body, direct, called)
          }

          if (node.otherwise) {
            scan(node.otherwise, direct, called)
          }

          break
        case 'let':
          expressionCalls(node.init, called)
          break
        case 'assign':
          expressionCalls(node.target, called)
          expressionCalls(node.value, called)
          break
        case 'expression':
          expressionCalls(node.expr, called)
          break
        case 'return':
          if (node.value) {
            expressionCalls(node.value, called)
          }

          break
        case 'hold':
          expressionCalls(node.expr, called)
          break
        default:
          break
      }
    }
  }

  const expressionCalls = (node: Expression, called: Set<string>): void => {
    for (const name of calledNames([{ form: 'expression', expr: node, span: node.span }], names)) {
      called.add(name)
    }
  }

  for (const [name, statement] of functions) {
    const direct = new Set<string>()
    const called = new Set<string>()
    scan(statement.body, direct, called)
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

  return { raises, via }
}
