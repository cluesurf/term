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

declare const termbig: any
declare const crypto: any
declare const Date: any
const date: any = typeof Date === "undefined" ? undefined : Date
declare const Math: any
const math: any = typeof Math === "undefined" ? undefined : Math

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

const __termVariantUnit = Object.freeze({ form: "unit" as const })

export interface BigInteger {
  dock: any
}

export function bigIntegerDivide(self: BigInteger, other: BigInteger): BigInteger {
  return { dock: self.dock / other.dock }
}

export function bigFromNumber(value: number): BigInteger {
  return { dock: BigInt(value) }
}

export function bigAdd(a: BigInteger, b: BigInteger): BigInteger {
  return { dock: a.dock + b.dock }
}

export function bigSubtract(a: BigInteger, b: BigInteger): BigInteger {
  return { dock: a.dock - b.dock }
}

export function bigMultiply(a: BigInteger, b: BigInteger): BigInteger {
  return { dock: a.dock * b.dock }
}

export function bigCompare(a: BigInteger, b: BigInteger): number {
  return a.dock < b.dock ? -1 : (a.dock > b.dock ? 1 : 0)
}

export type BinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "&&"
  | "||"

export function toTextIn0110(value: BinaryOp): string {
  if (value === "+") {
    return "+"
  } else if (value === "-") {
    return "-"
  } else if (value === "*") {
    return "*"
  } else if (value === "/") {
    return "/"
  } else if (value === "%") {
    return "%"
  } else if (value === "==") {
    return "=="
  } else if (value === "!=") {
    return "!="
  } else if (value === "<") {
    return "<"
  } else if (value === "<=") {
    return "<="
  } else if (value === ">") {
    return ">"
  } else if (value === ">=") {
    return ">="
  } else if (value === "&&") {
    return "&&"
  } else {
    return "||"
  }
}

export function fromTextIn1120(value: string, fallback: BinaryOp): BinaryOp {
  if (value === "+") {
    return "+"
  }
  if (value === "-") {
    return "-"
  }
  if (value === "*") {
    return "*"
  }
  if (value === "/") {
    return "/"
  }
  if (value === "%") {
    return "%"
  }
  if (value === "==") {
    return "=="
  }
  if (value === "!=") {
    return "!="
  }
  if (value === "<") {
    return "<"
  }
  if (value === "<=") {
    return "<="
  }
  if (value === ">") {
    return ">"
  }
  if (value === ">=") {
    return ">="
  }
  if (value === "&&") {
    return "&&"
  }
  if (value === "||") {
    return "||"
  }
  return fallback
}

export type UnaryOp =
  | "-"
  | "!"

export function toTextIn0111(value: UnaryOp): string {
  if (value === "-") {
    return "-"
  } else {
    return "!"
  }
}

export function fromTextIn1121(value: string, fallback: UnaryOp): UnaryOp {
  if (value === "-") {
    return "-"
  }
  if (value === "!") {
    return "!"
  }
  return fallback
}

export type AssignOp =
  | "="
  | "+="
  | "-="
  | "*="
  | "/="

export function toTextIn0112(value: AssignOp): string {
  if (value === "=") {
    return "="
  } else if (value === "+=") {
    return "+="
  } else if (value === "-=") {
    return "-="
  } else if (value === "*=") {
    return "*="
  } else {
    return "/="
  }
}

export function fromTextIn1122(value: string, fallback: AssignOp): AssignOp {
  if (value === "=") {
    return "="
  }
  if (value === "+=") {
    return "+="
  }
  if (value === "-=") {
    return "-="
  }
  if (value === "*=") {
    return "*="
  }
  if (value === "/=") {
    return "/="
  }
  return fallback
}

export type IntegerLiteral =
  | { form: "small"; value: number }
  | { form: "big"; value: BigInteger }

export type TemplatePart =
  | { form: "chunk"; value: string }
  | { form: "value"; value: ExpressionForm }

export interface MapEntryIn00 {
  key: string
  value: ExpressionForm
}

