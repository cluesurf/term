import type {
  Expression,
  Type,
  Statement,
} from '@term/make/code/compile/node'

// `keys` / `values` on a map type are stdlib operations that must materialize a list, not return a native iterator.
// Each backend handles the iterator -> list conversion in its own idiom (Array.from, .cloned().collect(), Array(...),
// .toList()), but they all detect the same shape here: a call whose callee is `<map>.keys` or `<map>.values`. Returns
// the receiver expression and the operation name, or undefined when the callee is not a map keys/values access.
export function mapCollect(
  callee: Expression,
): { target: Expression; name: 'keys' | 'values' } | undefined {
  if (
    callee.form === 'member' &&
    callee.target.type?.kind === 'map' &&
    (callee.name === 'keys' || callee.name === 'values')
  ) {
    return { target: callee.target, name: callee.name }
  }

  return undefined
}

// ---- native collection operations ----
// The stdlib `hash` / `list` forms are written against the JS collection API (`map.set`, `map.has`, `array.push`, ...).
// On a typed backend that vocabulary does not exist verbatim, so each backend lowers these operations to its own
// platform idiom. The shape is detected once here, by the receiver's TYPE (a map or an array), and the operation name.
// The receiver type means a user struct with a field called `set` or `size` never matches.
export type CollectionOp = {
  target: Expression
  op: string
  kind: 'map' | 'array'
}

const MAP_METHODS = new Set([
  'has',
  'get',
  'set',
  'delete',
  'keys',
  'values',
])

const ARRAY_METHODS = new Set([
  'push',
  'pop',
  'at',
  'get',
  'set',
  'includes',
  'indexOf',
  'lastIndexOf',
  'concat',
  'slice',
  'toReversed',
  'join',
  'map',
  'filter',
  'some',
  'every',
  'reduce',
  'findIndex',
  'flat',
  'shift',
  'unshift',
  'splice',
])

// the extra trait the element type needs for an array op that goes beyond `Clone`: equality (`includes` / `indexOf`)
// or string rendering (`join`). A backend reads this to constrain the element generic of a method that uses the op.
export const ARRAY_OP_BOUND: Record<string, 'eq' | 'display'> = {
  includes: 'eq',
  indexOf: 'eq',
  lastIndexOf: 'eq',
  join: 'display',
}

// a native collection METHOD CALL (`map.set(k, v)`, `array.push(x)`) on a map/array receiver
export function collectionCall(
  callee: Expression,
): CollectionOp | undefined {
  if (callee.form !== 'member') {
    return undefined
  }

  const kind = callee.target.type?.kind

  if (kind === 'map' && MAP_METHODS.has(callee.name)) {
    return { target: callee.target, op: callee.name, kind: 'map' }
  }

  if (kind === 'array' && ARRAY_METHODS.has(callee.name)) {
    return { target: callee.target, op: callee.name, kind: 'array' }
  }

  return undefined
}

// the host string methods the stdlib's `text.tree` delegates to (`call value/char-at` is JavaScript's `charAt`), so
// a native backend renders each in its own string API instead of emitting a method the platform does not have.
// The semantics are JavaScript's: an index past the end reads as empty, `indexOf` gives -1, `split` on an empty
// delimiter gives the characters, `replace` touches the first match and `replaceAll` every one.
const STRING_METHODS = new Set([
  'charAt',
  'at',
  'charCodeAt',
  'indexOf',
  'lastIndexOf',
  'split',
  'substring',
  'slice',
  'toLowerCase',
  'toUpperCase',
  'startsWith',
  'endsWith',
  'trim',
  'trimStart',
  'trimEnd',
  'padStart',
  'padEnd',
  'replace',
  'replaceAll',
  'includes',
  'repeat',
  'concat',
  // not a JavaScript method: the stdlib's code-point comparison (`ordering/from-texts`), -1, 0 or 1
  'compare',
])

export type StringOp = { target: Expression; op: string }

