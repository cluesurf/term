import type {
  Expression,
  Program,
  Type,
  Statement,
} from '@term/make/code/compile/node'
import { listFree, nativeCall, scalarTasks } from '@term/make/code/ir/facts/bounds'
import { armLocals } from '@term/make/code/check/arm'
import { isStringMethod, hostMethod } from '@term/make/code/compile/text-methods'
import { LIST_LENGTH_TASKS, LOWERED_LIST_MEMBERS, LOWERED_MAP_MEMBERS } from '@term/make/code/compile/lowered-members'

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

// the members every emitter lowers, the one table the checker reads too (compile/lowered-members.ts)
const MAP_METHODS = LOWERED_MAP_MEMBERS
const ARRAY_METHODS = LOWERED_LIST_MEMBERS

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

export type StringOp = { target: Expression; op: string }

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

  return isStringMethod(op) ? { target: callee.target, op } : undefined
}

// the host string methods whose answer is a text
const TEXT_RESULTS = new Set([
  'charAt',
  'at',
  'substring',
  'slice',
  'toLowerCase',
  'toUpperCase',
  'trim',
  'trimStart',
  'trimEnd',
  'padStart',
  'padEnd',
  'replace',
  'replaceAll',
  'repeat',
  'concat',
])

// is this expression a text: typed one, or a host string method answering one, which the checker leaves `unknown`
// (`char-at`'s body is `value.charAt(index)`, and so is every call of it once inlined)
export function textValued(e: Expression): boolean {
  if (isText(e.type)) {
    return true
  }

  const text = e.form === 'call' ? stringCall(e.callee) : undefined

  return text !== undefined && TEXT_RESULTS.has(text.op)
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
        if (part.form === 'value') {
          reassignedExpr(part.value, into)
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
        // `var xs = ...` that it then warned were never mutated. The same holds for a list reached through a record's
        // field (`save b/items/0, v`): the list is held by reference there too, and a field a record owns as a plain
        // list is never written through its path (`ownedFields` refuses that), so the record stays immutable
        const element =
          s.target.form === 'member' &&
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
//   - every mention of each list parameter is a slot read or write (`xs/{i}`, `xs/0`), its length, the list a walk
//     walks, or an argument at a position another task takes lent (the mode flows back: passed where it is written,
//     it is written here). Never reassigned, stored, returned or captured
//   - every other parameter is a scalar (a number, a float, a flag, a text), and all the list parameters are lent or
//     none is, since a list left shared could be the same list as a lent one
//   - every other call is to a task that cannot reach a list (`scalarTasks`) or a native call, with scalar arguments;
//     no function value, no closure, no collection from outside the task
// Several lists lent to one call could be one list: the CALL SITE answers that (`lendRefusals`), and a site that
// cannot is refused, which refuses the task.
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

export function lendableParams(
  fn: Extract<Statement, { form: 'function' }>,
  tasks: Set<string>,
  // the program's current answer for every OTHER task (`listFacts` solves them together): a list passed on to one of
  // these, at a position it takes lent, stays lent here, in the same mode or a stronger one
  lend: Map<string, Map<number, Lend>> = new Map(),
  // the tasks that cannot reach a list at all (ir/facts/bounds.ts, `scalarTasks`): a call to one costs nothing
  pure: Set<string> = new Set(),
  // the types that hold no list (ir/facts/bounds.ts, `listFree`); scalars alone when the caller has no program
  free: (type: unknown) => boolean = type => scalarType(type as Type | undefined),
): Map<number, Lend> {
  const lent = new Map<number, Lend>()
  const candidates = fn.params.flatMap((p, i) => (p.type?.kind === 'array' ? [i] : []))

  // every other parameter list-free: a map, or a record that holds a list, could hold one that aliases a list lent here
  if (!candidates.length || !fn.params.every((p, i) => candidates.includes(i) || free(p.type))) {
    return lent
  }

  const names = new Map(candidates.map(i => [fn.params[i]!.name, i]))
  const bound = rebinds(fn.body)

  // by name, so a parameter the body binds again is refused rather than confused with its shadow
  if ([...names.keys()].some(name => bound.has(name))) {
    return lent
  }

  const locals = new Set(fn.params.map(p => p.name))
  letNames(fn.body, locals)
  let refusedAll = false
  const refused = new Set<string>()
  const written = new Set<string>()
  type Loose = Record<string, unknown> & { form?: string }

  const ours = (node: Loose | undefined): string | undefined =>
    node?.form === 'variable' && names.has(node.name as string) ? (node.name as string) : undefined
  // a list local of this task's own: a parameter reaches a local only through a mention, which refuses it, so a call
  // given one cannot touch a lent list (`list_push(kids, build(depth - 1, state))`, AWFY's Storage)
  const ownList = (a: Loose | undefined): boolean =>
    a?.form === 'variable' && locals.has(a.name as string) && !names.has(a.name as string) && (a.type as Type | undefined)?.kind === 'array'
  const slotOf = (node: Loose): string | undefined =>
    node.form === 'member' && (node.index !== undefined || /^\d+$/.test(node.name as string)) ? ours(node.target as Loose) : undefined

  const visit = (value: unknown): void => {
    if (refusedAll || typeof value !== 'object' || value === null) {
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
        refusedAll = true

        return
      case 'variable': {
        const id = node.name as string

        // one of the lent lists anywhere but the places handled below; or a collection from outside the task. A name
        // whose type holds no list (`free`: a match arm's field of a recursive variant, a constant record) cannot
        // reach one, however it was bound: Towers' `pop-disk` reads `below`, a `stack`, and was refused for it
        if (names.has(id)) {
          refused.add(id)
        } else if (!locals.has(id) && !free(node.type) && !tasks.has(id)) {
          refusedAll = true
        }

        return
      }
      case 'call': {
        const callee = node.callee as Loose
        const name = callee.form === 'variable' ? (callee.name as string) : undefined
        const args = node.args as Loose[]
        const target = name !== undefined ? lend.get(name) : undefined

        // a task that takes lists lent: one of ours passed at a position it takes lent stays lent here, written if it
        // writes it there. A local of the task's own is passed freely: it cannot alias a parameter
        if (name !== undefined && target && !locals.has(name)) {
          args.forEach((arg, i) => {
            const mine = ours(arg)

            if (!mine) {
              visit(arg)
            } else if (!target.has(i)) {
              refused.add(mine)
            } else if (target.get(i) === 'write') {
              written.add(mine)
            }
          })

          return
        }

        // a collection operation on one of the lent lists: a read of a slot (`self/at(i)`, `self/get(i)`, the stdlib's
        // `get`) is a slot read; anything else on it (a push, a pop, a splice) could change its length, so refuses it
        if (callee.form === 'member') {
          const op = collectionCall(callee as Expression)
          const mine = op && op.kind !== 'map' ? ours(op.target as Loose) : undefined

          // any operation on a list local of this task's own, which no parameter can reach (`ownList` below)
          if (op && op.kind !== 'map' && !mine && ownList(op.target as Loose)) {
            visit(args)

            return
          }

          if (mine) {
            if (op!.op === 'at' || op!.op === 'get') {
              visit(args)
            } else {
              refused.add(mine)
            }

            return
          }
        }

        // a method of a text (`letters.char-at(pick)`, what the stdlib's text tasks inline to) reaches no list
        if (callee.form === 'member' && ((callee.target as Loose).type as Type | undefined)?.kind === 'string') {
          visit(callee.target)
          visit(args)

          return
        }

        // a task that cannot reach a list, or a native call, with list-free arguments (`listFree`: scalars, and records
        // that hold none), or a list local of this task's own: a parameter reaches a local only through a mention, which
        // refuses it, so `list_push(kids, build(depth - 1, state))` cannot touch `state` (AWFY's Storage)
        // A nested call's value is judged by that call, visited below: it carries a lent list only if it was given one
        const harmless =
          (nativeCall(callee) || (name !== undefined && !locals.has(name) && (pure.has(name) || !tasks.has(name)))) &&
          args.every(a => free(a.type) || ownList(a) || a.form === 'call')

        if (!harmless) {
          refusedAll = true

          return
        }

        visit(args)

        return
      }
      case 'member': {
        if (slotOf(node)) {
          visit(node.index)

          return
        }

        const read = collectionRead(node as Expression)

        if (read && ours(read.target as Loose)) {
          return
        }

        visit(node.target)
        visit(node.index)

        return
      }
      case 'assign': {
        const target = node.target as Loose
        const mine = slotOf(target)

        if (mine) {
          written.add(mine)
          visit(target.index)
          visit(node.value)

          return
        }

        // a write deeper through one of its slots (`save ps/{k}/xs/{i}, v`) writes the list too: its element is changed
        // in place, which a `&[T]` refuses once that element's own list is a plain one (`ownedFields`)
        let inner = target

        while (inner.form === 'member' && (inner.target as Loose).form === 'member') {
          inner = inner.target as Loose
        }

        const through = inner.form === 'member' ? slotOf(inner) : undefined

        if (through && inner !== target) {
          written.add(through)
        }

        visit(node.target)
        visit(node.value)

        return
      }
      case 'for-each': {
        if (!ours(node.iterable as Loose)) {
          visit(node.iterable)
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

  if (refusedAll) {
    return lent
  }

  for (const [name, i] of names) {
    if (!refused.has(name)) {
      lent.set(i, written.has(name) ? 'write' : 'read')
    }
  }

  // a list not lent is a second collection parameter that could alias a lent one: all or none
  return lent.size === names.size ? lent : new Map()
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
  // the variant fields that own their lists (`ownedFields`, `variant/field`), which an owned local may be answered into
  stores: Set<string> = new Set(),
  // the reads that hand an owned local into a list that owns its element lists, at its last mention (`ownedElements`)
  moves: WeakSet<object> = new WeakSet(),
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

        // handed whole into a list that owns its element lists, at its last mention: it leaves, as by `send back`
        if (name && !(moves.has(node) && !inClosure)) {
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
        const value = node.value as Loose | undefined

        // a node answered whole, an owned local handed into a field that owns its list (`ownedFields`): the local
        // leaves with the node, as it would leave by itself
        if (!inClosure && value?.form === 'record' && stores.size) {
          for (const f of value.fields as { name: string; value: Loose }[]) {
            if (!(stores.has(`${value.name as string}/${f.name}`) && owned(f.value))) {
              visit(f.value, inClosure)
            }
          }

          return
        }

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
        if (!inClosure && first && callee.form === 'variable' && (callee.name === 'list_push' || LIST_LENGTH_TASKS.has(callee.name))) {
          if (callee.name === 'list_push') {
            written.add(first)
          }

          visit(args.slice(1), inClosure)

          return
        }

        // a slot read or a push through the collection operation the stdlib's `get` and `push` inline to, `xs.at(i)`
        // and `xs.push(v)`
        if (!inClosure && callee.form === 'member') {
          const op = collectionCall(callee as Expression)
          const name = op && op.kind !== 'map' && ['at', 'get', 'push'].includes(op.op) ? owned(op.target as Loose) : undefined

          if (name) {
            if (op!.op === 'push') {
              written.add(name)
            }

            visit(args, inClosure)

            return
          }
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

// whether every mention of `local` in `body` only reads the list it names: its size, a slot, a walk over it, or an
// argument a task takes lent for reading. Never written, pushed, stored, answered, captured or bound again
export function onlyReads(
  body: Statement[],
  local: string,
  lend: Map<string, Map<number, Lend>>,
  // the caller has checked the name is bound once, by a `let` inside `body` itself
  bound = false,
): boolean {
  type Loose = Record<string, unknown> & { form?: string; name?: string }

  if (!bound && rebinds(body).has(local)) {
    return false
  }

  let fine = true
  const mine = (node: Loose | undefined): boolean => node?.form === 'variable' && node.name === local

  const visit = (value: unknown, inClosure: boolean): void => {
    if (!fine || typeof value !== 'object' || value === null) {
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
      case 'variable':
        if (mine(node)) {
          fine = false
        }

        return
      case 'member': {
        // a slot `xs/{i}` or `xs/0`, or a collection read (`size`)
        if (!inClosure && mine(node.target as Loose) && (node.index !== undefined || /^\d+$/.test(node.name as string) || collectionRead(node as Expression))) {
          visit(node.index, inClosure)

          return
        }

        break
      }
      case 'for-each':
        if (!inClosure && mine(node.iterable as Loose)) {
          visit(node.body, inClosure)

          return
        }

        break
      case 'assign':
        if (mine(node.target as Loose) || (((node.target as Loose).form === 'member') && mine((node.target as Loose).target as Loose))) {
          fine = false

          return
        }

        break
      case 'call': {
        const callee = node.callee as Loose
        const args = node.args as Loose[]

        if (!inClosure && callee.form === 'variable' && callee.name === 'list_size' && mine(args[0])) {
          return
        }

        if (!inClosure && callee.form === 'member') {
          const op = collectionCall(callee as Expression)

          if (op && op.kind !== 'map' && (op.op === 'at' || op.op === 'get') && mine(op.target as Loose)) {
            visit(args, inClosure)

            return
          }
        }

        const taken = callee.form === 'variable' ? lend.get(callee.name as string) : undefined

        if (!inClosure && taken) {
          args.forEach((a, i) => {
            if (!(mine(a) && taken.get(i) === 'read')) {
              visit(a, inClosure)
            }
          })
          visit(callee, inClosure)

          return
        }

        break
      }
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        visit(child, inClosure)
      }
    }
  }

  visit(body, false)

  return fine
}

// The forms whose values cross into native code: an argument or the result of a native call (`dock load`), or a
// parameter or the result of a task with no body (a binding or a stub a shim fills), and every form those hold through
// their fields. A shim builds and reads such a value in the host's own terms (a list field as the shared cell), which no
// analysis of the program can see, so its representation must stay the one every backend writes by default. (The Rust
// roundtrip's ten E0308s the day this was added were not this: a construction leaving an owned list field out filled
// it with the shared empty list, fixed in rust.ts. This guard is the boundary that case made visible)
export function nativeForms(program: Statement[]): Set<string> {
  type Loose = Record<string, unknown> & { form?: string; name?: string; type?: Type }
  const records = new Map(program.flatMap(n => (n.form === 'record-type' ? [[n.name, n] as const] : [])))
  const out = new Set<string>()

  const reach = (type: Type | undefined): void => {
    if (!type) {
      return
    }

    if (type.kind === 'named') {
      if (out.has(type.name)) {
        return
      }

      const record = records.get(type.name)

      if (record) {
        out.add(type.name)
        record.fields.forEach(f => reach(f.type))
        record.variants.forEach(v => v.fields.forEach(f => reach(f.type)))
      }

      type.args?.forEach(reach)
    } else if (type.kind === 'array') {
      reach(type.element)
    } else if (type.kind === 'map') {
      reach(type.key)
      reach(type.value)
    } else if (type.kind === 'function') {
      type.params.forEach(reach)
      reach(type.result)
    }
  }

  for (const node of program) {
    if (node.form === 'function' && node.body.length === 0) {
      node.params.forEach(p => reach(p.type))
      reach(node.result)
    }
  }

  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(visit)

      return
    }

    const node = value as Loose

    // a view's `call` node (`{ form: 'call', value }`) has no callee: the per-module emit meets views before they are
    // lowered, and every `term make` of a module holding one crashed here (face's layout-slot)
    if (node.form === 'call' && node.callee !== undefined && nativeCall(node.callee as Expression)) {
      ;(node.args as Loose[]).forEach(a => reach(a.type))
      reach(node.type)
    }

    for (const [k, child] of Object.entries(node)) {
      if (k !== 'type' && k !== 'span') {
        visit(child)
      }
    }
  }

  visit(program)

  return out
}

// F1 for lists held in a variant (note/term/codegen/shared.md): the variant fields of list type that OWN their list,
// keyed `variant/field`, so a backend may hold it as the plain list (`Vec<T>` on Rust) where it was a shared one. A list
// owned by its node is never seen by a second name, so whether it is shared or copied cannot be observed. A field owns
// its list when:
//   - every construction gives it a fresh list: a call to a task that answers one (`fresh`), an empty list, or an owned
//     local (`ownedLocals`) handed into it as the node is answered (`send back, make node / bind kids, read kids`)
//   - every read of it is the local an arm binds it to, and that local is only read: its size, a slot, a walk over it,
//     or an argument a task takes lent for reading. Never written, pushed, stored, answered, captured or bound again
//   - no `subject/field` path reads it, and the program fills or melts no form (their walkers build every list field
//     as the shared one)
// Measured first on AWFY's Storage, a tree whose every node holds a list: 623 ms to 318 with the lists plain, the hand
// version 310 (`tmp/rust-storage-ab.ts`)
export function ownedFields(
  program: Statement[],
  fresh: Set<string>,
  lend: Map<string, Map<number, Lend>>,
  // the forms whose records only ever live in one place (compile/place.ts, `privateForms`): a list field of one may
  // also be written through its path
  slotPrivate: Set<string> = new Set(),
): Set<string> {
  type Loose = Record<string, unknown> & { form?: string; name?: string }
  const keys = new Set<string>()
  // each variant's field names, and the variants of each form, for the path reads
  const fieldsOf = new Map<string, string[]>()
  const variantsOf = new Map<string, string[]>()

  // the forms a shim builds or reads keep the shared list (`nativeForms`)
  const native = nativeForms(program)

  for (const node of program) {
    if (node.form !== 'record-type') {
      continue
    }

    variantsOf.set(node.name, node.variants.map(v => v.name))

    if (native.has(node.name)) {
      for (const v of node.variants) {
        fieldsOf.set(v.name, v.fields.map(f => f.name))
      }

      continue
    }

    // a plain record's list fields, read through their path (`p/points`), keyed `form/field`
    if (node.variants.length === 0) {
      fieldsOf.set(node.name, node.fields.map(f => f.name))

      for (const f of node.fields) {
        if (f.type.kind === 'array') {
          keys.add(`${node.name}/${f.name}`)
        }
      }
    }

    for (const v of node.variants) {
      fieldsOf.set(v.name, v.fields.map(f => f.name))

      for (const f of v.fields) {
        if (f.type.kind === 'array') {
          keys.add(`${v.name}/${f.name}`)
        }
      }
    }
  }

  if (!keys.size) {
    return keys
  }

  let walkers = false
  // the constructions that store a variable, checked against each task's owned locals below
  const stores: { fn: Extract<Statement, { form: 'function' }>; key: string; name: string }[] = []
  const isFresh = (value: Loose): boolean =>
    (value.form === 'array' && (value.items as unknown[]).length === 0) ||
    (value.form === 'record' && value.name === 'list' && (value.fields as unknown[]).length === 0) ||
    (value.form === 'call' && (value.callee as Loose).form === 'variable' && fresh.has((value.callee as Loose).name as string))

  // whether every mention of `local` in an arm's body only reads the list
  const readOnly = (body: Statement[], local: string): boolean => onlyReads(body, local, lend)
  // the forms a record of which is ever HELD whole by a name or read whole out of a slot: a local, a walk's item, a
  // parameter, or a slot read that is not the start of a field path. Slot-private (`privateForms`) allows a local read
  // out of a slot, which on an object backend is the same object as the slot's, so a write through the slot's path
  // reaches it while a Rust copy of the record would not: such a form keeps its lists shared when written through the
  // path. Found by meaning-native `record-list`'s `copied`, which Rust answered with the old value
  const held = new Set<string>()
  const formOf = (type: unknown): string | undefined => {
    const t = type as { kind?: string; name?: string } | undefined

    return t?.kind === 'named' ? t.name : undefined
  }
  const holds = (value: unknown, parent: Loose | undefined, key: string): void => {
    if (typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(v => holds(v, parent, key))

      return
    }

    const node = value as Loose
    const form = formOf(node.type)

    if (form && node.form === 'variable') {
      held.add(form)
    }

    if (form && node.form === 'member' && (node.index !== undefined || /^\d+$/.test(node.name as string)) && !(parent?.form === 'member' && key === 'target' && parent.index === undefined)) {
      held.add(form)
    }

    if (node.form === 'function') {
      for (const p of (node.params as { type?: unknown }[]) ?? []) {
        const name = formOf(p.type)

        if (name) {
          held.add(name)
        }
      }
    }

    for (const [k, child] of Object.entries(node)) {
      if (k !== 'type' && k !== 'span') {
        holds(child, node, k)
      }
    }
  }

  holds(program, undefined, '')
  // the key a path `r/field` names, when it reads a plain record's list field
  const pathKey = (node: Loose | undefined): string | undefined => {
    if (node?.form !== 'member' || node.index !== undefined) {
      return undefined
    }

    const type = (node.target as Loose).type as { kind?: string; name?: string } | undefined
    const key = type?.kind === 'named' && (variantsOf.get(type.name!) ?? ['x']).length === 0 ? `${type.name}/${node.name as string}` : undefined

    return key !== undefined && keys.has(key) ? key : undefined
  }

  const visit = (value: unknown, fn: Extract<Statement, { form: 'function' }> | undefined): void => {
    if (typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(v => visit(v, fn))

      return
    }

    const node = value as Loose

    if (node.form === 'call' && (node.callee as Loose).form === 'variable' && ((node.callee as Loose).name === 'fill-form' || (node.callee as Loose).name === 'melt-form')) {
      walkers = true
    }

    // a plain record's list field read through its path, in a place that only reads it: a slot, its size, a walk over
    // it, a lent read argument. The record under the path is visited; the path itself is not a refusal
    if (node.form === 'assign') {
      const target = node.target as Loose
      const at = pathKey(target) ?? (target.form === 'member' ? pathKey(target.target as Loose) : undefined)

      // a slot written through the path (`save ps/{k}/xs/{i}, v`) of a SLOT-PRIVATE form (`privateForms`): no second
      // name ever holds a record of it, so no copy could see the write either way, and the record's own list takes it
      // in place (Particle). Anything else written through the path, and any such write on a form that may be copied,
      // refuses the field
      const slotWrite = target.form === 'member' && (target.index !== undefined || /^\d+$/.test(target.name as string)) && pathKey(target.target as Loose)
      const form = slotWrite ? (((target.target as Loose).target as Loose).type as { name?: string } | undefined)?.name : undefined

      if (slotWrite && form && slotPrivate.has(form) && !held.has(form) && node.op === '=') {
        visit(((target.target as Loose).target as Loose), fn)
        visit(target.index, fn)
        visit(node.value, fn)

        return
      }

      if (at) {
        keys.delete(at)
      }
    }

    if (node.form === 'member' && (node.index !== undefined || /^\d+$/.test(node.name as string)) && pathKey(node.target as Loose)) {
      visit((node.target as Loose).target, fn)
      visit(node.index, fn)

      return
    }

    if (node.form === 'for-each' && pathKey(node.iterable as Loose)) {
      visit((node.iterable as Loose).target, fn)
      visit(node.body, fn)

      return
    }

    if (node.form === 'call' && (node.callee as Loose).form === 'variable') {
      const name = (node.callee as Loose).name as string
      const args = node.args as Loose[]
      const taken = lend.get(name)
      const reads = (a: Loose, i: number): boolean =>
        pathKey(a) !== undefined && ((name === 'list_size' && i === 0) || taken?.get(i) === 'read')

      if (args.some(reads)) {
        args.forEach((a, i) => visit(reads(a, i) ? a.target : a, fn))

        return
      }
    }

    // a plain record's list field read anywhere else through its path: refused
    if (node.form === 'member') {
      const at = pathKey(node)

      if (at) {
        keys.delete(at)
      }
    }

    // a construction: each list field given a fresh list, or a variable the task must own
    if (node.form === 'record' && fieldsOf.has(node.name as string)) {
      for (const f of node.fields as { name: string; value: Loose }[]) {
        const key = `${node.name as string}/${f.name}`

        if (!keys.has(key) || isFresh(f.value)) {
          continue
        }

        if (f.value.form === 'variable' && fn) {
          stores.push({ fn, key, name: f.value.name as string })
        } else {
          keys.delete(key)
        }
      }
    }

    // a path read of a list field off a value of the form: not handled
    if (node.form === 'member' && !node.index) {
      const type = ((node.target as Loose).type as { kind?: string; name?: string } | undefined)

      if (type?.kind === 'named') {
        for (const variant of variantsOf.get(type.name!) ?? []) {
          keys.delete(`${variant}/${node.name as string}`)
        }
      }
    }

    // an arm binding a list field: its local only read
    if (node.form === 'match') {
      for (const c of node.cases as { label: string; binds?: string[]; body: Statement[] }[]) {
        const fields = fieldsOf.get(c.label)

        if (!fields) {
          continue
        }

        for (const { field, local } of armLocals(fields, c.binds ?? [])) {
          const key = `${c.label}/${field}`

          if (keys.has(key) && !readOnly(c.body, local)) {
            keys.delete(key)
          }
        }
      }
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        visit(child, node.form === 'function' ? (node as Extract<Statement, { form: 'function' }>) : fn)
      }
    }
  }

  visit(program, undefined)

  if (walkers) {
    return new Set()
  }

  // a stored variable must be a local its task owns, given the fields still standing; dropping a field can only drop
  // more locals, so this settles
  for (let changed = true; changed; ) {
    changed = false
    const owned = new Map<object, Map<string, boolean>>()

    for (const store of stores) {
      if (!keys.has(store.key)) {
        continue
      }

      const locals = owned.get(store.fn) ?? ownedLocals(store.fn, fresh, lend, keys)
      owned.set(store.fn, locals)

      if (!locals.has(store.name)) {
        keys.delete(store.key)
        changed = true
      }
    }
  }

  return keys
}

// F1 for lists of lists (note/term/codegen/shared.md): the element types E for which every `list of list of E` in the
// program OWNS its inner lists, so a backend may hold each inner list as the plain list (`Vec<E>` on Rust) where it
// was a shared one. Decided per type, program-wide, since the inner representation is part of the outer list's type
// wherever it flows. Nothing can then tell an owned inner list from a shared one, because:
//   - every inner list put in is fresh: a fresh task's answer, an empty list, or an owned local handed in at its last
//     mention in its own block (`list_push(cells, near)` as the last thing done with `near`)
//   - every inner list taken out is only read (`onlyReads`): a slot bound to a local, or a walk's item, read by size,
//     slot, walk or a lent read argument
//   - an outer list is used only through its size, a push, a slot, a walk, a lent argument, an alias or a `send back`,
//     so no generic task ever holds one (and could hand an inner list on unchecked)
// `keyOf` names E as the backend spells it. Answers the keys, and the nodes the emitter reads them through: the `let`s
// bound to a slot, the walks, the inner lists put in, and the locals moved in.
// Measured first on Graph, a grid's adjacency lists searched breadth-first: 173 ms to 92 with the inner lists plain,
// the hand version 86 (`tmp/rust-graph-ab.ts`)
export type OwnedElements = {
  keys: Set<string>
  lets: WeakMap<object, string>
  walks: WeakMap<object, string>
  items: WeakMap<object, string>
  moves: WeakSet<object>
}

export function ownedElements(
  program: Statement[],
  fresh: Set<string>,
  lend: Map<string, Map<number, Lend>>,
  keyOf: (type: Type) => string,
): OwnedElements {
  type Loose = Record<string, unknown> & { form?: string; name?: string; type?: Type }
  type Fn = Extract<Statement, { form: 'function' }>
  const keys = new Set<string>()
  const refused = new Set<string>()
  const lets = new WeakMap<object, string>()
  const walks = new WeakMap<object, string>()
  const items = new WeakMap<object, string>()
  const moves = new WeakSet<object>()
  // the key of a list of lists, the key of the inner list one is, when the type is one
  const outer = (type: Type | undefined): string | undefined =>
    type?.kind === 'array' && type.element.kind === 'array' ? keyOf(type.element.element) : undefined
  const refuse = (key: string | undefined): void => {
    if (key !== undefined) {
      refused.add(key)
    }
  }
  const outerVar = (node: Loose | undefined): string | undefined => (node?.form === 'variable' ? outer(node.type) : undefined)
  const isFreshList = (value: Loose): boolean =>
    (value.form === 'array' && (value.items as unknown[]).length === 0) ||
    (value.form === 'record' && value.name === 'list' && (value.fields as unknown[]).length === 0) ||
    (value.form === 'call' && (value.callee as Loose).form === 'variable' && fresh.has((value.callee as Loose).name as string))
  // the locals handed in, checked once each task's statements are known
  const handed: { fn: Fn; name: string; node: object; key: string }[] = []
  // how many times a task binds a name: its parameters, its `let`s, its walks' items and indexes, its closures'
  // parameters, its arms' fields
  const bindings = (fn: Fn, name: string): number => {
    let count = fn.params.filter(p => p.name === name).length

    const visit = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) {
        return
      }

      if (Array.isArray(value)) {
        value.forEach(visit)

        return
      }

      const node = value as Loose & { item?: string; index?: unknown; params?: { name: string }[]; binds?: string[] }

      if (node.form === 'let' && node.name === name) count++
      if (node.form === 'for-each' && (node.item === name || node.index === name)) count++
      if (node.form === 'closure' && node.params?.some(p => p.name === name)) count++
      if (Array.isArray(node.binds) && node.binds.includes(name)) count++

      for (const [k, child] of Object.entries(node)) {
        if (k !== 'type' && k !== 'span') {
          visit(child)
        }
      }
    }

    visit(fn.body)

    return count
  }

  for (const node of program) {
    const key = outer((node as Loose).type)

    // a list of lists at module level is reachable from anywhere
    if (node.form === 'let' && key !== undefined) {
      refuse(key)
    }
  }

  // every task by name, for the parameter a lent outer list is handed to
  const tasks = new Map(program.flatMap(n => (n.form === 'function' ? [[n.name, n] as const] : [])))

  // a list of lists that reaches native code (`nativeForms`), anywhere inside a type a native call or a bodiless task
  // takes or answers, keeps its shared inner lists: a shim builds them in the host's own terms
  const records = new Map(program.flatMap(n => (n.form === 'record-type' ? [[n.name, n] as const] : [])))
  const seen = new Set<string>()
  const crossing = (type: Type | undefined): void => {
    if (!type) {
      return
    }

    refuse(outer(type))

    if (type.kind === 'array') {
      crossing(type.element)
    } else if (type.kind === 'map') {
      crossing(type.key)
      crossing(type.value)
    } else if (type.kind === 'function') {
      type.params.forEach(crossing)
      crossing(type.result)
    } else if (type.kind === 'named' && !seen.has(type.name)) {
      seen.add(type.name)
      const record = records.get(type.name)
      record?.fields.forEach(f => crossing(f.type))
      record?.variants.forEach(v => v.fields.forEach(f => crossing(f.type)))
      type.args?.forEach(crossing)
    }
  }
  const natives = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(natives)

      return
    }

    const node = value as Loose

    // a view's `call` node (`{ form: 'call', value }`) has no callee: the per-module emit meets views before they are
    // lowered, and every `term make` of a module holding one crashed here (face's layout-slot)
    if (node.form === 'call' && node.callee !== undefined && nativeCall(node.callee as Expression)) {
      ;(node.args as Loose[]).forEach(a => crossing(a.type))
      crossing(node.type)
    }

    if (node.form === 'function' && (node.body as unknown[]).length === 0) {
      ;(node.params as { type?: Type }[]).forEach(p => crossing(p.type))
      crossing((node as { result?: Type }).result)
    }

    for (const [k, child] of Object.entries(node)) {
      if (k !== 'type' && k !== 'span') {
        natives(child)
      }
    }
  }

  natives(program)

  // an inner list put into an outer one of `key`: fresh, or a local of the task handed in whole
  const putIn = (value: Loose, key: string, fn: Fn, visit: (v: unknown) => void): void => {
    if (isFreshList(value)) {
      items.set(value, key)

      if (value.form === 'call') {
        visit(value.args)
      }

      return
    }

    if (value.form === 'variable') {
      items.set(value, key)
      handed.push({ fn, name: value.name as string, node: value, key })

      return
    }

    refuse(key)
    visit(value)
  }

  const scan = (fn: Fn): void => {
    const visit = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) {
        return
      }

      if (Array.isArray(value)) {
        value.forEach(visit)

        return
      }

      const node = value as Loose

      switch (node.form) {
        case 'variable':
          // an outer list anywhere the cases below do not take it
          refuse(outer(node.type))

          return
        // an outer list WRITTEN OUT with its inner lists (`make list, make(list, 3, 8), ...`) builds each inner list as
        // a list of its own, and the walk over it was told they were plain: Rust walked `row.iter()` on a shared
        // `Rc<RefCell<Vec>>` and Swift `row.enumerated()` on a `SeedList`, neither of which builds (the loops guide's
        // grid search, 2026-10-05). An empty one puts nothing in, so it is left to the rules above
        case 'array':
          if ((node.items as unknown[]).length > 0) {
            refuse(outer(node.type))
          }

          break
        case 'member': {
          // an inner list read out of an outer one anywhere but a `let` (below)
          const key = outerVar(node.target as Loose)

          if (key !== undefined) {
            refuse(key)
            visit(node.index)

            return
          }

          break
        }
        case 'let': {
          const init = node.init as Loose
          const key = init.form === 'member' ? outerVar(init.target as Loose) : undefined

          if (key !== undefined && (init.index !== undefined || /^\d+$/.test(init.name as string))) {
            if (bindings(fn, node.name as string) === 1 && onlyReads(fn.body, node.name as string, lend, true)) {
              lets.set(node, key)
              keys.add(key)
            } else {
              refuse(key)
            }

            visit(init.index)

            return
          }

          // an alias of an outer list
          if (outerVar(init) !== undefined) {
            return
          }

          break
        }
        case 'for-each': {
          const key = outerVar(node.iterable as Loose)

          if (key !== undefined) {
            if (onlyReads(node.body as Statement[], node.item as string, lend)) {
              walks.set(node, key)
              keys.add(key)
            } else {
              refuse(key)
            }

            visit(node.body)

            return
          }

          break
        }
        case 'return':
          if (outerVar(node.value as Loose) !== undefined) {
            return
          }

          break
        case 'assign': {
          const target = node.target as Loose
          const key = target.form === 'member' ? outerVar(target.target as Loose) : undefined

          // an inner list written into a slot of an outer one
          if (key !== undefined && target.index !== undefined) {
            keys.add(key)
            visit(target.index)
            putIn(node.value as Loose, key, fn, visit)

            return
          }

          if (target.form === 'variable' && outer(target.type) !== undefined && outerVar(node.value as Loose) !== undefined) {
            return
          }

          break
        }
        case 'call': {
          const callee = node.callee as Loose
          const args = node.args as Loose[]
          const name = callee.form === 'variable' ? (callee.name as string) : undefined
          const key = outerVar(args[0])

          if (key !== undefined && name === 'list_size') {
            return
          }

          if (key !== undefined && name === 'list_push') {
            keys.add(key)
            putIn(args[1]!, key, fn, visit)

            return
          }

          if (callee.form === 'member') {
            const op = collectionCall(callee as Expression)
            const on = op && op.kind !== 'map' ? outerVar(op.target as Loose) : undefined

            if (on !== undefined && op!.op === 'push') {
              keys.add(on)
              putIn(args[0]!, on, fn, visit)

              return
            }
          }

          // an outer list at a position the task takes lent: its body is scanned for its own reads
          const taken = name !== undefined ? lend.get(name) : undefined

          if (taken) {
            const params = name !== undefined ? tasks.get(name)?.params : undefined

            args.forEach((a, i) => {
              const key = outerVar(a)

              if (!(key !== undefined && taken.has(i))) {
                visit(a)
              } else if (outer(params?.[i]?.type) !== key) {
                // the task's parameter holds its inner lists under another key, a type parameter's (`flatten`'s
                // `list (list t)`), so it keeps them shared, and a plain `[[Int]]` cannot be handed to it
                refuse(key)
              }
            })

            return
          }

          break
        }
      }

      for (const [k, child] of Object.entries(node)) {
        if (k !== 'type' && k !== 'span') {
          visit(child)
        }
      }
    }

    // a parameter that is an outer list is one of the program's, read by the same rules
    visit(fn.body)
  }

  for (const node of program) {
    if (node.form === 'function') {
      scan(node)
    }
  }

  // a form filled or melted is walked by a generated function that builds every inner list as the shared one
  const walked = (value: unknown): boolean => {
    if (typeof value !== 'object' || value === null) {
      return false
    }

    if (Array.isArray(value)) {
      return value.some(walked)
    }

    const node = value as Loose

    if (node.form === 'call' && (node.callee as Loose).form === 'variable' && ['fill-form', 'melt-form'].includes((node.callee as Loose).name as string)) {
      return true
    }

    return Object.entries(node).some(([k, child]) => k !== 'type' && k !== 'span' && walked(child))
  }

  if (walked(program)) {
    return { keys: new Set(), lets, walks, items, moves }
  }

  const mentions = (value: unknown, name: string): number => {
    if (typeof value !== 'object' || value === null) {
      return 0
    }

    if (Array.isArray(value)) {
      return value.reduce((n: number, v) => n + mentions(v, name), 0)
    }

    const node = value as Loose
    const here = node.form === 'variable' && node.name === name ? 1 : 0

    return here + Object.entries(node).reduce((n, [k, child]) => (k === 'type' || k === 'span' ? n : n + mentions(child, name)), 0)
  }
  const contains = (value: unknown, target: object): boolean => {
    if (value === target) {
      return true
    }

    if (typeof value !== 'object' || value === null) {
      return false
    }

    return Object.entries(value).some(([k, child]) => k !== 'type' && k !== 'span' && contains(child, target))
  }

  // a local handed in must be declared in the block that hands it in, fresh, mentioned once in the statement that
  // hands it in and never after, and owned by its task with that hand-off counted as its leaving
  // the statement lists a compound statement holds: its body, its arms, its handler
  const lists = (s: Statement): Statement[][] => {
    const node = s as unknown as Loose & {
      body?: Statement[]
      otherwise?: Statement[]
      branches?: { body: Statement[] }[]
      cases?: { body: Statement[] }[]
      catch?: { body: Statement[] }
    }

    return [
      ...(Array.isArray(node.body) ? [node.body] : []),
      ...(Array.isArray(node.otherwise) ? [node.otherwise] : []),
      ...(node.branches ?? []).map(b => b.body),
      ...(node.cases ?? []).map(c => c.body),
      ...(node.catch ? [node.catch.body] : []),
    ]
  }
  // the innermost statement list whose own statement holds `target`, not inside a compound one
  const block = (stmts: Statement[], target: object): Statement[] | undefined => {
    for (const s of stmts) {
      if (!contains(s, target)) {
        continue
      }

      const inner = lists(s)

      if (!inner.length) {
        return stmts
      }

      for (const list of inner) {
        const found = block(list, target)

        if (found) {
          return found
        }
      }

      // in the statement's own expression (a condition, a subject): not a place a local is handed in
      return undefined
    }

    return undefined
  }

  // dropping a key can refuse a local another hand-off relied on, so settle
  for (let changed = true; changed; ) {
    changed = false
    const standing = handed.filter(hand => !refused.has(hand.key))
    const now = new WeakSet<object>(standing.map(hand => hand.node))

    for (const hand of standing) {
      const stmts = block(hand.fn.body, hand.node)
      const at = stmts ? stmts.findIndex(s => contains(s, hand.node)) : -1
      const declared = stmts?.slice(0, at).some(s => s.form === 'let' && s.name === hand.name && isFreshList(s.init as Loose))
      const fine =
        stmts !== undefined &&
        declared &&
        mentions(stmts[at], hand.name) === 1 &&
        stmts.slice(at + 1).every(s => mentions(s, hand.name) === 0) &&
        ownedLocals(hand.fn, fresh, lend, new Set(), now).has(hand.name)

      if (!fine) {
        refuse(hand.key)
        changed = true
      }
    }
  }

  for (const key of refused) {
    keys.delete(key)
  }

  for (const hand of handed) {
    if (keys.has(hand.key)) {
      moves.add(hand.node)
    }
  }

  return { keys, lets, walks, items, moves }
}

