;
// Bitwise integer operations over the node host, 64-bit like the compiled backends: the answer is the signed
// 64-bit one, so a mask such as 0xffffffff is a mask and not the JavaScript 32-bit coercion to -1. The result rides a
// plain number, so it is exact within the 53-bit safe-integer range (the same bound every number on this host lives
// under). Reached only through the public bit API.
//
// Each op takes JavaScript's own operator where that IS the 64-bit answer, and goes through BigInt only past it:
//   - two values in the signed 32-bit range sign-extend to 64 bits, and and, or, xor and not on sign-extended values are
//     the sign extension of the 32-bit result, which is what `a & b` gives
//   - two values in the unsigned 32-bit range have zero upper bits, so the 64-bit result is the 32-bit one read
//     unsigned, which is what `(a & b) >>> 0` gives
//   - a shift of a safe integer whose result is still safe is multiplication or floored division by a power of two
// Every BigInt allocated three objects per operation, and hash and digest loops spent most of their time there
// (note/term/codegen/browser.md, B4).
const __bitSigned32 = (x: number): boolean => (x | 0) === x
const __bitUnsigned32 = (x: number): boolean => x >>> 0 === x
const __bitShiftable = (value: number, count: number): boolean =>
  Number.isSafeInteger(value) && Number.isInteger(count) && count >= 0 && count < 64
const __bitWide = (op: (a: bigint, b: bigint) => bigint, left: number, right: number): number =>
  Number(BigInt.asIntN(64, op(BigInt(Math.trunc(left)), BigInt(Math.trunc(right)))))
const bit = {
  and: (left: number, right: number): number =>
    __bitSigned32(left) && __bitSigned32(right)
      ? left & right
      : __bitUnsigned32(left) && __bitUnsigned32(right)
        ? (left & right) >>> 0
        : __bitWide((a, b) => a & b, left, right),
  or: (left: number, right: number): number =>
    __bitSigned32(left) && __bitSigned32(right)
      ? left | right
      : __bitUnsigned32(left) && __bitUnsigned32(right)
        ? (left | right) >>> 0
        : __bitWide((a, b) => a | b, left, right),
  exclusiveOr: (left: number, right: number): number =>
    __bitSigned32(left) && __bitSigned32(right)
      ? left ^ right
      : __bitUnsigned32(left) && __bitUnsigned32(right)
        ? (left ^ right) >>> 0
        : __bitWide((a, b) => a ^ b, left, right),
  not: (value: number): number =>
    __bitSigned32(value) ? ~value : Number(BigInt.asIntN(64, ~BigInt(Math.trunc(value)))),
  shiftLeft: (value: number, count: number): number => {
    if (__bitShiftable(value, count)) {
      const shifted = value * 2 ** count
      if (Number.isSafeInteger(shifted)) return shifted + 0
    }
    return __bitWide((a, b) => a << b, value, count)
  },
  // arithmetic (sign-preserving), matching the compiled backends
  shiftRight: (value: number, count: number): number =>
    __bitShiftable(value, count) ? Math.floor(value / 2 ** count) + 0 : __bitWide((a, b) => a >> b, value, count),
  shiftRightUnsigned: (value: number, count: number): number =>
    __bitShiftable(value, count) && value >= 0
      ? Math.floor(value / 2 ** count)
      : Number(BigInt.asUintN(64, BigInt(Math.trunc(value))) >> BigInt(Math.trunc(count))),
  // A SIGNED 32-BIT MULTIPLY WITH WRAPAROUND. `Math.imul` exactly: the high bits are DISCARDED, which is what
  // the classic string hashes are defined in terms of. The other ops here are 64-bit; this one is deliberately not,
  // because a 64-bit product would give a different number and cyrb53 would stop being cyrb53.
  multiply32: (left: number, right: number): number =>
    Math.imul(Math.trunc(left), Math.trunc(right)),
}

