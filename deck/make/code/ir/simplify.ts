// The first IR transformation pass: a mid-level simplifier over the compile AST. Constant folding and algebraic
// identities, so the emitted code is leaner. This is the start of the IR pipeline (see
// note/research/vibe/computation/plans/05-ir.md); more passes (CFG, monomorphization, Perceus reuse) layer on.
// Pure and browser-safe.

import type {
  Expression,
  Program,
  Statement,
  Type,
  ViewNode,
} from '@term/make/code/compile/node'
import { egraphArith } from '@term/make/code/ir/egraph-arith'
import { inlineStatements } from '@term/make/code/ir/inline-statements'
import { expressionsEqual } from '@term/make/code/compile/expr-equal'
import { RENDER } from '@term/make/code/compile/render-names'

// the render + reactive runtime primitives emitZone (code/compile/typescript.ts) synthesizes as raw calls in a zone's
// output. They never appear as call nodes in the AST, so reference-counting cannot see them. When a program contains
// any zone, treat this fixed ABI as referenced so neither forwarder-inlining nor specialization drops a single-return
// member of it (`make-element` / `make-text` / `make-signal`). The render names come from compile/render-names.ts.
const VIEW_RUNTIME = [
  RENDER.element,
  RENDER.text,
  RENDER.dynamic,
  RENDER.attribute,
  RENDER.event,
  'append',
  RENDER.show,
  RENDER.each,
  RENDER.integers,
  'make-signal',
  'read-signal',
  'write-signal',
  'make-effect',
]

type Folded =
  | { kind: 'integer'; value: number }
  | { kind: 'boolean'; value: boolean }
  | undefined

function foldArithmetic(op: string, a: number, b: number): Folded {
  // fold only within the SAFE integer range: beyond 2^53 a JS number rounds, and the rounded literal is
  // not the value the program wrote (an i64 extreme folded here printed an off-by-192 neighbor)
  const safe = (value: number): Folded =>
    Number.isSafeInteger(value) ? { kind: 'integer', value } : undefined

  switch (op) {
    case '+':
      return safe(a + b)
    case '-':
      return safe(a - b)
    case '*':
      return safe(a * b)
    case '/':
      return b === 0
        ? undefined
        : { kind: 'integer', value: Math.trunc(a / b) }
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

function isBool(node: Expression, value: boolean): boolean {
  return node.form === 'boolean' && node.value === value
}

// the comparison operator a logical negation flips to, so `!(a == b)` becomes `a != b`
const NEGATED_COMPARE: Record<string, string> = {
  '==': '!=',
  '!=': '==',
  '<': '>=',
  '<=': '>',
  '>': '<=',
  '>=': '<',
}

// ---- specialization state ----
// the verbs and convenience forms that collapse at a constant selector: a function whose body is a single `send back`
// of one expression (a forwarder, a convenience form, or a verb whose dispatch is a value-position `fork test`). Set
// once per `simplify()` run, read by the call specializer. See plans/20-specialization-and-bind.md.
let specializable = new Map<
  string,
  { params: { name: string }[]; body: Statement[] }
>()

// the names currently being inlined on this path, to break a recursive verb cycle
let inlining = new Set<string>()

// the small one-expression tasks inlined at ANY call whose arguments are pure, not only at a constant one (see
// `smallBody`): the one-line stdlib wrappers (`list-size`, `boolean-and` over a native) that every backend otherwise
// calls through. note/term/codegen/passes.md, P1
let small = new Map<
  string,
  { params: { name: string; type?: Type; optional?: boolean; fallback?: Expression }[]; value: Expression }
>()

// the names the function being simplified binds (its parameters, lets, loop variables, closure parameters)
let callerBound = new Set<string>()

// ---- interpolation, filled at compile time where it can be ----
// THE RULE: an interpolation in a text (`<area {a}>`) whose value is a module constant that folds is filled HERE,
// at compile time, and the text is emitted as a plain literal; any other interpolation is filled at run time by
// the backend. A template parameter never reaches this pass, because a `tree` expanded it before the mill ran.
//
// It runs BEFORE constant propagation, so what it folds is exactly what the rule names. A local that propagation
// later proves constant (`save x, 5`) stays a run-time fill, as the rule says a local does.
//
// Inside a `fork case` arm nothing is filled from a module constant: an arm binds its variant's fields as locals
// by their own names, the IR does not list them, and one could shadow the constant. Run time is always right
// there, compile time only where nothing shadows.

// the text a literal prints as at run time, on EVERY backend, or undefined when the backends disagree. Rust, Swift
// and Kotlin agree with TypeScript on an integer, a boolean and a text. They disagree on a float with no fraction
// (`1` on TypeScript and Rust, `1.0` on Swift and Kotlin) and on exponent forms, so those stay run time.
function printedAlike(node: Expression): string | undefined {
  switch (node.form) {
    case 'string':
      return node.value
    case 'boolean':
      return String(node.value)
    case 'integer':
      return Number.isSafeInteger(Number(node.value)) ? String(Number(node.value)) : undefined
    case 'float': {
      const value = Number(node.value)

      return Number.isFinite(value) && !Number.isInteger(value) && !/e/i.test(String(value))
        ? String(value)
        : undefined
    }
    default:
      return undefined
  }
}

// the top-level immutable `host` constants whose value folds, in declaration order so one may be built from an
// earlier one. A constant assigned to anywhere is not one.
function collectModuleConstants(program: Program): Map<string, Expression> {
  const assigned = new Set<string>()
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') {
      return
    }

    if (Array.isArray(node)) {
      node.forEach(visit)

      return
    }

    const record = node as Record<string, unknown>
    const target = record.target as { form?: string; name?: string } | undefined

    if (record.form === 'assign' && target?.form === 'variable' && typeof target.name === 'string') {
      assigned.add(target.name)
    }

    for (const [key, value] of Object.entries(record)) {
      if (key !== 'span' && key !== 'type') {
        visit(value)
      }
    }
  }

  visit(program)

  const found = new Map<string, Expression>()

  for (const node of program) {
    if (node.form !== 'let' || node.mutable || node.foreign !== undefined || assigned.has(node.name)) {
      continue
    }

    const value = simplifyExpression(found.size > 0 ? substituteExpr(node.init, found) : node.init)

    if (printedAlike(value) !== undefined) {
      found.set(node.name, value)
    }
  }

  return found
}

// One text template: when every interpolated part reads only module constants the enclosing code does not bind
// itself (a name, a path, a call over them) and folds to a literal printed alike everywhere, the whole template
// becomes one string. Otherwise it is returned untouched, for the backend to fill at run time.
function fillTemplate(
  node: Extract<Expression, { form: 'template' }>,
  constants: Map<string, Expression>,
  bound: Set<string>,
): Expression {
  const printed: string[] = []

  for (const part of node.parts) {
    if (typeof part === 'string') {
      printed.push(part)
      continue
    }

    const read = [...namesRead(part)]

    if (read.some(name => bound.has(name) || !constants.has(name))) {
      return node
    }

    const text = printedAlike(simplifyExpression(substituteExpr(structuredClone(part), constants)))

    if (text === undefined) {
      return node
    }

    printed.push(text)
  }

  return { form: 'string', value: printed.join(''), span: node.span }
}

// every name a function, a closure or a component binds anywhere inside itself: its parameters, its lets, its loop
// variables and its closures' parameters. Over-collecting only sends a fill to run time, which is always right.
function namesBoundIn(node: Record<string, unknown>): Set<string> {
  const names = new Set<string>()
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(visit)

      return
    }

    const record = value as Record<string, unknown>

    if (Array.isArray(record.params)) {
      for (const param of record.params as { name?: unknown }[]) {
        if (typeof param?.name === 'string') {
          names.add(param.name)
        }
      }
    }

    if (record.form === 'let' && typeof record.name === 'string') {
      names.add(record.name)
    }

    if (record.form === 'for-each') {
      if (typeof record.item === 'string') {
        names.add(record.item)
      }

      if (typeof record.index === 'string') {
        names.add(record.index)
      }
    }

    for (const [key, inner] of Object.entries(record)) {
      if (key !== 'span' && key !== 'type') {
        visit(inner)
      }
    }
  }

  visit(node)

  return names
}