// whether anything here assigns the variable itself (`save x, ...`), closures and nested blocks included. A write to a
// slot or field of it (`save x/f, ...`) does not count
export function assignsName(value: unknown, name: string): boolean {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  if (Array.isArray(value)) {
    return value.some(v => assignsName(v, name))
  }

  const node = value as Record<string, unknown> & { form?: string; target?: { form?: string; name?: string } }

  if (node.form === 'assign' && node.target?.form === 'variable' && node.target.name === name) {
    return true
  }

  return Object.entries(node).some(([key, child]) => key !== 'type' && key !== 'span' && assignsName(child, name))
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

      // the collection operation `list_push` inlines to, or any other that changes the list (`pop`, `splice`)
      const op = callee.form === 'member' ? collectionCall(callee as Expression) : undefined

      if (op?.kind === 'array' && named(op.target) && !['at', 'get', 'length', 'includes', 'indexOf', 'join'].includes(op.op)) {
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

  // a method that implements a mask's method: its signature is the trait's, shared with every other instance, so it
  // cannot change alone. A method of a form that no mask names (`list/get`) is an ordinary task with a dotted spelling
  const maskMethods = new Map<string, Set<string>>()

  for (const n of program) {
    if (n.form === 'mask') {
      maskMethods.set(n.name, new Set(n.methods))
    }
  }

  const traitBound = new Set<string>()

  for (const n of program) {
    if (n.form === 'instance') {
      for (const m of maskMethods.get(n.mask) ?? []) {
        traitBound.add(`${n.target}:${m}`)
      }
    }
  }

  const method = (n: Extract<Statement, { form: 'function' }>): boolean => {
    const of = (n as { method?: { form: string; name: string } }).method

    return of !== undefined && traitBound.has(`${of.form}:${of.name}`)
  }

  return program.filter(
    (n): n is Extract<Statement, { form: 'function' }> =>
      n.form === 'function' &&
      !n.async &&
      n.body.length > 0 &&
      !method(n) &&
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
// An APPEND to a text variable: `save s, text <{s}...>`, the variable itself the template's first part. On Rust, Swift
// and Kotlin the template built a new text holding a copy of the old one, so text built in a loop cost O(n) per turn
// and O(n^2) in all; an append writes in place instead (`push_str`, `+=`, a StringBuilder). Answers the variable and
// the template of what is appended
export function textAppend(node: Statement): { name: string; rest: Expression } | undefined {
  if (node.form !== 'assign' || node.op !== '=' || node.target.form !== 'variable' || node.value.form !== 'template') {
    return undefined
  }

  const [firstPart, ...rest] = node.value.parts
  const first = firstPart?.form === 'value' ? firstPart.value : undefined
  const name = node.target.name

  if (first?.form !== 'variable' || first.name !== name || !rest.length || first.type?.kind !== 'string') {
    return undefined
  }

  return { name, rest: { form: 'template', parts: rest, span: node.value.span, type: { kind: 'string' } } as Expression }
}

// what an append adds when it is one character read out of an ASCII text (`<{s}{char-at(t, i)}>`, ir/facts/text.ts):
// the text and the index, so a backend appends the one unit in place with no one-character text made for it
export function asciiCharAppend(
  rest: Expression,
  ascii: { has(node: Expression): boolean },
): { text: Expression; index: Expression } | undefined {
  const part = rest.form === 'template' && rest.parts.length === 1 ? rest.parts[0] : undefined
  const only = part?.form === 'value' ? part.value : undefined

  if (!only || only.form !== 'call' || only.callee.form !== 'member') {
    return undefined
  }

  const text = stringCall(only.callee)

  if (!text || !ascii.has(text.target) || (text.op !== 'charAt' && text.op !== 'at') || !only.args[0]) {
    return undefined
  }

  return { text: text.target, index: only.args[0] }
}

// A map entry updated from its own value, `set(m, k, get-or-default(m, k, d) + x)`: the counting update (`tally`,
// k-nucleotide). As written it hashes the key for the read and again for the write, and on Rust clones it for each.
// Every backend has the one-lookup form (Rust's entry, Swift's `default:` subscript, Kotlin's `merge`), so it is
// answered here once: the map and the key are names, the step a literal or a name (so nothing it reads can change
// the map between the read and the write), the read either spelling the simplifier leaves
// (`hash_get-or-default(m, k, d)`, or `maybe_unwrap-or(hash_get(m, k), d)` once that is inlined)
export type MapUpdate = { map: Expression; key: Expression; fallback: Expression; step: Expression }

export function mapUpdate(node: Statement): MapUpdate | undefined {
  const call = node.form === 'expression' ? node.expr : undefined

  if (call?.form !== 'call' || call.callee.form !== 'variable' || call.callee.name !== 'hash_set' || call.args.length !== 3) {
    return undefined
  }

  const [map, key, value] = call.args as [Expression, Expression, Expression]
  const plain = (e: Expression): boolean => e.form === 'variable' || e.form === 'integer' || e.form === 'float'

  if (map.form !== 'variable' || key.form !== 'variable' || value.form !== 'binary' || value.op !== '+') {
    return undefined
  }

  const same = (e: Expression | undefined, of: Expression): boolean => e?.form === 'variable' && of.form === 'variable' && e.name === of.name
  const read = (e: Expression): Expression | undefined => {
    if (e.form !== 'call' || e.callee.form !== 'variable') {
      return undefined
    }

    if (e.callee.name === 'hash_get-or-default' && same(e.args[0], map) && same(e.args[1], key) && e.args[2] && plain(e.args[2])) {
      return e.args[2]
    }

    const inner = e.args[0]

    if (
      e.callee.name === 'maybe_unwrap-or' &&
      inner?.form === 'call' &&
      inner.callee.form === 'variable' &&
      inner.callee.name === 'hash_get' &&
      same(inner.args[0], map) &&
      same(inner.args[1], key) &&
      e.args[1] &&
      plain(e.args[1])
    ) {
      return e.args[1]
    }

    return undefined
  }

  const left = read(value.left)
  const right = read(value.right)
  const fallback = left ?? right
  const step = left ? value.right : value.left

  if (!fallback || !plain(step) || same(step, map)) {
    return undefined
  }

  return { map, key, fallback, step }
}

// The tasks that only FILL a list: an empty list, a counter from 0 up to a size parameter, one push of the same item
// each turn, and the list handed back (sieve's and fannkuch-redux's `filled`). Every host makes such a list in one
// allocation, `vec![x; n]`, `[T](repeating:count:)`, `BooleanArray(n) { x }`, `new Array(n).fill(x)`, where pushing
// grew it, and on Kotlin built a boxed list that a fixed list then copied (AWFY's Sieve: 113 ms to 69). The item is a
// literal or a parameter, so it is one value made once. Each task to the parameter positions of its size and item, or
// the item itself when it is a literal
export type Fill = { size: number; item: number | Expression }

export function fillTasks(program: Statement[]): Map<string, Fill> {
  const out = new Map<string, Fill>()

  for (const fn of program) {
    if (fn.form !== 'function' || fn.async || fn.body.length !== 4) {
      continue
    }

    const [made, counter, loop, back] = fn.body as [Statement, Statement, Statement, Statement]
    const param = (e: Expression | undefined): number => (e?.form === 'variable' ? fn.params.findIndex(p => p.name === e.name) : -1)

    if (
      made.form !== 'let' ||
      made.init.form !== 'array' ||
      made.init.items.length ||
      counter.form !== 'let' ||
      counter.init.form !== 'integer' ||
      Number(counter.init.value) !== 0 ||
      loop.form !== 'while' ||
      back.form !== 'return' ||
      back.value?.form !== 'variable' ||
      back.value.name !== made.name
    ) {
      continue
    }

    const cond = loop.cond
    const size = cond.form === 'binary' && cond.op === '<' && cond.left.form === 'variable' && cond.left.name === counter.name ? param(cond.right) : -1
    const [push, step] = loop.body as [Statement | undefined, Statement | undefined]

    if (size < 0 || loop.body.length !== 2 || push?.form !== 'expression' || step?.form !== 'assign') {
      continue
    }

    const call = push.expr
    const pushed =
      call.form === 'call' && call.callee.form === 'member' && call.callee.name === 'push' && call.callee.target.form === 'variable' && call.callee.target.name === made.name
        ? call.args[0]
        : call.form === 'call' && call.callee.form === 'variable' && call.callee.name === 'list_push' && call.args[0]?.form === 'variable' && call.args[0].name === made.name
          ? call.args[1]
          : undefined
    const counted =
      step.target.form === 'variable' &&
      step.target.name === counter.name &&
      step.value.form === 'binary' &&
      step.value.op === '+' &&
      step.value.left.form === 'variable' &&
      step.value.left.name === counter.name &&
      step.value.right.form === 'integer' &&
      Number(step.value.right.value) === 1

    const literal = pushed && ['integer', 'float', 'boolean', 'string'].includes(pushed.form)
    const item = literal ? pushed : param(pushed)

    if (!counted || pushed === undefined || item === -1 || item === size) {
      continue
    }

    out.set(fn.name, { size, item: item as number | Expression })
  }

  return out
}

// a call to a fill task (`fillTasks`): the size and the item, as arguments of this call
export function fillCall(node: Expression, fills: Map<string, Fill>): { size: Expression; item: Expression } | undefined {
  if (node.form !== 'call' || node.callee.form !== 'variable') {
    return undefined
  }

  const fill = fills.get(node.callee.name)
  const size = fill ? node.args[fill.size] : undefined
  const item = fill ? (typeof fill.item === 'number' ? node.args[fill.item] : fill.item) : undefined

  return size && item ? { size, item } : undefined
}

// The tasks whose every call to themselves is a TAIL call, `send back, call <self>(..)`, each to the `return`s that make
// one: such a task is a loop (AWFY's List: `is-shorter` walks two lists by recursion, which JavaScript, having no
// tail-call elimination, ran as a call per step, 209 ms against 110 as a loop, `tmp/ts-list-ab.ts`). TypeScript writes
// the body inside `while (true)` and each tail call as the parameters rebound, Kotlin marks the task `tailrec`, which is
// the same transform made by its compiler. Only where that is plain: not async, not generic over a mask, every self
// call in a `return` that sits in no loop (a `continue` there would continue that loop), no closure and no guard
export function tailTasks(program: Statement[]): Map<string, WeakSet<object>> {
  const out = new Map<string, WeakSet<object>>()

  for (const fn of program) {
    if (fn.form !== 'function' || fn.async || !fn.body.length) {
      continue
    }

    const tails = new WeakSet<object>()
    let found = 0
    let ok = true

    const visit = (value: unknown, parent: unknown, inLoop: boolean): void => {
      if (!ok || typeof value !== 'object' || value === null) return
      if (Array.isArray(value)) return value.forEach(v => visit(v, parent, inLoop))

      const node = value as { form?: string; callee?: { form?: string; name?: string }; value?: unknown; args?: unknown[] }

      if (node.form === 'closure' || node.form === 'guard' || node.form === 'await') {
        // a self call in a closure or a guard is not one this can loop; elsewhere in either nothing matters
        if (JSON.stringify(node).includes(`"name":"${fn.name}"`)) ok = false

        return
      }

      const self = (e: unknown): boolean => {
        const call = e as { form?: string; callee?: { form?: string; name?: string }; args?: unknown[] } | undefined

        return call?.form === 'call' && call.callee?.form === 'variable' && call.callee.name === fn.name && call.args?.length === fn.params.length
      }

      if (node.form === 'return' && self(node.value) && !inLoop) {
        tails.add(node)
        found++
        // the arguments may not call the task again
        visit((node.value as { args: unknown[] }).args, node, inLoop)

        return
      }

      // any other mention of the task: a call not in tail position, or the task taken as a value
      if (node.form === 'variable' && (node as { name?: string }).name === fn.name) {
        ok = false

        return
      }

      const loop = inLoop || node.form === 'while' || node.form === 'for-each'

      for (const [key, child] of Object.entries(node)) {
        if (key !== 'type' && key !== 'span') visit(child, node, loop)
      }
    }

    visit(fn.body, undefined, false)

    if (ok && found) {
      out.set(fn.name, tails)
    }
  }

  return out
}

// the empty text, as a literal or a template with no parts (`text <>`)
export function emptyText(value: Expression | undefined): boolean {
  return (
    (value?.form === 'string' && value.value === '') ||
    (value?.form === 'template' && value.parts.every(part => part.form === 'chunk' && part.value === ''))
  )
}

// The text locals of a task that are only ever BUILT by appending (and reset to the empty text between builds, as a
// loop that builds one line at a time does): declared once, every write an append (`textAppend`),
// and never mentioned inside a closure, which could see the text change under it. Kotlin holds one as a
// StringBuilder, appends in place, and reads it with `toString()`: never worse than a copy per append, since every
// other read costs what one append used to
export function textBuilders(fn: Extract<Statement, { form: 'function' }>): Set<string> {
  type Loose = Record<string, unknown> & { form?: string }
  const lets = new Map<string, number>()
  const plainWrites = new Set<string>()
  const appended = new Set<string>()
  const captured = new Set<string>()

  const visit = (value: unknown, inClosure: boolean): void => {
    if (typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(v => visit(v, inClosure))

      return
    }

    const node = value as Loose

    if (node.form === 'let' && (((node.type ?? (node.init as Loose).type) as Type | undefined)?.kind === 'string')) {
      lets.set(node.name as string, (lets.get(node.name as string) ?? 0) + 1)
    }

    // an append, or a reset to the empty text (the builder's `setLength(0)`); any other write is a plain one
    if (node.form === 'assign' && (node.target as Loose).form === 'variable') {
      const append = textAppend(node as unknown as Statement)
      const name = (node.target as Loose).name as string

      if (append) {
        appended.add(name)
      } else if (!emptyText(node.value as Expression)) {
        plainWrites.add(name)
      }
    }

    if (inClosure && node.form === 'variable') {
      captured.add(node.name as string)
    }

    const closure = inClosure || node.form === 'closure'

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        visit(child, closure)
      }
    }
  }

  visit(fn.body, false)

  const params = new Set(fn.params.map(p => p.name))

  return new Set(
    [...appended].filter(name => lets.get(name) === 1 && !plainWrites.has(name) && !captured.has(name) && !params.has(name)),
  )
}

// The `let`s that declare again a name an earlier `let` in the same statement list declared, at the same type, where
// the task also assigns that name: two counted walks over `i` in one body each lower to a `let i` and a `while`. Rust
// shadows the first; TypeScript, Swift and Kotlin refuse a second declaration in one scope, so each writes the second
// as an assignment to the first, which is dead by then (every later read is of the second). The name being assigned
// is what makes the first a `let` / `var` there rather than a `const` / `let` / `val`
// a local declared by a bare `save x` and given its value by a later assignment: mutable, the unit placeholder as its
// initializer, and a type the checker filled from that assignment (check/infer.ts). A named type is left to each
// backend's module-slot path, and a type still open has nothing to declare it with
export function declaredLater(node: Statement): boolean {
  if (node.form !== 'let' || !node.mutable || node.init.form !== 'unit' || !node.type) {
    return false
  }

  return !['unit', 'named', 'variable', 'unknown', 'dynamic'].includes(node.type.kind)
}

export function redeclaredLets(fn: Extract<Statement, { form: 'function' }>): WeakSet<Statement> {
  type Loose = Record<string, unknown> & { form?: string }
  const assigned = new Set<string>()
  const lists: Loose[][] = []

  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      if (value.some(v => (v as Loose | null)?.form === 'let')) {
        lists.push(value as Loose[])
      }

      value.forEach(visit)

      return
    }

    const node = value as Loose

    if (node.form === 'assign' && (node.target as Loose).form === 'variable') {
      assigned.add((node.target as Loose).name as string)
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        visit(child)
      }
    }
  }

  visit(fn.body)

  const out = new WeakSet<Statement>()
  const typeOf = (s: Loose): string => JSON.stringify((s.type ?? (s.init as Loose | undefined)?.type) ?? null)

  for (const list of lists) {
    const seen = new Map<string, string>()

    for (const s of list) {
      if (s.form !== 'let' || s.foreign) {
        continue
      }

      const name = s.name as string

      if (seen.get(name) === typeOf(s) && assigned.has(name)) {
        out.add(s as unknown as Statement)
      } else if (!seen.has(name)) {
        seen.set(name, typeOf(s))
      }
    }
  }

  return out
}