// the member name as the host spells it: the stdlib writes `call value/char-at`, the JavaScript method is `charAt`
function hostMethod(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

// a native string METHOD CALL (`value.charAt(i)`) on a text receiver
// is the value a text? The primitive, or the stdlib's `text` form named as such
export function isText(type: { kind: string; name?: string } | undefined): boolean {
  return type?.kind === 'string' || (type?.kind === 'named' && type.name === 'text')
}

export function stringCall(callee: Expression): StringOp | undefined {
  if (callee.form !== 'member' || !isText(callee.target.type)) {
    return undefined
  }

  const op = hostMethod(callee.name)

  return STRING_METHODS.has(op) ? { target: callee.target, op } : undefined
}

// a native string PROPERTY READ (`value.length`) on a text receiver
export function stringRead(node: Expression): StringOp | undefined {
  if (node.form !== 'member' || !isText(node.target.type) || node.name !== 'length') {
    return undefined
  }

  return { target: node.target, op: 'length' }
}

// a native collection PROPERTY READ (`map.size`, `array.length`) on a map/array receiver
export function collectionRead(
  node: Expression,
): CollectionOp | undefined {
  if (node.form !== 'member') {
    return undefined
  }

  const kind = node.target.type?.kind

  if (kind === 'map' && node.name === 'size') {
    return { target: node.target, op: 'size', kind: 'map' }
  }

  if (kind === 'array' && node.name === 'length') {
    return { target: node.target, op: 'length', kind: 'array' }
  }

  return undefined
}

// the names reassigned anywhere in a body. Rust, Swift, and Kotlin parameters are immutable, so a reassigned one is
// shadowed by a mutable local at the top of the function. This descends into closure bodies: a parameter reassigned
// only inside a nested closure still needs the shadow, since the closure captures the enclosing (mutable) local,
// never the parameter itself. Shared by the three native backends so the analysis cannot drift between them.
function reassignedExpr(expr: Expression, into: Set<string>): void {
  switch (expr.form) {
    case 'closure':
      reassigned(expr.body, into)
      break
    case 'call':
      reassignedExpr(expr.callee, into)
      expr.args.forEach(a => reassignedExpr(a, into))
      break
    case 'binary':
      reassignedExpr(expr.left, into)
      reassignedExpr(expr.right, into)
      break
    case 'unary':
      reassignedExpr(expr.operand, into)
      break
    case 'array':
      expr.items.forEach(i => reassignedExpr(i, into))
      break
    case 'map':
      expr.entries.forEach(e => {
        reassignedExpr(e.key, into)
        reassignedExpr(e.value, into)
      })
      break
    case 'record':
      expr.fields.forEach(f => reassignedExpr(f.value, into))
      break
    case 'member':
      reassignedExpr(expr.target, into)
      break
    case 'await':
      reassignedExpr(expr.expr, into)
      break
    case 'template':
      for (const part of expr.parts) {
        if (typeof part !== 'string') {
          reassignedExpr(part, into)
        }
      }

      break
    case 'conditional':
      expr.branches.forEach(b => {
        reassignedExpr(b.cond, into)
        reassignedExpr(b.value, into)
      })

      if (expr.otherwise) {
        reassignedExpr(expr.otherwise, into)
      }

      break
    default:
      break
  }
}

export function reassigned(
  body: Statement[],
  into: Set<string>,
): void {
  for (const s of body) {
    switch (s.form) {
      case 'let':
        reassignedExpr(s.init, into)
        break
      case 'assign': {
        // `save x, v` reassigns x; `save x/field, v` mutates x in place, which a by-value parameter needs a mutable
        // shadow for just the same. `save xs/{i}, v` and `save xs/0, v` on a LIST or MAP are not either: every
        // native backend holds a list and a map by reference (SeedList, Rc<RefCell<..>>, MutableList), and writes the
        // element through it, so the binding stays immutable. Counting them made Swift write `var perm = perm` and
        // `var xs = ...` that it then warned were never mutated
        const element =
          s.target.form === 'member' &&
          s.target.target.form === 'variable' &&
          (s.target.target.type?.kind === 'array' || s.target.target.type?.kind === 'map') &&
          (s.target.index !== undefined || /^\d+$/.test(s.target.name))

        if (element) {
          reassignedExpr(s.value, into)

          if (s.target.form === 'member' && s.target.index) {
            reassignedExpr(s.target.index, into)
          }

          break
        }

        let target: Expression = s.target

        while (target.form === 'member') {
          target = target.target
        }

        if (target.form === 'variable') {
          into.add(target.name)
        }

        reassignedExpr(s.value, into)
        break
      }
      case 'expression':
        reassignedExpr(s.expr, into)
        break
      case 'return':
        if (s.value) {
          reassignedExpr(s.value, into)
        }

        break
      case 'throw':
        reassignedExpr(s.value, into)
        break
      case 'if':
        s.branches.forEach(b => {
          reassignedExpr(b.cond, into)
          reassigned(b.body, into)
        })

        if (s.otherwise) {
          reassigned(s.otherwise, into)
        }

        break
      case 'match':
        reassignedExpr(s.subject, into)
        s.cases.forEach(c => reassigned(c.body, into))

        if (s.otherwise) {
          reassigned(s.otherwise, into)
        }

        break
      case 'while':
        reassignedExpr(s.cond, into)
        reassigned(s.body, into)
        break
      case 'guard':
        reassigned(s.body, into)

        if (s.catch) {
          reassigned(s.catch.body, into)
        }

        break
      case 'for-each':
        reassignedExpr(s.iterable, into)
        reassigned(s.body, into)
        break
      default:
        break
    }
  }
}

// Shared backend machinery. Every code generator must handle every AST form, on every target.
//
// `exhausted` makes that a COMPILE-TIME invariant. Route the `default` branch of any form switch through it: when a
// case is missing, `node` is not narrowed to `never`, so the call fails to typecheck. When a new Expression or
// Statement form is added to the language, every backend that has not added a case stops compiling. So "every
// backend supports everything the language will ever have" is enforced by the type checker, not by hope. If a form
// ever does reach it at runtime (e.g. a hand-built AST), it throws loudly rather than emitting silent wrong code.
export function exhausted(node: never): never {
  throw new Error(
    `backend: unhandled AST form ${JSON.stringify(
      (node as { form?: unknown }).form,
    )}`,
  )
}

// A target that cannot express a form (a GPU shader cannot throw; the HVM pure fragment has no stored closures) emits this marker
// instead of silently dropping or miscompiling the construct. The marker is a comment in the target's syntax, so the
// generated source still parses but the gap is visible and greppable (SEED-UNSUPPORTED), never silent.
export function unsupported(
  target: string,
  form: string,
  comment: string,
): string {
  return `${comment} SEED-UNSUPPORTED on ${target}: "${form}" is outside this target's fragment`
}

// ---- filling a form from data ----

// the shape a `call fill / <data> / like <form>` walks: one entry per field with its kind. A kind is `text`,
// `number`, `decimal`, `flag`, `data` (a field of the package's own `data` form, passed through), `list` (with its
// item), `form` (with its own spec, recursively) or `any` (a type with no data spelling, which a typed backend
// refuses at compile time). A form that reaches itself is cut at the second visit and read as `any`. The TypeScript
// emitter walks the spec at run time; the native emitters generate a function per form from it.
export type FormKind =
  | { kind: 'text' | 'number' | 'decimal' | 'flag' | 'data' | 'any' }
  | { kind: 'list'; item: FormKind }
  | { kind: 'form'; spec: FormSpec }

export type FormSpec = { form: string; fields: { name: string; optional: boolean; kind: FormKind }[] }

export type RecordFields = Map<string, { name: string; type: Type; optional?: boolean }[]>

export function formSpec(type: Type, records: RecordFields, seen: Set<string> = new Set()): FormSpec {
  const name = type.kind === 'named' ? type.name : ''
  const fields = records.get(name) ?? []
  const inner = new Set(seen).add(name)

  return {
    form: name,
    fields: fields.map(f => ({ name: f.name, optional: Boolean(f.optional), kind: formKind(f.type, records, inner) })),
  }
}

export function formKind(type: Type | undefined, records: RecordFields, seen: Set<string>): FormKind {
  switch (type?.kind) {
    case 'string':
      return { kind: 'text' }
    case 'boolean':
      return { kind: 'flag' }
    case 'number':
      return { kind: 'number' }
    case 'float':
      return { kind: 'decimal' }
    case 'array':
      return { kind: 'list', item: formKind(type.element, records, seen) }
    case 'named': {
      if (type.name === 'text') {
        return { kind: 'text' }
      }

      if (type.name === 'boolean') {
        return { kind: 'flag' }
      }

      if (/^(number|integer|natural|size|count|index|u?int(8|16|32|64)?)$/.test(type.name)) {
        return { kind: 'number' }
      }

      if (/^(decimal|float(32|64)?|double|real)$/.test(type.name)) {
        return { kind: 'decimal' }
      }

      if (type.name === 'data') {
        return { kind: 'data' }
      }

      if (type.name === 'list') {
        return { kind: 'list', item: formKind(type.args?.[0], records, seen) }
      }

      if (records.has(type.name) && !seen.has(type.name)) {
        return { kind: 'form', spec: formSpec(type, records, seen) }
      }

      return { kind: 'any' }
    }
    default:
      return { kind: 'any' }
  }
}

// every form a spec reaches, the outer one first, each once
export function specForms(spec: FormSpec, into: Map<string, FormSpec> = new Map()): Map<string, FormSpec> {
  if (into.has(spec.form)) {
    return into
  }

  into.set(spec.form, spec)

  const walk = (kind: FormKind): void => {
    if (kind.kind === 'form') {
      specForms(kind.spec, into)
    } else if (kind.kind === 'list') {
      walk(kind.item)
    }
  }

  spec.fields.forEach(f => walk(f.kind))

  return into
}

// a field whose type has no data spelling cannot be filled on a typed backend: the build says which
export function refuseAny(spec: FormSpec, backend: string): void {
  const walk = (kind: FormKind, at: string): void => {
    if (kind.kind === 'any') {
      throw new Error(`"fill" with a form: ${at} has a type with no data form, so it cannot be filled on ${backend}`)
    } else if (kind.kind === 'list') {
      walk(kind.item, `an item of ${at}`)
    } else if (kind.kind === 'form') {
      kind.spec.fields.forEach(f => walk(f.kind, `field "${f.name}" of "${kind.spec.form}"`))
    }
  }

  spec.fields.forEach(f => walk(f.kind, `field "${f.name}" of "${spec.form}"`))
}

// does any path of this body `return <value>`? A task with no declared result but a valued return still
// needs a non-void native result type (the gradual Any / boxed dynamic).
export function hasValuedReturn(body: import('@term/make/code/compile/node').Statement[]): boolean {
  for (const s of body) {
    switch (s.form) {
      case 'return': {
        // a `send back <unit call>` forwards nothing: not a valued return. An await's type rides on the
        // inner call when the await node itself was not typed.
        const returned =
          s.value?.form === 'await'
            ? (s.value.type ?? s.value.expr.type)
            : s.value?.type

        // only a KNOWN CONCRETE non-unit type counts: an untyped or unknown-typed dock forward may be a
        // unit shim, and guessing valued turns `return io::file_write(...)` into a type error. A valued
        // dock forward annotates its task (`like unknown`) instead.
        if (
          s.value &&
          returned &&
          returned.kind !== 'unit' &&
          returned.kind !== 'unknown'
        ) {
          return true
        }

        break
      }
      case 'if':
        if (
          s.branches.some(b => hasValuedReturn(b.body)) ||
          (s.otherwise && hasValuedReturn(s.otherwise))
        ) {
          return true
        }

        break
      case 'while':
      case 'for-each':
        if (hasValuedReturn(s.body)) {
          return true
        }

        break
      case 'match':
        if (
          s.cases.some(c => hasValuedReturn(c.body)) ||
          (s.otherwise && hasValuedReturn(s.otherwise))
        ) {
          return true
        }

        break
      case 'guard':
        if (
          hasValuedReturn(s.body) ||
          (s.catch && hasValuedReturn(s.catch.body))
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

// The function-typed parameters a task may keep past its call (note/term/codegen/passes.md, P3, in its first and
// most conservative form). A parameter stays NON-escaping only when every mention of it is the callee of a call made
// directly in the task's body: passed as an argument, returned, stored, read inside a closure, or written (a written
// parameter is copied into a `var`), it escapes. Anything this cannot see is treated as escaping, which is what every
// parameter was before, so a mistake can only cost the optimization and never the build.
export function escapingParams(fn: Extract<Statement, { form: 'function' }>): Set<string> {
  const names = new Set(fn.params.filter(p => p.type?.kind === 'function').map(p => p.name))
  const escapes = new Set<string>()

  if (names.size === 0) {
    return escapes
  }

  type Loose = { form?: string; [key: string]: unknown }
  const seen = new Set<object>()
  const visit = (value: unknown, inClosure: boolean): void => {
    if (typeof value !== 'object' || value === null || seen.has(value)) {
      return
    }

    seen.add(value)

    if (Array.isArray(value)) {
      value.forEach(v => visit(v, inClosure))

      return
    }

    const node = value as Loose
    const inside = inClosure || node.form === 'closure'

    if (node.form === 'variable' && names.has(node.name as string)) {
      escapes.add(node.name as string)
    }

    if (node.form === 'assign' && (node.target as Loose).form === 'variable' && names.has((node.target as Loose).name as string)) {
      escapes.add((node.target as Loose).name as string)
    }

    for (const [key, child] of Object.entries(node)) {
      if (key === 'type' || key === 'span') {
        continue
      }

      // the callee of a direct call outside any closure is the one use that does not escape
      const callee = child as Loose | null
      if (node.form === 'call' && key === 'callee' && !inside && callee?.form === 'variable' && names.has(callee.name as string)) {
        continue
      }

      visit(child, inside)
    }
  }

  visit(fn.body, false)

  return escapes
}

// The three-statement swap of two list slots, `save t, read xs/{i}` / `save xs/{i}, read xs/{j}` / `save xs/{j}, read
// t`, with the temporary read nowhere after. Rust writes it as `slice::swap` under one borrow where the three
// statements took four, and Kotlin as `Collections.swap`. Swift does not: `swapAt` through `SeedList.data` measured
// slower than the three statements (swift.ts, `block`). It stops where the three statements stop, before any write: each call
// checks both indexes before it moves anything. The indexes are a variable or an integer literal, so reading them
// once is reading them three times. Returns undefined for anything else, which is then emitted statement by statement
export type Swap = { list: Expression; first: Expression; second: Expression; temp: string }

export function swapAt(body: Statement[], at: number): Swap | undefined {
  const [hold, move, put] = [body[at], body[at + 1], body[at + 2]]

  if (hold?.form !== 'let' || move?.form !== 'assign' || put?.form !== 'assign' || move.op !== '=' || put.op !== '=') {
    return undefined
  }

  // a slot of a LIST read by a dynamic index, off a plain variable; a hash read `table/{key}` is not one
  const slot = (node: Expression): { list: string; index: Expression } | undefined =>
    node.form === 'member' &&
    node.index !== undefined &&
    node.target.form === 'variable' &&
    node.target.type?.kind === 'array' &&
    (node.index.form === 'variable' || node.index.form === 'integer')
      ? { list: node.target.name, index: node.index }
      : undefined
  const same = (a: Expression, b: Expression): boolean =>
    (a.form === 'variable' && b.form === 'variable' && a.name === b.name) ||
    (a.form === 'integer' && b.form === 'integer' && a.value === b.value)

  const read = slot(hold.init)
  const firstWrite = slot(move.target)
  const secondRead = slot(move.value)
  const secondWrite = slot(put.target)

  if (
    !read ||
    !firstWrite ||
    !secondRead ||
    !secondWrite ||
    ![firstWrite, secondRead, secondWrite].every(s => s.list === read.list) ||
    !same(read.index, firstWrite.index) ||
    !same(secondRead.index, secondWrite.index) ||
    put.value.form !== 'variable' ||
    put.value.name !== hold.name ||
    [read.index, secondRead.index].some(i => i.form === 'variable' && (i.name === hold.name || i.name === read.list)) ||
    mentions(body.slice(at + 3), hold.name)
  ) {
    return undefined
  }

  return { list: (hold.init as Extract<Expression, { form: 'member' }>).target, first: read.index, second: secondRead.index, temp: hold.name }
}

// is the name read anywhere in these statements (closures and nested blocks included)
function mentions(body: Statement[], name: string): boolean {
  const walk = (value: unknown): boolean => {
    if (Array.isArray(value)) {
      return value.some(walk)
    }

    if (value === null || typeof value !== 'object') {
      return false
    }

    const node = value as Record<string, unknown>

    if (node.form === 'variable' && node.name === name) {
      return true
    }

    return Object.entries(node).some(([key, child]) => key !== 'type' && key !== 'span' && walk(child))
  }

  return walk(body)
}

// F1, the first and narrowest slice (note/term/codegen/shared.md): the list PARAMETERS a task may take LENT, as
// `&mut [T]` ('write') or `&[T]` ('read'), where every list is otherwise an `Rc<RefCell<Vec<T>>>` borrowed again at
// each element. The caller lends once for the whole call. A wrong answer here does not merely slow a program down: a
// second name reaching the same list while it is lent panics on its `RefCell`. So it is refused unless nothing else
// in the task CAN reach a list:
//   - every mention of the parameter is a slot read or write (`xs/{i}`, `xs/0`), its length, or the list a walk walks.
//     Never reassigned, passed, stored, returned or captured
//   - every other parameter is a scalar (a number, a float, a flag, a text), so no second name can alias it
//   - the task makes no call to another task, calls no function value, builds no closure, and reads no collection
//     from outside itself; a native call takes scalar arguments only
// `gate` is the same filter `impl Fn` uses: a top-level synchronous task, defined once, never used as a value.
export type Lend = 'read' | 'write'

const SCALAR_NAMES = new Set(['text', 'boolean', 'number', 'integer', 'decimal'])

export function scalarType(type: Type | undefined): boolean {
  return (
    type !== undefined &&
    (type.kind === 'number' ||
      type.kind === 'float' ||
      type.kind === 'boolean' ||
      type.kind === 'string' ||
      (type.kind === 'named' && SCALAR_NAMES.has(type.name) && !type.args?.length))
  )
}

export function lendableParams(fn: Extract<Statement, { form: 'function' }>, tasks: Set<string>): Map<number, Lend> {
  const lent = new Map<number, Lend>()
  const candidates = fn.params.flatMap((p, i) => (p.type?.kind === 'array' ? [i] : []))

  if (candidates.length !== 1 || !fn.params.every((p, i) => i === candidates[0] || scalarType(p.type))) {
    return lent
  }

  const name = fn.params[candidates[0]!]!.name

  // by name, so a parameter the body binds again is refused rather than confused with its shadow
  if (rebinds(fn.body).has(name)) {
    return lent
  }

  const locals = new Set(fn.params.map(p => p.name))
  letNames(fn.body, locals)
  let refused = false
  let written = false
  type Loose = Record<string, unknown> & { form?: string }

  const slotOf = (node: Loose): boolean =>
    node.form === 'member' &&
    (node.index !== undefined || /^\d+$/.test(node.name as string)) &&
    (node.target as Loose).form === 'variable' &&
    (node.target as Loose).name === name

  const visit = (value: unknown): void => {
    if (refused || typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(visit)

      return
    }

    const node = value as Loose

    switch (node.form) {
      case 'closure':
      case 'await':
        refused = true

        return
      case 'variable': {
        const id = node.name as string

        // the parameter itself, anywhere but the places handled below; or a collection from outside the task
        if (id === name || (!locals.has(id) && !scalarType(node.type as Type | undefined) && !tasks.has(id))) {
          refused = true
        }

        return
      }
      case 'call': {
        const callee = node.callee as Loose

        // another task, a function value, or a method-shaped operation on a collection: any could reach the list
        if (callee.form !== 'variable' || tasks.has(callee.name as string) || locals.has(callee.name as string)) {
          refused = true

          return
        }

        if (!(node.args as Loose[]).every(a => scalarType(a.type as Type | undefined))) {
          refused = true

          return
        }

        visit(node.args)

        return
      }
      case 'member':
        if (slotOf(node)) {
          visit(node.index)

          return
        }

        {
          const read = collectionRead(node as Expression)

          if (read && read.target.form === 'variable' && read.target.name === name) {
            return
          }
        }

        visit(node.target)
        visit(node.index)

        return
      case 'assign': {
        const target = node.target as Loose

        if (slotOf(target)) {
          written = true
          visit(target.index)
          visit(node.value)

          return
        }

        visit(node.target)
        visit(node.value)

        return
      }
      case 'for-each': {
        const iterable = node.iterable as Loose

        if (!(iterable.form === 'variable' && iterable.name === name)) {
          visit(iterable)
        }

        visit(node.body)

        return
      }
      default:
        for (const [key, child] of Object.entries(node)) {
          if (key !== 'type' && key !== 'span') {
            visit(child)
          }
        }
    }
  }

  visit(fn.body)

  if (!refused) {
    lent.set(candidates[0]!, written ? 'write' : 'read')
  }

  return lent
}

// F1, the second slice: the list LOCALS a task owns outright, held as a plain `Vec<T>`. A local is owned when it is
// made fresh (`make list`, an empty literal, or a call to a task that answers a fresh list, `fresh`), never rebound,
// and every mention is one that cannot let a second name reach it:
//   - a slot read or write, its length (`list_size`), a walk over it, a `list_push` onto it
//   - an argument a callee takes lent (`lendParams`): the borrow ends with the call
//   - `send back` of it, the list leaving whole (wrapped into the shared cell then, or handed on as the `Vec` itself
//     when this task is `fresh`)
// Never inside a closure, never passed, stored or aliased otherwise. Answers each owned name and whether anything
// writes it (for `let mut`).
export function ownedLocals(
  fn: Extract<Statement, { form: 'function' }>,
  fresh: Set<string>,
  lend: Map<string, Map<number, Lend>>,
): Map<string, boolean> {
  type Loose = Record<string, unknown> & { form?: string }
  const made = (init: Loose): boolean =>
    (init.form === 'array' && (init.items as unknown[]).length === 0) ||
    (init.form === 'record' && init.name === 'list' && (init.fields as unknown[]).length === 0) ||
    (init.form === 'call' && (init.callee as Loose).form === 'variable' && fresh.has((init.callee as Loose).name as string))
  const candidates = new Map<string, boolean>()
  const declared = new Map<string, number>()

  const collect = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(collect)

      return
    }

    const node = value as Loose

    if (node.form === 'let') {
      declared.set(node.name as string, (declared.get(node.name as string) ?? 0) + 1)

      if ((node.type as Type | undefined)?.kind === 'array' && made(node.init as Loose)) {
        candidates.set(node.name as string, false)
      }
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        collect(child)
      }
    }
  }

  collect(fn.body)

  // a name declared twice (two branches, a shadow), or bound again any other way (a walk's item, a closure's
  // parameter, an arm's field), is refused: the analysis is by name
  const bound = rebinds(fn.body, new Set(), undefined, false)

  for (const name of [...candidates.keys()]) {
    if (declared.get(name) !== 1 || fn.params.some(p => p.name === name) || bound.has(name)) {
      candidates.delete(name)
    }
  }

  // refusals and writes are kept apart, so a write seen after a refusal cannot admit the name again
  const refused = new Set<string>()
  const written = new Set<string>()
  const refuse = (name: string): void => {
    refused.add(name)
  }
  const owned = (node: Loose | undefined): string | undefined =>
    node?.form === 'variable' && candidates.has(node.name as string) ? (node.name as string) : undefined
  const slotOf = (node: Loose): string | undefined =>
    node.form === 'member' && (node.index !== undefined || /^\d+$/.test(node.name as string)) ? owned(node.target as Loose) : undefined

  const visit = (value: unknown, inClosure: boolean): void => {
    if (typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(v => visit(v, inClosure))

      return
    }

    const node = value as Loose

    switch (node.form) {
      case 'closure':
        visit(node.body, true)

        return
      case 'variable': {
        const name = owned(node)

        if (name) {
          refuse(name)
        }

        return
      }
      case 'let':
        // the declaration of an owned local: its init is fresh by construction, so only the init's own arguments.
        // Any other `let` is visited whole, so `let y = xs` refuses `xs`
        if (candidates.has(node.name as string)) {
          visit((node.init as Loose).form === 'call' ? (node.init as Loose).args : undefined, inClosure)
        } else {
          visit(node.init, inClosure)
        }

        return
      case 'member': {
        const name = slotOf(node)

        if (name && !inClosure) {
          visit(node.index, inClosure)

          return
        }

        const read = collectionRead(node as Expression)
        const counted = read ? owned(read.target as Loose) : undefined

        if (counted && !inClosure) {
          return
        }

        visit(node.target, inClosure)
        visit(node.index, inClosure)

        return
      }
      case 'assign': {
        const name = slotOf(node.target as Loose)

        if (name && !inClosure) {
          written.add(name)
          visit((node.target as Loose).index, inClosure)
          visit(node.value, inClosure)

          return
        }

        visit(node.target, inClosure)
        visit(node.value, inClosure)

        return
      }
      case 'for-each': {
        const name = owned(node.iterable as Loose)

        if (!name || inClosure) {
          visit(node.iterable, inClosure)
        }

        visit(node.body, inClosure)

        return
      }
      case 'return': {
        const name = owned(node.value as Loose)

        if (!name || inClosure) {
          visit(node.value, inClosure)
        }

        return
      }
      case 'call': {
        const callee = node.callee as Loose
        const args = node.args as Loose[]
        const first = owned(args[0])

        // a push onto, or the size of, an owned list
        if (!inClosure && first && callee.form === 'variable' && (callee.name === 'list_push' || callee.name === 'list_size')) {
          if (callee.name === 'list_push') {
            written.add(first)
          }

          visit(args.slice(1), inClosure)

          return
        }

        // an argument the callee takes lent
        const lent = callee.form === 'variable' ? lend.get(callee.name as string) : undefined

        args.forEach((a, i) => {
          const name = owned(a)
          const how = lent?.get(i)

          if (name && how && !inClosure) {
            if (how === 'write') {
              written.add(name)
            }
          } else {
            visit(a, inClosure)
          }
        })

        visit(callee, inClosure)

        return
      }
      default:
        for (const [key, child] of Object.entries(node)) {
          if (key !== 'type' && key !== 'span') {
            visit(child, inClosure)
          }
        }
    }
  }

  // refusing one name can only refuse, never admit, so one pass sees every disqualifying mention
  visit(fn.body, false)

  return new Map([...candidates.keys()].filter(name => !refused.has(name)).map(name => [name, written.has(name)]))
}

// every variable name an expression (or statement list) reads, closures and nested blocks included
export function namesIn(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value !== 'object' || value === null) {
    return into
  }

  if (Array.isArray(value)) {
    value.forEach(v => namesIn(v, into))

    return into
  }

  const node = value as Record<string, unknown> & { form?: string; name?: string }

  if (node.form === 'variable' && typeof node.name === 'string') {
    into.add(node.name)
  }

  for (const [key, child] of Object.entries(node)) {
    if (key !== 'type' && key !== 'span') {
      namesIn(child, into)
    }
  }

  return into
}

// does anything in these statements write the owned list `name`: a push onto it, a slot write, or a lend for writing
export function writesTo(body: Statement[], name: string, lend: Map<string, Map<number, Lend>>): boolean {
  let found = false
  const named = (node: unknown): boolean =>
    (node as { form?: string; name?: string } | undefined)?.form === 'variable' && (node as { name: string }).name === name

  const visit = (value: unknown): void => {
    if (found || typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(visit)

      return
    }

    const node = value as Record<string, unknown> & { form?: string }

    if (node.form === 'assign' && (node.target as { form?: string }).form === 'member' && named((node.target as { target?: unknown }).target)) {
      found = true

      return
    }

    if (node.form === 'call') {
      const callee = node.callee as { form?: string; name?: string }
      const args = node.args as unknown[]

      if (callee.form === 'variable' && callee.name === 'list_push' && named(args[0])) {
        found = true

        return
      }

      const lent = callee.form === 'variable' ? lend.get(callee.name!) : undefined

      if (lent && args.some((a, i) => named(a) && lent.get(i) === 'write')) {
        found = true

        return
      }
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        visit(child)
      }
    }
  }

  visit(body)

  return found
}