// Fill every template in the program that reads only module constants. A node is copied only on the path to a
// template that changed, so every other node keeps its identity (facts are keyed by it).
function fillTemplates(program: Program): Program {
  const constants = collectModuleConstants(program)

  if (constants.size === 0) {
    return program
  }

  const walk = (value: unknown, bound: Set<string>, arm: boolean): unknown => {
    if (!value || typeof value !== 'object') {
      return value
    }

    if (Array.isArray(value)) {
      let changed = false
      const out = value.map(item => {
        const next = walk(item, bound, arm)

        changed ||= next !== item

        return next
      })

      return changed ? out : value
    }

    const record = value as Record<string, unknown>

    if (record.form === 'template') {
      return arm ? value : fillTemplate(value as Extract<Expression, { form: 'template' }>, constants, bound)
    }

    // a function, a closure or a component starts the names it binds, on top of the ones around it
    const scoped = Array.isArray(record.params)
      ? new Set([...bound, ...namesBoundIn(record)])
      : bound
    let changed = false
    const out: Record<string, unknown> = {}

    for (const [key, inner] of Object.entries(record)) {
      const next =
        key === 'span' || key === 'type'
          ? inner
          : walk(inner, scoped, arm || (record.form === 'match' && key === 'cases'))

      changed ||= next !== inner
      out[key] = next
    }

    return changed ? out : value
  }

  return walk(program, new Set(), false) as Program
}

// every variable name an expression reads, nested closures included
function namesRead(node: unknown, into = new Set<string>()): Set<string> {
  if (!node || typeof node !== 'object') {
    return into
  }

  if (Array.isArray(node)) {
    node.forEach(n => namesRead(n, into))

    return into
  }

  const record = node as Record<string, unknown>

  if (record.form === 'variable' && typeof record.name === 'string') {
    into.add(record.name)
  }

  for (const [key, value] of Object.entries(record)) {
    if (key !== 'span' && key !== 'type') {
      namesRead(value, into)
    }
  }

  return into
}

// the numeric value of an integer or float literal, for constant folding comparisons across both number kinds
function numericValue(node: Expression): number | undefined {
  if (node.form === 'integer' || node.form === 'float') {
    return Number(node.value)
  }

  return undefined
}

const COMPARISON = new Set(['==', '!=', '<', '<=', '>', '>='])

// a value the specializer treats as a known constant: a literal, or a variant / struct record whose fields are all
// constant (a nullary `make lines` is the common case)
function isConstantExpr(node: Expression): boolean {
  switch (node.form) {
    case 'integer':
    case 'float':
    case 'boolean':
    case 'string':
      return true
    case 'record':
      return node.fields.every(f => isConstantExpr(f.value))
    default:
      return false
  }
}

// only inline when every argument is pure (a literal, a constant, or a bare variable). This avoids reordering or
// dropping a side-effecting argument when a branch is pruned, so specialization stays semantics-preserving.
function isPureArg(node: Expression): boolean {
  return isConstantExpr(node) || node.form === 'variable'
}

// an expression with no observable side effect, so an unused binding of it is safe to drop. Value-constructing forms
// are pure (literals, a variable read, a field/member read, a closure literal, and aggregates of pures). A `call` or
// `await` is NOT pure: it may run effects, so its binding is kept even when unused.
function isPureExpr(node: Expression): boolean {
  switch (node.form) {
    case 'integer':
    case 'float':
    case 'boolean':
    case 'string':
    case 'null':
    case 'unit':
    case 'variable':
    case 'hole':
    case 'closure':
      return true
    case 'binary':
      return isPureExpr(node.left) && isPureExpr(node.right)
    case 'unary':
      return isPureExpr(node.operand)
    case 'array':
      return node.items.every(isPureExpr)
    case 'record':
      return node.fields.every(f => isPureExpr(f.value))
    case 'map':
      return node.entries.every(
        e => isPureExpr(e.key) && isPureExpr(e.value),
      )
    case 'member':
      return (
        isPureExpr(node.target) &&
        (!node.index || isPureExpr(node.index))
      )
    case 'conditional':
      return (
        node.branches.every(
          b => isPureExpr(b.cond) && isPureExpr(b.value),
        ) &&
        (!node.otherwise || isPureExpr(node.otherwise))
      )
    default:
      return false
  }
}

// a statement that ends control flow in its block, so any statement after it in the same block is unreachable
function isTerminator(node: Statement): boolean {
  return (
    node.form === 'return' ||
    node.form === 'break' ||
    node.form === 'continue' ||
    node.form === 'throw' ||
    node.form === 'exit'
  )
}

// ---- constant propagation ----
// A scalar literal: cheap to duplicate at every use, so it is safe to propagate. A constant record is NOT propagated,
// since copying it to several use sites would bloat the output.
function isScalarConst(node: Expression): boolean {
  switch (node.form) {
    case 'integer':
    case 'float':
    case 'boolean':
    case 'string':
    case 'null':
      return true
    default:
      return false
  }
}

// A forward pass over a function body. An immutable `let` bound (after substitution + folding) to a scalar constant is
// recorded; later reads of that name are replaced by the constant, so the folder can then reduce `x * 2` to `10`. A
// mutable binding (one that is reassigned anywhere) is never recorded, so a reassigned variable is never propagated.
// Branch and loop bodies inherit the constants known on entry (a copy); their own bindings do not leak back out. A
// nested function starts a fresh environment. The dead const-let is dropped afterward by dropDeadConstLets.
function propagateConstants(
  body: Statement[],
  env: Map<string, Expression>,
  safe: Set<string>,
  assigned: Set<string>,
): Statement[] {
  const local = new Map(env)

  return body.map(stmt =>
    propagateStatement(stmt, local, safe, assigned),
  )
}

function propagateStatement(
  node: Statement,
  env: Map<string, Expression>,
  safe: Set<string>,
  assigned: Set<string>,
): Statement {
  const sub = (e: Expression): Expression =>
    env.size > 0 ? substituteExpr(e, env) : e

  switch (node.form) {
    case 'let': {
      const init = sub(node.init)
      const folded = simplifyExpression(init)

      // `save` always mills as mutable, so the propagatable names (declared once, never reassigned) are precomputed
      // per function in `safe` rather than read off the node's mutable flag. A `safe` binding records either a scalar
      // constant (constant propagation) or a copy of a stable variable (copy propagation: the source is never
      // reassigned, so the alias is equal to it everywhere).
      if (
        safe.has(node.name) &&
        (isScalarConst(folded) ||
          (folded.form === 'variable' && !assigned.has(folded.name)))
      )
        {env.set(node.name, folded)}
      else {env.delete(node.name)}

      return { ...node, init }
    }

    case 'assign':
      // the TARGET of a write is a place, never a value: a variable there is left as written, whatever is known about
      // it. Substituted, a closure's `save total` became `0 = ...` on Swift and Kotlin (native-dom-0047). A member
      // target still substitutes its object, which is a read
      return {
        ...node,
        target: node.target.form === 'variable' ? node.target : sub(node.target),
        value: sub(node.value),
      }
    case 'return':
      return {
        ...node,
        value: node.value ? sub(node.value) : undefined,
      }
    case 'throw':
      return { ...node, value: sub(node.value) }
    case 'expression':
      return { ...node, expr: sub(node.expr) }
    case 'hold':
      return { ...node, expr: sub(node.expr) }
    case 'if':
      return {
        ...node,
        branches: node.branches.map(b => ({
          cond: sub(b.cond),
          body: propagateConstants(b.body, env, safe, assigned),
        })),
        otherwise: node.otherwise
          ? propagateConstants(node.otherwise, env, safe, assigned)
          : undefined,
      }
    case 'while':
      return {
        ...node,
        cond: sub(node.cond),
        body: propagateConstants(node.body, env, safe, assigned),
      }

    case 'guard': {
      const inner = new Map(env)

      if (node.catch) {
        inner.delete(node.catch.name)
      }

      return {
        ...node,
        body: propagateConstants(node.body, env, safe, assigned),
        ...(node.catch
          ? {
              catch: {
                ...node.catch,
                body: propagateConstants(
                  node.catch.body,
                  inner,
                  safe,
                  assigned,
                ),
              },
            }
          : {}),
      }
    }

    case 'for-each': {
      const inner = new Map(env)
      inner.delete(node.item)

      return {
        ...node,
        iterable: sub(node.iterable),
        body: propagateConstants(node.body, inner, safe, assigned),
      }
    }

    case 'match':
      return {
        ...node,
        subject: sub(node.subject),
        cases: node.cases.map(c => ({
          ...c,
          body: propagateConstants(c.body, env, safe, assigned),
        })),
        otherwise: node.otherwise
          ? propagateConstants(node.otherwise, env, safe, assigned)
          : undefined,
      }

    case 'function': {
      // a nested function is its own scope: a fresh environment and its own binding facts
      const facts = bindingFacts(node.body)

      return {
        ...node,
        body: keepWritten(
          node,
          dropDeadBindings(
            propagateConstants(
              node.body,
              new Map(),
              facts.safe,
              facts.assigned,
            ),
            facts.safe,
          ),
        ),
      }
    }

    default:
      return node
  }
}