// F4 `walked` (note/term/codegen/shared.md): the texts a task reads by position in a loop, each given a CURSOR, the
// code-point index of its last read and that code point's byte (Rust, Swift) or unit (Kotlin, TypeScript) offset. A
// read steps from the cursor, so a loop reading a text forward, or around one place (`i - 1`, `i + 1`), is O(1) per
// read where every read walked from the start (`chars().nth(i)`, `offsetBy`, a code-point count), O(n^2) over the
// loop. A text qualifies when it cannot change under its cursor and the cursor has one home:
//   - a parameter, or a `let` at the top of the task's body, nothing else in the task binds by that name
//   - never written in the task
//   - read by `char-at`, `at`, `char-code-at`, `substring` or `slice` at least once inside a loop, never inside a closure
//   - not ASCII (ir/facts/text.ts), where every read is already a direct index
// Every cursor is declared at the start of the task: it is two integers and never the text, so it holds for a `let`
// assigned later as well, being used only after it.
// The answer is the names, and each read through a cursor to its text's name
export type TextCursors = { names: string[]; reads: Map<object, string> }

const CURSOR_READS = new Set(['charAt', 'at', 'charCodeAt', 'substring', 'slice'])

export function textCursors(fn: Extract<Statement, { form: 'function' }>, ascii: { has(node: object): boolean }): TextCursors {
  type Loose = Record<string, unknown> & { form?: string }
  const candidates = new Set<string>([
    ...fn.params.filter(p => isText(p.type)).map(p => p.name),
    ...fn.body.flatMap(s => (s.form === 'let' && isText(s.type ?? s.init.type) ? [s.name] : [])),
  ])
  const binds = new Map<string, number>(fn.params.map(p => [p.name, 1]))
  const written = new Set<string>()
  const looped = new Set<string>()
  const closed = new Set<string>()
  const reads = new Map<object, string>()

  const bind = (name: string): void => {
    binds.set(name, (binds.get(name) ?? 0) + 1)
  }

  const visit = (value: unknown, loop: boolean, closure: boolean): void => {
    if (typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(v => visit(v, loop, closure))

      return
    }

    const node = value as Loose

    if (node.form === 'let') {
      bind(node.name as string)
    }

    if (node.form === 'for-each') {
      bind(node.item as string)
    }

    if (node.form === 'closure') {
      for (const p of node.params as { name: string }[]) {
        bind(p.name)
      }
    }

    if (node.form === 'match') {
      for (const c of node.cases as { binds?: string[] }[]) {
        for (const b of c.binds ?? []) {
          bind(b)
        }
      }
    }

    if (node.form === 'assign' && (node.target as Loose).form === 'variable') {
      written.add((node.target as Loose).name as string)
    }

    if (node.form === 'call') {
      const text = stringCall(node.callee as Expression)

      if (text && CURSOR_READS.has(text.op) && text.target.form === 'variable' && candidates.has(text.target.name) && !ascii.has(text.target)) {
        reads.set(node, text.target.name)

        if (closure) {
          closed.add(text.target.name)
        } else if (loop) {
          looped.add(text.target.name)
        }
      }
    }

    const inLoop = loop || node.form === 'while' || node.form === 'for-each'
    const inClosure = closure || node.form === 'closure'

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        visit(child, inLoop, inClosure)
      }
    }
  }

  visit(fn.body, false, false)

  const names = [...looped].filter(name => binds.get(name) === 1 && !written.has(name) && !closed.has(name))
  const kept = new Set(names)

  return { names, reads: new Map([...reads].filter(([, name]) => kept.has(name))) }
}

