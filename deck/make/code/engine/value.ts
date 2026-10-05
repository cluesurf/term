// The runtime values of the engine, over the balanced-ternary data types. Plus the scope (the environment) and
// the closure / native-function shapes. See note/research/vibe/computation/engine/01-values.md.

import type { Statement } from '@term/make/code/engine/ast'
// a three-valued boolean, -1 false, 0 unknown, +1 true. engine/data/boolean is Term since 2026-10-04 and spells it
// `number` (D9), so it is named here
type Bool3 = -1 | 0 | 1
import type { TernaryInteger } from '@term/make/code/engine/data/integer'
import type { TernaryFloat } from '@term/make/code/engine/data/float'
import type { Rope } from '@term/make/code/engine/data/string'
import type { Vector } from '@term/make/code/engine/data/array'
import type { TernaryMap } from '@term/make/code/engine/data/map'
import * as Int from '@term/make/code/engine/data/integer'
import * as Flt from '@term/make/code/engine/data/float'
import * as Str from '@term/make/code/engine/data/string'
import * as Arr from '@term/make/code/engine/data/array'

export type Value =
  | { form: 'unit' }
  | { form: 'boolean'; value: Bool3 }
  | { form: 'integer'; value: TernaryInteger }
  | { form: 'float'; value: TernaryFloat }
  | { form: 'string'; value: Rope }
  | { form: 'array'; value: Vector<Value> }
  | { form: 'map'; value: TernaryMap<Value> }
  | { form: 'function'; value: Closure }
  | {
      form: 'native'
      name: string
      fn: (args: Value[]) => Value | Promise<Value>
    }
  | { form: 'task'; promise: Promise<Value> } // an async call in flight, joined by `await`

export type Closure = {
  params: string[]
  body: Statement[]
  env: Scope
  isAsync: boolean
  name?: string
}

export type Scope = {
  vars: Map<string, Value>
  consts: Set<string>
  parent: Scope | null
}

export const UNIT: Value = { form: 'unit' }

// the exact value of an integer as a native bigint. engine/data/integer is Term since 2026-10-04 and holds the stdlib's
// `big-integer`, a record `{ dock: <BigInt> }` on TypeScript, so its value is read through `.dock`
export function bigOf(value: TernaryInteger): bigint {
  return value.value.dock as bigint
}

// constructors
export function integer(value: number | bigint): Value {
  return { form: 'integer', value: Int.makeInteger({ dock: typeof value === 'bigint' ? value : BigInt(value) }, '') }
}

export function float(value: number): Value {
  return { form: 'float', value: Flt.fromNumber(value) }
}

export function boolean(value: boolean): Value {
  return { form: 'boolean', value: value ? 1 : -1 }
}

export function string(text: string): Value {
  return { form: 'string', value: Str.fromString(text) }
}

// truthiness for conditions: boolean true, nonzero number, non-empty string/array/map; unit and unknown are false
export function truthy(v: Value): boolean {
  switch (v.form) {
    case 'unit':
      return false
    case 'boolean':
      return v.value === 1
    case 'integer':
      return bigOf(v.value) !== 0n
    case 'float':
      return Flt.toNumber(v.value) !== 0
    case 'string':
      return Str.length(v.value) > 0
    case 'array':
      return Arr.size(v.value) > 0
    case 'map':
      return v.value.size > 0
    default:
      return true // function / native / task are truthy
  }
}

// structural equality across the value forms
export function valuesEqual(a: Value, b: Value): boolean {
  if (a.form !== b.form) {
    return false
  }

  switch (a.form) {
    case 'unit':
      return true
    case 'boolean':
      return a.value === (b as typeof a).value
    case 'integer':
      return bigOf(a.value) === bigOf((b as typeof a).value)
    case 'float':
      return Flt.compareTernary(a.value, (b as typeof a).value) === 0
    case 'string':
      return Str.equals(a.value, (b as typeof a).value)

    case 'array': {
      const bv = (b as typeof a).value

      if (Arr.size(a.value) !== Arr.size(bv)) {
        return false
      }

      for (let i = 0; i < Arr.size(a.value); i++) {
        if (!valuesEqual(Arr.get(a.value, i), Arr.get(bv, i))) {
          return false
        }
      }

      return true
    }

    default:
      return a === b // map / function / native / task by identity
  }
}

// the canonical string key for a value used as a map key
export function keyOf(v: Value): string {
  switch (v.form) {
    case 'integer':
      return `i:${bigOf(v.value).toString()}`
    case 'string':
      return `s:${Str.toString(v.value)}`
    case 'boolean':
      return `b:${v.value}`
    case 'float':
      return `f:${Flt.toNumber(v.value)}`
    case 'unit':
      return 'unit'
    default:
      throw new Error(`value of form ${v.form} cannot be a map key`)
  }
}

// a readable rendering of a value (for print / debugging)
export function display(v: Value): string {
  switch (v.form) {
    case 'unit':
      return 'null'
    case 'boolean':
      return v.value === 1
        ? 'true'
        : v.value === -1
          ? 'false'
          : 'unknown'
    case 'integer':
      return bigOf(v.value).toString()
    case 'float':
      return String(Flt.toNumber(v.value))
    case 'string':
      return Str.toString(v.value)
    case 'array':
      return `[${Arr.toArray(v.value).map(display).join(', ')}]`
    case 'map':
      return `{${v.value.size} entries}`
    case 'function':
      return `function ${v.value.name ?? '(anon)'}`
    case 'native':
      return `native ${v.name}`
    case 'task':
      return 'task'
  }
}