// the names in a function body that are safe to treat as constants: declared by exactly one `let` and never the target
// of an `assign`, counted across the whole body (nested scopes included, so the over-approximation only ever keeps a
// binding, never wrongly drops one). `save` always mills as mutable, so this is how propagation decides what is fixed.
function bindingFacts(body: Statement[]): {
  safe: Set<string>
  assigned: Set<string>
} {
  const letCount = new Map<string, number>()
  const assigned = new Set<string>()

  // a closure anywhere in a statement's expressions (an effect body, a callback) writes the same variables: its
  // `save` of an outer name is an `assign` the scan has to see, or the name reads as never reassigned and its first
  // value is propagated over the write (native-dom-0047). Scanning a closure-local `let` more than once only makes it
  // look reassigned, which keeps it, the safe direction
  const closuresIn = (value: unknown): void => {
    if (!value || typeof value !== 'object') {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(closuresIn)

      return
    }

    const node = value as { form?: string; body?: Statement[] }

    if (node.form === 'closure' && Array.isArray(node.body)) {
      scan(node.body)

      return
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'span' && key !== 'type') {
        closuresIn(child)
      }
    }
  }

  const scan = (stmts: Statement[]): void => {
    for (const s of stmts) {
      closuresIn(s)

      switch (s.form) {
        case 'let':
          letCount.set(s.name, (letCount.get(s.name) ?? 0) + 1)
          break
        case 'assign':
          if (s.target.form === 'variable') {assigned.add(s.target.name)}

          break
        case 'if':
          s.branches.forEach(b => scan(b.body))

          if (s.otherwise) {scan(s.otherwise)}

          break
        case 'guard':
          scan(s.body)

          if (s.catch) {
            scan(s.catch.body)
          }

          break
        case 'while':
        case 'for-each':
        case 'function':
          scan(s.body)
          break
        case 'match':
          s.cases.forEach(c => scan(c.body))

          if (s.otherwise) {scan(s.otherwise)}

          break
        default:
          break
      }
    }
  }

  scan(body)

  // A record is a VALUE (D1): `save d, read c` then `save d/count, 7` writes d's copy and leaves c as it was. A field
  // write does not reassign the name, so the rule above saw both as fixed and propagated `c` for `d`, and the write
  // reached `c` on every backend (codegen-performance-0028). The base of a field write is treated as reassigned: never
  // propagated, nor propagated into. A list slot is not a field: lists are references on every backend today, so
  // propagating a list alias is exact (codegen-performance-0032)
  for (const name of fieldWritten(body)) {
    assigned.add(name)
  }

  const safe = new Set<string>()

  for (const [name, count] of letCount)
    {if (count === 1 && !assigned.has(name)) {safe.add(name)}}

  return { safe, assigned }
}

// the names whose record fields some assignment writes: the base of `save x/f, ...` and `save x/f/g, ...`, never of a
// list slot
function fieldWritten(body: Statement[]): Set<string> {
  const found = new Set<string>()

  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(visit)

      return
    }

    const node = value as Statement

    if (node.form === 'assign' && node.target.form === 'member') {
      let at: Expression = node.target
      let field = true

      while (at.form === 'member') {
        if (at.index !== undefined || /^\d+$/.test(at.name)) {
          field = false
        }

        at = at.target
      }

      if (field && at.form === 'variable') {
        found.add(at.name)
      }
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'span' && key !== 'type') {
        visit(child)
      }
    }
  }

  visit(body)

  return found
}

// collect every variable name read anywhere in an expression (descending into closures)
function collectReadNames(
  node: Expression | undefined,
  into: Set<string>,
): void {
  if (!node) {return}

  switch (node.form) {
    case 'variable':
      into.add(node.name)
      break
    case 'binary':
      collectReadNames(node.left, into)
      collectReadNames(node.right, into)
      break
    case 'unary':
      collectReadNames(node.operand, into)
      break
    case 'call':
      collectReadNames(node.callee, into)
      node.args.forEach(a => collectReadNames(a, into))
      break
    case 'array':
      node.items.forEach(i => collectReadNames(i, into))
      break
    case 'map':
      node.entries.forEach(e => {
        collectReadNames(e.key, into)
        collectReadNames(e.value, into)
      })
      break
    case 'record':
      node.fields.forEach(f => collectReadNames(f.value, into))
      break
    case 'member':
      collectReadNames(node.target, into)

      // a DYNAMIC segment (`read m/{at}`) reads its index variable: missing this, dead-binding elimination
      // dropped `let at1` while `m[at1]` still read it (md5's word assembly lost three bindings silently)
      if (node.index) {
        collectReadNames(node.index, into)
      }

      break
    case 'await':
      collectReadNames(node.expr, into)
      break
    case 'template':
      for (const part of node.parts) {
        if (typeof part !== 'string') {
          collectReadNames(part, into)
        }
      }

      break
    case 'conditional':
      node.branches.forEach(b => {
        collectReadNames(b.cond, into)
        collectReadNames(b.value, into)
      })
      collectReadNames(node.otherwise, into)
      break
    case 'closure':
      collectReadsInBody(node.body, into)
      break
    default:
      break
  }
}

function collectReadsInBody(
  body: Statement[],
  into: Set<string>,
): void {
  for (const s of body) {
    switch (s.form) {
      case 'let':
        collectReadNames(s.init, into)
        break
      case 'assign':
        collectReadNames(s.target, into)
        collectReadNames(s.value, into)
        break
      case 'expression':
        collectReadNames(s.expr, into)
        break
      case 'return':
        collectReadNames(s.value, into)
        break
      case 'throw':
        collectReadNames(s.value, into)
        break
      case 'hold':
        collectReadNames(s.expr, into)
        break
      case 'while':
        collectReadNames(s.cond, into)
        collectReadsInBody(s.body, into)
        break
      case 'guard':
        collectReadsInBody(s.body, into)

        if (s.catch) {
          collectReadsInBody(s.catch.body, into)
        }

        break
      case 'for-each':
        collectReadNames(s.iterable, into)
        collectReadsInBody(s.body, into)
        break
      case 'if':
        s.branches.forEach(b => {
          collectReadNames(b.cond, into)
          collectReadsInBody(b.body, into)
        })

        if (s.otherwise) {collectReadsInBody(s.otherwise, into)}

        break
      case 'match':
        collectReadNames(s.subject, into)
        s.cases.forEach(c => collectReadsInBody(c.body, into))

        if (s.otherwise) {collectReadsInBody(s.otherwise, into)}

        break
      case 'function':
        collectReadsInBody(s.body, into)
        break
      default:
        break
    }
  }
}

// dead-binding elimination: a `let x = <pure init>` whose name is read nowhere is dead (its init has no effect, so it
// can go). This covers both a constant whose every use was substituted away and an ordinary unused pure binding. A
// name read in any scope keeps every binding of that name (conservative but sound). The `safe` gate (declared once,
// never reassigned) prevents removing a binding that a later `assign` needs. A `call` / `await` init is not pure, so
// its binding is kept even when unused. Recurses into nested bodies.
function dropDeadBindings(
  body: Statement[],
  safe: Set<string>,
): Statement[] {
  const reads = new Set<string>()
  collectReadsInBody(body, reads)

  const prune = (stmts: Statement[]): Statement[] => {
    const out: Statement[] = []

    for (const s of stmts) {
      if (
        s.form === 'let' &&
        safe.has(s.name) &&
        isPureExpr(s.init) &&
        !reads.has(s.name)
      )
        {continue}

      if (s.form === 'if')
        {out.push({
          ...s,
          branches: s.branches.map(b => ({
            cond: b.cond,
            body: prune(b.body),
          })),
          otherwise: s.otherwise ? prune(s.otherwise) : undefined,
        })}
      else if (s.form === 'while')
        {out.push({ ...s, body: prune(s.body) })}
      else if (s.form === 'for-each')
        {out.push({ ...s, body: prune(s.body) })}
      else if (s.form === 'match')
        {out.push({
          ...s,
          cases: s.cases.map(c => ({
            ...c,
            body: prune(c.body),
          })),
          otherwise: s.otherwise ? prune(s.otherwise) : undefined,
        })}
      else if (s.form === 'function')
        {out.push({ ...s, body: keepWritten(s, prune(s.body)) })}
      else {out.push(s)}
    }

    return out
  }

  return prune(body)
}

