// The first IR transformation pass: a mid-level simplifier over the compile AST. Constant folding and algebraic
// identities, so the emitted code is leaner. This is the start of the IR pipeline (see
// note/research/vibe/computation/plans/05-ir.md); more passes (CFG, monomorphization, Perceus reuse) layer on.
// Pure and browser-safe.

import type { Expression, Program, Statement } from '@/code/compile/node'

type Folded = { kind: 'integer'; value: number } | { kind: 'boolean'; value: boolean } | undefined

function foldArithmetic(op: string, a: number, b: number): Folded {
  switch (op) {
    case '+':
      return { kind: 'integer', value: a + b }
    case '-':
      return { kind: 'integer', value: a - b }
    case '*':
      return { kind: 'integer', value: a * b }
    case '/':
      return b === 0 ? undefined : { kind: 'integer', value: Math.trunc(a / b) }
    case '%':
      return b === 0 ? undefined : { kind: 'integer', value: a % b }
    case '==':
      return { kind: 'boolean', value: a === b }
    case '!=':
      return { kind: 'boolean', value: a !== b }
    case '<':
      return { kind: 'boolean', value: a < b }
    case '<=':
      return { kind: 'boolean', value: a <= b }
    case '>':
      return { kind: 'boolean', value: a > b }
    case '>=':
      return { kind: 'boolean', value: a >= b }
    default:
      return undefined
  }
}

function isInteger(node: Expression, value: number): boolean {
  return node.form === 'integer' && Number(node.value) === value
}

function simplifyExpression(node: Expression): Expression {
  switch (node.form) {
    case 'binary': {
      const left = simplifyExpression(node.left)
      const right = simplifyExpression(node.right)

      // constant folding
      if (left.form === 'integer' && right.form === 'integer') {
        const folded = foldArithmetic(node.op, Number(left.value), Number(right.value))
        if (folded) return { ...folded, form: folded.kind, span: node.span } as Expression
      }

      // algebraic identities
      switch (node.op) {
        case '+':
          if (isInteger(right, 0)) return left
          if (isInteger(left, 0)) return right
          break
        case '-':
          if (isInteger(right, 0)) return left
          break
        case '*':
          if (isInteger(right, 1)) return left
          if (isInteger(left, 1)) return right
          if (isInteger(right, 0) || isInteger(left, 0)) return { form: 'integer', value: 0, span: node.span }
          break
        case '/':
          if (isInteger(right, 1)) return left
          break
        default:
          break
      }

      return { ...node, left, right }
    }
    case 'unary':
      return { ...node, operand: simplifyExpression(node.operand) }
    case 'call':
      return { ...node, callee: simplifyExpression(node.callee), args: node.args.map(simplifyExpression) }
    case 'array':
      return { ...node, items: node.items.map(simplifyExpression) }
    case 'member':
      return { ...node, target: simplifyExpression(node.target) }
    case 'record':
      return { ...node, fields: node.fields.map((f) => ({ name: f.name, value: simplifyExpression(f.value) })) }
    case 'map':
      return { ...node, entries: node.entries.map((e) => ({ key: simplifyExpression(e.key), value: simplifyExpression(e.value) })) }
    default:
      return node
  }
}

function simplifyBody(body: Array<Statement>): Array<Statement> {
  return body.map(simplifyStatement)
}

function simplifyStatement(node: Statement): Statement {
  switch (node.form) {
    case 'let':
      return { ...node, init: simplifyExpression(node.init) }
    case 'assign':
      return { ...node, target: simplifyExpression(node.target), value: simplifyExpression(node.value) }
    case 'expression':
      return { ...node, expr: simplifyExpression(node.expr) }
    case 'return':
      return { ...node, value: node.value ? simplifyExpression(node.value) : undefined }
    case 'while':
      return { ...node, cond: simplifyExpression(node.cond), body: simplifyBody(node.body) }
    case 'for-each':
      return { ...node, iterable: simplifyExpression(node.iterable), body: simplifyBody(node.body) }
    case 'if':
      return {
        ...node,
        branches: node.branches.map((b) => ({ cond: simplifyExpression(b.cond), body: simplifyBody(b.body) })),
        otherwise: node.otherwise ? simplifyBody(node.otherwise) : undefined,
      }
    case 'function':
      return { ...node, body: simplifyBody(node.body) }
    default:
      return node
  }
}