export type ExpressionForm =
  | { form: "integer"; value: IntegerLiteral }
  | { form: "float"; value: number }
  | { form: "boolean"; value: boolean }
  | { form: "string"; value: string }
  | { form: "template"; parts: TemplatePart[] }
  | { form: "unit" }
  | { form: "array"; items: ExpressionForm[] }
  | { form: "map"; entries: MapEntryIn00[] }
  | { form: "variable"; name: string }
  | { form: "binary"; op: BinaryOp; left: ExpressionForm; right: ExpressionForm }
  | { form: "unary"; op: UnaryOp; operand: ExpressionForm }
  | { form: "call"; callee: ExpressionForm; args: ExpressionForm[] }
  | { form: "await"; expr: ExpressionForm }
  | { form: "index"; target: ExpressionForm; index: ExpressionForm }
  | { form: "member"; target: ExpressionForm; name: string }
  | { form: "closure"; params: string[]; body: Statement[]; isAsync?: boolean }

export interface BranchForm {
  cond: ExpressionForm
  body: Statement[]
}

export interface CatchClause {
  name: string
  body: Statement[]
}

export interface SwitchCase {
  match: ExpressionForm
  body: Statement[]
}

export type Statement =
  | { form: "let"; name: string; init: ExpressionForm; mutable: boolean }
  | { form: "assign"; target: ExpressionForm; op: AssignOp; value: ExpressionForm }
  | { form: "expression"; expr: ExpressionForm }
  | { form: "if"; branches: BranchForm[]; otherwise: Statement[] }
  | { form: "while"; cond: ExpressionForm; body: Statement[] }
  | { form: "switch"; subject: ExpressionForm; cases: SwitchCase[]; otherwise: Statement[] }
  | { form: "function"; name: string; params: string[]; body: Statement[]; isAsync?: boolean }
  | { form: "return"; value: ExpressionForm }
  | { form: "break" }
  | { form: "continue" }
  | { form: "block"; body: Statement[] }
  | { form: "throw"; value: ExpressionForm }
  | { form: "try"; body: Statement[]; catches: CatchClause[]; finallyBody: Statement[] }
  | { form: "for"; name: string; iterable: ExpressionForm; body: Statement[] }

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

export function split(value: string, delimiter: string): string[] {
  return __termText.split(value, delimiter)
}

