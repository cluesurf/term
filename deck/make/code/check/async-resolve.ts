// Async resolution: infer which functions are async from the call graph and await async calls by default. See
// note/term/compiler/async-inference.md and note/term/plan/await-by-default-and-mark-metadata.md. A `tick f(x)` (the
// call's `background` flag, also `wait false`) is neither awaited nor counted: it does not make its caller async. Runs after type checking, before the effect check (so the inserted awaits
// satisfy the async/await discipline) and before IR + emit. Shared by the build and editor paths via compileProgram,
// so the language server gets the same inference. Pure, browser-safe; it mutates the program (marks functions async and
// wraps async calls in `await`).

import type {
  Expression,
  Program,
  Statement,
  Type,
} from '@term/make/code/compile/node'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'

type Fn = Extract<Statement, { form: 'function' }>

export function resolveAsync(program: Program): void {
  const functions = functionsOf(program)
  const asyncSet = asyncSetOf(functions)

  // apply: mark each async function, and wrap every default (non-background, not-yet-awaited) call to an async function
  // in an `await`
  for (const [name, fn] of functions) {
    if (asyncSet.has(name)) {
      fn.async = true
    }

    const visible = inScope(asyncSet, fn)

    fn.body = fn.body.map(s => stmt(s, visible))
  }
}

// An async task handed to a parameter typed as a task that is NOT async, and gives back a value. The callee calls it
// without waiting and reads the pending value as the result, so TypeScript printed `[object Promise]` (guides: language/async,
// 2026-10-04). Runs after `resolveAsync`, when every async task is marked, inferred ones included. Only the tasks of
// `file` are read, so a dependency is held to it where it is compiled itself.
export function checkAsyncArguments(program: Program, file: string): Diagnostic[] {
  const functions = functionsOf(program)
  const asyncSet = new Set([...functions].filter(([, fn]) => fn.async).map(([name]) => name))
  const out: Diagnostic[] = []

  for (const fn of functions.values()) {
    if (fn.span.file !== file) {
      continue
    }

    const visible = inScope(asyncSet, fn)
    const own = new Set(fn.params.map(p => p.name))

    const e = (node: Expression | undefined): void => {
      if (!node) {
        return
      }

      if (node.form === 'closure') {
        node.body.forEach(s => walkStmt(s, e))

        return
      }

      // a parameter of the same name is the value, never the task
      if (node.form === 'call' && node.callee.form === 'variable' && !own.has(node.callee.name)) {
        const callee = functions.get(node.callee.name)

        node.args.forEach((arg, i) => {
          const param = callee?.params[i]
          const passed =
            (arg.form === 'variable' && visible.has(arg.name)) || (arg.form === 'closure' && arg.async === true)

          // a callback whose result is `void` is not refused: nothing reads what it gives back, so calling it without
          // waiting starts it the way `tick` does (cask's `snapshot` takes a `done` that calls an async `quit`)
          // nor one whose result is the callee's own type parameter, or unknown: the callee then takes whatever the
          // task gives back, a pending value included, and hands it on (`spawn`, `gather` in @term/base/task)
          const result = param?.type?.kind === 'function' ? param.type.result : undefined
          const open =
            result?.kind === 'unknown' ||
            result?.kind === 'dynamic' ||
            (result?.kind === 'named' && (callee?.generics ?? []).some(g => g.name === result.name))

          if (
            passed &&
            param?.type?.kind === 'function' &&
            !param.type.effects?.includes('async') &&
            param.type.result.kind !== 'unit' &&
            !open
          ) {
            out.push(
              diagnose('async-argument', {
                file,
                span: arg.span,
                message: `${arg.form === 'variable' ? `\`${arg.name}\` is async, and` : 'this task is async, and'} \`${param.name}\` of \`${node.callee.form === 'variable' ? node.callee.name : ''}\` takes a task that is not: it would be called without waiting`,
              }),
            )
          }
        })
      }

      walkExpr(node, e)
    }

    fn.body.forEach(s => walkStmt(s, e))
  }

  return out
}

