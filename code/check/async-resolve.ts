// Async resolution: infer which functions are async from the call graph and await async calls by default. See
// note/seed/compiler/async-inference.md. Runs after type checking, before the effect check (so the inserted awaits
// satisfy the async/await discipline) and before IR + emit. Shared by the build and editor paths via compileProgram,
// so the language server gets the same inference. Pure, browser-safe; it mutates the program (marks functions async and
// wraps async calls in `await`).

import type { Expression, Program, Statement } from '@/code/compile/node'

type Fn = Extract<Statement, { form: 'function' }>

export function resolveAsync(program: Program): void {
  const functions = new Map<string, Fn>()
  for (const statement of program)
    if (statement.form === 'function')
      functions.set(statement.name, statement)

  // seed: a function is async if it is marked async (task-level) or already awaits something (a call-level `wait true`)
  const asyncSet = new Set<string>()
  for (const [name, fn] of functions)
    if (fn.async || bodyAwaits(fn.body)) asyncSet.add(name)

  // fixed point: a function that calls an async function in non-background position is itself async
  let changed = true
  while (changed) {
    changed = false
    for (const [name, fn] of functions) {
      if (asyncSet.has(name)) continue
      if (bodyCallsAsync(fn.body, asyncSet)) {
        asyncSet.add(name)
        changed = true
      }
    }
  }

  // apply: mark each async function, and wrap every default (non-background, not-yet-awaited) call to an async function
  // in an `await`
  for (const [name, fn] of functions) {
    if (asyncSet.has(name)) fn.async = true
    fn.body = fn.body.map(s => stmt(s, asyncSet))
  }
}

// does this body await directly (not counting a nested closure, whose await makes the CLOSURE async, not this scope)?
function bodyAwaits(body: Array<Statement>): boolean {
  let found = false
  const e = (node: Expression | undefined): void => {
    if (!node || found) return
    if (node.form === 'await') {
      found = true
      return
    }
    if (node.form === 'closure') return // a closure's await belongs to the closure
    walkExpr(node, e)
  }
  for (const s of body) walkStmt(s, e)
  return found
}

// does this body make a non-background call to a function in `asyncSet` (again, not descending into closures)?
function bodyCallsAsync(
  body: Array<Statement>,
  asyncSet: Set<string>,
): boolean {
  let found = false
  const e = (node: Expression | undefined): void => {
    if (!node || found) return
    if (node.form === 'closure') return
    if (
      node.form === 'call' &&
      !node.background &&
      node.callee.form === 'variable' &&
      asyncSet.has(node.callee.name)
    ) {
      found = true
      return
    }
    walkExpr(node, e)
  }
  for (const s of body) walkStmt(s, e)
  return found
}

// rewrite a statement, wrapping async calls in `await`
function stmt(node: Statement, asyncSet: Set<string>): Statement {
  const e = (x: Expression): Expression => expr(x, asyncSet)
  switch (node.form) {
    case 'let':
      return { ...node, init: e(node.init) }
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
function expr(node: Expression, asyncSet: Set<string>): Expression {
  switch (node.form) {
    case 'call': {
      const callee = expr(node.callee, asyncSet)
      const args = node.args.map(a => expr(a, asyncSet))
      const call = { ...node, callee, args }
      if (
        !node.background &&
        node.callee.form === 'variable' &&
        asyncSet.has(node.callee.name)
      )
        return { form: 'await', expr: call, span: node.span }
      return call
    }
    case 'await':
      return { ...node, expr: expr(node.expr, asyncSet) }
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
      const body = node.body.map(s => stmt(s, asyncSet))
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
      if (node.otherwise) visit(node.otherwise)
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
      if (node.value) visit(node.value)
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