// The tasks that answer a FRESH list, returned as a plain `Vec<T>`: every `send back` hands back a list the task owns
// (`ownedLocals`). A fixpoint, since a local made by a call to a fresh task is itself owned. Begins from every task the
// gate admits whose result is a list, and drops one each round until none drops
export function freshTasks(candidates: Extract<Statement, { form: 'function' }>[], lend: Map<string, Map<number, Lend>>): Set<string> {
  const fresh = new Set(candidates.filter(fn => fn.result?.kind === 'array').map(fn => fn.name))
  let changed = true

  const returns = (body: unknown, into: Expression[]): void => {
    if (typeof body !== 'object' || body === null) {
      return
    }

    if (Array.isArray(body)) {
      body.forEach(b => returns(b, into))

      return
    }

    const node = body as Record<string, unknown> & { form?: string }

    // a closure's own `send back` answers the closure, not the task
    if (node.form === 'closure') {
      return
    }

    if (node.form === 'return') {
      into.push(node.value as Expression)
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        returns(child, into)
      }
    }
  }

  while (changed) {
    changed = false

    for (const fn of candidates) {
      if (!fresh.has(fn.name)) {
        continue
      }

      const owned = ownedLocals(fn, fresh, lend)
      const values: Expression[] = []
      returns(fn.body, values)

      if (values.length === 0 || !values.every(v => v?.form === 'variable' && owned.has(v.name))) {
        fresh.delete(fn.name)
        changed = true
      }
    }
  }

  return fresh
}