// A BODY THE SOURCE WROTE NEVER COMES OUT EMPTY. The native backends read an empty body as a signature-only declaration
// and emit the not-implemented trap in it, so a task written as a no-op (`save skip, code 0`, the abstract page's
// `push-path`) lost its one dead binding here and crashed a macOS app with "stub: push-path". A written body this pass
// empties keeps a bare `return`: still nothing, and no longer mistaken for nothing written (native-navigation-0007)
function keepWritten(written: Extract<Statement, { form: 'function' }>, body: Statement[]): Statement[] {
  return body.length === 0 && written.body.length > 0 ? [{ form: 'return', span: written.span }] : body
}

// a function whose result type is a collection currency (list / map / set), which the backend boxes into a reference
// wrapper at the function boundary. Inlining or specializing such a function away would drop that boxing.
function wrapsCollection(
  fn: Extract<Statement, { form: 'function' }>,
): boolean {
  return fn.result?.kind === 'array' || fn.result?.kind === 'map'
}

// a function the call specializer may inline at a constant argument: its body must be a single statement that can
// reduce to one value once the constant is known. A single `send back <expr>` always qualifies (a forwarder, a
// convenience form, or a `fork test` verb whose dispatch is a value-position `conditional`). A single `fork case` (an
// enum verb) qualifies too: once the constant variant reaches the subject, foldMatchOnConstant collapses the match to
// the chosen arm, which is itself a single `send back`. Async and collection-wrapping functions are never inlined (a
// caller awaits the former, and the backend boxes the latter at the function boundary).
function specializableBody(
  fn: Extract<Statement, { form: 'function' }>,
): Statement[] | undefined {
  if (fn.async) {
    return undefined
  }

  if (wrapsCollection(fn)) {
    return undefined
  }

  if (fn.body.length !== 1) {
    return undefined
  }

  const only = fn.body[0]!

  if (only.form === 'return' && only.value) {
    return fn.body
  }

  if (only.form === 'match') {
    return fn.body
  }

  return undefined
}

// A task the inliner may replace by its value at any call whose arguments are pure (a literal or a bare variable):
// its body is one `send back <expr>` of at most 16 nodes. With pure arguments, substituting them changes neither what
// is evaluated nor its order, and the expression is small enough that copying it costs less than the call. Left out,
// each for a reason the backends give:
//   - async, and a list or map result: the caller awaits the first, and a backend boxes the second at the boundary
//   - an `unknown` or `dynamic` result or parameter: Rust boxes those at the boundary, which inlining would skip
//   - generics: the expression's types mention the task's type parameters, which mean nothing at the caller
function smallBody(fn: Extract<Statement, { form: 'function' }>): Expression | undefined {
  const only = fn.body.length === 1 ? fn.body[0]! : undefined

  if (!only || only.form !== 'return' || !only.value || fn.async || wrapsCollection(fn)) {
    return undefined
  }

  const loose = (t: Type | undefined): boolean => t?.kind === 'unknown' || t?.kind === 'dynamic'

  if (loose(fn.result) || fn.params.some(p => loose(p.type)) || (fn.generics?.length ?? 0) > 0) {
    return undefined
  }

  // the size, and no type variable anywhere in the expression's types
  let nodes = 0
  let generic = false
  const seen = new Set<object>()
  const measure = (value: unknown, inType: boolean): void => {
    if (typeof value !== 'object' || value === null || seen.has(value)) {
      return
    }

    seen.add(value)

    if (Array.isArray(value)) {
      value.forEach(v => measure(v, inType))

      return
    }

    const node = value as { form?: string; kind?: string }

    if (inType && node.kind === 'variable') {
      generic = true
    }

    if (!inType && node.form) {
      nodes++
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'span') {
        measure(child, inType || key === 'type')
      }
    }
  }

  measure(only.value, false)

  return nodes <= 16 && !generic ? only.value : undefined
}

// substitute parameter variables with their argument expressions when inlining a specializable function body. The
// stdlib verbs reference only their parameters and globals, so a free-variable substitution is sound. A closure that
// rebinds a parameter name shadows it, so that name is dropped from the substitution before descending.
function substituteExpr(
  node: Expression,
  subst: Map<string, Expression>,
): Expression {
  switch (node.form) {
    case 'variable':
      return subst.get(node.name) ?? node
    case 'binary':
      return {
        ...node,
        left: substituteExpr(node.left, subst),
        right: substituteExpr(node.right, subst),
      }
    case 'unary':
      return { ...node, operand: substituteExpr(node.operand, subst) }
    case 'call':
      return {
        ...node,
        callee: substituteExpr(node.callee, subst),
        args: node.args.map(a => substituteExpr(a, subst)),
      }
    case 'array':
      return {
        ...node,
        items: node.items.map(i => substituteExpr(i, subst)),
      }
    case 'member':
      return {
        ...node,
        target: substituteExpr(node.target, subst),
        ...(node.index
          ? { index: substituteExpr(node.index, subst) }
          : {}),
      }
    case 'record':
      return {
        ...node,
        fields: node.fields.map(f => ({
          name: f.name,
          value: substituteExpr(f.value, subst),
        })),
      }
    case 'map':
      return {
        ...node,
        entries: node.entries.map(e => ({
          key: substituteExpr(e.key, subst),
          value: substituteExpr(e.value, subst),
        })),
      }
    case 'await':
      return { ...node, expr: substituteExpr(node.expr, subst) }
    case 'template':
      return { ...node, parts: node.parts.map(part => (typeof part === 'string' ? part : substituteExpr(part, subst))) }
    case 'conditional':
      return {
        ...node,
        branches: node.branches.map(b => ({
          cond: substituteExpr(b.cond, subst),
          value: substituteExpr(b.value, subst),
        })),
        otherwise: node.otherwise
          ? substituteExpr(node.otherwise, subst)
          : undefined,
      }

    case 'closure': {
      const inner = new Map(subst)

      for (const p of node.params) {
        inner.delete(p.name)
      }

      return {
        ...node,
        body: node.body.map(s => substituteStmt(s, inner)),
      }
    }

    default:
      return node
  }
}

function substituteStmt(
  node: Statement,
  subst: Map<string, Expression>,
): Statement {
  const body = (b: Statement[]) => b.map(s => substituteStmt(s, subst))

  switch (node.form) {
    case 'let':
      return { ...node, init: substituteExpr(node.init, subst) }
    case 'assign':
      return {
        ...node,
        target: substituteExpr(node.target, subst),
        value: substituteExpr(node.value, subst),
      }
    case 'expression':
      return { ...node, expr: substituteExpr(node.expr, subst) }
    case 'return':
      return {
        ...node,
        value: node.value
          ? substituteExpr(node.value, subst)
          : undefined,
      }
    case 'throw':
      return { ...node, value: substituteExpr(node.value, subst) }
    case 'while':
      return {
        ...node,
        cond: substituteExpr(node.cond, subst),
        body: body(node.body),
      }
    case 'guard':
      return {
        ...node,
        body: body(node.body),
        ...(node.catch
          ? { catch: { ...node.catch, body: body(node.catch.body) } }
          : {}),
      }
    case 'for-each':
      return {
        ...node,
        iterable: substituteExpr(node.iterable, subst),
        body: body(node.body),
      }
    case 'if':
      return {
        ...node,
        branches: node.branches.map(b => ({
          cond: substituteExpr(b.cond, subst),
          body: body(b.body),
        })),
        otherwise: node.otherwise ? body(node.otherwise) : undefined,
      }
    case 'match':
      return {
        ...node,
        subject: substituteExpr(node.subject, subst),
        cases: node.cases.map(c => ({
          ...c,
          body: body(c.body),
        })),
        otherwise: node.otherwise ? body(node.otherwise) : undefined,
      }
    case 'hold':
      return { ...node, expr: substituteExpr(node.expr, subst) }
    default:
      return node
  }
}