// D1 for records on the backends whose records are objects (TypeScript, Kotlin): where a copy must be made so a write
// through one name cannot reach another. A record is a value, so a task that writes a field of a record it was passed
// works on its own copy, and `save b, read a` followed by a field write through either name leaves the other as it was.
// Rust and Swift copy by construction and never read this.
//   - `params`: per task, the record parameters whose fields it writes (a field write whose base is the parameter, or
//     the parameter passed on at a position its callee writes), each with whether some written path is deeper than one
//     field (`t/inner/x`), which a one-level copy would not separate
//   - `lets`: the `let`s that alias a record (`save b, read a`) where either name is written through, same flag
// A `mark shared` form is a reference by design and is never copied.
//   - `plain`: the record forms all this reads, every one with fields that is not `mark shared` and has no variants
export type RecordCopies = { params: Map<string, Map<number, boolean>>; lets: Map<Statement, boolean>; plain: Set<string> }

// `context` is what a unit of the separate build imports (compile/separate.ts): a form declared in another module is a
// record all the same, and reading the unit alone left every alias of one uncopied (`save copy, one` then a field
// write through `copy` changed the caller's record, 2026-10-05)
export function recordCopies(program: Statement[], context: Statement[] = []): RecordCopies {
  type Fn = Extract<Statement, { form: 'function' }>
  type Loose = Record<string, unknown> & { form?: string }
  const plain = new Set(
    [...context, ...program].flatMap(n => (n.form === 'record-type' && !n.shared && n.fields.length && !n.variants.length ? [n.name] : [])),
  )
  const isRecord = (t: Type | undefined): boolean => t?.kind === 'named' && plain.has(t.name)
  const fns = program.filter((n): n is Fn => n.form === 'function')
  const params = new Map<string, Map<number, boolean>>()
  const lets = new Map<Statement, boolean>()

  // every field write in a body: its base variable and its depth
  const fieldWrites = (body: Statement[]): Map<string, boolean> => {
    const found = new Map<string, boolean>()
    const visit = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) {
        return
      }

      if (Array.isArray(value)) {
        value.forEach(visit)

        return
      }

      const node = value as Loose

      if (node.form === 'assign' && (node.target as Loose).form === 'member') {
        let at = node.target as Loose
        let depth = 0

        while (at.form === 'member') {
          // a slot of a list is not a field: the list's own facts hold it
          if (at.index !== undefined || /^\d+$/.test(at.name as string)) {
            depth = -1

            break
          }

          depth += 1
          at = at.target as Loose
        }

        if (depth > 0 && at.form === 'variable' && isRecord(at.type as Type)) {
          found.set(at.name as string, (found.get(at.name as string) ?? false) || depth > 1)
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

  // the parameters, to a fixpoint: one passed on at a written position is written here
  for (let changed = true; changed; ) {
    changed = false

    for (const fn of fns) {
      const written = fieldWrites(fn.body)
      const passOn = (value: unknown): void => {
        if (typeof value !== 'object' || value === null) {
          return
        }

        if (Array.isArray(value)) {
          value.forEach(passOn)

          return
        }

        const node = value as Loose

        if (node.form === 'call' && (node.callee as Loose).form === 'variable') {
          const target = params.get((node.callee as Loose).name as string)

          ;(node.args as Loose[]).forEach((arg, i) => {
            if (target?.has(i) && arg.form === 'variable') {
              written.set(arg.name as string, (written.get(arg.name as string) ?? false) || target.get(i)!)
            }
          })
        }

        for (const [key, child] of Object.entries(node)) {
          if (key !== 'type' && key !== 'span') {
            passOn(child)
          }
        }
      }

      passOn(fn.body)

      const mine = params.get(fn.name) ?? new Map<number, boolean>()

      fn.params.forEach((p, i) => {
        if (isRecord(p.type) && written.has(p.name) && mine.get(i) !== written.get(p.name)) {
          mine.set(i, (mine.get(i) ?? false) || written.get(p.name)!)
          changed = true
        }
      })

      if (mine.size) {
        params.set(fn.name, mine)
      }
    }
  }

  // the aliasing `let`s, per task: every name written through, by a field write or a callee, then each alias of one
  const walk = (value: unknown, see: (node: Loose) => void): void => {
    if (typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(v => walk(v, see))

      return
    }

    const node = value as Loose
    see(node)

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        walk(child, see)
      }
    }
  }

  for (const fn of fns) {
    const written = fieldWrites(fn.body)

    walk(fn.body, node => {
      if (node.form === 'call' && (node.callee as Loose).form === 'variable') {
        const target = params.get((node.callee as Loose).name as string)

        ;(node.args as Loose[]).forEach((arg, i) => {
          if (target?.has(i) && arg.form === 'variable') {
            written.set(arg.name as string, (written.get(arg.name as string) ?? false) || target.get(i)!)
          }
        })
      }
    })

    walk(fn.body, node => {
      if (node.form === 'let' && (node.init as Loose).form === 'variable' && isRecord((node.type ?? (node.init as Loose).type) as Type)) {
        const from = (node.init as Loose).name as string
        const to = node.name as string

        if (written.has(from) || written.has(to)) {
          lets.set(node as unknown as Statement, (written.get(from) ?? false) || (written.get(to) ?? false))
        }
      }
    })
  }

  return { params, lets, plain }
}