// ---- trivial-forwarder inlining ----
// A function `f(p1..pn) { return g(p1..pn) }` is an eta-wrapper of g: it just passes its arguments straight through.
// Replacing every call `f(a1..an)` with `g(a1..an)` collapses the wrapper, and chained wrappers fold in one step to
// the underlying native call. Wrapper definitions left with no remaining references are dropped. This is what lets a
// clean delegating interface (math.absolute -> abs -> Math.abs) vanish from the compiled output for the simple
// pass-through cases: no indirection survives to runtime. Eta-reduction is semantics-preserving, so this only changes
// the shape of the emitted code, never its behavior.

// the call this function forwards to verbatim (a free function or a native member), or undefined if it is not a
// trivial pass-through. Awaited / argument-reordering / argument-augmenting wrappers do not qualify.
function forwarderTarget(fn: Extract<Statement, { form: 'function' }>): Expression | undefined {
  if (fn.body.length !== 1) return undefined
  const ret = fn.body[0]!
  if (ret.form !== 'return' || !ret.value || ret.value.form !== 'call') return undefined
  const call = ret.value
  if (call.args.length !== fn.params.length) return undefined
  for (let i = 0; i < fn.params.length; i++) {
    const arg = call.args[i]!
    if (arg.form !== 'variable' || arg.name !== fn.params[i]!.name) return undefined
  }
  if (call.callee.form === 'variable' && call.callee.name !== fn.name) return call.callee
  if (call.callee.form === 'member') return call.callee
  return undefined
}

function rewriteExpression(node: Expression, forwarders: Map<string, Expression>): Expression {
  switch (node.form) {
    case 'binary':
      return { ...node, left: rewriteExpression(node.left, forwarders), right: rewriteExpression(node.right, forwarders) }
    case 'unary':
      return { ...node, operand: rewriteExpression(node.operand, forwarders) }
    case 'call': {
      let callee = rewriteExpression(node.callee, forwarders)
      const args = node.args.map((a) => rewriteExpression(a, forwarders))
      // collapse a chain of wrappers in one pass, guarding against a forwarder cycle
      const seen = new Set<string>()
      while (callee.form === 'variable' && forwarders.has(callee.name) && !seen.has(callee.name)) {
        seen.add(callee.name)
        callee = forwarders.get(callee.name)!
      }
      return { ...node, callee, args }
    }
    case 'array':
      return { ...node, items: node.items.map((i) => rewriteExpression(i, forwarders)) }
    case 'member':
      return { ...node, target: rewriteExpression(node.target, forwarders) }
    case 'record':
      return { ...node, fields: node.fields.map((f) => ({ name: f.name, value: rewriteExpression(f.value, forwarders) })) }
    case 'map':
      return { ...node, entries: node.entries.map((e) => ({ key: rewriteExpression(e.key, forwarders), value: rewriteExpression(e.value, forwarders) })) }
    case 'await':
      return { ...node, expr: rewriteExpression(node.expr, forwarders) }
    case 'closure':
      return { ...node, body: node.body.map((s) => rewriteStatement(s, forwarders)) }
    default:
      return node
  }
}

function rewriteStatement(node: Statement, forwarders: Map<string, Expression>): Statement {
  const body = (b: Array<Statement>) => b.map((s) => rewriteStatement(s, forwarders))
  switch (node.form) {
    case 'let':
      return { ...node, init: rewriteExpression(node.init, forwarders) }
    case 'assign':
      return { ...node, target: rewriteExpression(node.target, forwarders), value: rewriteExpression(node.value, forwarders) }
    case 'expression':
      return { ...node, expr: rewriteExpression(node.expr, forwarders) }
    case 'return':
      return { ...node, value: node.value ? rewriteExpression(node.value, forwarders) : undefined }
    case 'throw':
      return { ...node, value: rewriteExpression(node.value, forwarders) }
    case 'while':
      return { ...node, cond: rewriteExpression(node.cond, forwarders), body: body(node.body) }
    case 'for-each':
      return { ...node, iterable: rewriteExpression(node.iterable, forwarders), body: body(node.body) }
    case 'if':
      return { ...node, branches: node.branches.map((b) => ({ cond: rewriteExpression(b.cond, forwarders), body: body(b.body) })), otherwise: node.otherwise ? body(node.otherwise) : undefined }
    case 'match':
      return { ...node, subject: rewriteExpression(node.subject, forwarders), cases: node.cases.map((c) => ({ label: c.label, body: body(c.body) })), otherwise: node.otherwise ? body(node.otherwise) : undefined }
    case 'hold':
      return { ...node, expr: rewriteExpression(node.expr, forwarders) }
    case 'function':
      return { ...node, body: body(node.body) }
    default:
      return node
  }
}