;
// Raw byte buffers over the node host. The currency value is a Uint8Array. Buffer is a Uint8Array subclass, so the
// node hex and base64 codecs come for free with zero copy at the boundary.
const octets = {
  fromText: (text: string): Uint8Array =>
    new TextEncoder().encode(text),
  toText: (value: Uint8Array): string =>
    new TextDecoder().decode(value),
  toHex: (value: Uint8Array): string =>
    Buffer.from(value).toString('hex'),
  fromHex: (text: string): Uint8Array =>
    new Uint8Array(Buffer.from(text, 'hex')),
  toBase64: (value: Uint8Array): string =>
    Buffer.from(value).toString('base64'),
  fromBase64: (text: string): Uint8Array =>
    new Uint8Array(Buffer.from(text, 'base64')),
  length: (value: Uint8Array): number => value.length,
  concat: (left: Uint8Array, right: Uint8Array): Uint8Array => {
    const out = new Uint8Array(left.length + right.length)
    out.set(left, 0)
    out.set(right, left.length)
    return out
  },
  slice: (value: Uint8Array, start: number, end: number): Uint8Array =>
    value.slice(start, end),
}

declare const Math: any
const math: any = typeof Math === "undefined" ? undefined : Math
declare const crypto: any
declare const Date: any
const date: any = typeof Date === "undefined" ? undefined : Date

export class TermException extends Error {
  host!: string
  form!: string
  note!: string
  code!: string
  time!: number
  link!: unknown
  base?: unknown
  // the whole record a raise builds (host, form, code, time, note, link, base, site, flow), every field copied onto
  // the exception; typed as that record so code checked with tsc takes the fields a raise passes (TS2353 otherwise)
  constructor(base: { note: string; form: string; [field: string]: unknown }) {
    super(base.note)
    Object.assign(this, base)
    this.name = TermException.name
    // the frames of the raise, innermost first, in `capture-trace`'s shape, where the raise gave none: every raise
    // built `flow: []`, so an exception carried no stack (guides: library/exceptions, 2026-10-05)
    const flow = (this as { flow?: unknown }).flow
    if (!Array.isArray(flow) || flow.length === 0) {
      ;(this as { flow?: unknown }).flow = (this.stack ?? '').split(String.fromCharCode(10)).slice(1).map(line => line.trim()).filter(line => line.length !== 0)
    }
    // the hive hears every raise, once wakeHive has hooked it in
    const hive = (globalThis as { __termRaise?: (e: unknown) => void }).__termRaise
    if (hive) hive(this)
  }
}