// The text parameters a task only READS AS TEXT: every mention a string method's receiver (`value/char-at`), a length
// read, or a part of a template, never rebound, never seen by a closure. Rust takes one as `&str`, so a caller lends
// its text where it cloned the String into every call: fasta's `char_at(alu.clone(), i)` copied 287 characters per
// character it read. Only a task the program itself calls: one called from outside (a harness, a host) is called with
// what that caller has, a String. And only the string operations that borrow their receiver on Rust: `pad-start` and
// `pad-end` take theirs by value
const OWNING = new Set(['padStart', 'padEnd'])

export function borrowedTexts(program: Statement[], gated: Extract<Statement, { form: 'function' }>[]): Map<string, Set<number>> {
  type Loose = Record<string, unknown> & { form?: string }
  const found = new Map<string, Set<number>>()
  const called = new Set<string>()
  const calls = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(calls)

      return
    }

    const node = value as Loose

    if (node.form === 'call' && (node.callee as Loose).form === 'variable') {
      called.add((node.callee as Loose).name as string)
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        calls(child)
      }
    }
  }

  calls(program)

  for (const fn of gated.filter(f => called.has(f.name))) {
    const bound = rebinds(fn.body)
    const at = new Set<number>()

    fn.params.forEach((p, i) => {
      if (p.type?.kind !== 'string' || bound.has(p.name)) {
        return
      }

      let ok = true
      const visit = (value: unknown, parent: Loose | undefined, key: string, inClosure: boolean): void => {
        if (!ok || typeof value !== 'object' || value === null) {
          return
        }

        if (Array.isArray(value)) {
          value.forEach(v => visit(v, parent, key, inClosure))

          return
        }

        const node = value as Loose

        if (node.form === 'variable' && node.name === p.name) {
          const op = parent?.form === 'member' ? hostMethod(parent.name as string) : ''
          const receiver =
            parent?.form === 'member' &&
            key === 'target' &&
            (stringRead(parent as Expression) !== undefined || (isStringMethod(op) && !OWNING.has(op)))
          // a value read inside a template: its parent is the part (compile/node.ts, `TemplatePart`)
          const part = parent?.form === 'value' && key === 'value'

          if (inClosure || !(receiver || part)) {
            ok = false
          }

          return
        }

        const closure = inClosure || node.form === 'closure'

        for (const [k, child] of Object.entries(node)) {
          if (k !== 'type' && k !== 'span') {
            visit(child, node, k, closure)
          }
        }
      }

      visit(fn.body, undefined, '', false)

      if (ok) {
        at.add(i)
      }
    })

    if (at.size) {
      found.set(fn.name, at)
    }
  }

  return found
}

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
    // a list field read through a borrowed record (`b/items`), which a walk or a lent read only reads
    const fieldList = (node: Loose | undefined): boolean =>
      node?.form === 'member' && node.index === undefined && named(node.target as Loose) !== undefined && (node.type as Type | undefined)?.kind === 'array'

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
        case 'for-each':
          // a walk over a list field of a borrowed record reads it in place; any other walk is visited whole (a bare
          // `break` here skipped the switch's default and visited nothing, which borrowed a set method that passes
          // its set on by value)
          if (fieldList(node.iterable as Loose)) {
            visit(node.body)
          } else {
            visit(node.iterable)
            visit(node.body)
          }

          return
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

          // a slot of a list field read through the borrowed record (`p/points/{i}`), a scalar out of it: reading
          // through a reference reads the list in place, plain or shared (Polygon's corners)
          const field = node.target as Loose

          if (
            (node.index !== undefined || /^\d+$/.test(node.name as string)) &&
            field.form === 'member' &&
            field.index === undefined &&
            named(field.target as Loose) &&
            (field.type as Type | undefined)?.kind === 'array' &&
            scalar(node.type as Type | undefined)
          ) {
            visit(node.index)

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

          // the size of a list field of a borrowed record
          if (callee.form === 'variable' && callee.name === 'list_size' && fieldList((node.args as Loose[])[0])) {
            return
          }

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

// A list GENERATED by a counted loop: `xs = []`, `i = <literal>`, `while (i < n) { push(xs, e); i = i + 1 }`, which a
// backend may make in one sized construction (Kotlin's `MutableList(n) { e }`, `Array(n) { e }`), running `e` for each
// index in the same order. Only where nothing can tell: `e` reads neither the list nor (through a closure) the counter,
// the bound is a literal or a name no closure writes, the counter is declared once in the task and mentioned nowhere
// after the loop, the list is never assigned whole, and the task has no guard (a raise inside `e` would otherwise leave
// a half-made list for a handler to see). The push is `list_push(xs, e)` or the collection operation it inlines to,
// `xs.push(e)`. A list of numbers is left to the caller, which keeps its own storage for them
export type ListGenerator = { list: string; counter: string; base: number; bound: Expression; item: Expression; type: Type; push: Expression }

export function listGenerator(body: Statement[], at: number, fn: Extract<Statement, { form: 'function' }> | undefined): ListGenerator | undefined {
  const made = body[at]
  const start = body[at + 1]
  const loop = body[at + 2]

  if (!fn || made?.form !== 'let' || start?.form !== 'let' || loop?.form !== 'while' || made.type?.kind !== 'array') {
    return undefined
  }

  const empty =
    (made.init.form === 'array' && made.init.items.length === 0) || (made.init.form === 'record' && made.init.name === 'list' && made.init.fields.length === 0)

  if (!empty || start.init.form !== 'integer' || start.name === made.name) {
    return undefined
  }

  const list = made.name
  const counter = start.name
  const cond = loop.cond

  if (cond.form !== 'binary' || cond.op !== '<' || cond.left.form !== 'variable' || cond.left.name !== counter) {
    return undefined
  }

  const bound = cond.right

  if (!(bound.form === 'integer' || (bound.form === 'variable' && bound.name !== counter && bound.name !== list))) {
    return undefined
  }

  const [push, step] = loop.body

  if (loop.body.length !== 2 || push?.form !== 'expression' || push.expr.form !== 'call') {
    return undefined
  }

  // `list_push(xs, e)`, or `xs.push(e)`
  const call = push.expr
  const direct = call.callee.form === 'variable' && call.callee.name === 'list_push' && call.args[0]?.form === 'variable' && call.args[0].name === list ? call.args[1] : undefined
  const op = call.callee.form === 'member' ? collectionCall(call.callee) : undefined
  const member = op?.kind === 'array' && op.op === 'push' && op.target.form === 'variable' && op.target.name === list && call.args.length === 1 ? call.args[0] : undefined
  const item = direct ?? member

  if (
    !item ||
    step?.form !== 'assign' ||
    step.op !== '=' ||
    step.target.form !== 'variable' ||
    step.target.name !== counter ||
    step.value.form !== 'binary' ||
    step.value.op !== '+' ||
    step.value.left.form !== 'variable' ||
    step.value.left.name !== counter ||
    step.value.right.form !== 'integer' ||
    Number(step.value.right.value) !== 1
  ) {
    return undefined
  }

  if (namesIn(item).has(list) || namesIn(body.slice(at + 3)).has(counter)) {
    return undefined
  }

  // the task as a whole: the counter declared once, no guard, the list never assigned whole, and no closure writing the
  // counter or the bound
  let lets = 0
  let refused = false
  const visit = (value: unknown, inClosure: boolean): void => {
    if (typeof value !== 'object' || value === null) return
    if (Array.isArray(value)) return value.forEach(v => visit(v, inClosure))
    const node = value as { form?: string; name?: string; target?: { form?: string; name?: string } }
    if (node.form === 'let' && node.name === counter) lets++
    if (node.form === 'guard') refused = true
    if (node.form === 'assign' && node.target?.form === 'variable' && node.target.name === list) refused = true
    if (inClosure && node.form === 'assign' && node.target?.form === 'variable' && (node.target.name === counter || (bound.form === 'variable' && node.target.name === bound.name))) {
      refused = true
    }
    for (const [key, child] of Object.entries(node)) if (key !== 'type' && key !== 'span') visit(child, inClosure || node.form === 'closure')
  }

  visit(fn.body, false)

  if (lets !== 1 || refused) {
    return undefined
  }

  return { list, counter, base: Number(start.init.value), bound, item, type: made.type, push: call }
}

// every generated list in a task (`listGenerator`), by the `let` that makes it
export function listGenerators(fn: Extract<Statement, { form: 'function' }>): Map<Statement, ListGenerator> {
  const found = new Map<Statement, ListGenerator>()
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return

    if (Array.isArray(value)) {
      value.forEach((_, at) => {
        const generator = listGenerator(value as Statement[], at, fn)

        if (generator) {
          found.set((value as Statement[])[at]!, generator)
        }
      })
      value.forEach(visit)

      return
    }

    for (const [key, child] of Object.entries(value)) if (key !== 'type' && key !== 'span') visit(child)
  }

  visit(fn.body)

  return found
}

