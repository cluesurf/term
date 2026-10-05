function __termInt(x: number): number {
  if (!(x <= 9007199254740991 && x >= -9007199254740991)) __termIntStop(x)
  return x
}
function __termIntStop(x: number): never {
  const base = !Number.isFinite(x)
    ? { host: "@term/base", form: "defect", note: "Invalid", code: "", time: Date.now(), link: { thing: "a division or remainder by zero" } }
    : { host: "@term/base", form: x > 0 ? "excess" : "shortage", note: x > 0 ? "Too large" : "Too small", code: "", time: Date.now(), link: { thing: "number", limit: x > 0 ? 9007199254740991 : -9007199254740991, actual: x } }
  throw Object.assign(new Error(base.note), base, { name: "TermException" })
}

const __termShared = Symbol.for('term.shared')
function __termShare<T extends object>(value: T): T {
  Object.defineProperty(value, __termShared, { value: true })
  return value
}
function __termEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return a == b
  if (typeof a !== 'object' || typeof b !== 'object') return false
  if (__termShared in (a as object) || __termShared in (b as object)) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!__termEqual(a[i], b[i])) return false
    return true
  }
  if (a instanceof Map) {
    if (!(b instanceof Map) || a.size !== b.size) return false
    for (const [k, v] of a) if (!b.has(k) || !__termEqual(v, b.get(k))) return false
    return true
  }
  if (a instanceof Uint8Array) {
    if (!(b instanceof Uint8Array) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }
  if (Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false
  const ka = Object.keys(a as object)
  if (ka.length !== Object.keys(b as object).length) return false
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false
    if (!__termEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  }
  return true
}
function __termKeyText(v: unknown): string {
  if (v === undefined) return 'u'
  if (v === null) return 'z'
  switch (typeof v) {
    case 'number': return 'n' + (Object.is(v, -0) ? '0' : String(v))
    case 'string': return 's' + JSON.stringify(v)
    case 'boolean': return v ? 't' : 'f'
    case 'bigint': return 'b' + String(v)
    case 'object': break
    default: return 'i' + __termIdentity(v as object)
  }
  if (__termShared in (v as object)) return 'i' + __termIdentity(v as object)
  if (Array.isArray(v)) return '[' + v.map(__termKeyText).join(',') + ']'
  if (v instanceof Map) return '{' + Array.from(v, ([k, x]) => __termKeyText(k) + ':' + __termKeyText(x)).sort().join(',') + '}'
  if (v instanceof Uint8Array) return 'y' + Array.from(v).join('.')
  if (Object.getPrototypeOf(v) !== Object.prototype) return 'i' + __termIdentity(v as object)
  const o = v as Record<string, unknown>
  return '(' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + __termKeyText(o[k])).join(',') + ')'
}
function __termIdentity(v: object): number {
  const g = globalThis as { __termIdentities?: WeakMap<object, number>; __termIdentityNext?: number }
  const ids = (g.__termIdentities ??= new WeakMap())
  let id = ids.get(v)
  if (id === undefined) { id = g.__termIdentityNext = (g.__termIdentityNext ?? 0) + 1; ids.set(v, id) }
  return id
}
function __termKey<T>(k: T): T {
  if (typeof k !== 'object' || k === null) return k
  const g = globalThis as { __termKeys?: Map<string, WeakRef<object>>; __termKeysGone?: FinalizationRegistry<string> }
  const keys = (g.__termKeys ??= new Map())
  const gone = (g.__termKeysGone ??= new FinalizationRegistry(text => { if (keys.get(text)?.deref() === undefined) keys.delete(text) }))
  const text = __termKeyText(k)
  const seen = keys.get(text)?.deref()
  if (seen !== undefined) return seen as T
  keys.set(text, new WeakRef(k as object))
  gone.register(k as object, text)
  return k
}

function __termStop(thing: string): never {
  const base = { host: "@term/base", form: "defect", note: "Invalid", code: "", time: Date.now(), link: { thing } }
  throw Object.assign(new Error(base.note), base, { name: "TermException" })
}
function __termAt<T>(a: T[], i: number): T {
  if (!(i >= 0 && i < a.length)) __termStop("a list read at " + i + " of " + a.length)
  return a[i]!
}
function __termReadPast(a: unknown[], i: number): never {
  return __termStop("a list read at " + i + " of " + a.length)
}
function __termWritePast(a: unknown[], i: number): never {
  return __termStop("a list write at " + i + " of " + a.length)
}
function __termPut<T>(a: T[], i: number, v: T): T {
  if (!(i >= 0 && i < a.length)) __termStop("a list write at " + i + " of " + a.length)
  return (a[i] = v)
}
function __termPop<T>(a: T[]): T {
  if (a.length === 0) __termStop("a pop of an empty list")
  return a.pop()!
}
function __termShift<T>(a: T[]): T {
  if (a.length === 0) __termStop("a shift of an empty list")
  return a.shift()!
}
function __termSlice<T>(a: T[], s: number, e?: number): T[] {
  const n = a.length
  const x = Math.min(Math.max(s, 0), n)
  const y = Math.min(Math.max(e === undefined ? n : e, 0), n)
  return x < y ? a.slice(x, y) : []
}
function __termSplice<T>(a: T[], s: number, d: number, ...items: T[]): T[] {
  const x = Math.min(Math.max(s, 0), a.length)
  return a.splice(x, Math.min(Math.max(d, 0), a.length - x), ...items)
}

const __termVariantNone = Object.freeze({ form: "none" as const })