function simplifyExpression(node: Expression): Expression {
  switch (node.form) {
    case 'binary': {
      const left = simplifyExpression(node.left)
      const right = simplifyExpression(node.right)

      // comparison of two numeric literals (integer or float) folds to a boolean. This is what lets a constant-selector
      // dispatch like `is-equal(base, 2.0)` reduce, so the specializer can pick a branch.
      if (COMPARISON.has(node.op)) {
        const lv = numericValue(left)
        const rv = numericValue(right)

        if (lv !== undefined && rv !== undefined) {
          const folded = foldArithmetic(node.op, lv, rv)

          if (folded) {
            return {
              ...folded,
              form: folded.kind,
              span: node.span,
            } as Expression
          }
        }
      }

      // boolean comparison against a literal: `x == true` -> x, `x == false` -> !x, and the `!=` duals. This collapses
      // the common `is-equal(flag, wave true/false)` shape (the test DSL's want / lack guards lower to exactly this).
      if (node.op === '==' || node.op === '!=') {
        const negate = (e: Expression): Expression =>
          simplifyExpression({
            form: 'unary',
            op: '!',
            operand: e,
            span: node.span,
          })

        if (isBool(right, true)) {
          return node.op === '==' ? left : negate(left)
        }

        if (isBool(right, false)) {
          return node.op === '==' ? negate(left) : left
        }

        if (isBool(left, true)) {
          return node.op === '==' ? right : negate(right)
        }

        if (isBool(left, false)) {
          return node.op === '==' ? negate(right) : right
        }
      }

      // constant folding
      if (left.form === 'integer' && right.form === 'integer') {
        const folded = foldArithmetic(
          node.op,
          Number(left.value),
          Number(right.value),
        )

        if (folded) {
          return {
            ...folded,
            form: folded.kind,
            span: node.span,
          } as Expression
        }
      }

      // algebraic identities
      switch (node.op) {
        case '+':
          if (isInteger(right, 0)) {
            return left
          }

          if (isInteger(left, 0)) {
            return right
          }

          break
        case '-':
          if (isInteger(right, 0)) {
            return left
          }

          break
        case '*':
          if (isInteger(right, 1)) {
            return left
          }

          if (isInteger(left, 1)) {
            return right
          }

          if (isInteger(right, 0) || isInteger(left, 0)) {
            return { form: 'integer', value: 0, span: node.span }
          }

          break
        case '/':
          if (isInteger(right, 1)) {
            return left
          }

          break
        case '&&':
          // x && true -> x, true && x -> x. false && x -> false (x is not evaluated). x && false -> false only when x
          // is pure, since x's left-operand effects would otherwise be lost.
          if (isBool(right, true)) {
            return left
          }

          if (isBool(left, true)) {
            return right
          }

          if (isBool(left, false)) {
            return { form: 'boolean', value: false, span: node.span }
          }

          if (isBool(right, false) && isPureExpr(left)) {
            return { form: 'boolean', value: false, span: node.span }
          }

          // idempotence and absorption over pure operands: `x && x` -> x, `x && (x || y)` -> x, `(x || y) && x` -> x.
          // Both sides pure makes the implied duplicate / drop / reorder sound (no effect is added or lost; y is
          // never observed in either form). Catches forms the greedy literal rules above miss across nesting.
          if (isPureExpr(left) && isPureExpr(right)) {
            if (expressionsEqual(left, right)) {
              return left
            }

            if (
              right.form === 'binary' &&
              right.op === '||' &&
              (expressionsEqual(left, right.left) ||
                expressionsEqual(left, right.right))
            ) {
              return left
            }

            if (
              left.form === 'binary' &&
              left.op === '||' &&
              (expressionsEqual(right, left.left) ||
                expressionsEqual(right, left.right))
            ) {
              return right
            }
          }

          break
        case '||':
          // x || false -> x, false || x -> x. true || x -> true (x is not evaluated). x || true -> true only when x
          // is pure.
          if (isBool(right, false)) {
            return left
          }

          if (isBool(left, false)) {
            return right
          }

          if (isBool(left, true)) {
            return { form: 'boolean', value: true, span: node.span }
          }

          if (isBool(right, true) && isPureExpr(left)) {
            return { form: 'boolean', value: true, span: node.span }
          }

          // idempotence and absorption (dual of `&&`): `x || x` -> x, `x || (x && y)` -> x, `(x && y) || x` -> x.
          if (isPureExpr(left) && isPureExpr(right)) {
            if (expressionsEqual(left, right)) {
              return left
            }

            if (
              right.form === 'binary' &&
              right.op === '&&' &&
              (expressionsEqual(left, right.left) ||
                expressionsEqual(left, right.right))
            ) {
              return left
            }

            if (
              left.form === 'binary' &&
              left.op === '&&' &&
              (expressionsEqual(right, left.left) ||
                expressionsEqual(right, left.right))
            ) {
              return right
            }
          }

          break
        default:
          break
      }

      // the greedy rules above are local peepholes; hand the assembled `+` / `-` / `*` tree to the e-graph so
      // reassociation across levels (`(x + 3) + 4` -> `x + 7`) and `x - x` -> 0 are caught too. Returns the node
      // unchanged unless the e-graph finds a strictly smaller, provably equivalent form.
      return egraphArith({ ...node, left, right })
    }

    case 'unary': {
      const operand = simplifyExpression(node.operand)

      if (node.op === '!') {
        // !true -> false, !false -> true
        if (operand.form === 'boolean') {
          return {
            form: 'boolean',
            value: !operand.value,
            span: node.span,
          }
        }

        // !!x -> x
        if (operand.form === 'unary' && operand.op === '!') {
          return operand.operand
        }

        // !(a == b) -> a != b, !(a < b) -> a >= b, ...
        if (
          operand.form === 'binary' &&
          NEGATED_COMPARE[operand.op] !== undefined
        ) {
          return {
            ...operand,
            op: NEGATED_COMPARE[operand.op]! as typeof operand.op,
          }
        }
      }

      return { ...node, operand }
    }

    case 'call': {
      const callee = simplifyExpression(node.callee)
      let args = node.args.map(simplifyExpression)

      // specialization: inline a specializable function when an argument is a known constant, then fold. Only when
      // every argument is pure (a constant or a bare variable), so no side-effecting argument is reordered or dropped
      // when a branch is pruned. The cycle guard stops a recursive verb from looping the pass. A callee the caller binds
      // itself (a parameter typed as a task, a `let`) is that binding and not the task of its name: `group-by` calls
      // its `key-of` parameter, and a program with a task called `key-of` had it inlined in the parameter's place
      if (callee.form === 'variable' && !callerBound.has(callee.name)) {
        const fn = specializable.get(callee.name)

        if (
          fn?.params.length === args.length &&
          args.some(isConstantExpr) &&
          args.every(isPureArg) &&
          !inlining.has(callee.name)
        ) {
          const subst = new Map<string, Expression>()
          fn.params.forEach((p, i) => subst.set(p.name, args[i]!))
          inlining.add(callee.name)

          // substitute the constant into the whole body and simplify: a value-position `send back` folds to its value,
          // an enum verb's `fork case` folds to the chosen arm. If the body collapses to a single `send back <expr>`,
          // that expr is the inlined value; otherwise the verb does not reduce to one expression here (a multi-statement
          // arm, a non-constant subject), so the call is left intact.
          const reduced = simplifyBody(
            fn.body.map(s => substituteStmt(s, subst)),
          )

          inlining.delete(callee.name)

          const sole = reduced.length === 1 ? reduced[0]! : undefined

          if (sole?.form === 'return' && sole.value) {
            return sole.value
          }
        }

        // a small one-expression task, inlined at a call whose arguments are all pure: the value with the arguments
        // substituted for the parameters. Not where a name the body reads, other than its own parameters, is bound by
        // the caller, which would capture it
        const tiny = small.get(callee.name)

        // a trailing `need false` number left out is the 0 every backend passes for it, written in, so the call inlines
        // like any other: `index-of(s, <de>)` was a call where `index-of(s, <de>, 0)` reached the text's own search
        const missing = tiny ? tiny.params.slice(args.length) : []

        if (
          missing.length &&
          missing.every(p => p.optional && !p.fallback && p.type?.kind === 'number')
        ) {
          args = [
            ...args,
            ...missing.map(p => ({ form: 'integer', value: 0, span: node.span, type: p.type }) as Expression),
          ]
        }

        // an argument computed with no effect (`modulo(i, size)`) is taken too when its parameter is read exactly once,
        // so nothing is computed twice, and every other argument is a constant or a variable, so nothing else runs
        // before it: fasta's `char-at(alu, modulo(i, size))` was a call per character it built
        const readOnce = (name: string): boolean => {
          let count = 0
          const walk = (value: unknown): void => {
            if (typeof value !== 'object' || value === null) {
              return
            }

            if (Array.isArray(value)) {
              value.forEach(walk)

              return
            }

            const node = value as { form?: string; name?: string }

            if (node.form === 'variable' && node.name === name) {
              count++
            }

            for (const [key, child] of Object.entries(node)) {
              if (key !== 'type' && key !== 'span') {
                walk(child)
              }
            }
          }

          walk(tiny!.value)

          return count === 1
        }
        const computed = tiny ? args.filter(a => !isPureArg(a)) : []
        const takes =
          tiny !== undefined &&
          (computed.length === 0 ||
            (computed.length === 1 &&
              isPureExpr(computed[0]!) &&
              readOnce(tiny.params[args.indexOf(computed[0]!)]!.name)))

        if (
          tiny &&
          tiny.params.length === args.length &&
          takes &&
          !inlining.has(callee.name)
        ) {
          const own = new Set(tiny.params.map(p => p.name))
          const captured = [...namesRead(tiny.value)].some(name => !own.has(name) && callerBound.has(name))

          if (!captured) {
            const subst = new Map<string, Expression>()
            tiny.params.forEach((p, i) => subst.set(p.name, args[i]!))
            inlining.add(callee.name)
            // a COPY per call site: facts are keyed by node identity, and an emitter may rename a node it visits, so
            // two sites must never share one
            const value = simplifyExpression(substituteExpr(structuredClone(tiny.value), subst))
            inlining.delete(callee.name)

            return value
          }
        }
      }

      return { ...node, callee, args }
    }

    case 'array':
      return { ...node, items: node.items.map(simplifyExpression) }
    case 'member':
      return {
        ...node,
        target: simplifyExpression(node.target),
        ...(node.index
          ? { index: simplifyExpression(node.index) }
          : {}),
      }
    case 'record':
      return {
        ...node,
        fields: node.fields.map(f => ({
          name: f.name,
          value: simplifyExpression(f.value),
        })),
      }
    case 'map':
      return {
        ...node,
        entries: node.entries.map(e => ({
          key: simplifyExpression(e.key),
          value: simplifyExpression(e.value),
        })),
      }

    case 'conditional': {
      // prune branches whose condition folded to a constant: a false branch is unreachable and dropped, and a true
      // branch wins (later branches and the otherwise become unreachable). A leading true branch collapses the whole
      // conditional to its value.
      const branches: { cond: Expression; value: Expression }[] = []

      let decided = false

      for (const b of node.branches) {
        const cond = simplifyExpression(b.cond)

        if (cond.form === 'boolean' && cond.value === false) {
          continue
        }

        const value = simplifyExpression(b.value)

        if (cond.form === 'boolean' && cond.value === true) {
          if (branches.length === 0) {
            return value
          }

          branches.push({ cond, value })
          decided = true
          break
        }

        branches.push({ cond, value })
      }

      const otherwise = decided
        ? undefined
        : node.otherwise
          ? simplifyExpression(node.otherwise)
          : undefined

      if (branches.length === 0) {
        return otherwise ?? node
      }

      return { ...node, branches, otherwise }
    }

    // a template's parts are expressions like any other: unvisited, a call inside one (`<{line}{char-at(alu, i)}>`) was
    // never folded nor inlined, so fasta called the stdlib's one-line `char-at` wrapper once per character it built
    // and a part that is itself a template (a small task answering one, inlined into another's) is spliced in, its parts
    // read in the same order, so the text is built once: two `format!`s nested was clippy's format_in_format_args
    case 'template': {
      const parts: (typeof node.parts)[number][] = []

      for (const part of node.parts) {
        const simplified = typeof part === 'string' ? part : simplifyExpression(part)
        const spliced = typeof simplified !== 'string' && simplified.form === 'template' ? simplified.parts : [simplified]

        for (const piece of spliced) {
          const last = parts.length - 1

          if (typeof piece === 'string' && typeof parts[last] === 'string') {
            parts[last] = `${parts[last]}${piece}`
          } else {
            parts.push(piece)
          }
        }
      }

      return { ...node, parts }
    }

    default:
      return node
  }
}