function __termInt(x: number): number {
  if (!(x <= 9007199254740991 && x >= -9007199254740991)) __termIntStop(x)
  return x
}
function __termIntStop(x: number): never {
  const base = !Number.isFinite(x)
    ? { host: "@term/base", form: "defect", note: "Invalid", code: "", time: Date.now(), link: { thing: "a division or remainder by zero" } }
    : { host: "@term/base", form: x > 0 ? "excess" : "shortage", note: x > 0 ? "Too large" : "Too small", code: "", time: Date.now(), link: { thing: "number", limit: x > 0 ? 9007199254740991 : -9007199254740991, actual: x } }
  throw new TermException(base)
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

const __termSurrogate = { a: "", aHas: false, b: "", bHas: false, test(s: string): boolean { if (s === this.a) return this.aHas; if (s === this.b) return this.bHas; let has = false; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c >= 55296 && c <= 57343) { has = true; break } } this.b = this.a; this.bHas = this.aHas; this.a = s; this.aHas = has; return has } }
const __termWhite = [9, 10, 11, 12, 13, 32, 133, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288].map(c => String.fromCharCode(c)).join('')
const __termWhiteStart = new RegExp('^[' + __termWhite + ']+')
const __termWhiteEnd = new RegExp('[' + __termWhite + ']+$')
const __termText = {
  length(s: string): number {
    if (!__termSurrogate.test(s)) return s.length
    let n = 0
    for (const _ of s) n++
    return n
  },
  // the UTF-16 offset of code point i, for a text with surrogates
  offset(s: string, i: number): number {
    let at = 0
    let n = 0
    for (const c of s) {
      if (n === i) return at
      at += c.length
      n++
    }
    return s.length
  },
  charAt(s: string, i: number): string {
    if (!(i >= 0)) return ''
    if (!__termSurrogate.test(s)) return i < s.length ? s[i]! : ''
    let n = 0
    for (const c of s) {
      if (n === i) return c
      n++
    }
    return ''
  },
  at(s: string, i: number): string {
    return __termText.charAt(s, i)
  },
  charCodeAt(s: string, i: number): number {
    const c = __termText.charAt(s, i)
    return c === '' ? -1 : c.codePointAt(0)!
  },
  // a code point read through a cursor, [code-point index, unit offset] of the last read, stepped forward or back
  // from, or restarted at the start when that is nearer. A text with no surrogates is read by unit
  // the unit offset of code point i, the end past the last, for a text with surrogates
  cursorTo(s: string, i: number, c: number[]): number {
    let k = c[0]!
    let u = c[1]!
    if (i < k) {
      if (i <= k - i) {
        k = 0
        u = 0
      } else {
        while (k > i) {
          u--
          const x = s.charCodeAt(u)
          if (u > 0 && x >= 56320 && x <= 57343 && s.charCodeAt(u - 1) >= 55296 && s.charCodeAt(u - 1) <= 56319) u--
          k--
        }
      }
    }
    while (k < i && u < s.length) {
      u += s.codePointAt(u)! > 65535 ? 2 : 1
      k++
    }
    c[0] = k
    c[1] = u
    return u
  },
  cursorAt(s: string, i: number, c: number[]): number {
    if (!(i >= 0)) return -1
    if (!__termSurrogate.test(s)) return i < s.length ? s.charCodeAt(i) : -1
    const u = __termText.cursorTo(s, i, c)
    return c[0] === i && u < s.length ? s.codePointAt(u)! : -1
  },
  // the code points from a to e, both clamped and swapped when reversed: JavaScript's own substring on a text with no
  // surrogates, the cursor moved to the start and the end counted on from it otherwise
  cursorSlice(s: string, a: number, e: number, c: number[]): string {
    if (!__termSurrogate.test(s)) return s.substring(a, e)
    const x = Math.max(Math.min(a, e), 0)
    const y = Math.max(Math.max(a, e), 0)
    const from = __termText.cursorTo(s, x, c)
    let to = from
    let k = c[0]!
    while (k < y && to < s.length) {
      to += s.codePointAt(to)! > 65535 ? 2 : 1
      k++
    }
    return s.slice(from, to)
  },
  cursorCodeAt(s: string, i: number, c: number[]): number {
    return __termText.cursorAt(s, i, c)
  },
  cursorCharAt(s: string, i: number, c: number[]): string {
    const x = __termText.cursorAt(s, i, c)
    return x < 0 ? '' : String.fromCodePoint(x)
  },
  indexOf(s: string, n: string, from: number = 0): number {
    const size = __termText.length(s)
    const f = Math.min(Math.max(from, 0), size)
    if (n === '') return f
    const plain = !__termSurrogate.test(s)
    const found = s.indexOf(n, plain ? f : __termText.offset(s, f))
    if (found < 0) return -1
    return plain ? found : __termText.length(s.slice(0, found))
  },
  lastIndexOf(s: string, n: string): number {
    const found = s.lastIndexOf(n)
    if (found < 0) return -1
    return __termText.length(s.slice(0, found))
  },
  split(s: string, d: string): string[] {
    return d === '' ? Array.from(s) : s.split(d)
  },
  substring(s: string, a: number, b?: number): string {
    const plain = !__termSurrogate.test(s)
    const size = plain ? s.length : __termText.length(s)
    let x = Math.min(Math.max(a, 0), size)
    let y = Math.min(Math.max(b === undefined ? size : b, 0), size)
    if (x > y) [x, y] = [y, x]
    if (plain) return s.slice(x, y)
    const from = __termText.offset(s, x)
    return s.slice(from, from + __termText.offset(s.slice(from), y - x))
  },
  slice(s: string, a: number, b?: number): string {
    return __termText.substring(s, a, b)
  },
  toLowerCase(s: string): string {
    return s.toLowerCase()
  },
  toUpperCase(s: string): string {
    return s.toUpperCase()
  },
  trim(s: string): string {
    return s.replace(__termWhiteStart, '').replace(__termWhiteEnd, '')
  },
  trimStart(s: string): string {
    return s.replace(__termWhiteStart, '')
  },
  trimEnd(s: string): string {
    return s.replace(__termWhiteEnd, '')
  },
  pad(s: string, w: number, f: string, front: boolean): string {
    const size = __termText.length(s)
    if (size >= w || f === '') return s
    const fill = Array.from(f)
    let out = ''
    for (let i = 0; i < w - size; i++) out += fill[i % fill.length]
    return front ? out + s : s + out
  },
  padStart(s: string, w: number, f: string): string {
    return __termText.pad(s, w, f, true)
  },
  padEnd(s: string, w: number, f: string): string {
    return __termText.pad(s, w, f, false)
  },
  replace(s: string, a: string, b: string): string {
    const at = s.indexOf(a)
    return at < 0 ? s : s.slice(0, at) + b + s.slice(at + a.length)
  },
  replaceAll(s: string, a: string, b: string): string {
    if (a === '') return b + Array.from(s).join(b) + (s === '' ? '' : b)
    return s.split(a).join(b)
  },
  includes(s: string, n: string): boolean {
    return s.includes(n)
  },
  startsWith(s: string, n: string): boolean {
    return s.startsWith(n)
  },
  endsWith(s: string, n: string): boolean {
    return s.endsWith(n)
  },
  repeat(s: string, n: number): string {
    return n > 0 ? s.repeat(n) : ''
  },
  concat(s: string, b: string): string {
    return s + b
  },
  // code point order, which is UTF-8 byte order: JavaScript's < orders by UTF-16 unit, and the two disagree above
  // the basic plane
  // read in place: up to the first unit that differs the two agree, so that position is a code point boundary in both
  // (or the low half of one shared high surrogate), two units outside the surrogate range order as their code points,
  // and only a surrogate needs the whole code point read. It built two arrays of code points per comparison, so a sort
  // of texts allocated on every comparison
  compare(a: string, b: string): number {
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i++) {
      const x = a.charCodeAt(i)
      const y = b.charCodeAt(i)
      if (x !== y) {
        if ((x < 55296 || x > 57343) && (y < 55296 || y > 57343)) return x < y ? -1 : 1
        const p = a.codePointAt(i)!
        const q = b.codePointAt(i)!
        return p < q ? -1 : p > q ? 1 : 0
      }
    }
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
  },
}