// F1, the fixed-length slice: the lists a backend may hold as a plain primitive ARRAY (Kotlin's `LongArray`), which
// cannot grow. Measured first on Kotlin fannkuch-redux: the 64-bit hand version in term.tree's own shape over plain
// `LongArray`s ran 21% faster than the emitted program with every check stripped and direct storage access, so the
// list representation itself was the cost (tmp/kotlin-width-ab.ts, 2026-10-02).
//   - a LOCAL is fixed when it is owned (`ownedLocals`), its element passes `element`, it is made by a call to a fresh
//     task (so it starts full; `make list` starts empty and must grow), nothing in its task pushes onto it, and it is
//     never handed back
//   - a lent PARAMETER is fixed when its element passes `element` and EVERY call to its task passes, at that position, a
//     fixed local or a fixed parameter of the caller, or a call to a fresh task (converted once at the call)
//   - a local stays fixed only while every lend of it is to a fixed parameter
// The last two depend on each other, so they are solved together, dropping candidates until none drops.
export function fixedLists(
  program: Statement[],
  lend: Map<string, Map<number, Lend>>,
  fresh: Set<string>,
  element: (type: Type) => boolean,
  // whether a list a counted loop generates (`listGenerator`) counts as made full, for a backend that writes the
  // generator as one sized construction: it then starts full like a fresh task's answer, its one push the generator's
  generated = false,
): { locals: Map<string, Set<string>>; params: Map<string, Set<number>> } {
  type Fn = Extract<Statement, { form: 'function' }>
  type Loose = Record<string, unknown> & { form?: string }
  const fns = program.filter((n): n is Fn => n.form === 'function')
  const byName = new Map(fns.map(f => [f.name, f]))
  const locals = new Map<string, Set<string>>()
  const params = new Map<string, Set<number>>()

  // the candidate locals, per task
  for (const fn of fns) {
    if (fn.async) {
      continue
    }

    const owned = ownedLocals(fn, fresh, lend)
    const pushed = new Set<string>()
    const returned = new Set<string>()
    const lets = new Map<string, Loose>()
    // the generated lists, and the push each generator makes, which is not a push onto a full list
    const generators = generated ? listGenerators(fn) : new Map<Statement, ListGenerator>()
    const generatorPushes = new Set<object>([...generators.values()].map(g => g.push))
    const scan = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) {
        return
      }

      if (Array.isArray(value)) {
        value.forEach(scan)

        return
      }

      const node = value as Loose

      if (node.form === 'let') {
        lets.set(node.name as string, node)
      }

      if (node.form === 'call' && !generatorPushes.has(node)) {
        const callee = node.callee as Loose
        const first = (node.args as Loose[])[0]

        if (callee.form === 'variable' && callee.name === 'list_push' && first?.form === 'variable') {
          pushed.add(first.name as string)
        }

        // the collection operation `list_push` inlines to, `xs.push(v)`
        const op = callee.form === 'member' ? collectionCall(callee as Expression) : undefined

        if (op?.kind === 'array' && op.op === 'push' && (op.target as Loose).form === 'variable') {
          pushed.add((op.target as Loose).name as string)
        }
      }

      if (node.form === 'return' && (node.value as Loose | undefined)?.form === 'variable') {
        returned.add((node.value as Loose).name as string)
      }

      for (const [key, child] of Object.entries(node)) {
        if (key !== 'type' && key !== 'span') {
          scan(child)
        }
      }
    }

    scan(fn.body)

    const fixed = new Set(
      [...owned.keys()].filter(name => {
        const made = lets.get(name)
        const type = made?.type as Type | undefined
        const init = made?.init as Loose | undefined

        const madeFull =
          (init?.form === 'call' && (init.callee as Loose).form === 'variable' && fresh.has((init.callee as Loose).name as string)) ||
          (made !== undefined && generators.has(made as unknown as Statement))

        return type?.kind === 'array' && element(type.element) && madeFull && !pushed.has(name) && !returned.has(name)
      }),
    )

    if (fixed.size) {
      locals.set(fn.name, fixed)
    }
  }

  // the candidate parameters
  for (const [name, lent] of lend) {
    const fn = byName.get(name)

    if (!fn) {
      continue
    }

    const at = new Set(
      [...lent.keys()].filter(i => {
        const type = fn.params[i]?.type

        return type?.kind === 'array' && element(type.element)
      }),
    )

    if (at.size) {
      params.set(name, at)
    }
  }

  // every lending call: who calls, what, at which position, with what
  type Site = { caller: string; callee: string; at: number; arg: Loose }
  const sites: Site[] = []

  for (const fn of fns) {
    const visit = (value: unknown, inClosure: boolean): void => {
      if (typeof value !== 'object' || value === null) {
        return
      }

      if (Array.isArray(value)) {
        value.forEach(v => visit(v, inClosure))

        return
      }

      const node = value as Loose
      const inside = inClosure || node.form === 'closure'

      if (node.form === 'call' && (node.callee as Loose).form === 'variable') {
        const callee = (node.callee as Loose).name as string
        const lent = lend.get(callee)

        for (const [i, arg] of (node.args as Loose[]).entries()) {
          if (lent?.has(i)) {
            // an argument inside a closure is never a caller's fixed list: mark it as nothing the caller holds
            sites.push({ caller: inside ? '' : fn.name, callee, at: i, arg })
          }
        }
      }

      for (const [key, child] of Object.entries(node)) {
        if (key !== 'type' && key !== 'span') {
          visit(child, inside)
        }
      }
    }

    visit(fn.body, false)
  }

  // drop until stable
  const fixedArg = (site: Site): boolean => {
    const arg = site.arg

    if (arg.form === 'call' && (arg.callee as Loose).form === 'variable' && fresh.has((arg.callee as Loose).name as string)) {
      return true
    }

    if (arg.form !== 'variable' || !site.caller) {
      return false
    }

    const name = arg.name as string
    const caller = byName.get(site.caller)
    const index = caller?.params.findIndex(p => p.name === name) ?? -1

    return locals.get(site.caller)?.has(name) === true || (index >= 0 && params.get(site.caller)?.has(index) === true)
  }

  let changed = true

  while (changed) {
    changed = false

    for (const [name, at] of params) {
      for (const i of [...at]) {
        if (!sites.filter(s => s.callee === name && s.at === i).every(fixedArg)) {
          at.delete(i)
          changed = true
        }
      }

      if (!at.size) {
        params.delete(name)
      }
    }

    for (const site of sites) {
      const arg = site.arg

      if (arg.form === 'variable' && site.caller && locals.get(site.caller)?.has(arg.name as string) && !params.get(site.callee)?.has(site.at)) {
        locals.get(site.caller)!.delete(arg.name as string)
        changed = true
      }

      // a fixed PARAMETER passed on the same way: `count-each`'s dense guard took `values` as a `LongArray` and handed
      // it to `is-every-within`, whose `values` is a list
      const index = arg.form === 'variable' && site.caller ? (byName.get(site.caller)?.params.findIndex(p => p.name === arg.name) ?? -1) : -1

      if (index >= 0 && params.get(site.caller)?.has(index) && !params.get(site.callee)?.has(site.at)) {
        params.get(site.caller)!.delete(index)

        if (!params.get(site.caller)!.size) {
          params.delete(site.caller)
        }

        changed = true
      }
    }
  }

  return { locals, params }
}

