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
  'includes',
  'indexOf',
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
])

export type StringOp = { target: Expression; op: string }

// the member name as the host spells it: the stdlib writes `call value/char-at`, the JavaScript method is `charAt`
function hostMethod(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

// a native string METHOD CALL (`value.charAt(i)`) on a text receiver
// is the value a text? The primitive, or the stdlib's `text` form named as such
function isText(type: { kind: string; name?: string } | undefined): boolean {
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
        // shadow for just the same
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