export function letNames(body: Statement[], into: Set<string>): void {
  for (const s of body) {
    switch (s.form) {
      case 'let':
        into.add(s.name)
        break
      case 'if':
        s.branches.forEach(b => letNames(b.body, into))

        if (s.otherwise) {
          letNames(s.otherwise, into)
        }

        break
      case 'while':
      case 'for-each':
        if (s.form === 'for-each') {
          into.add(s.item)
        }

        letNames(s.body, into)
        break
      case 'match':
        s.cases.forEach(c => letNames(c.body, into))

        if (s.otherwise) {
          letNames(s.otherwise, into)
        }

        break
      case 'guard':
        letNames(s.body, into)

        if (s.catch) {
          letNames(s.catch.body, into)
        }

        break
      default:
        break
    }
  }
}

// The tasks a backend may change the signature of: top-level, synchronous, with a body, defined once, no trait method
// (`refuse` names the trait methods), and never used as a value, since a task held as a value must keep the one
// shape every function value has. A parameter or local that happens to share a task's name is not a use of the task
// (the stdlib's `fold` takes a `total`). Read by `impl Fn` on Rust and by every F1 lowering on Rust and Swift
export function gatedTasks(program: Statement[], refuse: Set<string>): Extract<Statement, { form: 'function' }>[] {
  const defined = new Map<string, number>()
  const asValue = new Set<string>()
  const seen = new Set<object>()

  const walk = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || seen.has(value)) {
      return
    }

    seen.add(value)

    if (Array.isArray(value)) {
      value.forEach(walk)

      return
    }

    const node = value as { form?: string; name?: string; callee?: { form?: string }; binding?: { kind?: string } }

    if (node.form === 'variable' && typeof node.name === 'string' && node.binding?.kind !== 'local' && node.binding?.kind !== 'parameter') {
      asValue.add(node.name)
    }

    for (const [key, child] of Object.entries(node)) {
      // the callee of a call is the one use of a task's name that is not a value
      if (key === 'type' || key === 'span' || (node.form === 'call' && key === 'callee' && node.callee?.form === 'variable')) {
        continue
      }

      walk(child)
    }
  }

  for (const n of program) {
    if (n.form === 'function') {
      defined.set(n.name, (defined.get(n.name) ?? 0) + 1)
    }
  }

  walk(program)

  return program.filter(
    (n): n is Extract<Statement, { form: 'function' }> =>
      n.form === 'function' &&
      !n.async &&
      n.body.length > 0 &&
      !(n as { method?: unknown }).method &&
      !refuse.has(n.name) &&
      defined.get(n.name) === 1 &&
      !asValue.has(n.name),
  )
}