// the list parameters each task takes lent (`listFacts`), with the gate every emitter uses: a trait's methods are
// never lent. For a fact that needs to know which calls can change no list's length (`boundedLoops`)
export function lentLists(program: Statement[]): Map<string, Map<number, Lend>> {
  const maskMethods = new Set(program.flatMap(n => (n.form === 'mask' ? n.methods : [])))

  return listFacts(program, gatedTasks(program, maskMethods)).lend
}

// The tasks that reach a list only through their arguments, though they may make and use lists of their own: no
// module-level name mentioned that could hold a list, and every call made to another such task, a scalar one, a native
// call or a collection operation. `lendableParams` gives one only list-free arguments and lists of the caller's own, so
// a list lent across the call cannot be seen twice. `scalarTasks` asks the stronger question, whether a task touches
// any list at all, and refused `zeros(n)` and `list_push(kids, ..)` in AWFY's Storage, which kept `build`'s generator
// state a shared cell. Solved optimistically and dropped until stable
export function isolatedTasks(program: Statement[], free: (type: unknown) => boolean): Set<string> {
  type Loose = Record<string, unknown> & { form?: string; name?: string }
  const fns = program.filter((n): n is Extract<Statement, { form: 'function' }> => n.form === 'function')
  const tasks = new Set(fns.map(f => f.name))
  // module-level names a list could be reached through
  const globals = new Set(program.flatMap(n => (n.form === 'let' && !free(n.type) ? [n.name] : [])))
  const scalar = scalarTasks(program as Program)
  const out = new Set(fns.map(f => f.name))

  const fits = (fn: Extract<Statement, { form: 'function' }>): boolean => {
    const own = new Set(fn.params.map(p => p.name))
    letNames(fn.body, own)
    let fine = true

    const visit = (value: unknown): void => {
      if (!fine || typeof value !== 'object' || value === null) {
        return
      }

      if (Array.isArray(value)) {
        value.forEach(visit)

        return
      }

      const node = value as Loose

      if (node.form === 'variable' && globals.has(node.name as string) && !own.has(node.name as string)) {
        fine = false

        return
      }

      if (node.form === 'call') {
        const callee = node.callee as Loose
        const name = callee.form === 'variable' ? (callee.name as string) : undefined

        // a call to a task outside the set, or to a function value (a parameter or a local) whose body is unknown
        if (name !== undefined && tasks.has(name) && !own.has(name) && !out.has(name) && !scalar.has(name)) {
          fine = false

          return
        }

        if (name !== undefined && own.has(name)) {
          fine = false

          return
        }
      }

      for (const [key, child] of Object.entries(node)) {
        if (key !== 'type' && key !== 'span') {
          visit(child)
        }
      }
    }

    visit(fn.body)

    return fine
  }

  for (let changed = true; changed; ) {
    changed = false

    for (const fn of fns) {
      if (out.has(fn.name) && !fits(fn)) {
        out.delete(fn.name)
        changed = true
      }
    }
  }

  return out
}

// F1's program-wide facts, the same on every backend that reads them: which list parameter each gated task takes
// lent, and which tasks answer a fresh list
export function listFacts(
  program: Statement[],
  gated: Extract<Statement, { form: 'function' }>[],
): { lend: Map<string, Map<number, Lend>>; fresh: Set<string> } {
  const tasks = new Set(program.flatMap(n => (n.form === 'function' ? [n.name] : [])))
  const free = listFree(program as Program)
  const pure = new Set([...scalarTasks(program as Program), ...isolatedTasks(program, free)])
  // optimistic start: every gated task's list parameters, read only. Each round recomputes every task against the
  // others' current answer, so a task passing a list on stays lent while its callee does, and a mode only strengthens
  let lend = new Map<string, Map<number, Lend>>(
    gated.flatMap(fn => {
      const at = fn.params.flatMap((p, i) => (p.type?.kind === 'array' ? [[i, 'read' as Lend] as const] : []))

      return at.length ? [[fn.name, new Map(at)] as const] : []
    }),
  )
  const refused = new Set<string>()

  for (;;) {
    let changed = true

    while (changed) {
      changed = false

      for (const fn of gated) {
        if (refused.has(fn.name)) {
          continue
        }

        const now = lendableParams(fn, tasks, lend, pure, free)
        const was = lend.get(fn.name)
        const same = was !== undefined && was.size === now.size && [...now].every(([i, how]) => was.get(i) === how)

        if (!same && (now.size || was)) {
          if (now.size) {
            lend.set(fn.name, now)
          } else {
            lend.delete(fn.name)
          }

          changed = true
        }
      }
    }

    const fresh = freshTasks(gated, lend)
    const bad = lendRefusals(program, lend, fresh)

    if (!bad.size) {
      return { lend, fresh }
    }

    for (const name of bad) {
      refused.add(name)
      lend.delete(name)
    }

    lend = new Map(lend)
  }
}

// The tasks some call to which cannot lend its lists safely, so must take them shared. A call that lends with any
// position WRITTEN must pass lists that cannot be one list: each argument at a lent position is an owned local of the
// caller (a plain Vec, unique storage), a call to a fresh task, or a lent parameter of the caller (Rust's borrow rules
// already keep two of those apart). At most one argument may be a shared cell, and no name may be passed twice. Lends
// that only read may alias freely: two shared borrows of one list are fine
function lendRefusals(program: Statement[], lend: Map<string, Map<number, Lend>>, fresh: Set<string>): Set<string> {
  type Fn = Extract<Statement, { form: 'function' }>
  type Loose = Record<string, unknown> & { form?: string }
  const bad = new Set<string>()

  for (const fn of program.filter((n): n is Fn => n.form === 'function')) {
    const owned = fn.async ? new Map<string, boolean>() : ownedLocals(fn, fresh, lend)
    const mine = lend.get(fn.name)
    const lentHere = new Set(fn.params.flatMap((p, i) => (mine?.has(i) ? [p.name] : [])))

    const visit = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) {
        return
      }

      if (Array.isArray(value)) {
        value.forEach(visit)

        return
      }

      const node = value as Loose

      if (node.form === 'call' && (node.callee as Loose).form === 'variable') {
        const callee = (node.callee as Loose).name as string
        const lent = lend.get(callee)
        const args = node.args as Loose[]

        if (lent && [...lent.values()].includes('write') && lent.size > 1) {
          const at = [...lent.keys()].map(i => args[i]).filter((a): a is Loose => a !== undefined)
          const named = at.flatMap(a => (a.form === 'variable' ? [a.name as string] : []))
          const plain = (a: Loose): boolean =>
            (a.form === 'variable' && (owned.has(a.name as string) || lentHere.has(a.name as string))) ||
            (a.form === 'call' && (a.callee as Loose).form === 'variable' && fresh.has((a.callee as Loose).name as string))
          const cells = at.filter(a => !plain(a)).length

          if (new Set(named).size !== named.length || cells > 1) {
            bad.add(callee)
          }
        }
      }

      for (const [key, child] of Object.entries(node)) {
        if (key !== 'type' && key !== 'span') {
          visit(child)
        }
      }
    }

    visit(fn.body)
  }

  return bad
}

