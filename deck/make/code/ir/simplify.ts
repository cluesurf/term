// The first IR transformation pass: a mid-level simplifier over the compile AST. Constant folding and algebraic
// identities, so the emitted code is leaner. This is the start of the IR pipeline (see
// note/research/vibe/computation/plans/05-ir.md); more passes (CFG, monomorphization, Perceus reuse) layer on.
// Pure and browser-safe.

import type {
  Expression,
  Program,
  Statement,
  ZoneNode,
} from '@cluesurf/make/code/compile/node'
import { egraphArith } from '@cluesurf/make/code/ir/egraph-arith'
import { expressionsEqual } from '@cluesurf/make/code/compile/expr-equal'

// the render + reactive runtime primitives emitZone (code/compile/typescript.ts) synthesizes as raw calls in a zone's
// output. They never appear as call nodes in the AST, so reference-counting cannot see them. When a program contains
// any zone, treat this fixed ABI as referenced so neither forwarder-inlining nor specialization drops a single-return
// member of it (`element` / `text` / `make-signal`).
const ZONE_RUNTIME = [
  'element',
  'text',
  'dynamic',
  'attribute',
  'event',
  'append',
  'show',
  'each',
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
  switch (op) {
    case '+':
      return { kind: 'integer', value: a + b }
    case '-':
      return { kind: 'integer', value: a - b }
    case '*':
      return { kind: 'integer', value: a * b }
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

// the numeric value of an integer or float literal, for constant folding comparisons across both number kinds
function numericValue(node: Expression): number | undefined {
  if (node.form === 'integer' || node.form === 'float')
    {return Number(node.value)}

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
      return isPureExpr(node.target)
    case 'conditional':
      return (
        node.branches.every(
          b => isPureExpr(b.cond) && isPureExpr(b.value),
        ) && (!node.otherwise || isPureExpr(node.otherwise))
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
  body: Array<Statement>,
  env: Map<string, Expression>,
  safe: Set<string>,
  assigned: Set<string>,
): Array<Statement> {
  const local = new Map(env)
  return body.map(stmt => propagateStatement(stmt, local, safe, assigned))
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
        env.set(node.name, folded)
      else env.delete(node.name)
      return { ...node, init }
    }
    case 'assign':
      return { ...node, target: sub(node.target), value: sub(node.value) }
    case 'return':
      return { ...node, value: node.value ? sub(node.value) : undefined }
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
          label: c.label,
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
        body: dropDeadBindings(
          propagateConstants(
            node.body,
            new Map(),
            facts.safe,
            facts.assigned,
          ),
          facts.safe,
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
function bindingFacts(body: Array<Statement>): {
  safe: Set<string>
  assigned: Set<string>
} {
  const letCount = new Map<string, number>()
  const assigned = new Set<string>()
  const scan = (stmts: Array<Statement>): void => {
    for (const s of stmts) {
      switch (s.form) {
        case 'let':
          letCount.set(s.name, (letCount.get(s.name) ?? 0) + 1)
          break
        case 'assign':
          if (s.target.form === 'variable') assigned.add(s.target.name)
          break
        case 'if':
          s.branches.forEach(b => scan(b.body))
          if (s.otherwise) scan(s.otherwise)
          break
        case 'while':
        case 'for-each':
        case 'function':
          scan(s.body)
          break
        case 'match':
          s.cases.forEach(c => scan(c.body))
          if (s.otherwise) scan(s.otherwise)
          break
        default:
          break
      }
    }
  }
  scan(body)
  const safe = new Set<string>()
  for (const [name, count] of letCount)
    if (count === 1 && !assigned.has(name)) safe.add(name)
  return { safe, assigned }
}

// collect every variable name read anywhere in an expression (descending into closures)
function collectReadNames(
  node: Expression | undefined,
  into: Set<string>,
): void {
  if (!node) return
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
      break
    case 'await':
      collectReadNames(node.expr, into)
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
  body: Array<Statement>,
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
      case 'for-each':
        collectReadNames(s.iterable, into)
        collectReadsInBody(s.body, into)
        break
      case 'if':
        s.branches.forEach(b => {
          collectReadNames(b.cond, into)
          collectReadsInBody(b.body, into)
        })
        if (s.otherwise) collectReadsInBody(s.otherwise, into)
        break
      case 'match':
        collectReadNames(s.subject, into)
        s.cases.forEach(c => collectReadsInBody(c.body, into))
        if (s.otherwise) collectReadsInBody(s.otherwise, into)
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
  body: Array<Statement>,
  safe: Set<string>,
): Array<Statement> {
  const reads = new Set<string>()
  collectReadsInBody(body, reads)
  const prune = (stmts: Array<Statement>): Array<Statement> => {
    const out: Array<Statement> = []
    for (const s of stmts) {
      if (
        s.form === 'let' &&
        safe.has(s.name) &&
        isPureExpr(s.init) &&
        !reads.has(s.name)
      )
        continue
      if (s.form === 'if')
        out.push({
          ...s,
          branches: s.branches.map(b => ({
            cond: b.cond,
            body: prune(b.body),
          })),
          otherwise: s.otherwise ? prune(s.otherwise) : undefined,
        })
      else if (s.form === 'while') out.push({ ...s, body: prune(s.body) })
      else if (s.form === 'for-each')
        out.push({ ...s, body: prune(s.body) })
      else if (s.form === 'match')
        out.push({
          ...s,
          cases: s.cases.map(c => ({
            label: c.label,
            body: prune(c.body),
          })),
          otherwise: s.otherwise ? prune(s.otherwise) : undefined,
        })
      else if (s.form === 'function')
        out.push({ ...s, body: prune(s.body) })
      else out.push(s)
    }
    return out
  }
  return prune(body)
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
  if (fn.async) {return undefined}

  if (wrapsCollection(fn)) {return undefined}

  if (fn.body.length !== 1) {return undefined}

  const only = fn.body[0]!

  if (only.form === 'return' && only.value) {return fn.body}

  if (only.form === 'match') {return fn.body}

  return undefined
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
      return { ...node, target: substituteExpr(node.target, subst) }
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

      for (const p of node.params) {inner.delete(p.name)}

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
  const body = (b: Statement[]) =>
    b.map(s => substituteStmt(s, subst))

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
          label: c.label,
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

          if (folded)
            {return {
              ...folded,
              form: folded.kind,
              span: node.span,
            } as Expression}
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
        if (isBool(right, true))
          {return node.op === '==' ? left : negate(left)}
        if (isBool(right, false))
          {return node.op === '==' ? negate(left) : left}
        if (isBool(left, true))
          {return node.op === '==' ? right : negate(right)}
        if (isBool(left, false))
          {return node.op === '==' ? negate(right) : right}
      }

      // constant folding
      if (left.form === 'integer' && right.form === 'integer') {
        const folded = foldArithmetic(
          node.op,
          Number(left.value),
          Number(right.value),
        )

        if (folded)
          {return {
            ...folded,
            form: folded.kind,
            span: node.span,
          } as Expression}
      }

      // algebraic identities
      switch (node.op) {
        case '+':
          if (isInteger(right, 0)) {return left}

          if (isInteger(left, 0)) {return right}

          break
        case '-':
          if (isInteger(right, 0)) {return left}

          break
        case '*':
          if (isInteger(right, 1)) {return left}

          if (isInteger(left, 1)) {return right}

          if (isInteger(right, 0) || isInteger(left, 0))
            {return { form: 'integer', value: 0, span: node.span }}

          break
        case '/':
          if (isInteger(right, 1)) {return left}

          break
        case '&&':
          // x && true -> x, true && x -> x. false && x -> false (x is not evaluated). x && false -> false only when x
          // is pure, since x's left-operand effects would otherwise be lost.
          if (isBool(right, true)) {return left}
          if (isBool(left, true)) {return right}
          if (isBool(left, false))
            {return { form: 'boolean', value: false, span: node.span }}
          if (isBool(right, false) && isPureExpr(left))
            {return { form: 'boolean', value: false, span: node.span }}
          // idempotence and absorption over pure operands: `x && x` -> x, `x && (x || y)` -> x, `(x || y) && x` -> x.
          // Both sides pure makes the implied duplicate / drop / reorder sound (no effect is added or lost; y is
          // never observed in either form). Catches forms the greedy literal rules above miss across nesting.
          if (isPureExpr(left) && isPureExpr(right)) {
            if (expressionsEqual(left, right)) {return left}

            if (
              right.form === 'binary' &&
              right.op === '||' &&
              (expressionsEqual(left, right.left) ||
                expressionsEqual(left, right.right))
            )
              {return left}

            if (
              left.form === 'binary' &&
              left.op === '||' &&
              (expressionsEqual(right, left.left) ||
                expressionsEqual(right, left.right))
            )
              {return right}
          }
          break
        case '||':
          // x || false -> x, false || x -> x. true || x -> true (x is not evaluated). x || true -> true only when x
          // is pure.
          if (isBool(right, false)) {return left}
          if (isBool(left, false)) {return right}
          if (isBool(left, true))
            {return { form: 'boolean', value: true, span: node.span }}
          if (isBool(right, true) && isPureExpr(left))
            {return { form: 'boolean', value: true, span: node.span }}
          // idempotence and absorption (dual of `&&`): `x || x` -> x, `x || (x && y)` -> x, `(x && y) || x` -> x.
          if (isPureExpr(left) && isPureExpr(right)) {
            if (expressionsEqual(left, right)) {return left}

            if (
              right.form === 'binary' &&
              right.op === '&&' &&
              (expressionsEqual(left, right.left) ||
                expressionsEqual(left, right.right))
            )
              {return left}

            if (
              left.form === 'binary' &&
              left.op === '&&' &&
              (expressionsEqual(right, left.left) ||
                expressionsEqual(right, left.right))
            )
              {return right}
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
        if (operand.form === 'boolean')
          {return { form: 'boolean', value: !operand.value, span: node.span }}
        // !!x -> x
        if (operand.form === 'unary' && operand.op === '!')
          {return operand.operand}
        // !(a == b) -> a != b, !(a < b) -> a >= b, ...
        if (
          operand.form === 'binary' &&
          NEGATED_COMPARE[operand.op] !== undefined
        )
          {return {
            ...operand,
            op: NEGATED_COMPARE[operand.op]! as typeof operand.op,
          }}
      }
      return { ...node, operand }
    }

    case 'call': {
      const callee = simplifyExpression(node.callee)
      const args = node.args.map(simplifyExpression)

      // specialization: inline a specializable function when an argument is a known constant, then fold. Only when
      // every argument is pure (a constant or a bare variable), so no side-effecting argument is reordered or dropped
      // when a branch is pruned. The cycle guard stops a recursive verb from looping the pass.
      if (callee.form === 'variable') {
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
      }

      return { ...node, callee, args }
    }

    case 'array':
      return { ...node, items: node.items.map(simplifyExpression) }
    case 'member':
      return { ...node, target: simplifyExpression(node.target) }
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
      const branches: { cond: Expression; value: Expression }[] =
        []

      let decided = false

      for (const b of node.branches) {
        const cond = simplifyExpression(b.cond)

        if (cond.form === 'boolean' && cond.value === false) {continue}

        const value = simplifyExpression(b.value)

        if (cond.form === 'boolean' && cond.value === true) {
          if (branches.length === 0) {return value}

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

      if (branches.length === 0) {return otherwise ?? node}

      return { ...node, branches, otherwise }
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
  if (node.form !== 'match') {return [simplifyStatement(node)]}

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
        label: c.label,
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
function forwarderTarget(
  fn: Extract<Statement, { form: 'function' }>,
): Expression | undefined {
  // never inline an async forwarder. Its callers `await` it, so it must stay a real future. Inlining it would replace
  // the call with the inner (often synchronous) call while the caller's `await` remains, which the strict backends
  // reject (rust: "String is not a future"). Node tolerates `await` on a non-promise, which masked this before.
  if (fn.async) {return undefined}

  // never inline a forwarder whose result is a collection currency. The backend boxes a raw host collection into its
  // reference wrapper (swift SeedList / SeedMap, rust Rc<RefCell<Vec>>) at the function boundary, so inlining the
  // wrapper away leaves a raw host array where the wrapped currency type is expected.
  if (wrapsCollection(fn)) {return undefined}

  if (fn.body.length !== 1) {return undefined}

  const ret = fn.body[0]!

  if (ret.form !== 'return' || ret.value?.form !== 'call')
    {return undefined}

  const call = ret.value

  if (call.args.length !== fn.params.length) {return undefined}

  for (let i = 0; i < fn.params.length; i++) {
    const arg = call.args[i]!

    if (arg.form !== 'variable' || arg.name !== fn.params[i]!.name)
      {return undefined}
  }

  if (call.callee.form === 'variable' && call.callee.name !== fn.name)
    {return call.callee}

  if (call.callee.form === 'member') {return call.callee}

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
          label: c.label,
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
    case 'closure':
      node.body.forEach(s => countReferencesStatement(s, counts))
      break
    case 'conditional':
      node.branches.forEach(b => {
        countReferences(b.cond, counts)
        countReferences(b.value, counts)
      })

      if (node.otherwise) {countReferences(node.otherwise, counts)}

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
      if (node.value) {countReferences(node.value, counts)}

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
      node.branches.forEach(b => {
        countReferences(b.cond, counts)
        body(b.body)
      })

      if (node.otherwise) {body(node.otherwise)}

      break
    case 'match':
      countReferences(node.subject, counts)
      node.cases.forEach(c => body(c.body))

      if (node.otherwise) {body(node.otherwise)}

      break
    case 'hold':
      countReferences(node.expr, counts)
      break
    case 'function':
      body(node.body)
      break
    case 'zone':
      // the render-runtime ABI emitZone will synthesize, plus the user expressions inside the view tree
      for (const name of ZONE_RUNTIME)
        {counts.set(name, (counts.get(name) ?? 0) + 1)}

      countReferencesZone(node.body, counts)
      break
    default:
      break
  }
}

// count name references inside a zone's view tree (attribute / event / read / save / fork / walk expressions) so a
// user helper used only from a zone is not mistaken for dead code
function countReferencesZone(
  nodes: ZoneNode[],
  counts: Map<string, number>,
): void {
  for (const node of nodes) {
    switch (node.form) {
      case 'element':
        for (const attribute of node.attributes)
          {countReferences(attribute.value, counts)}

        for (const prop of node.props)
          {countReferences(prop.value, counts)}

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

        if (node.otherwise) {countReferencesZone(node.otherwise, counts)}

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

      if (target) {forwarders.set(node.name, target)}
    }
  }

  if (forwarders.size === 0) {return program}

  const rewritten = program.map(s => rewriteStatement(s, forwarders))
  const counts = new Map<string, number>()

  for (const s of rewritten) {countReferencesStatement(s, counts)}

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

  for (const s of program) {countReferencesStatement(s, counts)}

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

    for (const s of current) {countReferencesStatement(s, counts)}

    const next = current.filter(
      n =>
        !(
          n.form === 'function' &&
          droppable.has(n.name) &&
          (counts.get(n.name) ?? 0) === 0 &&
          !roots?.has(n.name)
        ),
    )

    if (next.length === current.length) {return next}

    current = next
  }
}

// run the simplifier over a whole program: collapse pass-through wrappers, drop unused host globals, fold constants and
// identities, specialize constant-selector verbs to their native branch, and drop the verbs that fully unwrapped away.
export function simplify(
  program: Program,
  roots?: Set<string>,
): Program {
  const inlined = dropUnusedHostGlobals(
    inlineForwarders(program, roots),
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

  for (const node of propagated)
    {if (node.form === 'function') {
      const body = specializableBody(node)

      if (body)
        {specializable.set(node.name, {
          params: node.params,
          body,
        })}
    }}

  inlining = new Set()

  const folded = propagated.map(simplifyStatement)
  const droppable = new Set(specializable.keys())
  specializable = new Map()
  inlining = new Set()

  return dropDeadFunctions(folded, droppable, roots)
}
