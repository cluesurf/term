// The TypeScript runtime the emitted code calls (the `RT` module). It is the canonical value-op library: the
// emitted program uses native JS control flow and functions, and these calls for everything ternary / aggregate.
// Reuses the engine's shared ops, so compiled output computes identically to the interpreter (the oracle).

import {
  binary,
  indexGet,
  memberGet,
} from '@term/make/code/engine/engine'
import {
  type Value,
  makeUnit,
  integer as mkInt,
  float as mkFloat,
  boolean as mkBool,
  string as mkStr,
  truthy as isTruthy,
  display as show,
  keyOf,
} from '@term/make/code/engine/value'
import * as Arr from '@term/make/code/engine/data/array'
import * as Mp from '@term/make/code/engine/data/map'

export const UNIT_V: Value = makeUnit()

// constructors (literals)
export const int = (v: bigint | number): Value =>
  mkInt({ dock: typeof v === 'bigint' ? v : BigInt(v) })
export const flt = (v: number): Value => mkFloat(v)
export const bool = (v: boolean): Value => mkBool(v)
export const str = (v: string): Value => mkStr(v)
export const array = (items: Value[]): Value => ({
  form: 'array',
  value: Arr.fromArray(items),
})

export const mapLit = (pairs: [string, Value][]): Value => {
  let m = Mp.makeMap<Value>()

  for (const [k, v] of pairs) {
    m = Mp.set(m, `s:${k}`, v)
  }

  // the contents in a shared cell (engine/value `map-cell`), marked as the port marks a `mark shared` record, so it is
  // compared and keyed by identity like one the interpreter made
  const cell = { map: m }
  Object.defineProperty(cell, Symbol.for('term.shared'), { value: true })

  return { form: 'map', value: cell }
}

// binary ops
export const add = (a: Value, b: Value): Value => binary('+', a, b)
export const sub = (a: Value, b: Value): Value => binary('-', a, b)
export const mul = (a: Value, b: Value): Value => binary('*', a, b)
export const div = (a: Value, b: Value): Value => binary('/', a, b)
export const mod = (a: Value, b: Value): Value => binary('%', a, b)
export const eq = (a: Value, b: Value): Value => binary('==', a, b)
export const ne = (a: Value, b: Value): Value => binary('!=', a, b)
export const lt = (a: Value, b: Value): Value => binary('<', a, b)
export const le = (a: Value, b: Value): Value => binary('<=', a, b)
export const gt = (a: Value, b: Value): Value => binary('>', a, b)
export const ge = (a: Value, b: Value): Value => binary('>=', a, b)

// logical (lazy right side via a thunk, so short-circuit is preserved)
export const and = (a: Value, right: () => Value): Value =>
  isTruthy(a) ? right() : a
export const or = (a: Value, right: () => Value): Value =>
  isTruthy(a) ? a : right()

// unary
export const neg = (a: Value): Value => binary('-', int(0n), a)
export const notTruthy = (a: Value): Value => bool(!isTruthy(a))
export const truthy = (a: Value): boolean => isTruthy(a)

// aggregate access
export const index = (c: Value, i: Value): Value => indexGet(c, i)
export const member = (c: Value, name: string): Value =>
  memberGet(c, name)

export function setIndex(c: Value, i: Value, v: Value): Value {
  if (c.form === 'array') {
    return {
      form: 'array',
      value: Arr.set(
        c.value,
        // an integer index: its ternary integer holds a big integer, `{ dock: bigint }`
        Number((i as { value: { value: { dock: bigint } } }).value.value.dock),
        v,
      ),
    }
  }

  if (c.form === 'map') {
    // a map's contents sit in its shared cell (engine/value `map-cell`), one object every alias sees
    c.value.map = Mp.set(c.value.map, keyOf(i), v)

    return c
  }

  throw new Error(`cannot index-assign a ${c.form}`)
}

export function setMember(c: Value, name: string, v: Value): Value {
  if (c.form === 'map') {
    c.value.map = Mp.set(c.value.map, `s:${name}`, v)

    return c
  }

  throw new Error(`cannot set member on a ${c.form}`)
}

// built-ins (bound to plain names in the emitted preamble)
export const print = (...args: Value[]): Value => {
  console.log(args.map(show).join(' '))

  return UNIT_V
}

export const len = (v: Value): Value => member(v, 'length')

export const push = (a: Value, v: Value): Value => {
  if (a.form !== 'array') {
    throw new Error('push needs an array')
  }

  return { form: 'array', value: Arr.push(a.value, v) }
}

export const keys = (m: Value): Value => {
  if (m.form !== 'map') {
    throw new Error('keys needs a map')
  }

  return array(Mp.keys(m.value.map).map(k => str(k.replace(/^s:/, ''))))
}

export const strOf = (v: Value): Value => str(show(v))

// error bridging for `throw` / `try`: a thrown Value travels as a JS Error carrying the original Value, so the
// `catch` binding can recover it. A non-Seed JS error caught here is surfaced as a string Value.
class SeedError extends Error {
  constructor(public readonly value: Value) {
    super(show(value))
  }
}

export const toError = (v: Value): SeedError => new SeedError(v)
export const fromError = (e: unknown): Value =>
  e instanceof SeedError
    ? e.value
    : str(e instanceof Error ? e.message : String(e))

// `for` iteration: yield the elements of an array, or the values of a map, as a JS iterable of Values
export const iterate = (v: Value): Iterable<Value> => {
  if (v.form === 'array') {
    return Arr.toArray(v.value)
  }

  if (v.form === 'map') {
    return Mp.values(v.value.map)
  }

  throw new Error(`cannot iterate ${v.form}`)
}

export const toInt = (v: Value): Value => {
  if (v.form === 'integer') {
    return v
  }

  if (v.form === 'float') {
    return int(
      BigInt(
        Math.trunc(
          Number((v.value as { mantissa: { dock: bigint } }).mantissa.dock) *
            3 ** (v.value as { exponent: number }).exponent,
        ),
      ),
    )
  }

  if (v.form === 'string') {
    const s = show(v)

    return int(BigInt(s))
  }

  throw new Error(`int of ${v.form}`)
}
