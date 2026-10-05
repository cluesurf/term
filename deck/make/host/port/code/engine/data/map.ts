declare const termbig: any

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

export function maybeUnwrapOr<T>(self: Maybe<T>, fallback: T): T {
  if (self.form === "some") {
    return self.value
  } else {
    return fallback
  }
}

export type Side =
  | { form: "start" }
  | { form: "end" }
  | { form: "both" }

export interface Pair<A = any, B = any> {
  first: A
  second: B
}

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

export function hashKeys<K, V>(self: Map<K, V>): K[] {
  return Array.from(self.keys())
}

export function hashValues<K, V>(self: Map<K, V>): V[] {
  return Array.from(self.values())
}

export function hashGetOrDefault<K, V>(self: Map<K, V>, key: K, fallback: V): V {
  return maybeUnwrapOr(hashGet(self, key), fallback)
}

export function hashEntries<K, V>(self: Map<K, V>): Pair<K, V>[] {
  const ks: K[] = hashKeys(self)
  const vs: V[] = hashValues(self)
  const out: Pair<K, V>[] = ([] as Pair<K, V>[])
  let at: number = 0
  for (const key of ks) {
    if (at < vs.length) {
      out.push({ first: key, second: (at >= 0 && at < vs.length ? vs[at]! : __termReadPast(vs, at)) })
    }
    const __n0 = at + 1; if (!(__n0 <= 9007199254740991 && __n0 >= -9007199254740991)) __termIntStop(__n0); at = __n0
  }
  return out
}

export function hashChange<K, V>(self: Map<K, V>, key: K, fallback: V, call: (a0: V) => V): V {
  const value: V = call(hashGetOrDefault(self, key, fallback))
  self.set(__termKey(key), value)
  return value
}

export function listPush<T>(self: T[], item: T): number {
  return self.push(item)
}

export function listPop<T>(self: T[]): T {
  return __termPop(self)
}

export function listGet<T>(self: T[], index: number): T {
  return (index >= 0 && index < self.length ? self[index]! : __termReadPast(self, index))
}

export function listSet<T>(self: T[], index: number, item: T): T[] {
  __termSplice(self, index, 1, item)
  return self
}

export function listMap<T, S>(self: T[], call: (a0: T) => S): S[] {
  return self.map(call)
}

export function listFirst<T>(self: T[]): Maybe<T> {
  if (self.length > 0) {
    return { form: "some", value: (0 < self.length ? self[0]! : __termReadPast(self, 0)) }
  } else {
    return __termVariantNone
  }
}

export interface BigInteger {
  dock: any
}

export function bigAdd(a: BigInteger, b: BigInteger): BigInteger {
  return { dock: a.dock + b.dock }
}

export function bigCompare(a: BigInteger, b: BigInteger): number {
  return a.dock < b.dock ? -1 : (a.dock > b.dock ? 1 : 0)
}

export function toTrits(value: BigInteger): number[] {
  const trits: number[] = ([] as number[])
  if (bigCompare(value, { dock: BigInt(0) }) === 0) {
    trits.push(0)
    return trits
  }
  const three: BigInteger = { dock: BigInt(3) }
  let v: BigInteger = value
  while (bigCompare(v, { dock: BigInt(0) }) !== 0) {
    const shifted: BigInteger = bigAdd({ dock: v.dock % three.dock }, three)
    const r: BigInteger = { dock: shifted.dock % three.dock }
    if (bigCompare(r, { dock: BigInt(2) }) === 0) {
      trits.push(-1)
      const up: BigInteger = bigAdd(v, { dock: BigInt(1) })
      v = { dock: up.dock / three.dock }
    } else {
      if (bigCompare(r, { dock: BigInt(1) }) === 0) {
        trits.push(1)
      } else {
        trits.push(0)
      }
      const down: BigInteger = { dock: v.dock - r.dock }
      v = { dock: down.dock / three.dock }
    }
  }
  return trits
}

const tritsPerCodePoint: number = 14

export interface MapEntry<V = any> {
  key: string
  value: V
}

export interface TrieNode<V = any> {
  entry: MapEntry<V>[]
  kids: Map<number, TrieNode<V>>
}

export interface TernaryMap<V = any> {
  root: TrieNode<V>
  size: number
}

export interface TrieChange<V = any> {
  node: TrieNode<V>
  delta: number
}

export function makeNode<V>(): TrieNode<V> {
  return { entry: ([] as MapEntry<V>[]), kids: new Map() }
}

export function makeMap<V>(): TernaryMap<V> {
  return { root: makeNode(), size: 0 }
}