const __termVariantLess = Object.freeze({ form: "less" as const })

const __termVariantGreater = Object.freeze({ form: "greater" as const })

const __termVariantEqual = Object.freeze({ form: "equal" as const })

export type Maybe<T = any> =
  | { form: "some"; value: T }
  | { form: "none" }

export type Side =
  | { form: "start" }
  | { form: "end" }
  | { form: "both" }

export function hashGet<K, V>(self: Map<K, V>, key: K): Maybe<V> {
  if (self.has(__termKey(key))) {
    return { form: "some", value: self.get(__termKey(key))! }
  } else {
    return __termVariantNone
  }
}

export function hashSet<K, V>(self: Map<K, V>, key: K, value: V): Map<K, V> {
  return self.set(__termKey(key), value)
}

export function hashHas<K, V>(self: Map<K, V>, key: K): boolean {
  return self.has(__termKey(key))
}

export type Ordering =
  | { form: "less" }
  | { form: "equal" }
  | { form: "greater" }

export function orderingIsGreater(self: Ordering): boolean {
  if (self.form === "greater") {
    return true
  } else if (self.form === "less") {
    return false
  } else {
    return false
  }
}

export function fromNumbers(left: number, right: number): Ordering {
  if (left < right) {
    return __termVariantLess
  } else {
    if (left > right) {
      return __termVariantGreater
    } else {
      return __termVariantEqual
    }
  }
}

export function listGet<T>(self: T[], index: number): T {
  return (index >= 0 && index < self.length ? self[index]! : __termReadPast(self, index))
}

export function listSet<T>(self: T[], index: number, item: T): T[] {
  __termSplice(self, index, 1, item)
  return self
}

function mergePass<T>(source: T[], width: number, compare: (a0: T, a1: T) => Ordering): T[] {
  const n: number = source.length
  const merged: T[] = ([] as T[])
  let low: number = 0
  while (low < n) {
    const __n0 = low + width; if (!(__n0 <= 9007199254740991 && __n0 >= -9007199254740991)) __termIntStop(__n0); let middle: number = __n0
    if (middle > n) {
      middle = n
    }
    const __n1 = middle + width; if (!(__n1 <= 9007199254740991 && __n1 >= -9007199254740991)) __termIntStop(__n1); let high: number = __n1
    if (high > n) {
      high = n
    }
    let i: number = low
    let j: number = middle
    while (i < middle && j < high && (i < source.length && j < source.length)) {
      const left: T = listGet(source, i)
      const right: T = listGet(source, j)
      if (orderingIsGreater(compare(left, right))) {
        merged.push(right)
        const __n2 = j + 1; if (!(__n2 <= 9007199254740991 && __n2 >= -9007199254740991)) __termIntStop(__n2); j = __n2
      } else {
        merged.push(left)
        const __n3 = i + 1; if (!(__n3 <= 9007199254740991 && __n3 >= -9007199254740991)) __termIntStop(__n3); i = __n3
      }
    }
    while (i < middle && i < source.length) {
      merged.push(listGet(source, i))
      const __n4 = i + 1; if (!(__n4 <= 9007199254740991 && __n4 >= -9007199254740991)) __termIntStop(__n4); i = __n4
    }
    while (j < high && j < source.length) {
      merged.push(listGet(source, j))
      const __n5 = j + 1; if (!(__n5 <= 9007199254740991 && __n5 >= -9007199254740991)) __termIntStop(__n5); j = __n5
    }
    low = high
  }
  return merged
}

export function sort<T>(items: T[], compare: (a0: T, a1: T) => Ordering): T[] {
  let source: T[] = ([] as T[])
  for (const item of items) {
    source.push(item)
  }
  const total: number = source.length
  let width: number = 1
  while (width < total) {
    source = mergePass(source, width, compare)
    const __n6 = width * 2; if (!(__n6 <= 9007199254740991 && __n6 >= -9007199254740991)) __termIntStop(__n6); const doubled: number = __n6
    if (doubled > total) {
      width = total
      continue
    } else {
      width = doubled
      continue
    }
  }
  return source
}

export interface SymmetricSystem<S = any> {
  init: S
  succ: (a0: S) => S[]
  key: (a0: S) => string
  canon: (a0: S) => S
}

export interface ExploredStates {
  states: string[]
  explored: number
}

export function reach<S>(system: SymmetricSystem<S>): ExploredStates {
  const seen: Map<string, boolean> = new Map()
  const states: string[] = ([] as string[])
  const frontier: S[] = ([] as S[])
  const start: S = system.canon(system.init)
  const startKey: string = system.key(start)
  seen.set(startKey, true)
  states.push(startKey)
  frontier.push(start)
  let at: number = 0
  while (at < frontier.length) {
    const state: S = listGet(frontier, at)
    at = at + 1
    for (const after of system.succ(state)) {
      const canonical: S = system.canon(after)
      const key: string = system.key(canonical)
      if (hashHas(seen, key)) {} else {
        seen.set(key, true)
        states.push(key)
        frontier.push(canonical)
      }
    }
  }
  return { states: states, explored: at }
}

export function byNumber(left: number, right: number): Ordering {
  return fromNumbers(left, right)
}

export function sortedCanon(state: number[]): number[] {
  return sort(state, byNumber)
}

export function unsafeIn(states: string[], parse: (a0: string) => number[], bad: (a0: number[]) => boolean): boolean {
  for (const key of states) {
    if (bad(parse(key))) {
      return true
    }
  }
  return false
}
