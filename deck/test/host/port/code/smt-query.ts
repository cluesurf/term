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

;
// The one place @term/test reaches a solver: SMT-LIB2 text in, Z3's answer out. Everything around it (the formulas,
// their text, the queries, reading the answers, every algorithm built on them) is Term, in smt-query.tree and the
// modules that load it, which dock this as `load <global:smt-text>`.
//
// Z3 is the `z3-solver` package (WebAssembly), opened once on first use, so this runs on node. A native backend would
// hand the same text to a `z3` process; the text is the interface, which is why it is text (2026-10-05). The package is
// resolved from the working directory, because the module this is prepended to may be written anywhere (`term test`
// writes it to a temporary directory, where no package resolves).
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let smtContext: Promise<(text: string) => Promise<string>> | undefined

const smtText = {
  evaluate: async (text: string): Promise<string> => {
    smtContext ??= (async () => {
      const found = createRequire(join(process.cwd(), 'noop.js')).resolve('z3-solver')
      const { init } = (await import(pathToFileURL(found).href)) as { init: () => Promise<{ Z3: Record<string, (...a: unknown[]) => unknown> }> }
      const { Z3 } = await init()
      const ctx = Z3.mk_context!(Z3.mk_config!())

      return (query: string) => Z3.eval_smtlib2_string!(ctx, query) as Promise<string>
    })()

    return (await smtContext)(text)
  },
}

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