// The tasks of a program that are async, marked or inferred, without changing the program: what `resolveAsync`
// would mark. The lint rule that finds a redundant `wait true` (L054) and the effect check read it.
export function asyncNames(program: Program): Set<string> {
  return asyncSetOf(functionsOf(program))
}

function functionsOf(program: Program): Map<string, Fn> {
  const functions = new Map<string, Fn>()

  for (const statement of program) {
    if (statement.form === 'function') {
      functions.set(statement.name, statement)
    }
  }

  return functions
}

function asyncSetOf(functions: Map<string, Fn>): Set<string> {
  // seed: a function is async if it is marked async (task-level) or already awaits something (a call-level `wait true`)
  const asyncSet = new Set<string>()

  for (const [name, fn] of functions) {
    if (fn.async || bodyAwaits(fn.body)) {
      asyncSet.add(name)
    }
  }

  // fixed point: a function that calls an async function in non-background position is itself async
  let changed = true

  while (changed) {
    changed = false

    for (const [name, fn] of functions) {
      if (asyncSet.has(name)) {
        continue
      }

      if (bodyCallsAsync(fn.body, inScope(asyncSet, fn))) {
        asyncSet.add(name)
        changed = true
      }
    }
  }

  return asyncSet
}

// the async names a function's body can reach. A parameter or a local of the same name SHADOWS the global task, so a
// call to it is a call to the value, never the task: `find-index` takes a callback named `test`, and calling it was
// awaited as though it were the async file `test` the stdlib also defines, which refused the whole program
//
// A parameter typed as an async task (`take work / like task / mark async`) is async itself: a call to it is awaited
// and makes the task taking it async, the same as a call to an async task by name (guides: language/async, 2026-10-04)
export function inScope(
  asyncSet: Set<string>,
  fn: { params: { name: string; type?: Type }[]; body: Statement[] },
): Set<string> {
  const awaited = fn.params.filter(p => p.type?.kind === 'function' && p.type.effects?.includes('async'))
  const local = new Set<string>(fn.params.map(p => p.name))
  const scope = inScopeOf(asyncSet, local, fn.body)

  return awaited.length === 0 ? scope : new Set([...scope, ...awaited.map(p => p.name)])
}

function inScopeOf(asyncSet: Set<string>, local: Set<string>, body: Statement[]): Set<string> {

  const collect = (node: unknown): void => {
    if (!node || typeof node !== 'object') {
      return
    }

    if (Array.isArray(node)) {
      node.forEach(collect)

      return
    }

    const record = node as Record<string, unknown>

    if (record.form === 'let' && typeof record.name === 'string') {
      local.add(record.name)
    }

    if (record.form === 'closure') {
      // a closure's own parameters are handled where the closure is rewritten
      return
    }

    for (const [key, value] of Object.entries(record)) {
      if (key !== 'span' && key !== 'type') {
        collect(value)
      }
    }
  }

  collect(body)

  if (![...local].some(name => asyncSet.has(name))) {
    return asyncSet
  }

  return new Set([...asyncSet].filter(name => !local.has(name)))
}

// does this body await directly (not counting a nested closure, whose await makes the CLOSURE async, not this scope)?
function bodyAwaits(body: Statement[]): boolean {
  let found = false

  const e = (node: Expression | undefined): void => {
    if (!node || found) {
      return
    }

    if (node.form === 'await') {
      found = true

      return
    }

    if (node.form === 'closure') {
      return
    } // a closure's await belongs to the closure

    walkExpr(node, e)
  }

  for (const s of body) {
    walkStmt(s, e)
  }

  return found
}

// does this body make a non-background call to a function in `asyncSet` (again, not descending into closures)?
function bodyCallsAsync(
  body: Statement[],
  asyncSet: Set<string>,
): boolean {
  let found = false

  const e = (node: Expression | undefined): void => {
    if (!node || found) {
      return
    }

    if (node.form === 'closure') {
      return
    }

    if (node.form === 'call' && callsAsync(node, asyncSet)) {
      found = true

      return
    }

    walkExpr(node, e)
  }

  for (const s of body) {
    walkStmt(s, e)
  }

  return found
}