function __termStop(thing: string): never {
  const base = { host: "@term/base", form: "defect", note: "Invalid", code: "", time: Date.now(), link: { thing } }
  throw new TermException(base)
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

export function hashValues<K, V>(self: Map<K, V>): V[] {
  return Array.from(self.values())
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

export function listSize<T>(self: T[]): number {
  return self.length
}

export function listPush<T>(self: T[], item: T): number {
  return self.push(item)
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

export function split(value: string, delimiter: string): string[] {
  return __termText.split(value, delimiter)
}

export function substring(value: string, startIndex: number, endIndex: number = 9007199254740991): string {
  return __termText.substring(value, startIndex, endIndex)
}

export function padLeft(value: string, length: number, fill: string): string {
  return __termText.padStart(value, length, fill)
}

export function replaceAll(value: string, search: string, replacement: string): string {
  return __termText.replaceAll(value, search, replacement)
}

export function count(value: Uint8Array): number {
  return octets.length(value)
}

export function length(value: Uint8Array): number {
  return octets.length(value)
}

const hexAlpha: string = "0123456789abcdef"

const toneAlpha: string = "mndbtkhsfvzxcwlr"

export function toneEncode(hex: string): string {
  const chars: string[] = split(hex, "")
  const out: string[] = ([] as string[])
  let count: number = 0
  for (const ch of chars) {
    if (count === 4) {
      out.push("-")
      count = 0
    }
    const i: number = __termText.indexOf(hexAlpha, ch, 0)
    out.push(__termText.charAt(toneAlpha, i))
    count = count + 1
  }
  return out.join("")
}

const toneWideAlpha: string = "mndbtkhsfvzxcwlrMNDBTKHSFVZXCWLR"

export interface Exception<P = any> {
  host: string
  form: string
  note: string
  code: string
  time: number
  link: P
  base: Maybe
  site: Maybe
  flow: any[]
}

export function exceptionCode(): string {
  const hex: string = replaceAll(crypto.randomUUID(), "-", "")
  const flat: string = replaceAll(toneEncode(hex), "-", "")
  const parts: string[] = [__termText.substring(flat, 0, 8), __termText.substring(flat, 8, 16), __termText.substring(flat, 16, 24), __termText.substring(flat, 24, 32)]
  return parts.join("-")
}

export interface Mismatch {
  host: string
  form: string
  note: string
  code: string
  time: number
  link: MismatchLink
  base: Maybe
  site: Maybe
  flow: any[]
}

export interface NumberMismatch {
  host: string
  form: string
  note: string
  code: string
  time: number
  link: NumberMismatchLink
  base: Maybe
  site: Maybe
  flow: any[]
}

function numberRuneAt(runes: number[], at: number): number {
  if (at >= 0 && at < runes.length) {
    return listGet(runes, at)
  }
  return -1
}

export function toFixed(value: number, places: number): string {
  if (places < 0 || places > 100) {
    throw new TermException({ host: "@local", form: "number-mismatch", code: exceptionCode(), time: date.now(), note: "Not a number", link: { thing: "places", at: 0, reason: "places is from 0 to 100" }, base: undefined as any, site: undefined as any, flow: [] })
  }
  const shown: string = `${value}`
  if (shown === "NaN" || (shown === "Infinity" || shown === "-Infinity")) {
    return shown
  }
  const r: number[] = Array.from(shown, function (rune) { return rune.codePointAt(0) ?? 0 })
  const n: number = r.length
  const negative: boolean = numberRuneAt(r, 0) === 45
  let i: number = 0
  if (negative) {
    i = 1
  }
  const digits: number[] = ([] as number[])
  let point: number = -1
  let exponent: number = 0
  let exponentNegative: boolean = false
  let inExponent: boolean = false
  while (i < n) {
    const c: number = listGet(r, i)
    if (c === 101) {
      inExponent = true
    } else if (c === 45) {
      exponentNegative = true
    } else if (c === 46) {
      point = digits.length
    } else if (c >= 48 && c <= 57) {
      if (inExponent) {
        const __n7 = __termInt(exponent * 10) + (c - 48); if (!(__n7 <= 9007199254740991 && __n7 >= -9007199254740991)) __termIntStop(__n7); exponent = __n7
      } else {
        digits.push(c - 48)
      }
    }
    i = i + 1
  }
  if (point < 0) {
    point = digits.length
  }
  if (exponentNegative) {
    const __n8 = 0 - exponent; if (!(__n8 <= 9007199254740991 && __n8 >= -9007199254740991)) __termIntStop(__n8); exponent = __n8
  }
  const __n9 = __termInt(point + exponent) + places; if (!(__n9 <= 9007199254740991 && __n9 >= -9007199254740991)) __termIntStop(__n9); const keep: number = __n9
  const kept: number[] = ([] as number[])
  let k: number = 0
  while (k < keep) {
    if (k < digits.length) {
      kept.push(listGet(digits, k))
    } else {
      kept.push(0)
    }
    k = k + 1
  }
  let next: number = 0
  if (keep >= 0 && keep < digits.length) {
    next = listGet(digits, keep)
  }
  if (next >= 5) {
    let carry: boolean = true
    let j: number = kept.length
    while (carry && j > 0) {
      const __n10 = j - 1; if (!(__n10 <= 9007199254740991 && __n10 >= -9007199254740991)) __termIntStop(__n10); j = __n10
      const __n11 = listGet(kept, j) + 1; if (!(__n11 <= 9007199254740991 && __n11 >= -9007199254740991)) __termIntStop(__n11); const d: number = __n11
      if (d === 10) {
        __termPut(kept, j, 0)
      } else {
        __termPut(kept, j, d)
        carry = false
      }
    }
    if (carry) {
      kept.unshift(1)
    }
  }
  const __n12 = places + 1 - kept.length; if (!(__n12 <= 9007199254740991 && __n12 >= -9007199254740991)) __termIntStop(__n12); const missing: number = __n12
  let pad: number = 0
  while (pad < missing) {
    kept.unshift(0)
    pad = pad + 1
  }
  const __n13 = kept.length - places; if (!(__n13 <= 9007199254740991 && __n13 >= -9007199254740991)) __termIntStop(__n13); const wholeCount: number = __n13
  let whole: string = ""
  let fraction: string = ""
  let started: boolean = false
  let nonzero: boolean = false
  k = 0
  for (const d of kept) {
    if (d !== 0) {
      nonzero = true
    }
    const written: string = String.fromCodePoint(__termInt(d + 48))
    if (k < wholeCount) {
      if (started || d !== 0 || k === __termInt(wholeCount - 1)) {
        started = true
        whole = `${whole}${written}`
      }
    } else {
      fraction = `${fraction}${written}`
    }
    const __n14 = k + 1; if (!(__n14 <= 9007199254740991 && __n14 >= -9007199254740991)) __termIntStop(__n14); k = __n14
  }
  let sign: string = ""
  if (negative && nonzero) {
    sign = "-"
  }
  if (places === 0) {
    return `${sign}${whole}`
  }
  return `${sign}${whole}.${fraction}`
}

export interface CallFrame {
  functionName: string
  url: string
  lineNumber: number
}

export interface ProfileNode {
  id: number
  callFrame: CallFrame
}

export interface V8Profile {
  nodes: ProfileNode[]
  startTime: number
  endTime: number
  samples: number[]
  timeDeltas: number[]
}

export interface CpuFrame {
  name: string
  location: string
  selfMs: number
  totalMs: number
}

export interface CpuResult {
  name: string
  durationMs: number
  sampleCount: number
  frames: CpuFrame[]
}

export interface MemoryResult {
  name: string
  heapUsedBeforeBytes: number
  heapUsedAfterBytes: number
  heapDeltaBytes: number
  rssAfterBytes: number
}

export function baseName(path: string): string {
  let rest: string = path
  while (__termText.endsWith(rest, "/")) {
    rest = substring(rest, 0, __termInt((Array.from(rest).length) - 1))
  }
  return substring(rest, __termText.lastIndexOf(rest, "/") + 1, 9007199254740991)
}

export function isSynthetic(name: string): boolean {
  return name === "(root)" || name === "(program)" || (name === "(idle)" || name === "(garbage collector)")
}

export function bySelfTime(left: CpuFrame, right: CpuFrame): Ordering {
  if (left.selfMs > right.selfMs) {
    return __termVariantLess
  }
  if (left.selfMs < right.selfMs) {
    return __termVariantGreater
  }
  return __termVariantEqual
}

export function summarize(profile: V8Profile, name: string, top: number): CpuResult {
  const nodes: Map<number, ProfileNode> = new Map()
  for (const node of profile.nodes) {
    nodes.set(node.id, node)
  }
  const selfMs: Map<number, number> = new Map()
  const sampled: number[] = ([] as number[])
  let at: number = 0
  for (const id of profile.samples) {
    let delta: number = 0
    if (at < profile.timeDeltas.length) {
      delta = listGet(profile.timeDeltas, at)
    }
    if (hashHas(selfMs, id)) {} else {
      sampled.push(id)
      selfMs.set(id, 0)
    }
    selfMs.set(id, maybeUnwrapOr(hashGet(selfMs, id), 0) + delta / 1000)
    const __n15 = at + 1; if (!(__n15 <= 9007199254740991 && __n15 >= -9007199254740991)) __termIntStop(__n15); at = __n15
  }
  const frames: Map<string, CpuFrame> = new Map()
  const order: string[] = ([] as string[])
  for (const id of sampled) {
    if (hashHas(nodes, id)) {
      const node: ProfileNode = maybeUnwrapOr(hashGet(nodes, id), { id: 0, callFrame: { functionName: "", url: "", lineNumber: 0 } })
      let functionName: string = node.callFrame.functionName
      if (functionName === "") {
        functionName = "(anonymous)"
      }
      if (functionName === "(root)" || functionName === "(program)" || (functionName === "(idle)" || functionName === "(garbage collector)")) {} else {
        let file: string = "native"
        if (node.callFrame.url === "") {} else {
          file = baseName(node.callFrame.url)
        }
        const location: string = `${file}:${node.callFrame.lineNumber + 1}`
        const key: string = `${functionName}@${location}`
        const ms: number = maybeUnwrapOr(hashGet(selfMs, id), 0)
        if (hashHas(frames, key)) {
          const held: CpuFrame = maybeUnwrapOr(hashGet(frames, key), { name: "", location: "", selfMs: 0, totalMs: 0 })
          held.selfMs = held.selfMs + ms
          held.totalMs = held.selfMs
          frames.set(key, held)
        } else {
          order.push(key)
          frames.set(key, { name: functionName, location: location, selfMs: ms, totalMs: ms })
        }
      }
    }
  }
  const gathered: CpuFrame[] = ([] as CpuFrame[])
  for (const key of order) {
    gathered.push(maybeUnwrapOr(hashGet(frames, key), { name: "", location: "", selfMs: 0, totalMs: 0 }))
  }
  const ranked: CpuFrame[] = sort(gathered, bySelfTime)
  const kept: CpuFrame[] = ([] as CpuFrame[])
  for (const frame of ranked) {
    if (kept.length < top) {
      kept.push(frame)
    }
  }
  return { name: name, durationMs: __termInt(profile.endTime - profile.startTime) / 1000, sampleCount: profile.samples.length, frames: kept }
}

export function blankNode(): ProfileNode {
  return { id: 0, callFrame: { functionName: "", url: "", lineNumber: 0 } }
}

export function blankFrame(): CpuFrame {
  return { name: "", location: "", selfMs: 0, totalMs: 0 }
}

export function makeFrame(name: string, location: string, ms: number): CpuFrame {
  return { name: name, location: location, selfMs: ms, totalMs: ms }
}

export function formatCpuResult(result: CpuResult): string {
  const lines: string[] = ([] as string[])
  lines.push(`${result.name}: ${toFixed(result.durationMs, 1)}ms wall, ${result.sampleCount} samples`)
  lines.push("")
  if (result.frames.length === 0) {
    lines.push("  (no user frames sampled; the run was too short)")
    return lines.join("\n")
  }
  let width: number = 8
  for (const frame of result.frames) {
    if ((Array.from(frame.name).length) > width) {
      width = Array.from(frame.name).length
    }
  }
  lines.push(`  ${__termText.padEnd("function", width, " ")}  ${__termText.padStart("self", 9, " ")}  location`)
  for (const frame of result.frames) {
    lines.push(`  ${__termText.padEnd(frame.name, width, " ")}  ${padLeft(`${toFixed(frame.selfMs, 1)}ms`, 9, " ")}  ${frame.location}`)
  }
  return lines.join("\n")
}

export function makeMemoryResult(name: string, heapBefore: number, heapAfter: number, rssAfter: number): MemoryResult {
  return { name: name, heapUsedBeforeBytes: heapBefore, heapUsedAfterBytes: heapAfter, heapDeltaBytes: __termInt(heapAfter - heapBefore), rssAfterBytes: rssAfter }
}

export function formatBytes(n: number): string {
  let sign: string = ""
  let size: number = n
  if (n < 0) {
    sign = "-"
    const __n16 = 0 - n; if (!(__n16 <= 9007199254740991 && __n16 >= -9007199254740991)) __termIntStop(__n16); size = __n16
  }
  if (size < 1024) {
    return `${sign}${size}B`
  }
  if (size < 1048576) {
    return `${sign}${toFixed(size / 1024, 1)}KB`
  }
  if (size < 1073741824) {
    return `${sign}${toFixed(size / 1024 / 1024, 2)}MB`
  }
  return `${sign}${toFixed(size / 1024 / 1024 / 1024, 2)}GB`
}

export function formatMemoryResult(result: MemoryResult): string {
  const lines: string[] = ([] as string[])
  lines.push(`  ${result.name}`)
  lines.push(`    heap before: ${formatBytes(result.heapUsedBeforeBytes)}`)
  lines.push(`    heap after:  ${formatBytes(result.heapUsedAfterBytes)}`)
  lines.push(`    retained:    ${formatBytes(result.heapDeltaBytes)}`)
  lines.push(`    rss:         ${formatBytes(result.rssAfterBytes)}`)
  return lines.join("\n")
}

export interface MismatchLink {
  thing: string
  expected?: string
  actual?: string
}

export interface NumberMismatchLink {
  thing: string
  expected?: string
  actual?: string
  at: number
  reason: string
}
