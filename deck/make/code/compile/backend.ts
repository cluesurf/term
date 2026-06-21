import type { Expression } from '@cluesurf/make/code/compile/node'

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
  if (callee.form !== 'member') {return undefined}

  const kind = callee.target.type?.kind

  if (kind === 'map' && MAP_METHODS.has(callee.name)) {
    return { target: callee.target, op: callee.name, kind: 'map' }
  }

  if (kind === 'array' && ARRAY_METHODS.has(callee.name)) {
    return { target: callee.target, op: callee.name, kind: 'array' }
  }

  return undefined
}

// a native collection PROPERTY READ (`map.size`, `array.length`) on a map/array receiver
export function collectionRead(
  node: Expression,
): CollectionOp | undefined {
  if (node.form !== 'member') {return undefined}

  const kind = node.target.type?.kind

  if (kind === 'map' && node.name === 'size') {
    return { target: node.target, op: 'size', kind: 'map' }
  }

  if (kind === 'array' && node.name === 'length') {
    return { target: node.target, op: 'length', kind: 'array' }
  }

  return undefined
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

// A target that cannot express a form (a GPU shader cannot throw; bare LLVM has no managed map) emits this marker
// instead of silently dropping or miscompiling the construct. The marker is a comment in the target's syntax, so the
// generated source still parses but the gap is visible and greppable (SEED-UNSUPPORTED), never silent.
export function unsupported(
  target: string,
  form: string,
  comment: string,
): string {
  return `${comment} SEED-UNSUPPORTED on ${target}: "${form}" is outside this target's fragment`
}