export function replaceAll(value: string, search: string, replacement: string): string {
  return __termText.replaceAll(value, search, replacement)
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

export type Ordering =
  | { form: "less" }
  | { form: "equal" }
  | { form: "greater" }

export function listSize<T>(self: T[]): number {
  return self.length
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

export function listCopy<T>(self: T[]): T[] {
  return __termSlice(self, 0)
}

export function listSlice<T>(self: T[], start: number, end: number): T[] {
  return __termSlice(self, start, end)
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

export function listTakeFirst<T>(self: T[], count: number): T[] {
  return __termSlice(self, 0, count)
}

export function listDrop<T>(self: T[], count: number, side: Side): T[] {
  if (side.form === "end") {
    return __termSlice(self, 0, __termInt(self.length - count))
  } else if (side.form === "start") {
    return __termSlice(self, count)
  } else {
    return __termSlice(self, count, __termInt(self.length - count))
  }
}

export function chunk<T>(items: T[], count: number): T[][] {
  let width: number = count
  if (width < 1) {
    width = 1
  }
  const out: T[][] = ([] as T[][])
  let run: T[] = listTakeFirst(items, 0)
  for (const item of items) {
    run.push(item)
    if (run.length === width) {
      out.push(run)
      run = listTakeFirst(items, 0)
    }
  }
  if (run.length > 0) {
    out.push(run)
  }
  return out
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

export function fromRunes(runes: number[]): string {
  let result: string = ""
  for (const code of runes) {
    result = result + String.fromCodePoint(code)
  }
  return result
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

function numberDigitsEnd(runes: number[], at: number): number {
  let i: number = at
  while (i < runes.length && (numberRuneAt(runes, i) >= 48 && numberRuneAt(runes, i) <= 57)) {
    const __n1 = i + 1; if (!(__n1 <= 9007199254740991 && __n1 >= -9007199254740991)) __termIntStop(__n1); i = __n1
  }
  return i
}

export function parseFloat(value: string): number {
  const r: number[] = Array.from(value, function (rune) { return rune.codePointAt(0) ?? 0 })
  const n: number = r.length
  let i: number = 0
  if (numberRuneAt(r, 0) === 45) {
    i = 1
  }
  let end: number = numberDigitsEnd(r, i)
  if (end === i) {
    refuseNumber(i, "a digit was expected")
  }
  i = end
  if (numberRuneAt(r, i) === 46) {
    end = numberDigitsEnd(r, __termInt(i + 1))
    if (end === __termInt(i + 1)) {
      refuseNumber(__termInt(i + 1), "a digit was expected after the point")
    }
    i = end
  }
  const mark: number = numberRuneAt(r, i)
  if (mark === 101 || mark === 69) {
    const __n2 = i + 1; if (!(__n2 <= 9007199254740991 && __n2 >= -9007199254740991)) __termIntStop(__n2); i = __n2
    const sign: number = numberRuneAt(r, i)
    if (sign === 43 || sign === 45) {
      const __n3 = i + 1; if (!(__n3 <= 9007199254740991 && __n3 >= -9007199254740991)) __termIntStop(__n3); i = __n3
    }
    end = numberDigitsEnd(r, i)
    if (end === i) {
      refuseNumber(i, "a digit was expected in the exponent")
    }
    i = end
  }
  if (i < n) {
    refuseNumber(i, "the number ends before this")
  }
  return Number(value)
}

export interface WordRange {
  min: BigInteger
  max: BigInteger
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

export function tritLength(value: BigInteger): number {
  const trits: number[] = toTrits(value)
  return trits.length
}

export function tritWordRange(n: number): WordRange {
  let power: BigInteger = { dock: BigInt(1) }
  let k: number = 0
  while (k < n) {
    power = bigMultiply(power, { dock: BigInt(3) })
    k = k + 1
  }
  const below: BigInteger = bigSubtract(power, { dock: BigInt(1) })
  const half: BigInteger = bigIntegerDivide(below, { dock: BigInt(2) })
  return { min: { dock: -half.dock }, max: half }
}

export interface TernaryInteger {
  value: BigInteger
  resolution: string
}

export function resolutionWidth(resolution: string): number {
  if (resolution === "tri8") {
    return 8
  }
  if (resolution === "tri16") {
    return 16
  }
  if (resolution === "tri40") {
    return 40
  }
  return 0
}

export function fitResolution(value: BigInteger): string {
  const length: number = tritLength(value)
  const fixed: string[] = ([] as string[])
  fixed.push("tri8")
  fixed.push("tri16")
  fixed.push("tri40")
  for (const r of fixed) {
    if (length <= resolutionWidth(r)) {
      return r
    }
  }
  return "big"
}

export function makeInteger(value: BigInteger, resolution: string): TernaryInteger {
  if (resolution !== "" && resolution !== "big") {
    const width: number = resolutionWidth(resolution)
    const range: WordRange = tritWordRange(width)
    const below: boolean = (value.dock < range.min.dock ? -1 : (value.dock > range.min.dock ? 1 : 0)) < 0
    const above: boolean = (value.dock < range.max.dock ? -1 : (value.dock > range.max.dock ? 1 : 0)) > 0
    if (below || above) {
      const shown: string = value.dock.toString()
      throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`value ${shown} does not fit ${resolution} (width ${width})`)
    }
    return { value: value, resolution: resolution }
  }
  if (resolution === "big") {
    return { value: value, resolution: "big" }
  }
  return { value: value, resolution: fitResolution(value) }
}

export function compareTernaryIn131(a: TernaryInteger, b: TernaryInteger): number {
  return bigCompare(a.value, b.value)
}

export function power(base: number, exponent: number): number {
  return math.pow(base, exponent)
}

const defaultPrecision: number = 24

export interface TernaryFloat {
  mantissa: BigInteger
  exponent: number
}

export function isZeroIn80(value: BigInteger): boolean {
  return bigCompare(value, { dock: BigInt(0) }) === 0
}

export function powerOfThree(n: number): BigInteger {
  let out: BigInteger = { dock: BigInt(1) }
  let k: number = 0
  while (k < n) {
    out = bigMultiply(out, { dock: BigInt(3) })
    k = k + 1
  }
  return out
}

export function roundHalfUp(x: number): number {
  const floor: number = math.floor(x)
  if (x - floor >= 0.5) {
    return floor + 1
  }
  return floor
}

export function wholeToBig(x: number): BigInteger {
  if (!Number.isFinite(x)) {
    throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`The number ${x} cannot be converted to a BigInt because it is not an integer`)
  }
  let scaled: number = x
  let doublings: number = 0
  while (scaled >= 4611686018427388000 || scaled <= 0 - 4611686018427388000) {
    scaled = scaled / 2
    const __n4 = doublings + 1; if (!(__n4 <= 9007199254740991 && __n4 >= -9007199254740991)) __termIntStop(__n4); doublings = __n4
  }
  let out: BigInteger = bigFromNumber(Math.trunc(scaled))
  let k: number = 0
  while (k < doublings) {
    out = bigMultiply(out, { dock: BigInt(2) })
    k = k + 1
  }
  return out
}

export function normalizeIn61(mantissa: BigInteger, exponent: number): TernaryFloat {
  if (bigCompare(mantissa, { dock: BigInt(0) }) === 0) {
    return { mantissa: { dock: BigInt(0) }, exponent: 0 }
  }
  let m: BigInteger = mantissa
  let e: number = exponent
  const three: BigInteger = { dock: BigInt(3) }
  while (isZeroIn80({ dock: m.dock % three.dock })) {
    m = { dock: m.dock / three.dock }
    const __n5 = e + 1; if (!(__n5 <= 9007199254740991 && __n5 >= -9007199254740991)) __termIntStop(__n5); e = __n5
  }
  return { mantissa: m, exponent: e }
}

export function roundTo(value: TernaryFloat, precision: number): TernaryFloat {
  const length: number = tritLength(value.mantissa)
  if (length <= precision) {
    return value
  }
  const __n6 = length - precision; if (!(__n6 <= 9007199254740991 && __n6 >= -9007199254740991)) __termIntStop(__n6); const drop: number = __n6
  const scale: BigInteger = powerOfThree(drop)
  const half: BigInteger = bigIntegerDivide(scale, { dock: BigInt(2) })
  const m: BigInteger = value.mantissa
  let shifted: BigInteger = { dock: m.dock - half.dock }
  if (bigCompare(m, { dock: BigInt(0) }) >= 0) {
    shifted = { dock: m.dock + half.dock }
  }
  return normalizeIn61({ dock: shifted.dock / scale.dock }, __termInt(value.exponent + drop))
}

export function fromNumber(value: number, precision: number = defaultPrecision): TernaryFloat {
  if (value === 0 || !Number.isFinite(value)) {
    return { mantissa: { dock: BigInt(0) }, exponent: 0 }
  }
  const scale: number = math.pow(3, precision)
  const mantissa: BigInteger = wholeToBig(roundHalfUp(value * scale))
  return roundTo(normalizeIn61(mantissa, __termInt(0 - precision)), precision)
}

export function toNumberIn150(value: TernaryFloat): number {
  const m: BigInteger = value.mantissa
  const digits: string = m.dock.toString()
  const whole: number = parseFloat(digits)
  const places: number = value.exponent
  return whole * math.pow(3, places)
}

export function negateTernaryIn120(a: TernaryFloat): TernaryFloat {
  const m: BigInteger = a.mantissa
  return { mantissa: { dock: -m.dock }, exponent: a.exponent }
}

export function addTernaryIn90(a: TernaryFloat, b: TernaryFloat, precision: number = defaultPrecision): TernaryFloat {
  if (bigCompare(a.mantissa, { dock: BigInt(0) }) === 0) {
    return roundTo(b, precision)
  }
  if (bigCompare(b.mantissa, { dock: BigInt(0) }) === 0) {
    return roundTo(a, precision)
  }
  let e: number = a.exponent
  if (b.exponent < e) {
    e = b.exponent
  }
  const am: BigInteger = bigMultiply(a.mantissa, powerOfThree(__termInt(a.exponent - e)))
  const bm: BigInteger = bigMultiply(b.mantissa, powerOfThree(__termInt(b.exponent - e)))
  return roundTo(normalizeIn61({ dock: am.dock + bm.dock }, e), precision)
}

export function compareTernaryIn130(a: TernaryFloat, b: TernaryFloat): number {
  const d: number = toNumberIn150(addTernaryIn90(a, negateTernaryIn120(b), defaultPrecision))
  if (d < 0) {
    return -1
  }
  if (d > 0) {
    return 1
  }
  return 0
}

const maxLeafHost1: number = 64

const rebalanceDepthHost3: number = 32

export type Rope =
  | { form: "leaf"; text: string; length: number }
  | { form: "branch"; left: Rope; right: Rope; length: number; depth: number }

export function makeLeaf(text: string, length: number): Rope {
  return { form: "leaf", text: text, length: length }
}

export function build(points: number[]): Rope {
  if (points.length <= maxLeafHost1) {
    return makeLeaf(fromRunes(points), points.length)
  }
  const mid: number = Math.trunc(points.length / 2)
  const left: Rope = build(__termSlice(points, 0, mid))
  const right: Rope = build(__termSlice(points, mid, points.length))
  return joinHalvesIn171(left, right)
}

export function depthOfIn161(r: Rope): number {
  if (r.form === "leaf") {
    return 0
  } else {
    const depth = r.depth
    return depth
  }
}

export function joinHalvesIn171(left: Rope, right: Rope): Rope {
  const a: number = depthOfIn161(left)
  const b: number = depthOfIn161(right)
  let deeper: number = a
  if (b > a) {
    deeper = b
  }
  return { form: "branch", left: left, right: right, length: __termInt(measureIn181(left) + measureIn181(right)), depth: __termInt(1 + deeper) }
}

export function measureIn181(r: Rope): number {
  if (r.form === "leaf") {
    const length = r.length
    return length
  } else {
    const length = r.length
    return length
  }
}

export function toStringIn142(r: Rope): string {
  if (r.form === "leaf") {
    const text = r.text
    return text
  } else {
    const left = r.left
    const right = r.right
    return `${toStringIn142(left)}${toStringIn142(right)}`
  }
}

const maxLeafHost0: number = 32

const rebalanceDepthHost2: number = 40

export type Vector<T = any> =
  | { form: "leaf"; items: T[]; size: number }
  | { form: "branch"; left: Vector<T>; right: Vector<T>; size: number; depth: number }

export function empty<T>(): Vector<T> {
  return { form: "leaf", items: ([] as T[]), size: 0 }
}

export function fromArray<T>(items: T[]): Vector<T> {
  if (items.length <= maxLeafHost0) {
    return { form: "leaf", items: listCopy(items), size: items.length }
  }
  const mid: number = Math.trunc(items.length / 2)
  const left: Vector<T> = fromArray(__termSlice(items, 0, mid))
  const right: Vector<T> = fromArray(__termSlice(items, mid, items.length))
  return joinHalvesIn170(left, right)
}

export function depthOfIn160<T>(v: Vector<T>): number {
  if (v.form === "leaf") {
    return 0
  } else {
    const depth = v.depth
    return depth
  }
}

export function joinHalvesIn170<T>(left: Vector<T>, right: Vector<T>): Vector<T> {
  const a: number = depthOfIn160(left)
  const b: number = depthOfIn160(right)
  let deeper: number = a
  if (b > a) {
    deeper = b
  }
  return { form: "branch", left: left, right: right, size: __termInt(measureIn180(left) + measureIn180(right)), depth: __termInt(1 + deeper) }
}

export function measureIn180<T>(v: Vector<T>): number {
  if (v.form === "leaf") {
    const size = v.size
    return size
  } else {
    const size = v.size
    return size
  }
}

export function getIn200<T>(v: Vector<T>, index: number): T {
  while (true) {
    const count: number = measureIn180(v)
    if (index < 0 || index >= count) {
      throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`index ${index} out of range (size ${count})`)
    }
    if (v.form === "leaf") {
      const items = v.items
      return (index >= 0 && index < items.length ? items[index]! : __termReadPast(items, index))
    } else {
      const left = v.left
      const right = v.right
      const before: number = measureIn180(left)
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

export function pop<T>(v: Vector<T>): Vector<T> {
  const count: number = measureIn180(v)
  if (count === 0) {
    throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))("pop on empty vector")
  }
  return sliceIn51(v, 0, __termInt(count - 1))
}

export function sliceIn51<T>(v: Vector<T>, start: number, end: number): Vector<T> {
  const count: number = measureIn180(v)
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
    const before: number = measureIn180(left)
    if (e <= before) {
      return sliceIn51(left, s, e)
    }
    if (s >= before) {
      return sliceIn51(right, __termInt(s - before), __termInt(e - before))
    }
    return concatIn41(sliceIn51(left, s, before), sliceIn51(right, 0, __termInt(e - before)))
  }
}

export function concatIn41<T>(a: Vector<T>, b: Vector<T>): Vector<T> {
  if (measureIn180(a) === 0) {
    return b
  }
  if (measureIn180(b) === 0) {
    return a
  }
  const joined: Vector<T> = joinHalvesIn170(a, b)
  if (depthOfIn160(joined) > rebalanceDepthHost2) {
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
    const __n7 = at + 1; if (!(__n7 <= 9007199254740991 && __n7 >= -9007199254740991)) __termIntStop(__n7); at = __n7
  }
  return fromArray(out)
}

const tritsPerCodePoint: number = 14

export interface MapEntryIn01<V = any> {
  key: string
  value: V
}

export interface TrieNode<V = any> {
  entry: MapEntryIn01<V>[]
  kids: Map<number, TrieNode<V>>
}

export interface TernaryMap<V = any> {
  root: TrieNode<V>
  size: number
}

export function makeNode<V>(): TrieNode<V> {
  return { entry: ([] as MapEntryIn01<V>[]), kids: new Map() }
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
    const __n8 = t + 1; if (!(__n8 <= 9007199254740991 && __n8 >= -9007199254740991)) __termIntStop(__n8); const slot: number = __n8
    if (kids.has(slot)) {} else {
      return makeNode()
    }
    node = hashGetOrDefault(kids, slot, makeNode())
  }
  return node
}

export function has<V>(map: TernaryMap<V>, key: string): boolean {
  const node: TrieNode<V> = findNode(map.root, keyTrits(key))
  const entry: MapEntryIn01<V>[] = node.entry
  return entry.length > 0
}

export function entries<V>(map: TernaryMap<V>): MapEntryIn01<V>[] {
  const out: MapEntryIn01<V>[] = ([] as MapEntryIn01<V>[])
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

export type Value =
  | { form: "unit" }
  | { form: "boolean"; value: number }
  | { form: "integer"; value: TernaryInteger }
  | { form: "float"; value: TernaryFloat }
  | { form: "string"; value: Rope }
  | { form: "array"; value: Vector<Value> }
  | { form: "map"; value: MapCell }
  | { form: "function"; value: ClosureValue }
  | { form: "native"; name: string }
  | { form: "task"; value: TaskCell }

export interface MapCell {
  map: TernaryMap<Value>
}

export interface TaskCell {
  result: Value
  thrown: boolean
}

export interface ClosureValue {
  params: string[]
  body: Statement[]
  env: Scope
  isAsync: boolean
  name: string
}

export interface Scope {
  vars: Map<string, Value>
  consts: Map<string, boolean>
  parent: Scope[]
}

export function makeUnit(): Value {
  return __termVariantUnit
}

export function integer(value: BigInteger): Value {
  return { form: "integer", value: makeInteger(value, "") }
}

export function integerOf(value: number): Value {
  return integer({ dock: BigInt(value) })
}

export function float(value: number): Value {
  return { form: "float", value: fromNumber(value, defaultPrecision) }
}

export function boolean(truth: boolean): Value {
  let trit: number = -1
  if (truth) {
    trit = 1
  }
  return { form: "boolean", value: trit }
}

export function string(text: string): Value {
  return { form: "string", value: build(Array.from(text, function (rune) { return rune.codePointAt(0) ?? 0 })) }
}

export function integerValue(held: TernaryInteger): Value {
  return { form: "integer", value: held }
}

export function floatValue(held: TernaryFloat): Value {
  return { form: "float", value: held }
}

export function ropeValue(held: Rope): Value {
  return { form: "string", value: held }
}

export function arrayOf(items: Vector<Value>): Value {
  return { form: "array", value: items }
}

export function mapOf(cell: MapCell): Value {
  return { form: "map", value: cell }
}

export function functionOf(held: ClosureValue): Value {
  return { form: "function", value: held }
}

export function nativeOf(name: string): Value {
  return { form: "native", name: name }
}

export function taskOf(cell: TaskCell): Value {
  return { form: "task", value: cell }
}

export function truthy(v: Value): boolean {
  if (v.form === "unit") {
    return false
  } else if (v.form === "boolean") {
    const value = v.value
    return value === 1
  } else if (v.form === "integer") {
    const value = v.value
    return compareTernaryIn131(value, makeInteger({ dock: BigInt(0) }, "")) !== 0
  } else if (v.form === "float") {
    const value = v.value
    return toNumberIn150(value) !== 0
  } else if (v.form === "string") {
    const value = v.value
    return measureIn181(value) > 0
  } else if (v.form === "array") {
    const value = v.value
    return measureIn180(value) > 0
  } else if (v.form === "map") {
    const value = v.value
    return value.map.size > 0
  } else if (v.form === "function") {
    return true
  } else if (v.form === "native") {
    return true
  } else {
    return true
  }
}

export function valuesEqual(a: Value, b: Value): boolean {
  if (a.form === "unit") {
    if (b.form === "unit") {
      return true
    } else {
      return false
    }
  } else if (a.form === "boolean") {
    const left = a.value
    if (b.form === "boolean") {
      const value = b.value
      return left === value
    } else {
      return false
    }
  } else if (a.form === "integer") {
    const left = a.value
    if (b.form === "integer") {
      const value = b.value
      return bigCompare(left.value, value.value) === 0
    } else {
      return false
    }
  } else if (a.form === "float") {
    const left = a.value
    if (b.form === "float") {
      const value = b.value
      return compareTernaryIn130(left, value) === 0
    } else {
      return false
    }
  } else if (a.form === "string") {
    const left = a.value
    if (b.form === "string") {
      const value = b.value
      return measureIn181(left) === measureIn181(value) && toStringIn142(left) === toStringIn142(value)
    } else {
      return false
    }
  } else if (a.form === "array") {
    const left = a.value
    if (b.form === "array") {
      const value = b.value
      const count: number = measureIn180(left)
      if (count !== measureIn180(value)) {
        return false
      }
      let i: number = 0
      while (i < count) {
        if (!valuesEqual(getIn200(left, i), getIn200(value, i))) {
          return false
        }
        i = i + 1
      }
      return true
    } else {
      return false
    }
  } else if (a.form === "map") {
    const left = a.value
    if (b.form === "map") {
      const value = b.value
      return left === value
    } else {
      return false
    }
  } else if (a.form === "function") {
    const left = a.value
    if (b.form === "function") {
      const value = b.value
      return left === value
    } else {
      return false
    }
  } else if (a.form === "native") {
    const left = a.name
    if (b.form === "native") {
      const name = b.name
      return left === name
    } else {
      return false
    }
  } else {
    const left = a.value
    if (b.form === "task") {
      const value = b.value
      return left === value
    } else {
      return false
    }
  }
}

export function floatText(value: TernaryFloat): string {
  const n: number = toNumberIn150(value)
  return `${n}`
}

export function keyOf(v: Value): string {
  if (v.form === "integer") {
    const value = v.value
    return `i:${value.value.dock.toString()}`
  } else if (v.form === "string") {
    const value = v.value
    return `s:${toStringIn142(value)}`
  } else if (v.form === "boolean") {
    const value = v.value
    return `b:${value}`
  } else if (v.form === "float") {
    const value = v.value
    return `f:${floatText(value)}`
  } else if (v.form === "unit") {
    return "unit"
  } else {
    throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`value of form ${toFormName(v)} cannot be a map key`)
  }
}

export function toFormName(v: Value): string {
  if (v.form === "unit") {
    return "unit"
  } else if (v.form === "boolean") {
    return "boolean"
  } else if (v.form === "integer") {
    return "integer"
  } else if (v.form === "float") {
    return "float"
  } else if (v.form === "string") {
    return "string"
  } else if (v.form === "array") {
    return "array"
  } else if (v.form === "map") {
    return "map"
  } else if (v.form === "function") {
    return "function"
  } else if (v.form === "native") {
    return "native"
  } else {
    return "task"
  }
}

export function display(v: Value): string {
  if (v.form === "unit") {
    return "null"
  } else if (v.form === "boolean") {
    const value = v.value
    if (value === 1) {
      return "true"
    }
    if (value === -1) {
      return "false"
    }
    return "unknown"
  } else if (v.form === "integer") {
    const value = v.value
    return value.value.dock.toString()
  } else if (v.form === "float") {
    const value = v.value
    return floatText(value)
  } else if (v.form === "string") {
    const value = v.value
    return toStringIn142(value)
  } else if (v.form === "array") {
    const value = v.value
    const shown: string[] = ([] as string[])
    for (const item of toArray(value)) {
      shown.push(display(item))
    }
    return `[${shown.join(", ")}]`
  } else if (v.form === "map") {
    const value = v.value
    return `{${value.map.size} entries}`
  } else if (v.form === "function") {
    const held = v.value
    let name: string = "(anon)"
    if (held.name !== "") {
      name = held.name
    }
    return `function ${name}`
  } else if (v.form === "native") {
    const name = v.name
    return `native ${name}`
  } else {
    return "task"
  }
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