export function keyTrits(key: string): number[] {
  const out: number[] = ([] as number[])
  for (const point of Array.from(key, function (rune) { return rune.codePointAt(0) ?? 0 })) {
    const trits: number[] = toTrits({ dock: BigInt(point) })
    let i: number = 0
    while (i < tritsPerCodePoint) {
      if (i < trits.length) {
        out.push(listGet(trits, i))
      } else {
        out.push(0)
      }
      i = i + 1
    }
  }
  return out
}

export function findNode<V>(root: TrieNode<V>, trits: number[]): TrieNode<V> {
  let node: TrieNode<V> = root
  for (const t of trits) {
    const kids: Map<number, TrieNode<V>> = node.kids
    const __n1 = t + 1; if (!(__n1 <= 9007199254740991 && __n1 >= -9007199254740991)) __termIntStop(__n1); const slot: number = __n1
    if (kids.has(slot)) {} else {
      return makeNode()
    }
    node = hashGetOrDefault(kids, slot, makeNode())
  }
  return node
}

export function writeAt<V>(node: TrieNode<V>, trits: number[], at: number, entry: MapEntry<V>[]): TrieChange<V> {
  if (at === trits.length) {
    const had: MapEntry<V>[] = node.entry
    const next: TrieNode<V> = { ...node }
    next.entry = entry
    return { node: next, delta: __termInt(entry.length - had.length) }
  }
  const kids: Map<number, TrieNode<V>> = node.kids
  const __n2 = listGet(trits, at) + 1; if (!(__n2 <= 9007199254740991 && __n2 >= -9007199254740991)) __termIntStop(__n2); const slot: number = __n2
  const child: TrieNode<V> = hashGetOrDefault(kids, slot, makeNode())
  const below: TrieChange<V> = writeAt(child, trits, __termInt(at + 1), entry)
  const copied: Map<number, TrieNode<V>> = new Map()
  let k: number = 0
  while (k <= 2) {
    if (kids.has(k)) {
      copied.set(k, hashGetOrDefault(kids, k, makeNode()))
    }
    k = k + 1
  }
  copied.set(slot, below.node)
  const next: TrieNode<V> = { ...node }
  next.kids = copied
  return { node: next, delta: below.delta }
}

export function set<V>(map: TernaryMap<V>, key: string, value: V): TernaryMap<V> {
  const one: MapEntry<V>[] = ([] as MapEntry<V>[])
  one.push({ key: key, value: value })
  const change: TrieChange<V> = writeAt(map.root, keyTrits(key), 0, one)
  return { root: change.node, size: __termInt(map.size + change.delta) }
}

export function lookup<V>(map: TernaryMap<V>, key: string, fallback: V): V {
  const node: TrieNode<V> = findNode(map.root, keyTrits(key))
  const entry: MapEntry<V>[] = node.entry
  if (entry.length === 0) {
    return fallback
  }
  const first: MapEntry<V> = (0 < entry.length ? entry[0]! : __termReadPast(entry, 0))
  return first.value
}

export function has<V>(map: TernaryMap<V>, key: string): boolean {
  const node: TrieNode<V> = findNode(map.root, keyTrits(key))
  const entry: MapEntry<V>[] = node.entry
  return entry.length > 0
}

export function remove<V>(map: TernaryMap<V>, key: string): TernaryMap<V> {
  if (has(map, key)) {} else {
    return map
  }
  const none: MapEntry<V>[] = ([] as MapEntry<V>[])
  const change: TrieChange<V> = writeAt(map.root, keyTrits(key), 0, none)
  return { root: change.node, size: __termInt(map.size + change.delta) }
}

export function size<V>(map: TernaryMap<V>): number {
  return map.size
}

export function entries<V>(map: TernaryMap<V>): MapEntry<V>[] {
  const out: MapEntry<V>[] = ([] as MapEntry<V>[])
  const stack: TrieNode<V>[] = ([] as TrieNode<V>[])
  stack.push(map.root)
  while (stack.length > 0) {
    const node: TrieNode<V> = listPop(stack)
    for (const one of node.entry) {
      out.push(one)
    }
    const kids: Map<number, TrieNode<V>> = node.kids
    let slot: number = 2
    while (slot >= 0) {
      if (kids.has(slot)) {
        stack.push(hashGetOrDefault(kids, slot, makeNode()))
      }
      slot = slot - 1
    }
  }
  return out
}

export function keys<V>(map: TernaryMap<V>): string[] {
  const out: string[] = ([] as string[])
  for (const one of entries(map)) {
    out.push(one.key)
  }
  return out
}

export function values<V>(map: TernaryMap<V>): V[] {
  const out: V[] = ([] as V[])
  for (const one of entries(map)) {
    out.push(one.value)
  }
  return out
}
