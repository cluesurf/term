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

export function listGet<T>(self: T[], index: number): T {
  return (index >= 0 && index < self.length ? self[index]! : __termReadPast(self, index))
}

export function listConcat<T>(self: T[], other: T[]): T[] {
  return self.concat(other)
}

export function listSlice<T>(self: T[], start: number, end: number): T[] {
  return __termSlice(self, start, end)
}

export function fromRunes(runes: number[]): string {
  let result: string = ""
  for (const code of runes) {
    result = result + String.fromCodePoint(code)
  }
  return result
}

export interface BigInteger {
  dock: any
}

export function bigFromNumber(value: number): BigInteger {
  return { dock: BigInt(value) }
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

const maxLeaf: number = 64

const rebalanceDepth: number = 32

export type Rope =
  | { form: "leaf"; text: string; length: number }
  | { form: "branch"; left: Rope; right: Rope; length: number; depth: number }

export function makeLeaf(text: string, length: number): Rope {
  return { form: "leaf", text: text, length: length }
}

export function fromString(text: string): Rope {
  return build(Array.from(text, function (rune) { return rune.codePointAt(0) ?? 0 }))
}

export function build(points: number[]): Rope {
  if (points.length <= maxLeaf) {
    return makeLeaf(fromRunes(points), points.length)
  }
  const mid: number = Math.trunc(points.length / 2)
  const left: Rope = build(__termSlice(points, 0, mid))
  const right: Rope = build(__termSlice(points, mid, points.length))
  return joinHalves(left, right)
}

export function depthOf(r: Rope): number {
  if (r.form === "leaf") {
    return 0
  } else {
    const depth = r.depth
    return depth
  }
}

export function joinHalves(left: Rope, right: Rope): Rope {
  const a: number = depthOf(left)
  const b: number = depthOf(right)
  let deeper: number = a
  if (b > a) {
    deeper = b
  }
  return { form: "branch", left: left, right: right, length: __termInt(measure(left) + measure(right)), depth: __termInt(1 + deeper) }
}

export function length(r: Rope): number {
  return measure(r)
}

export function measure(r: Rope): number {
  if (r.form === "leaf") {
    const length = r.length
    return length
  } else {
    const length = r.length
    return length
  }
}

export function concat(a: Rope, b: Rope): Rope {
  if (measure(a) === 0) {
    return b
  }
  if (measure(b) === 0) {
    return a
  }
  const joined: Rope = joinHalves(a, b)
  if (depthOf(joined) > rebalanceDepth) {
    return fromString(toString(joined))
  }
  return joined
}

export function charAt(r: Rope, index: number): string {
  const count: number = measure(r)
  if (index < 0 || index >= count) {
    throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`index ${index} out of range (length ${count})`)
  }
  let node: Rope = r
  let i: number = index
  while (true) {
    if (node.form === "leaf") {
      const text = node.text
      const points: number[] = Array.from(text, function (rune) { return rune.codePointAt(0) ?? 0 })
      return String.fromCodePoint(listGet(points, i))
    } else {
      const left = node.left
      const right = node.right
      const before: number = measure(left)
      if (i < before) {
        node = left
      } else {
        const __n0 = i - before; if (!(__n0 <= 9007199254740991 && __n0 >= -9007199254740991)) __termIntStop(__n0); i = __n0
        node = right
      }
    }
  }
  return ""
}

export function codePointAt(r: Rope, index: number): number {
  const points: number[] = Array.from(charAt(r, index), function (rune) { return rune.codePointAt(0) ?? 0 })
  return (0 < points.length ? points[0]! : __termReadPast(points, 0))
}

export function tritsAt(r: Rope, index: number): number[] {
  return toTrits(bigFromNumber(codePointAt(r, index)))
}

export function slice(r: Rope, start: number, end: number): Rope {
  const count: number = measure(r)
  let s: number = start
  if (s < 0) {
    s = 0
  }
  let e: number = end
  if (e > count) {
    e = count
  }
  if (s >= e) {
    return { form: "leaf", text: "", length: 0 }
  }
  if (r.form === "leaf") {
    const text = r.text
    const points: number[] = Array.from(text, function (rune) { return rune.codePointAt(0) ?? 0 })
    const kept: number[] = __termSlice(points, s, e)
    return makeLeaf(fromRunes(kept), __termInt(e - s))
  } else {
    const left = r.left
    const right = r.right
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

export function toString(r: Rope): string {
  if (r.form === "leaf") {
    const text = r.text
    return text
  } else {
    const left = r.left
    const right = r.right
    return `${toString(left)}${toString(right)}`
  }
}

export function equals(a: Rope, b: Rope): boolean {
  return measure(a) === measure(b) && toString(a) === toString(b)
}