function simplifyBody(body: Statement[]): Statement[] {
  const out = body.flatMap(simplifyStatementSplice)
  // drop unreachable statements after the first terminator in this block (dead code after a return / break / throw)
  const terminator = out.findIndex(isTerminator)

  return terminator >= 0 ? out.slice(0, terminator + 1) : out
}

// most statements simplify in place to a single statement; a `match` (a `fork case`) whose subject folded to a constant
// nullary variant selects its case at compile time, splicing that case's body into the parent list and dropping the
// rest (the enum analog of constant `if`-branch pruning). A nullary variant binds no payload, so the splice is a pure
// substitution. The constant case never matched by any label falls to `otherwise`.
function simplifyStatementSplice(node: Statement): Statement[] {
  if (node.form !== 'match') {
    return [simplifyStatement(node)]
  }

  const subject = simplifyExpression(node.subject)

  if (
    subject.form === 'record' &&
    subject.fields.length === 0 &&
    isConstantExpr(subject)
  ) {
    const chosen = node.cases.find(c => c.label === subject.name)

    return simplifyBody(chosen ? chosen.body : (node.otherwise ?? []))
  }

  return [
    {
      ...node,
      subject,
      cases: node.cases.map(c => ({
        ...c,
        body: simplifyBody(c.body),
      })),
      otherwise: node.otherwise
        ? simplifyBody(node.otherwise)
        : undefined,
    },
  ]
}