// every name a body binds: a `let`, a walk's item and index, a closure's parameters, and the fields or `link` names an
// arm of a `fork case` binds. An analysis that goes by name refuses a parameter whose name is in here, since a read of
// the shadow would otherwise count as a read of the parameter
export function rebinds(
  body: unknown,
  into: Set<string> = new Set(),
  // each variant's field names, for an arm that binds them without `link` lines; without it only `link` names count
  fields?: Map<string, Map<string, unknown>>,
  // whether a `let` counts (an analysis that admits one declaration of its own name counts lets itself)
  lets = true,
): Set<string> {
  if (typeof body !== 'object' || body === null) {
    return into
  }

  if (Array.isArray(body)) {
    body.forEach(b => rebinds(b, into, fields, lets))

    return into
  }

  const node = body as Record<string, unknown> & { form?: string }

  switch (node.form) {
    case 'let':
      if (lets) {
        into.add(node.name as string)
      }

      break
    case 'for-each':
      into.add(node.item as string)

      if (typeof node.index === 'string') {
        into.add(node.index)
      }

      break
    case 'closure':
      for (const p of node.params as { name: string }[]) {
        into.add(p.name)
      }

      break
    case 'match':
      for (const arm of node.cases as { label: string; binds?: string[] }[]) {
        const names = arm.binds?.length ? arm.binds : [...(fields?.get(arm.label)?.keys() ?? [])]

        for (const b of names) {
          into.add(b)
        }
      }

      break
    default:
      break
  }

  for (const [key, child] of Object.entries(node)) {
    if (key !== 'type' && key !== 'span') {
      rebinds(child, into, fields, lets)
    }
  }

  return into
}

