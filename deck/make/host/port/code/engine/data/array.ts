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

export function listSet<T>(self: T[], index: number, item: T): T[] {
  __termSplice(self, index, 1, item)
  return self
}

export function listCopy<T>(self: T[]): T[] {
  return __termSlice(self, 0)
}

export function listConcat<T>(self: T[], other: T[]): T[] {
  return self.concat(other)
}

export function listSlice<T>(self: T[], start: number, end: number): T[] {
  return __termSlice(self, start, end)
}

export function listMap<T, S>(self: T[], call: (a0: T) => S): S[] {
  return self.map(call)
}

const maxLeaf: number = 32

const rebalanceDepth: number = 40

export type Vector<T = any> =
  | { form: "leaf"; items: T[]; size: number }
  | { form: "branch"; left: Vector<T>; right: Vector<T>; size: number; depth: number }

export function empty<T>(): Vector<T> {
  return { form: "leaf", items: ([] as T[]), size: 0 }
}

export function fromArray<T>(items: T[]): Vector<T> {
  if (items.length <= maxLeaf) {
    return { form: "leaf", items: listCopy(items), size: items.length }
  }
  const mid: number = Math.trunc(items.length / 2)
  const left: Vector<T> = fromArray(__termSlice(items, 0, mid))
  const right: Vector<T> = fromArray(__termSlice(items, mid, items.length))
  return joinHalves(left, right)
}

export function depthOf<T>(v: Vector<T>): number {
  if (v.form === "leaf") {
    return 0
  } else {
    const depth = v.depth
    return depth
  }
}

export function joinHalves<T>(left: Vector<T>, right: Vector<T>): Vector<T> {
  const a: number = depthOf(left)
  const b: number = depthOf(right)
  let deeper: number = a
  if (b > a) {
    deeper = b
  }
  return { form: "branch", left: left, right: right, size: __termInt(measure(left) + measure(right)), depth: __termInt(1 + deeper) }
}

export function size<T>(v: Vector<T>): number {
  return measure(v)
}

export function measure<T>(v: Vector<T>): number {
  if (v.form === "leaf") {
    const size = v.size
    return size
  } else {
    const size = v.size
    return size
  }
}

export function get<T>(v: Vector<T>, index: number): T {
  while (true) {
    const count: number = size(v)
    if (index < 0 || index >= count) {
      throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`index ${index} out of range (size ${count})`)
    }
    if (v.form === "leaf") {
      const items = v.items
      return (index >= 0 && index < items.length ? items[index]! : __termReadPast(items, index))
    } else {
      const left = v.left
      const right = v.right
      const before: number = measure(left)
      if (index < before) {
        const __tail0_0: Vector<T> = left
        const __tail0_1: number = index
        v = __tail0_0
        index = __tail0_1
        continue
      }
      const __tail1_0: Vector<T> = right
      const __tail1_1: number = __termInt(index - before)
      v = __tail1_0
      index = __tail1_1
      continue
    }
  }
}

export function set<T>(v: Vector<T>, index: number, value: T): Vector<T> {
  const count: number = size(v)
  if (index < 0 || index >= count) {
    throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`index ${index} out of range (size ${count})`)
  }
  if (v.form === "leaf") {
    const items = v.items
    const changed: T[] = listCopy(items)
    __termPut(changed, index, value)
    return { form: "leaf", items: changed, size: count }
  } else {
    const left = v.left
    const right = v.right
    const before: number = measure(left)
    if (index < before) {
      return joinHalves(set(left, index, value), right)
    }
    return joinHalves(left, set(right, __termInt(index - before), value))
  }
}

export function push<T>(v: Vector<T>, value: T): Vector<T> {
  if (v.form === "leaf") {
    const items = v.items
    const size = v.size
    if (items.length < maxLeaf) {
      const grown: T[] = listCopy(items)
      grown.push(value)
      return { form: "leaf", items: grown, size: __termInt(size + 1) }
    }
    const alone: T[] = ([] as T[])
    alone.push(value)
    const tail: Vector<T> = { form: "leaf", items: alone, size: 1 }
    return joinHalves(v, tail)
  } else {
    const left = v.left
    const right = v.right
    const grown: Vector<T> = joinHalves(left, push(right, value))
    if (depthOf(grown) > rebalanceDepth) {
      return fromArray(toArray(grown))
    }
    return grown
  }
}

export function pop<T>(v: Vector<T>): Vector<T> {
  const count: number = measure(v)
  if (count === 0) {
    throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))("pop on empty vector")
  }
  return slice(v, 0, __termInt(count - 1))
}

export function slice<T>(v: Vector<T>, start: number, end: number): Vector<T> {
  const count: number = size(v)
  let s: number = start
  if (s < 0) {
    s = 0
  }
  let e: number = end
  if (e > count) {
    e = count
  }
  if (s >= e) {
    return empty()
  }
  if (v.form === "leaf") {
    const items = v.items
    return { form: "leaf", items: __termSlice(items, s, e), size: __termInt(e - s) }
  } else {
    const left = v.left
    const right = v.right
    const before: number = measure(left)
    if (e <= before) {
      return slice(left, s, e)
    }
    if (s >= before) {
      return slice(right, __termInt(s - before), __termInt(e - before))
    }
    return concat(slice(left, s, before), slice(right, 0, __termInt(e - before)))
  }
}

export function concat<T>(a: Vector<T>, b: Vector<T>): Vector<T> {
  if (measure(a) === 0) {
    return b
  }
  if (measure(b) === 0) {
    return a
  }
  const joined: Vector<T> = joinHalves(a, b)
  if (depthOf(joined) > rebalanceDepth) {
    return fromArray(toArray(joined))
  }
  return joined
}

export function toArray<T>(v: Vector<T>): T[] {
  const out: T[] = ([] as T[])
  const stack: Vector<T>[] = ([] as Vector<T>[])
  stack.push(v)
  while (stack.length > 0) {
    const node: Vector<T> = __termPop(stack)
    if (node.form === "leaf") {
      const items = node.items
      for (const x of items) {
        out.push(x)
      }
    } else {
      const left = node.left
      const right = node.right
      stack.push(right)
      stack.push(left)
    }
  }
  return out
}

export function map<T, U>(v: Vector<T>, fn: (a0: T, a1: number) => U): Vector<U> {
  const out: U[] = ([] as U[])
  let at: number = 0
  for (const x of toArray(v)) {
    out.push(fn(x, at))
    const __n0 = at + 1; if (!(__n0 <= 9007199254740991 && __n0 >= -9007199254740991)) __termIntStop(__n0); at = __n0
  }
  return fromArray(out)
}

export function reduce<T, A>(v: Vector<T>, fn: (a0: A, a1: T) => A, initial: A): A {
  let acc: A = initial
  for (const x of toArray(v)) {
    acc = fn(acc, x)
  }
  return acc
}