function simplifyStatement(node: Statement): Statement {
  switch (node.form) {
    case 'let':
      return { ...node, init: simplifyExpression(node.init) }
    case 'assign':
      return {
        ...node,
        target: simplifyExpression(node.target),
        value: simplifyExpression(node.value),
      }
    case 'expression':
      return { ...node, expr: simplifyExpression(node.expr) }
    case 'return':
      return {
        ...node,
        value: node.value ? simplifyExpression(node.value) : undefined,
      }
    case 'while':
      return {
        ...node,
        cond: simplifyExpression(node.cond),
        body: simplifyBody(node.body),
      }
    case 'guard':
      return {
        ...node,
        body: simplifyBody(node.body),
        ...(node.catch
          ? { catch: { ...node.catch, body: simplifyBody(node.catch.body) } }
          : {}),
      }
    case 'for-each':
      return {
        ...node,
        iterable: simplifyExpression(node.iterable),
        body: simplifyBody(node.body),
      }
    case 'if':
      return {
        ...node,
        branches: node.branches.map(b => ({
          cond: simplifyExpression(b.cond),
          body: simplifyBody(b.body),
        })),
        otherwise: node.otherwise
          ? simplifyBody(node.otherwise)
          : undefined,
      }
    case 'function': {
      // the names this function binds, so a small task's body is not inlined where one of them would capture a name
      // the body means as its own (see the call case)
      const outer = callerBound
      callerBound = boundNames(node)
      const body = simplifyBody(node.body)
      callerBound = outer

      return { ...node, body }
    }
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
function forwarderTarget(
  fn: Extract<Statement, { form: 'function' }>,
): Expression | undefined {
  // never inline an async forwarder. Its callers `await` it, so it must stay a real future. Inlining it would replace
  // the call with the inner (often synchronous) call while the caller's `await` remains, which the strict backends
  // reject (rust: "String is not a future"). Node tolerates `await` on a non-promise, which masked this before.
  if (fn.async) {
    return undefined
  }

  // never inline a forwarder whose result is a collection currency. The backend boxes a raw host collection into its
  // reference wrapper (swift SeedList / SeedMap, rust Rc<RefCell<Vec>>) at the function boundary, so inlining the
  // wrapper away leaves a raw host array where the wrapped currency type is expected.
  if (wrapsCollection(fn)) {
    return undefined
  }

  if (fn.body.length !== 1) {
    return undefined
  }

  const ret = fn.body[0]!

  if (ret.form !== 'return' || ret.value?.form !== 'call') {
    return undefined
  }

  const call = ret.value

  if (call.args.length !== fn.params.length) {
    return undefined
  }

  for (let i = 0; i < fn.params.length; i++) {
    const arg = call.args[i]!

    if (arg.form !== 'variable' || arg.name !== fn.params[i]!.name) {
      return undefined
    }
  }

  if (call.callee.form === 'variable' && call.callee.name !== fn.name) {
    return call.callee
  }

  if (call.callee.form === 'member') {
    return call.callee
  }

  return undefined
}

function rewriteExpression(
  node: Expression,
  forwarders: Map<string, Expression>,
): Expression {
  switch (node.form) {
    case 'binary':
      return {
        ...node,
        left: rewriteExpression(node.left, forwarders),
        right: rewriteExpression(node.right, forwarders),
      }
    case 'unary':
      return {
        ...node,
        operand: rewriteExpression(node.operand, forwarders),
      }

    case 'call': {
      let callee = rewriteExpression(node.callee, forwarders)

      const args = node.args.map(a => rewriteExpression(a, forwarders))
      // collapse a chain of wrappers in one pass, guarding against a forwarder cycle
      const seen = new Set<string>()

      while (
        callee.form === 'variable' &&
        forwarders.has(callee.name) &&
        !seen.has(callee.name)
      ) {
        seen.add(callee.name)
        callee = forwarders.get(callee.name)!
      }

      return { ...node, callee, args }
    }

    case 'array':
      return {
        ...node,
        items: node.items.map(i => rewriteExpression(i, forwarders)),
      }
    case 'member':
      return {
        ...node,
        target: rewriteExpression(node.target, forwarders),
        ...(node.index
          ? { index: rewriteExpression(node.index, forwarders) }
          : {}),
      }
    case 'record':
      return {
        ...node,
        fields: node.fields.map(f => ({
          name: f.name,
          value: rewriteExpression(f.value, forwarders),
        })),
      }
    case 'map':
      return {
        ...node,
        entries: node.entries.map(e => ({
          key: rewriteExpression(e.key, forwarders),
          value: rewriteExpression(e.value, forwarders),
        })),
      }
    case 'await':
      return { ...node, expr: rewriteExpression(node.expr, forwarders) }
    case 'template':
      return { ...node, parts: node.parts.map(part => (typeof part === 'string' ? part : rewriteExpression(part, forwarders))) }
    case 'closure':
      return {
        ...node,
        body: node.body.map(s => rewriteStatement(s, forwarders)),
      }
    case 'conditional':
      return {
        ...node,
        branches: node.branches.map(b => ({
          cond: rewriteExpression(b.cond, forwarders),
          value: rewriteExpression(b.value, forwarders),
        })),
        otherwise: node.otherwise
          ? rewriteExpression(node.otherwise, forwarders)
          : undefined,
      }
    default:
      return node
  }
}

function rewriteStatement(
  node: Statement,
  forwarders: Map<string, Expression>,
): Statement {
  const body = (b: Statement[]) =>
    b.map(s => rewriteStatement(s, forwarders))

  switch (node.form) {
    case 'let':
      return { ...node, init: rewriteExpression(node.init, forwarders) }
    case 'assign':
      return {
        ...node,
        target: rewriteExpression(node.target, forwarders),
        value: rewriteExpression(node.value, forwarders),
      }
    case 'expression':
      return { ...node, expr: rewriteExpression(node.expr, forwarders) }
    case 'return':
      return {
        ...node,
        value: node.value
          ? rewriteExpression(node.value, forwarders)
          : undefined,
      }
    case 'throw':
      return {
        ...node,
        value: rewriteExpression(node.value, forwarders),
      }
    case 'while':
      return {
        ...node,
        cond: rewriteExpression(node.cond, forwarders),
        body: body(node.body),
      }
    case 'guard':
      return {
        ...node,
        body: body(node.body),
        ...(node.catch
          ? { catch: { ...node.catch, body: body(node.catch.body) } }
          : {}),
      }
    case 'for-each':
      return {
        ...node,
        iterable: rewriteExpression(node.iterable, forwarders),
        body: body(node.body),
      }
    case 'if':
      return {
        ...node,
        branches: node.branches.map(b => ({
          cond: rewriteExpression(b.cond, forwarders),
          body: body(b.body),
        })),
        otherwise: node.otherwise ? body(node.otherwise) : undefined,
      }
    case 'match':
      return {
        ...node,
        subject: rewriteExpression(node.subject, forwarders),
        cases: node.cases.map(c => ({
          ...c,
          body: body(c.body),
        })),
        otherwise: node.otherwise ? body(node.otherwise) : undefined,
      }
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
function countReferences(
  node: Expression,
  counts: Map<string, number>,
): void {
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
      node.args.forEach(a => countReferences(a, counts))
      break
    case 'array':
      node.items.forEach(i => countReferences(i, counts))
      break
    case 'member':
      countReferences(node.target, counts)

      if (node.index) {
        countReferences(node.index, counts)
      }

      break
    case 'record':
      node.fields.forEach(f => countReferences(f.value, counts))
      break
    case 'map':
      node.entries.forEach(e => {
        countReferences(e.key, counts)
        countReferences(e.value, counts)
      })
      break
    case 'await':
      countReferences(node.expr, counts)
      break
    case 'template':
      for (const part of node.parts) {
        if (typeof part !== 'string') {
          countReferences(part, counts)
        }
      }

      break
    case 'closure':
      node.body.forEach(s => countReferencesStatement(s, counts))
      break
    case 'conditional':
      node.branches.forEach(b => {
        countReferences(b.cond, counts)
        countReferences(b.value, counts)
      })

      if (node.otherwise) {
        countReferences(node.otherwise, counts)
      }

      break
    default:
      break
  }
}

function countReferencesStatement(
  node: Statement,
  counts: Map<string, number>,
): void {
  const body = (b: Statement[]) =>
    b.forEach(s => countReferencesStatement(s, counts))

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
      if (node.value) {
        countReferences(node.value, counts)
      }

      break
    case 'throw':
      countReferences(node.value, counts)
      break
    case 'while':
      countReferences(node.cond, counts)
      body(node.body)
      break
    case 'guard':
      body(node.body)

      if (node.catch) {
        body(node.catch.body)
      }

      break
    case 'for-each':
      countReferences(node.iterable, counts)
      body(node.body)
      break
    case 'if':
      node.branches.forEach(b => {
        countReferences(b.cond, counts)
        body(b.body)
      })

      if (node.otherwise) {
        body(node.otherwise)
      }

      break
    case 'match':
      countReferences(node.subject, counts)
      node.cases.forEach(c => body(c.body))

      if (node.otherwise) {
        body(node.otherwise)
      }

      break
    case 'hold':
      countReferences(node.expr, counts)
      break
    case 'function':
      body(node.body)
      break
    case 'view':
      // the render-runtime ABI emitZone will synthesize, plus the user expressions inside the view tree
      for (const name of VIEW_RUNTIME) {
        counts.set(name, (counts.get(name) ?? 0) + 1)
      }

      countReferencesZone(node.body, counts)
      break
    default:
      break
  }
}

// count name references inside a zone's view tree (attribute / event / read / save / fork / walk expressions) so a
// user helper used only from a zone is not mistaken for dead code
function countReferencesZone(
  nodes: ViewNode[],
  counts: Map<string, number>,
): void {
  for (const node of nodes) {
    switch (node.form) {
      case 'element':
        for (const attribute of node.attributes) {
          countReferences(attribute.value, counts)
        }

        for (const prop of node.props) {
          countReferences(prop.value, counts)
        }

        countReferencesZone(node.children, counts)
        break
      case 'read':
        countReferences(node.value, counts)
        break
      case 'save':
        countReferences(node.value, counts)
        break
      case 'fork':
        for (const branch of node.branches) {
          countReferences(branch.cond, counts)
          countReferencesZone(branch.body, counts)
        }

        if (node.otherwise) {
          countReferencesZone(node.otherwise, counts)
        }

        break
      case 'walk':
        countReferences(node.iterable, counts)
        countReferencesZone(node.body, counts)
        break
      case 'text':
      case 'slot':
        break
    }
  }
}

// the variable a forwarder's target starts from: `job` for `job.state`, `abs` for `abs`
function rootOf(node: Expression): string | undefined {
  if (node.form === 'variable') {
    return node.name
  }

  if (node.form === 'member') {
    return rootOf(node.target)
  }

  return undefined
}

// every case's field names, by case name across every form (coarse: two forms naming a case alike pool their
// fields, which only blocks more inlining). Set by `simplify`
let caseFields = new Map<string, Set<string>>()

// every name a function binds anywhere in its body, nested closures included: parameters, `let`s, loop items and
// indexes, an arm's fields and a handler's caught value. Coarse on purpose: a name bound anywhere in the function
// blocks an inlining that could be captured by it
function boundNames(fn: Extract<Statement, { form: 'function' }>): Set<string> {
  const names = new Set<string>(fn.params.map(p => p.name))
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') {
      return
    }

    if (Array.isArray(node)) {
      node.forEach(visit)

      return
    }

    const record = node as Record<string, unknown>

    if (record.form === 'let' && typeof record.name === 'string') {
      names.add(record.name)
    }

    if (record.form === 'for-each') {
      if (typeof record.item === 'string') {
        names.add(record.item)
      }

      if (typeof record.index === 'string') {
        names.add(record.index)
      }
    }

    if (record.form === 'closure' && Array.isArray(record.params)) {
      for (const p of record.params as { name: string }[]) {
        names.add(p.name)
      }
    }

    // a match arm binds its variant's fields, renamed or not, and an arm over a caught exception binds every shared
    // field and prop by name: an inlined `time.now()` (the stdlib's `exception-time`) inside an arm that binds the
    // caught exception's `time` read the number, on Swift and Kotlin (2026-10-04)
    if (record.form === 'match' && Array.isArray(record.cases)) {
      const arms = record.exceptionArms as Record<string, { shared: string[]; link: string[] }> | undefined

      for (const c of record.cases as { label: string; binds?: string[] }[]) {
        // an arm's `link` lines name what it binds; without them it binds the case's fields by their own names
        const own = c.binds?.length ? [] : [...(caseFields.get(c.label) ?? [])]

        for (const name of [...(c.binds ?? []), ...own, ...(arms?.[c.label]?.shared ?? []), ...(arms?.[c.label]?.link ?? [])]) {
          names.add(name)
        }
      }
    }

    // and a handler binds the caught value
    if (record.form === 'guard') {
      const caught = (record.catch as { name?: string } | undefined)?.name

      if (caught) {
        names.add(caught)
      }
    }

    for (const [key, value] of Object.entries(record)) {
      if (key !== 'span' && key !== 'type') {
        visit(value)
      }
    }
  }

  visit(fn.body)

  return names
}