// F1 for RECORDS: the record parameters a gated task only READS, taken as `&R` on Rust where they arrive by value and
// are destructured (a recursive field through `Rc::unwrap_or_clone`) at every node. A record is a value here: every
// clone is a copy and nothing writes inside a shared subtree, so a borrow can never be seen through a second name,
// and the worst a wrong answer can do is fail to compile, which every native suite would show. Each mention of the
// parameter must be one of
//   - the subject of a `fork case` (a match), whose arms then bind its fields by reference
//   - a scalar field read (`p/size`, a number, a float or a flag)
//   - an argument at a position the callee also takes borrowed, of the same type (a fixpoint: `item-check` calls
//     itself with each branch)
// and an arm's field that is itself a record is held to the same rule, except that it may not be matched again (a
// match through `&Rc<R>` does not dereference). Any other field is copied (a scalar) or cloned (anything else) out of
// the reference at the arm's entry, so the arm's body reads it as it always did
export function borrowedRecords(program: Statement[], gated: Extract<Statement, { form: 'function' }>[]): Map<string, Set<number>> {
  type Loose = Record<string, unknown> & { form?: string }
  const records = new Map(
    program.flatMap(n => (n.form === 'record-type' && !n.shared ? [[n.name, n] as const] : [])),
  )
  const recordType = (type: Type | undefined): string | undefined =>
    type?.kind === 'named' && records.has(type.name) ? type.name : undefined
  // each variant's field types, for what an arm binds
  const variantTypes = new Map<string, Map<string, Type>>()

  for (const record of records.values()) {
    for (const v of record.variants) {
      variantTypes.set(v.name, new Map(v.fields.map(f => [f.name, f.type])))
    }
  }

  const scalar = (type: Type | undefined): boolean =>
    type !== undefined && (type.kind === 'number' || type.kind === 'float' || type.kind === 'boolean')
  const candidates = new Map<string, Set<number>>(
    gated.flatMap(fn => {
      const at = new Set(fn.params.flatMap((p, i) => (recordType(p.type) ? [i] : [])))

      return at.size ? [[fn.name, at] as const] : []
    }),
  )
  const byName = new Map(gated.map(fn => [fn.name, fn]))

  // does this task read the borrowed name `name` only in the allowed ways, given the current candidates
  const conforms = (fn: Extract<Statement, { form: 'function' }>, start: string): boolean => {
    // the analysis goes by name, so a parameter something in the body binds again (a walk's `item` inside a task that
    // takes an `item`) is refused rather than confused with its shadow
    if (rebinds(fn.body, new Set(), variantTypes).has(start)) {
      return false
    }

    let ok = true
    // the borrowed names in scope: the parameter, then each record field an arm binds from it
    const borrowed = new Set([start])
    // of them, the ones that may be matched (the parameter, never an arm's field)
    const matchable = new Set([start])
    const named = (node: Loose | undefined): string | undefined =>
      node?.form === 'variable' && borrowed.has(node.name as string) ? (node.name as string) : undefined

    const visit = (value: unknown): void => {
      if (!ok || typeof value !== 'object' || value === null) {
        return
      }

      if (Array.isArray(value)) {
        value.forEach(visit)

        return
      }

      const node = value as Loose

      switch (node.form) {
        case 'closure':
          // a capture of a borrowed name would outlive nothing here, but keep the first slice plain
          if (namesIn(node.body).size && [...borrowed].some(b => namesIn(node.body).has(b))) {
            ok = false

            return
          }

          visit(node.body)

          return
        case 'variable':
          if (named(node)) {
            ok = false
          }

          return
        case 'assign': {
          // a write anywhere into a borrowed record (`save t/count, ..`) needs it owned: E0594 behind a `&`
          let root = node.target as Loose

          while (root.form === 'member') {
            root = root.target as Loose
          }

          if (named(root)) {
            ok = false

            return
          }

          visit(node.target)
          visit(node.value)

          return
        }
        case 'member': {
          const name = named(node.target as Loose)

          if (name && node.index === undefined && scalar(node.type as Type | undefined)) {
            return
          }

          visit(node.target)
          visit(node.index)

          return
        }
        case 'match': {
          const name = named(node.subject as Loose)

          if (name && !matchable.has(name)) {
            ok = false

            return
          }

          if (!name) {
            visit(node.subject)
          }

          for (const arm of node.cases as Loose[]) {
            const added: string[] = []

            if (name) {
              const fields = variantTypes.get(arm.label as string)
              const binds = (arm.binds as string[] | undefined) ?? []
              const names = binds.length ? binds : [...(fields?.keys() ?? [])]
              const order = [...(fields?.keys() ?? [])]

              // an arm's `link` lines select fields by name, or rename them in declaration order (check/arm.ts)
              const renames = binds.length > 0 && binds.some(b => !fields?.has(b))

              names.forEach((local, i) => {
                const field = renames ? order[i] : local
                const type = field !== undefined ? fields?.get(field) : undefined

                if (recordType(type) && !borrowed.has(local)) {
                  borrowed.add(local)
                  added.push(local)
                }
              })
            }

            visit(arm.body)
            added.forEach(local => borrowed.delete(local))
          }

          visit(node.otherwise)

          return
        }
        case 'call': {
          const callee = node.callee as Loose
          const lent = callee.form === 'variable' ? current.get(callee.name as string) : undefined
          const target = callee.form === 'variable' ? byName.get(callee.name as string) : undefined

          for (const [i, arg] of (node.args as Loose[]).entries()) {
            const name = named(arg)

            if (name) {
              // a borrowed name passed on: only where the callee borrows it too, at the same record type
              if (!lent?.has(i) || recordType(target?.params[i]?.type) !== recordType(arg.type as Type | undefined)) {
                ok = false

                return
              }
            } else {
              visit(arg)
            }
          }

          visit(callee)

          return
        }
        default:
          for (const [key, child] of Object.entries(node)) {
            if (key !== 'type' && key !== 'span') {
              visit(child)
            }
          }
      }
    }

    visit(fn.body)

    return ok
  }

  // the fixpoint: a parameter stays borrowed while every task it is passed to still borrows it there
  let current = candidates
  let changed = true

  while (changed) {
    changed = false
    const next = new Map<string, Set<number>>()

    for (const [name, at] of current) {
      const fn = byName.get(name)!
      const kept = new Set([...at].filter(i => conforms(fn, fn.params[i]!.name)))

      if (kept.size !== at.size) {
        changed = true
      }

      if (kept.size) {
        next.set(name, kept)
      }
    }

    current = next
  }

  return current
}

// F1's program-wide facts, the same on every backend that reads them: which list parameter each gated task takes
// lent, and which tasks answer a fresh list
export function listFacts(
  program: Statement[],
  gated: Extract<Statement, { form: 'function' }>[],
): { lend: Map<string, Map<number, Lend>>; fresh: Set<string> } {
  const tasks = new Set(program.flatMap(n => (n.form === 'function' ? [n.name] : [])))
  const lend = new Map<string, Map<number, Lend>>()

  for (const fn of gated) {
    const lent = lendableParams(fn, tasks)

    if (lent.size) {
      lend.set(fn.name, lent)
    }
  }

  return { lend, fresh: freshTasks(gated, lend) }
}