// A SLOT TAKEN AT ITS LAST READ. `host top, read piles/{pile}` copied the slot out (an `Rc` bump for a node, a deep copy
// for a text), and when the slot was written again the old value was dropped: a node read and written back was never
// unique, so `Rc::unwrap_or_clone` cloned where it could move and a box was freed and made again on every step. Here
// the local is the slot itself until its last read, which TAKES it (`std::mem::replace` with a field-less case), so
// the value moves out whole. Two shapes, each in one block of a task:
//   - the last read inside the value written straight back to the same slot (`save piles/{pile}, make disk / bind
//     below, read top`): the earlier reads see the slot through a reference
//   - the last read the subject of a match whose every arm either is the placeholder case (the slot then holds what it
//     held) or writes the slot first (`case disk` / `save piles/{pile}, read below`)
// A raise between the take and the write would leave the placeholder where the value was, so nothing between them
// may raise: the value written back holds no call, and nothing between the `let` and the last read mentions the list.
// Earlier reads are only a match's subject or a `top/field` read, which a reference serves. The list is one the task
// holds as a plain `Vec` or slice (`lists`), the index a literal or a name nothing assigns
// `form` and `empty` name the placeholder, the form's field-less case written into the slot by the take
export type SlotTake = { list: string; index: Expression; form: string; empty: string }

export function slotTakes(
  body: Statement[],
  lists: (name: string) => boolean,
  last: WeakSet<object>,
  // the field-less case of the form a local holds, when it has one
  placeholder: (type: Type | undefined) => { form: string; empty: string } | undefined,
  // the locals held some other way (a mutated capture's cell)
  held: Set<string>,
): { lets: WeakMap<object, SlotTake & { kept: boolean }>; takes: WeakMap<object, SlotTake> } {
  const lets = new WeakMap<object, SlotTake & { kept: boolean }>()
  const takes = new WeakMap<object, SlotTake>()
  type Loose = Record<string, unknown> & { form?: string; name?: string }

  // every place a name is read, with its parent, so the reads before the last can be checked for their shape
  const reads = (value: unknown, name: string, parent: Loose | undefined, into: { node: Loose; parent: Loose | undefined }[]): void => {
    if (typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(v => reads(v, name, parent, into))

      return
    }

    const node = value as Loose

    if (node.form === 'variable' && node.name === name) {
      into.push({ node, parent })
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        reads(child, name, node, into)
      }
    }
  }
  const has = (value: unknown, form: string): boolean => {
    if (typeof value !== 'object' || value === null) {
      return false
    }

    if (Array.isArray(value)) {
      return value.some(v => has(v, form))
    }

    const node = value as Loose

    return node.form === form || Object.entries(node).some(([key, child]) => key !== 'type' && key !== 'span' && has(child, form))
  }
  const sameIndex = (a: Expression, b: Expression): boolean =>
    (a.form === 'variable' && b.form === 'variable' && a.name === b.name) ||
    (a.form === 'integer' && b.form === 'integer' && Number(a.value) === Number(b.value))
  // a list slot `xs/{i}` or `xs/0` off one of the lists, as its list and index
  const slot = (node: Expression): { list: string; index: Expression } | undefined => {
    if (node.form !== 'member' || node.target.form !== 'variable' || node.target.type?.kind !== 'array' || !lists(node.target.name)) {
      return undefined
    }

    if (node.index && (node.index.form === 'variable' || node.index.form === 'integer')) {
      return { list: node.target.name, index: node.index }
    }

    return /^\d+$/.test(node.name) ? { list: node.target.name, index: { form: 'integer', value: Number(node.name), span: node.span, type: { kind: 'number' } } as Expression } : undefined
  }
  // the first statement of an arm writing the slot back, with nothing in its value that could raise
  const writesBack = (s: Statement | undefined, at: { list: string; index: Expression }): boolean => {
    if (s?.form !== 'assign' || s.op !== '=') {
      return false
    }

    const target = slot(s.target)

    return target !== undefined && target.list === at.list && sameIndex(target.index, at.index) && !has(s.value, 'call') && !has(s.value, 'await') && !namesIn(s.value).has(at.list)
  }

  const block = (stmts: Statement[]): void => {
    stmts.forEach((s, a) => {
      if (s.form === 'let') {
        const at = slot(s.init)
        const fill = placeholder(s.type)

        if (at && fill && !held.has(s.name) && !assignsName(body, s.name) && (at.index.form !== 'variable' || (at.index.name !== s.name && !assignsName(body, at.index.name)))) {
          check(stmts, a, s, at, fill)
        }
      }

      // the arms of a branch are blocks of their own, and so is a loop's body for the names it declares (`lastReads`
      // finds their last read there; the take is made at that read, so a turn that leaves early has taken nothing)
      if (s.form === 'if') {
        s.branches.forEach(b => block(b.body))
        if (s.otherwise) block(s.otherwise)
      } else if (s.form === 'match') {
        s.cases.forEach(c => block(c.body))
        if (s.otherwise) block(s.otherwise)
      } else if (s.form === 'while' || s.form === 'for-each') {
        block(s.body)
      }
    })
  }

  const check = (stmts: Statement[], a: number, s: Extract<Statement, { form: 'let' }>, at: { list: string; index: Expression }, fill: { form: string; empty: string }): void => {
    const rest = stmts.slice(a + 1)
    // the statement holding the last read: found by the node `lastReads` chose, at this block's level
    const b = rest.findIndex(t => {
      const found: { node: Loose; parent: Loose | undefined }[] = []
      reads(t, s.name, undefined, found)

      return found.some(f => last.has(f.node))
    })

    if (b < 0) {
      return
    }

    const end = rest[b]!
    const between = rest.slice(0, b)

    // nothing between the let and the last read touches the list, so the slot still holds the value
    if (between.some(t => namesIn(t).has(at.list))) {
      return
    }

    // every earlier read is a match subject or a field read, which a reference serves
    const earlier: { node: Loose; parent: Loose | undefined }[] = []
    reads(between, s.name, undefined, earlier)
    const servable = earlier.every(({ node, parent }) =>
      (parent?.form === 'match' && parent.subject === node) || (parent?.form === 'member' && parent.target === node && !parent.index),
    )

    if (!servable) {
      return
    }

    const take: SlotTake = { list: at.list, index: at.index, ...fill }

    // the value written back to the slot holds the last read
    if (end.form === 'assign' && writesBack(end, at)) {
      const found: { node: Loose; parent: Loose | undefined }[] = []
      reads(end.value, s.name, undefined, found)

      if (found.length === 1 && last.has(found[0]!.node)) {
        lets.set(s, { ...take, kept: earlier.length > 0 })
        takes.set(found[0]!.node, take)
      }

      return
    }

    // the last read is a match's subject, and every arm is the placeholder's case or writes the slot first
    if (end.form === 'match' && end.subject.form === 'variable' && end.subject.name === s.name && last.has(end.subject)) {
      const fine =
        !end.otherwise &&
        end.cases.every(c => c.label === fill.empty || writesBack(c.body[0], at))

      if (fine) {
        lets.set(s, { ...take, kept: earlier.length > 0 })
        takes.set(end.subject, take)
      }
    }
  }

  block(body)

  return { lets, takes }
}

// MOVE ON LAST USE, by node: `moveOnLastUse` moves a name read once in the whole task, and a name read twice was cloned
// at both reads. Here the LAST read of a name moves however many came before: the read that is the only mention of
// its name in the last statement of a block to mention it, outside any loop, closure or guard inside that statement,
// with nothing after the block mentioning it either. An `if` or `match` that is that last statement passes the question
// into each arm, since one arm runs. Answers the variable nodes themselves, so only that read moves; the emitter
// still decides by type and by how the name is held whether a move is legal there (`lastMove`). Towers' `push-disk`
// read a pile's top for its size and then built the new node with it, `Rc::new(top.clone())`
// `many`, when given, gets each read that is the LAST of several reads of its name inside one statement, in evaluation
// order (a call's callee, then its arguments left to right): a backend may move it when every earlier one there was a
// copy, which only the backend knows (rust.ts, `owned`). Rust List's `tail(rest(z), x, y)` cloned each a third time
export function lastReads(body: Statement[], many?: WeakSet<object>): WeakSet<object> {
  const out = new WeakSet<object>()
  type Loose = Record<string, unknown> & { form?: string; name?: string }
  // every variable node naming each name, and whether any sits inside a loop, closure or guard
  const mentions = (value: unknown, into: Map<string, { nodes: object[]; held: boolean }>, held: boolean): void => {
    if (typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(v => mentions(v, into, held))

      return
    }

    const node = value as Loose

    if (node.form === 'variable' && typeof node.name === 'string') {
      const seen = into.get(node.name) ?? { nodes: [], held: false }
      seen.nodes.push(node)
      seen.held ||= held
      into.set(node.name, seen)
    }

    // a closure is a `Fn` (a move out of a capture is refused), and a loop or a guard's closure re-runs its reads
    const inner = held || node.form === 'closure' || node.form === 'while' || node.form === 'for-each' || node.form === 'guard'

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        mentions(child, into, inner)
      }
    }
  }

  // how many times each name is declared in the task, so a name declared once inside a loop's body is that turn's own
  const declared = new Map<string, number>()
  const countLets = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return
    if (Array.isArray(value)) return value.forEach(countLets)
    const node = value as Loose
    if (node.form === 'let') declared.set(node.name as string, (declared.get(node.name as string) ?? 0) + 1)
    for (const [key, child] of Object.entries(node)) if (key !== 'type' && key !== 'span') countLets(child)
  }

  countLets(body)

  const block = (stmts: Statement[], later: Set<string>): void => {
    const after = new Set(later)

    for (let k = stmts.length - 1; k >= 0; k--) {
      const s = stmts[k]!
      const here = new Map<string, { nodes: object[]; held: boolean }>()
      mentions(s, here, false)

      // a loop's body is a block of its own for the names it alone declares, each a new binding every turn, so its last
      // read there is the last. Every other name the loop mentions is read again by the next turn, so is never last
      if (s.form === 'while' || s.form === 'for-each') {
        const own = new Set<string>()
        const collectOwn = (value: unknown): void => {
          if (typeof value !== 'object' || value === null) return
          if (Array.isArray(value)) return value.forEach(collectOwn)
          const node = value as Loose
          if (node.form === 'let' && declared.get(node.name as string) === 1) own.add(node.name as string)
          if (node.form === 'closure') return
          for (const [key, child] of Object.entries(node)) if (key !== 'type' && key !== 'span') collectOwn(child)
        }

        collectOwn(s.body)
        block(s.body, new Set([...after, ...[...here.keys()].filter(name => !own.has(name))]))
      }

      if (s.form === 'if' || s.form === 'match') {
        // the conditions or the subject are read before any arm, so a name there is not last in an arm
        const front = new Map<string, { nodes: object[]; held: boolean }>()
        mentions(s.form === 'if' ? s.branches.map(b => b.cond) : s.subject, front, false)
        const arms = s.form === 'if' ? [...s.branches.map(b => b.body), ...(s.otherwise ? [s.otherwise] : [])] : [...s.cases.map(c => c.body), ...(s.otherwise ? [s.otherwise] : [])]
        // what is read after an arm: nothing past the statement when the arm ends in a `return` or a raise, since the
        // task has left; a match's subject names besides, which may stay borrowed through the arm. An `if`'s
        // conditions are done before any arm runs, so they are read before it, never after
        const subjectNames = s.form === 'match' ? [...front.keys()] : []
        const armLater = (arm: Statement[]): Set<string> => {
          const end = arm[arm.length - 1]

          return end?.form === 'return' || end?.form === 'throw' ? new Set(subjectNames) : new Set([...after, ...subjectNames])
        }
        arms.forEach(arm => block(arm, armLater(arm)))

        // a subject no arm mentions is read last as the subject: matched by value, its fields move out
        const inArms = new Map<string, { nodes: object[]; held: boolean }>()
        mentions(arms, inArms, false)

        if (s.form === 'match' && s.subject.form === 'variable') {
          const seen = front.get(s.subject.name)

          if (!after.has(s.subject.name) && !inArms.has(s.subject.name) && seen?.nodes.length === 1) {
            out.add(s.subject)
          }
        }
      } else if (s.form === 'let' || s.form === 'assign' || s.form === 'expression' || s.form === 'return') {
        // an assignment's target is written, never moved: no name in it moves here
        const written = new Map<string, { nodes: object[]; held: boolean }>()

        if (s.form === 'assign') {
          mentions(s.target, written, false)
        }

        for (const [name, seen] of here) {
          if (!after.has(name) && !written.has(name) && !seen.held && seen.nodes.length === 1) {
            out.add(seen.nodes[0]!)
          } else if (many && !after.has(name) && !written.has(name) && !seen.held && seen.nodes.length > 1) {
            many.add(seen.nodes[seen.nodes.length - 1]!)
          }
        }
      }

      here.forEach((_, name) => after.add(name))
    }
  }

  block(body, new Set())

  return out
}