export function hashValues<K, V>(self: Map<K, V>): V[] {
  return Array.from(self.values())
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

export function listJoin<T>(self: T[], separator: string): string {
  return self.join(separator)
}

export function listFirst<T>(self: T[]): Maybe<T> {
  if (self.length > 0) {
    return { form: "some", value: (0 < self.length ? self[0]! : __termReadPast(self, 0)) }
  } else {
    return __termVariantNone
  }
}

export function split(value: string, delimiter: string): string[] {
  return __termText.split(value, delimiter)
}

export function trim(value: string): string {
  return __termText.trim(value)
}

export function replaceAll(value: string, search: string, replacement: string): string {
  return __termText.replaceAll(value, search, replacement)
}

export function count(value: Uint8Array): number {
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

function refuseNumber(at: number, reason: string): number {
  throw new TermException({ host: "@local", form: "number-mismatch", code: exceptionCode(), time: date.now(), note: "Not a number", link: { thing: "number", at: at, reason: reason }, base: undefined as any, site: undefined as any, flow: [] })
}

function numberRuneAt(runes: number[], at: number): number {
  if (at >= 0 && at < runes.length) {
    return listGet(runes, at)
  }
  return -1
}

function digitValue(c: number): number {
  if (c >= 48 && c <= 57) {
    return c - 48
  }
  if (c >= 97 && c <= 122) {
    return c - 87
  }
  if (c >= 65 && c <= 90) {
    return c - 55
  }
  return -1
}

export function parseInteger(value: string, radix: number = 10): number {
  if (radix < 2 || radix > 36) {
    refuseNumber(0, "a radix is from 2 to 36")
  }
  const r: number[] = Array.from(value, function (rune) { return rune.codePointAt(0) ?? 0 })
  const n: number = r.length
  let i: number = 0
  let negative: boolean = false
  const first: number = numberRuneAt(r, 0)
  if (first === 45) {
    negative = true
    i = 1
  } else if (first === 43) {
    i = 1
  }
  if (i >= n) {
    refuseNumber(i, "no digits")
  }
  let total: number = 0
  while (i < n && i < r.length) {
    const d: number = digitValue(listGet(r, i))
    if (d < 0 || d >= radix) {
      refuseNumber(i, `not a digit in base ${radix}`)
    }
    if (negative) {
      const __n0 = __termInt(total * radix) - d; if (!(__n0 <= 9007199254740991 && __n0 >= -9007199254740991)) __termIntStop(__n0); total = __n0
    } else {
      const __n1 = __termInt(total * radix) + d; if (!(__n1 <= 9007199254740991 && __n1 >= -9007199254740991)) __termIntStop(__n1); total = __n1
    }
    const __n2 = i + 1; if (!(__n2 <= 9007199254740991 && __n2 >= -9007199254740991)) __termIntStop(__n2); i = __n2
  }
  return total
}

export type SmtTerm =
  | { form: "int-value"; value: number }
  | { form: "int-name"; name: string }
  | { form: "plus"; left: SmtTerm; right: SmtTerm }
  | { form: "minus"; left: SmtTerm; right: SmtTerm }
  | { form: "times"; left: SmtTerm; right: SmtTerm }
  | { form: "opposite"; inner: SmtTerm }
  | { form: "modulo"; left: SmtTerm; right: SmtTerm }
  | { form: "choose"; test: Formula; then: SmtTerm; else: SmtTerm }

export type Formula =
  | { form: "truth"; value: boolean }
  | { form: "all-of"; items: Formula[] }
  | { form: "any-of"; items: Formula[] }
  | { form: "denial"; inner: Formula }
  | { form: "relation"; op: string; left: SmtTerm; right: SmtTerm }
  | { form: "for-every"; names: string[]; body: Formula }

export interface Verdict {
  status: string
  values: number[]
}

export function valueTerm(value: number): SmtTerm {
  return { form: "int-value", value: value }
}

export function nameTerm(name: string): SmtTerm {
  return { form: "int-name", name: name }
}

export function related(op: string, left: SmtTerm, right: SmtTerm): Formula {
  return { form: "relation", op: op, left: left, right: right }
}

export function both(left: Formula, right: Formula): Formula {
  const items: Formula[] = [left, right]
  return { form: "all-of", items: items }
}

export function either(left: Formula, right: Formula): Formula {
  const items: Formula[] = [left, right]
  return { form: "any-of", items: items }
}

export function negated(inner: Formula): Formula {
  return { form: "denial", inner: inner }
}

export function quantified(names: string[], body: Formula): Formula {
  return { form: "for-every", names: names, body: body }
}

export function numberText(value: number): string {
  if (value < 0) {
    return `(- ${__termInt(0 - value)})`
  }
  return `${value}`
}

export function termText(value: SmtTerm): string {
  if (value.form === "int-value") {
    const n = value.value
    return numberText(n)
  } else if (value.form === "int-name") {
    const written = value.name
    return written
  } else if (value.form === "plus") {
    const left = value.left
    const right = value.right
    return `(+ ${termText(left)} ${termText(right)})`
  } else if (value.form === "minus") {
    const left = value.left
    const right = value.right
    return `(- ${termText(left)} ${termText(right)})`
  } else if (value.form === "times") {
    const left = value.left
    const right = value.right
    return `(* ${termText(left)} ${termText(right)})`
  } else if (value.form === "opposite") {
    const inner = value.inner
    return `(- ${termText(inner)})`
  } else if (value.form === "modulo") {
    const left = value.left
    const right = value.right
    return `(mod ${termText(left)} ${termText(right)})`
  } else {
    const test = value.test
    const then = value.then
    const else_ = value.else
    return `(ite ${formulaText(test)} ${termText(then)} ${termText(else_)})`
  }
}

export function joinedFormulas(items: Formula[]): string {
  const parts: string[] = ([] as string[])
  for (const each of items) {
    parts.push(formulaText(each))
  }
  return parts.join(" ")
}

export function formulaText(value: Formula): string {
  if (value.form === "truth") {
    const holds = value.value
    if (holds) {
      return "true"
    }
    return "false"
  } else if (value.form === "all-of") {
    const items = value.items
    if (items.length === 0) {
      return "true"
    }
    return `(and ${joinedFormulas(items)})`
  } else if (value.form === "any-of") {
    const items = value.items
    if (items.length === 0) {
      return "false"
    }
    return `(or ${joinedFormulas(items)})`
  } else if (value.form === "denial") {
    const inner = value.inner
    return `(not ${formulaText(inner)})`
  } else if (value.form === "relation") {
    const op = value.op
    const left = value.left
    const right = value.right
    return `(${op} ${termText(left)} ${termText(right)})`
  } else {
    const names = value.names
    const body = value.body
    if (names.length === 0) {
      return formulaText(body)
    }
    const bound: string[] = ([] as string[])
    for (const each of names) {
      bound.push(`(${each} Int)`)
    }
    return `(forall (${bound.join(" ")}) ${formulaText(body)})`
  }
}

export function readValues(printed: string): number[] {
  const values: number[] = ([] as number[])
  const letters: string[] = split(printed, "")
  let depth: number = 0
  let token: string = ""
  let negative: boolean = false
  let item: number = 0
  for (const letter of letters) {
    if (letter === "(") {
      const __n3 = depth + 1; if (!(__n3 <= 9007199254740991 && __n3 >= -9007199254740991)) __termIntStop(__n3); depth = __n3
    }
    if (letter === ")" || letter === " " || (letter === "\n" || letter === "(")) {
      if (token === "-") {
        negative = true
      } else {
        if (token !== "") {
          if (item > 0) {
            const n: number = parseInteger(token, 10)
            if (negative) {
              values.push(__termInt(0 - n))
            } else {
              values.push(n)
            }
            negative = false
            item = 0
          } else {
            item = 1
          }
        }
      }
      token = ""
    } else {
      token = `${token}${letter}`
    }
    if (letter === ")") {
      const __n4 = depth - 1; if (!(__n4 <= 9007199254740991 && __n4 >= -9007199254740991)) __termIntStop(__n4); depth = __n4
    }
  }
  return values
}

export function solverAnswer(printed: string): string {
  return printed
}

export async function checkSat(names: string[], assertion: Formula): Promise<Verdict> {
  const lines: string[] = ([] as string[])
  lines.push("(reset)")
  for (const each of names) {
    lines.push(`(declare-const ${each} Int)`)
  }
  lines.push(`(assert ${formulaText(assertion)})`)
  lines.push("(check-sat)")
  if (names.length > 0) {
    lines.push(`(get-value (${names.join(" ")}))`)
  }
  const evaluated: any = await smtText.evaluate(listJoin(lines, "\n"))
  const printed: string = evaluated
  const answer: string[] = split(__termText.trim(printed), "\n")
  const status: string = trim((0 < answer.length ? answer[0]! : __termReadPast(answer, 0)))
  const none: number[] = ([] as number[])
  if (status === "sat" && names.length > 0) {
    const rest: string[] = ([] as string[])
    let at: number = 1
    while (at < answer.length) {
      rest.push(listGet(answer, at))
      at = at + 1
    }
    return { status: status, values: readValues(rest.join("\n")) }
  }
  return { status: status, values: none }
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