// count every `variable` occurrence by name (callee or value position), so a wrapper still used as a first-class
// value (passed as a callback) is kept while one that is only ever called directly is dropped
function countReferences(node: Expression, counts: Map<string, number>): void {
  switch (node.form) {
    case 'variable':
      counts.set(node.name, (counts.get(node.name) ?? 0) + 1)
      break
    case 'binary':
      countReferences(node.left, counts)
      countReferences(node.right, counts)
      break
    case 'unary':
      countReferences(node.operand, counts)
      break
    case 'call':
      countReferences(node.callee, counts)
      node.args.forEach((a) => countReferences(a, counts))
      break
    case 'array':
      node.items.forEach((i) => countReferences(i, counts))
      break
    case 'member':
      countReferences(node.target, counts)
      break
    case 'record':
      node.fields.forEach((f) => countReferences(f.value, counts))
      break
    case 'map':
      node.entries.forEach((e) => {
        countReferences(e.key, counts)
        countReferences(e.value, counts)
      })
      break
    case 'await':
      countReferences(node.expr, counts)
      break
    case 'closure':
      node.body.forEach((s) => countReferencesStatement(s, counts))
      break
    default:
      break
  }
}

function countReferencesStatement(node: Statement, counts: Map<string, number>): void {
  const body = (b: Array<Statement>) => b.forEach((s) => countReferencesStatement(s, counts))
  switch (node.form) {
    case 'let':
      countReferences(node.init, counts)
      break
    case 'assign':
      countReferences(node.target, counts)
      countReferences(node.value, counts)
      break
    case 'expression':
      countReferences(node.expr, counts)
      break
    case 'return':
      if (node.value) countReferences(node.value, counts)
      break
    case 'throw':
      countReferences(node.value, counts)
      break
    case 'while':
      countReferences(node.cond, counts)
      body(node.body)
      break
    case 'for-each':
      countReferences(node.iterable, counts)
      body(node.body)
      break
    case 'if':
      node.branches.forEach((b) => {
        countReferences(b.cond, counts)
        body(b.body)
      })
      if (node.otherwise) body(node.otherwise)
      break
    case 'match':
      countReferences(node.subject, counts)
      node.cases.forEach((c) => body(c.body))
      if (node.otherwise) body(node.otherwise)
      break
    case 'hold':
      countReferences(node.expr, counts)
      break
    case 'function':
      body(node.body)
      break
    default:
      break
  }
}

// `roots` are the entry module's public functions: kept even when unreferenced. Only internal (imported) wrappers are
// eligible to be dropped once their calls are inlined away.
function inlineForwarders(program: Program, roots?: Set<string>): Program {
  const forwarders = new Map<string, Expression>()
  for (const node of program) {
    if (node.form === 'function') {
      const target = forwarderTarget(node)
      if (target) forwarders.set(node.name, target)
    }
  }
  if (forwarders.size === 0) return program
  const rewritten = program.map((s) => rewriteStatement(s, forwarders))
  const counts = new Map<string, number>()
  for (const s of rewritten) countReferencesStatement(s, counts)
  // drop wrapper definitions whose calls were all inlined away (no remaining reference) and that are not public roots
  return rewritten.filter((n) => !(n.form === 'function' && forwarders.has(n.name) && (counts.get(n.name) ?? 0) === 0 && !roots?.has(n.name)))
}

// drop ambient host globals (`host document, name <document>` -> a foreign-aliased `let`) that nothing references.
// A generated binding package declares hundreds of host globals; importing one interface pulls them all in. Emitting
// an unused `const window = Window` is dead weight, and worse, a binding whose name shadows a real global of a
// different case (`const document = Document`) would mask the genuine global. Keeping only the referenced ones is a
// pure win and removes the shadow.
function dropUnusedHostGlobals(program: Program): Program {
  const counts = new Map<string, number>()
  for (const s of program) countReferencesStatement(s, counts)
  // a function of the same name is the real binding for that name; drop the host global so it does not redeclare it
  // (bind's `Event` global vs the framework's `event` render helper). Also drop host globals nothing references.
  const functionNames = new Set(program.filter((n) => n.form === 'function').map((n: any) => n.name as string))
  return program.filter(
    (n) => !(n.form === 'let' && n.foreign !== undefined && ((counts.get(n.name) ?? 0) === 0 || functionNames.has(n.name))),
  )
}

// run the simplifier over a whole program: first collapse pass-through wrappers, drop unused host globals, then fold
// constants / identities
export function simplify(program: Program, roots?: Set<string>): Program {
  return dropUnusedHostGlobals(inlineForwarders(program, roots)).map(simplifyStatement)
}