// rewrite a statement, wrapping async calls in `await`
function stmt(node: Statement, asyncSet: Set<string>): Statement {
  const e = (x: Expression): Expression => expr(x, asyncSet)

  switch (node.form) {
    case 'let': {
      // `save pending, tick fetch(x)`: the value is the PENDING one (a `Promise` on TypeScript), not the task's
      // result, so the binding drops the result type the checker gave it and is left to the backend's inference.
      // Term has no promise type to spell it with: the only things to do with one are hand it on and `gather` it
      if (
        node.init.form === 'call' &&
        node.init.background &&
        node.init.callee.form === 'variable' &&
        asyncSet.has(node.init.callee.name) &&
        node.type
      ) {
        const { type: _dropped, ...untyped } = node

        return { ...untyped, init: e(node.init) }
      }

      return { ...node, init: e(node.init) }
    }
    case 'assign':
      return { ...node, target: e(node.target), value: e(node.value) }
    case 'expression':
      return { ...node, expr: e(node.expr) }
    case 'return':
      return node.value ? { ...node, value: e(node.value) } : node
    case 'throw':
      return { ...node, value: e(node.value) }
    case 'hold':
      return { ...node, expr: e(node.expr) }
    case 'while':
      return {
        ...node,
        cond: e(node.cond),
        body: node.body.map(s => stmt(s, asyncSet)),
      }
    case 'guard':
      return {
        ...node,
        body: node.body.map(s => stmt(s, asyncSet)),
        ...(node.catch
          ? {
              catch: {
                ...node.catch,
                body: node.catch.body.map(s => stmt(s, asyncSet)),
              },
            }
          : {}),
      }
    case 'for-each':
      return {
        ...node,
        iterable: e(node.iterable),
        body: node.body.map(s => stmt(s, asyncSet)),
      }
    case 'if':
      return {
        ...node,
        branches: node.branches.map(b => ({
          cond: e(b.cond),
          body: b.body.map(s => stmt(s, asyncSet)),
        })),
        otherwise: node.otherwise?.map(s => stmt(s, asyncSet)),
      }
    case 'match':
      return {
        ...node,
        subject: e(node.subject),
        cases: node.cases.map(c => ({
          ...c,
          body: c.body.map(s => stmt(s, asyncSet)),
        })),
        otherwise: node.otherwise?.map(s => stmt(s, asyncSet)),
      }
    default:
      return node
  }
}

// rewrite an expression, wrapping a default call to an async function in `await`; recurse into closures (a closure that
// gains an await becomes async itself)
// whether a call waits: a call of a name the async set holds, or of anything else (a field, `each/propose`) whose type
// is an async task. The second was missing, so a call through a field typed `like task / mark async` handed back the
// promise unawaited, and a `sift` on it matched no case (deck/test/code/model-proposer.tree, 2026-10-05)
function callsAsync(node: Extract<Expression, { form: 'call' }>, asyncSet: Set<string>): boolean {
  if (node.background) {
    return false
  }

  if (node.callee.form === 'variable') {
    return asyncSet.has(node.callee.name)
  }

  const type = node.callee.type

  return type?.kind === 'function' && Boolean(type.effects?.includes('async'))
}