// `roots` are the entry module's public functions: kept even when unreferenced. Only internal (imported) wrappers are
// eligible to be dropped once their calls are inlined away.
function inlineForwarders(
  program: Program,
  roots?: Set<string>,
): Program {
  const forwarders = new Map<string, Expression>()

  for (const node of program) {
    if (node.form === 'function') {
      const target = forwarderTarget(node)

      if (target) {
        forwarders.set(node.name, target)
      }
    }
  }

  if (forwarders.size === 0) {
    return program
  }

  // HYGIENE. Inlining puts the forwarder's target, written in the WRAPPER's scope, into the caller's. When the target
  // starts with a name the caller binds itself (a parameter, a `let`, a loop variable), the caller's binding captures
  // it: `gather`'s loop variable `job` turned an inlined `job.state(dock)`, meant for the runtime object `job`, into a
  // call on the loop's handle. Such a call keeps its wrapper, which then keeps its definition through the reference
  const rewritten = program.map(s => {
    if (s.form !== 'function') {
      return rewriteStatement(s, forwarders)
    }

    // and a forwarder whose own name the caller binds is not reached by that name there at all
    const bound = boundNames(s)
    const visible = new Map([...forwarders].filter(([name, target]) => !bound.has(name) && !bound.has(rootOf(target) ?? '')))

    return rewriteStatement(s, visible.size === forwarders.size ? forwarders : visible)
  })
  const counts = new Map<string, number>()

  for (const s of rewritten) {
    countReferencesStatement(s, counts)
  }

  // drop wrapper definitions whose calls were all inlined away (no remaining reference) and that are not public roots
  return rewritten.filter(
    n =>
      !(
        n.form === 'function' &&
        forwarders.has(n.name) &&
        (counts.get(n.name) ?? 0) === 0 &&
        !roots?.has(n.name)
      ),
  )
}

// drop ambient host globals (`host document, name <document>` -> a foreign-aliased `let`) that nothing references.
// A generated binding package declares hundreds of host globals; importing one interface pulls them all in. Emitting
// an unused `const window = Window` is dead weight, and worse, a binding whose name shadows a real global of a
// different case (`const document = Document`) would mask the genuine global. Keeping only the referenced ones is a
// pure win and removes the shadow.
function dropUnusedHostGlobals(program: Program): Program {
  const counts = new Map<string, number>()

  for (const s of program) {
    countReferencesStatement(s, counts)
  }

  // a function of the same name is the real binding for that name; drop the host global so it does not redeclare it
  // (bind's `Event` global vs the framework's `event` render helper). Also drop host globals nothing references.
  const functionNames = new Set(
    program
      .filter(n => n.form === 'function')
      .map((n: any) => n.name as string),
  )

  return program.filter(
    n =>
      !(
        n.form === 'let' &&
        n.foreign !== undefined &&
        ((counts.get(n.name) ?? 0) === 0 || functionNames.has(n.name))
      ),
  )
}

// drop specializable functions (forwarders, convenience forms, verbs) that no longer have any reference after inlining
// and specialization, so a fully-unwrapped verb leaves no dead definition behind. Iterate to a fixpoint: a function
// used only by another now-dead function becomes dead next round. Entry roots are always kept.
function dropDeadFunctions(
  program: Program,
  droppable: Set<string>,
  roots?: Set<string>,
): Program {
  let current = program

  for (;;) {
    const counts = new Map<string, number>()

    for (const s of current) {
      countReferencesStatement(s, counts)
    }

    const next = current.filter(
      n =>
        !(
          n.form === 'function' &&
          droppable.has(n.name) &&
          (counts.get(n.name) ?? 0) === 0 &&
          !roots?.has(n.name)
        ),
    )

    if (next.length === current.length) {
      return next
    }

    current = next
  }
}

// run the simplifier over a whole program: collapse pass-through wrappers, drop unused host globals, fold constants and
// identities, specialize constant-selector verbs to their native branch, and drop the verbs that fully unwrapped away.
export function simplify(
  program: Program,
  roots?: Set<string>,
): Program {
  // every case's fields, which an arm with no `link` lines binds by their own names (see `boundNames`)
  caseFields = new Map()

  for (const node of program) {
    if (node.form === 'record-type') {
      for (const variant of node.variants) {
        caseFields.set(variant.name, new Set([...(caseFields.get(variant.name) ?? []), ...variant.fields.map(f => f.name)]))
      }
    }
  }

  // an interpolation that reads only module constants is filled here, at compile time, before propagation can
  // make a local look constant too (see `fillTemplates`)
  const inlined = fillTemplates(
    dropUnusedHostGlobals(inlineForwarders(program, roots)),
  )

  // constant propagation: substitute scalar constants forward through each function body, then drop the now-dead
  // bindings, so the folder below can reduce expressions that depend on a named constant (`x = 5; x * 2` -> `10`)
  const propagated = inlined.map(node =>
    node.form === 'function'
      ? propagateStatement(node, new Map(), new Set(), new Set())
      : node,
  )

  // collect the functions the call specializer may inline at a constant argument (value-position returns and enum verbs)
  specializable = new Map()

  for (const node of propagated) {
    if (node.form === 'function') {
      const body = specializableBody(node)

      if (body) {
        specializable.set(node.name, {
          params: node.params,
          body,
        })
      }
    }
  }

  // and the small one-expression tasks inlined at any call with pure arguments
  small = new Map()

  for (const node of propagated) {
    // a specializable task may be small as well: the specializer tries a constant argument first, and this covers the
    // calls it does not reduce
    if (node.form === 'function') {
      const value = smallBody(node)

      if (value) {
        small.set(node.name, { params: node.params, value })
      }
    }
  }

  inlining = new Set()

  const folded = propagated.map(simplifyStatement)
  const droppable = new Set([...specializable.keys(), ...small.keys()])
  specializable = new Map()
  small = new Map()
  inlining = new Set()

  // then the small tasks of statements over a recursive form, inlined where their call is a statement, a `let`'s value
  // or an argument of such a call (ir/inline-statements.ts). One inlined everywhere is dropped like any task above, but
  // only when the roots are known: without them anything may call it
  const statements = inlineStatements(folded)

  for (const name of roots ? statements.inlined : []) {
    droppable.add(name)
  }

  return dropDeadFunctions(statements.program, droppable, roots)
}
