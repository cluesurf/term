// The first IR transformation pass: a mid-level simplifier over the compile AST. Constant folding and algebraic
// identities, so the emitted code is leaner. This is the start of the IR pipeline (see
// note/research/vibe/computation/plans/05-ir.md); more passes (CFG, monomorphization, Perceus reuse) layer on.
// Pure and browser-safe.

import type {
  Expression,
  Program,
  Statement,
  ZoneNode,
} from '@/code/compile/node'

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

// ---- specialization state ----
// the verbs and convenience forms that collapse at a constant selector: a function whose body is a single `send back`
// of one expression (a forwarder, a convenience form, or a verb whose dispatch is a value-position `fork test`). Set
// once per `simplify()` run, read by the call specializer. See plans/20-specialization-and-bind.md.
let specializable: Map<
  string,
  { params: Array<{ name: string }>, body: Array<Statement> }
> = new Map()
// the names currently being inlined on this path, to break a recursive verb cycle
let inlining: Set<string> = new Set()

// the numeric value of an integer or float literal, for constant folding comparisons across both number kinds
function numericValue(node: Expression): number | undefined {
  if (node.form === 'integer' || node.form === 'float')
    return Number(node.value)
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
): Array<Statement> | undefined {
  if (fn.async) return undefined
  if (wrapsCollection(fn)) return undefined
  if (fn.body.length !== 1) return undefined
  const only = fn.body[0]!
  if (only.form === 'return' && only.value) return fn.body
  if (only.form === 'match') return fn.body
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
      return { ...node, items: node.items.map(i => substituteExpr(i, subst)) }
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
      for (const p of node.params) inner.delete(p.name)
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
  const body = (b: Array<Statement>) => b.map(s => substituteStmt(s, subst))
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
        value: node.value ? substituteExpr(node.value, subst) : undefined,
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
        cases: node.cases.map(c => ({ label: c.label, body: body(c.body) })),
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
            return { ...folded, form: folded.kind, span: node.span } as Expression
        }
      }

      // constant folding
      if (left.form === 'integer' && right.form === 'integer') {
        const folded = foldArithmetic(
          node.op,
          Number(left.value),
          Number(right.value),
        )
        if (folded)
          return {
            ...folded,
            form: folded.kind,
            span: node.span,
          } as Expression
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
          if (isInteger(right, 0) || isInteger(left, 0))
            return { form: 'integer', value: 0, span: node.span }
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
    case 'call': {
      const callee = simplifyExpression(node.callee)
      const args = node.args.map(simplifyExpression)
      // specialization: inline a specializable function when an argument is a known constant, then fold. Only when
      // every argument is pure (a constant or a bare variable), so no side-effecting argument is reordered or dropped
      // when a branch is pruned. The cycle guard stops a recursive verb from looping the pass.
      if (callee.form === 'variable') {
        const fn = specializable.get(callee.name)
        if (
          fn &&
          fn.params.length === args.length &&
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
          if (sole && sole.form === 'return' && sole.value) {
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
      const branches: Array<{ cond: Expression; value: Expression }> = []
      let decided = false
      for (const b of node.branches) {
        const cond = simplifyExpression(b.cond)
        if (cond.form === 'boolean' && cond.value === false) continue
        const value = simplifyExpression(b.value)
        if (cond.form === 'boolean' && cond.value === true) {
          if (branches.length === 0) return value
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
      if (branches.length === 0) return otherwise ?? node
      return { ...node, branches, otherwise }
    }
    default:
      return node
  }
}

function simplifyBody(body: Array<Statement>): Array<Statement> {
  return body.flatMap(simplifyStatementSplice)
}

// most statements simplify in place to a single statement; a `match` (a `fork case`) whose subject folded to a constant
// nullary variant selects its case at compile time, splicing that case's body into the parent list and dropping the
// rest (the enum analog of constant `if`-branch pruning). A nullary variant binds no payload, so the splice is a pure
// substitution. The constant case never matched by any label falls to `otherwise`.
function simplifyStatementSplice(node: Statement): Array<Statement> {
  if (node.form !== 'match') return [simplifyStatement(node)]
  const subject = simplifyExpression(node.subject)
  if (
    subject.form === 'record' &&
    subject.fields.length === 0 &&
    isConstantExpr(subject)
  ) {
    const chosen = node.cases.find(c => c.label === subject.name)
    return simplifyBody(chosen ? chosen.body : node.otherwise ?? [])
  }
  return [
    {
      ...node,
      subject,
      cases: node.cases.map(c => ({
        label: c.label,
        body: simplifyBody(c.body),
      })),
      otherwise: node.otherwise ? simplifyBody(node.otherwise) : undefined,
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
  if (fn.async) return undefined
  // never inline a forwarder whose result is a collection currency. The backend boxes a raw host collection into its
  // reference wrapper (swift SeedList / SeedMap, rust Rc<RefCell<Vec>>) at the function boundary, so inlining the
  // wrapper away leaves a raw host array where the wrapped currency type is expected.
  if (wrapsCollection(fn)) return undefined
  if (fn.body.length !== 1) return undefined
  const ret = fn.body[0]!
  if (ret.form !== 'return' || !ret.value || ret.value.form !== 'call')
    return undefined
  const call = ret.value
  if (call.args.length !== fn.params.length) return undefined
  for (let i = 0; i < fn.params.length; i++) {
    const arg = call.args[i]!
    if (arg.form !== 'variable' || arg.name !== fn.params[i]!.name)
      return undefined
  }
  if (call.callee.form === 'variable' && call.callee.name !== fn.name)
    return call.callee
  if (call.callee.form === 'member') return call.callee
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
  const body = (b: Array<Statement>) =>
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
      if (node.otherwise) countReferences(node.otherwise, counts)
      break
    default:
      break
  }
}

function countReferencesStatement(
  node: Statement,
  counts: Map<string, number>,
): void {
  const body = (b: Array<Statement>) =>
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
      node.branches.forEach(b => {
        countReferences(b.cond, counts)
        body(b.body)
      })
      if (node.otherwise) body(node.otherwise)
      break
    case 'match':
      countReferences(node.subject, counts)
      node.cases.forEach(c => body(c.body))
      if (node.otherwise) body(node.otherwise)
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
        counts.set(name, (counts.get(name) ?? 0) + 1)
      countReferencesZone(node.body, counts)
      break
    default:
      break
  }
}

// count name references inside a zone's view tree (attribute / event / read / save / fork / walk expressions) so a
// user helper used only from a zone is not mistaken for dead code
function countReferencesZone(
  nodes: Array<ZoneNode>,
  counts: Map<string, number>,
): void {
  for (const node of nodes) {
    switch (node.form) {
      case 'element':
        for (const attribute of node.attributes)
          countReferences(attribute.value, counts)
        for (const prop of node.props) countReferences(prop.value, counts)
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
        if (node.otherwise) countReferencesZone(node.otherwise, counts)
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
      if (target) forwarders.set(node.name, target)
    }
  }
  if (forwarders.size === 0) return program
  const rewritten = program.map(s => rewriteStatement(s, forwarders))
  const counts = new Map<string, number>()
  for (const s of rewritten) countReferencesStatement(s, counts)
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
  for (const s of program) countReferencesStatement(s, counts)
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
    for (const s of current) countReferencesStatement(s, counts)
    const next = current.filter(
      n =>
        !(
          n.form === 'function' &&
          droppable.has(n.name) &&
          (counts.get(n.name) ?? 0) === 0 &&
          !roots?.has(n.name)
        ),
    )
    if (next.length === current.length) return next
    current = next
  }
}

// run the simplifier over a whole program: collapse pass-through wrappers, drop unused host globals, fold constants and
// identities, specialize constant-selector verbs to their native branch, and drop the verbs that fully unwrapped away.
export function simplify(
  program: Program,
  roots?: Set<string>,
): Program {
  const inlined = dropUnusedHostGlobals(inlineForwarders(program, roots))
  // collect the functions the call specializer may inline at a constant argument (value-position returns and enum verbs)
  specializable = new Map()
  for (const node of inlined)
    if (node.form === 'function') {
      const body = specializableBody(node)
      if (body)
        specializable.set(node.name, {
          params: node.params,
          body,
        })
    }
  inlining = new Set()
  const folded = inlined.map(simplifyStatement)
  const droppable = new Set(specializable.keys())
  specializable = new Map()
  inlining = new Set()
  return dropDeadFunctions(folded, droppable, roots)
}