function expr(node: Expression, asyncSet: Set<string>): Expression {
  switch (node.form) {
    case 'call': {
      const callee = expr(node.callee, asyncSet)
      const args = node.args.map(a => expr(a, asyncSet))
      const call = { ...node, callee, args }

      if (callsAsync(node, asyncSet)) {
        return { form: 'await', expr: call, span: node.span }
      }

      return call
    }

    case 'await': {
      // collapse `await (await x)` to a single await: a call already wrapped by mill's `wait true` would otherwise be
      // re-wrapped here (the callee is async), and a doubled await is fatal on backends where the awaited value is a
      // plain scalar (Rust `.await.await`).
      const inner = expr(node.expr, asyncSet)

      return inner.form === 'await' ? inner : { ...node, expr: inner }
    }
    case 'binary':
      return {
        ...node,
        left: expr(node.left, asyncSet),
        right: expr(node.right, asyncSet),
      }
    case 'unary':
      return { ...node, operand: expr(node.operand, asyncSet) }
    case 'member':
      return { ...node, target: expr(node.target, asyncSet) }
    case 'array':
      return { ...node, items: node.items.map(i => expr(i, asyncSet)) }
    // a call inside a text's `{...}` is awaited like any other: this case was missing, so `log <with one: {fetch-it()}>`
    // printed `with one: [object Promise]` (guides: library/network, 2026-10-04)
    case 'template':
      return {
        ...node,
        parts: node.parts.map(part => (typeof part === 'string' ? part : expr(part, asyncSet))),
      }
    case 'map':
      return {
        ...node,
        entries: node.entries.map(en => ({
          key: expr(en.key, asyncSet),
          value: expr(en.value, asyncSet),
        })),
      }
    case 'record':
      return {
        ...node,
        fields: node.fields.map(f => ({
          ...f,
          value: expr(f.value, asyncSet),
        })),
      }
    case 'conditional':
      return {
        ...node,
        branches: node.branches.map(b => ({
          cond: expr(b.cond, asyncSet),
          value: expr(b.value, asyncSet),
        })),
        otherwise: node.otherwise
          ? expr(node.otherwise, asyncSet)
          : undefined,
      }

    case 'closure': {
      const body = node.body.map(s => stmt(s, inScope(asyncSet, node)))

      return { ...node, body, async: node.async || bodyAwaits(body) }
    }

    default:
      return node
  }
}

// generic child-expression walk (used by the read-only analyses above), NOT descending control flow into closures
function walkExpr(
  node: Expression,
  visit: (e: Expression | undefined) => void,
): void {
  switch (node.form) {
    case 'call':
      visit(node.callee)
      node.args.forEach(visit)
      break
    case 'await':
      visit(node.expr)
      break
    case 'template':
      for (const part of node.parts) {
        if (typeof part !== 'string') {
          visit(part)
        }
      }

      break
    case 'binary':
      visit(node.left)
      visit(node.right)
      break
    case 'unary':
      visit(node.operand)
      break
    case 'member':
      visit(node.target)
      break
    case 'array':
      node.items.forEach(visit)
      break
    case 'map':
      node.entries.forEach(en => {
        visit(en.key)
        visit(en.value)
      })
      break
    case 'record':
      node.fields.forEach(f => visit(f.value))
      break
    case 'conditional':
      node.branches.forEach(b => {
        visit(b.cond)
        visit(b.value)
      })

      if (node.otherwise) {
        visit(node.otherwise)
      }

      break
    default:
      break
  }
}

function walkStmt(
  node: Statement,
  visit: (e: Expression | undefined) => void,
): void {
  switch (node.form) {
    case 'let':
      visit(node.init)
      break
    case 'assign':
      visit(node.target)
      visit(node.value)
      break
    case 'expression':
      visit(node.expr)
      break
    case 'return':
      if (node.value) {
        visit(node.value)
      }

      break
    case 'throw':
      visit(node.value)
      break
    case 'hold':
      visit(node.expr)
      break
    case 'while':
      visit(node.cond)
      node.body.forEach(s => walkStmt(s, visit))
      break
    case 'guard':
      node.body.forEach(s => walkStmt(s, visit))
      node.catch?.body.forEach(s => walkStmt(s, visit))
      break
    case 'for-each':
      visit(node.iterable)
      node.body.forEach(s => walkStmt(s, visit))
      break
    case 'if':
      node.branches.forEach(b => {
        visit(b.cond)
        b.body.forEach(s => walkStmt(s, visit))
      })
      node.otherwise?.forEach(s => walkStmt(s, visit))
      break
    case 'match':
      visit(node.subject)
      node.cases.forEach(c => c.body.forEach(s => walkStmt(s, visit)))
      node.otherwise?.forEach(s => walkStmt(s, visit))
      break
    default:
      break
  }
}
