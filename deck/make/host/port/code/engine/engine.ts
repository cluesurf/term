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
declare const console: any
declare const process: any

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

const __termVariantNormal = Object.freeze({ form: "normal" as const })

const __termVariantUnit = Object.freeze({ form: "unit" as const })

const __termVariantBroke = Object.freeze({ form: "broke" as const })

const __termVariantContinued = Object.freeze({ form: "continued" as const })

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

export function substring(value: string, startIndex: number, endIndex: number = 9007199254740991): string {
  return __termText.substring(value, startIndex, endIndex)
}

export function toLowerCase(value: string): string {
  return __termText.toLowerCase(value)
}

export function toUpperCase(value: string): string {
  return __termText.toUpperCase(value)
}

export function trim(value: string): string {
  return __termText.trim(value)
}

export function replaceAll(value: string, search: string, replacement: string): string {
  return __termText.replaceAll(value, search, replacement)
}

export function contains(value: string, search: string): boolean {
  return __termText.includes(value, search)
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

export type Ordering =
  | { form: "less" }
  | { form: "equal" }
  | { form: "greater" }

export function orderingIsLess(self: Ordering): boolean {
  if (self.form === "less") {
    return true
  } else if (self.form === "equal") {
    return false
  } else {
    return false
  }
}

export function orderingIsGreater(self: Ordering): boolean {
  if (self.form === "greater") {
    return true
  } else if (self.form === "less") {
    return false
  } else {
    return false
  }
}

export function fromTexts(left: string, right: string): Ordering {
  const sign: any = __termText.compare(left, right)
  if (sign < 0) {
    return __termVariantLess
  } else {
    if (sign > 0) {
      return __termVariantGreater
    } else {
      return __termVariantEqual
    }
  }
}

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

export function listJoin<T>(self: T[], separator: string): string {
  return self.join(separator)
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

export function listLast<T>(self: T[]): Maybe<T> {
  if (self.length > 0) {
    return { form: "some", value: __termAt(self, __termInt(self.length - 1)) }
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

export function toTextIn00(value: Uint8Array): string {
  return octets.toText(value)
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

export interface Refusal {
  host: string
  form: string
  note: string
  code: string
  time: number
  link: RefusalLink
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

export function wrap(value: BigInteger): TernaryInteger {
  return { value: value, resolution: fitResolution(value) }
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

export function negateTernaryIn121(a: TernaryInteger): TernaryInteger {
  const value: BigInteger = a.value
  return { value: { dock: -value.dock }, resolution: a.resolution }
}

export function absoluteTernary(a: TernaryInteger): TernaryInteger {
  const value: BigInteger = a.value
  if (bigCompare(value, { dock: BigInt(0) }) < 0) {
    return wrap({ dock: -value.dock })
  }
  return { value: value, resolution: fitResolution(value) }
}

export function divideTernary(a: TernaryInteger, b: TernaryInteger): TernaryInteger {
  if (bigCompare(b.value, { dock: BigInt(0) }) === 0) {
    throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))("division by zero")
  }
  const value: BigInteger = a.value
  return wrap({ dock: value.dock / b.value.dock })
}

export function remainderTernary(a: TernaryInteger, b: TernaryInteger): TernaryInteger {
  if (bigCompare(b.value, { dock: BigInt(0) }) === 0) {
    throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))("division by zero")
  }
  const value: BigInteger = a.value
  return wrap({ dock: value.dock % b.value.dock })
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

export function fromString(text: string): Rope {
  return build(Array.from(text, function (rune) { return rune.codePointAt(0) ?? 0 }))
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

export function concatIn42(a: Rope, b: Rope): Rope {
  if (measureIn181(a) === 0) {
    return b
  }
  if (measureIn181(b) === 0) {
    return a
  }
  const joined: Rope = joinHalvesIn171(a, b)
  if (depthOfIn161(joined) > rebalanceDepthHost3) {
    return fromString(toStringIn142(joined))
  }
  return joined
}

export function charAtIn21(r: Rope, index: number): string {
  const count: number = measureIn181(r)
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
      const before: number = measureIn181(left)
      if (i < before) {
        node = left
      } else {
        const __n7 = i - before; if (!(__n7 <= 9007199254740991 && __n7 >= -9007199254740991)) __termIntStop(__n7); i = __n7
        node = right
      }
    }
  }
  return ""
}

export function sliceIn52(r: Rope, start: number, end: number): Rope {
  const count: number = measureIn181(r)
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
    const before: number = measureIn181(left)
    if (e <= before) {
      return sliceIn52(left, s, e)
    }
    if (s >= before) {
      return sliceIn52(right, __termInt(s - before), __termInt(e - before))
    }
    return concatIn42(sliceIn52(left, s, before), sliceIn52(right, 0, __termInt(e - before)))
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

export function setIn210<T>(v: Vector<T>, index: number, value: T): Vector<T> {
  const count: number = measureIn180(v)
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
    const before: number = measureIn180(left)
    if (index < before) {
      return joinHalvesIn170(setIn210(left, index, value), right)
    }
    return joinHalvesIn170(left, setIn210(right, __termInt(index - before), value))
  }
}

export function pushIn220<T>(v: Vector<T>, value: T): Vector<T> {
  if (v.form === "leaf") {
    const items = v.items
    const size = v.size
    if (items.length < maxLeafHost0) {
      const grown: T[] = listCopy(items)
      grown.push(value)
      return { form: "leaf", items: grown, size: __termInt(size + 1) }
    }
    const alone: T[] = ([] as T[])
    alone.push(value)
    const tail: Vector<T> = { form: "leaf", items: alone, size: 1 }
    return joinHalvesIn170(v, tail)
  } else {
    const left = v.left
    const right = v.right
    const grown: Vector<T> = joinHalvesIn170(left, pushIn220(right, value))
    if (depthOfIn160(grown) > rebalanceDepthHost2) {
      return fromArray(toArray(grown))
    }
    return grown
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
    const __n8 = at + 1; if (!(__n8 <= 9007199254740991 && __n8 >= -9007199254740991)) __termIntStop(__n8); at = __n8
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

export interface TrieChange<V = any> {
  node: TrieNode<V>
  delta: number
}

export function makeNode<V>(): TrieNode<V> {
  return { entry: ([] as MapEntryIn01<V>[]), kids: new Map() }
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
    const __n9 = t + 1; if (!(__n9 <= 9007199254740991 && __n9 >= -9007199254740991)) __termIntStop(__n9); const slot: number = __n9
    if (kids.has(slot)) {} else {
      return makeNode()
    }
    node = hashGetOrDefault(kids, slot, makeNode())
  }
  return node
}

export function writeAt<V>(node: TrieNode<V>, trits: number[], at: number, entry: MapEntryIn01<V>[]): TrieChange<V> {
  if (at === trits.length) {
    const had: MapEntryIn01<V>[] = node.entry
    const next: TrieNode<V> = { ...node }
    next.entry = entry
    return { node: next, delta: __termInt(entry.length - had.length) }
  }
  const kids: Map<number, TrieNode<V>> = node.kids
  const __n10 = listGet(trits, at) + 1; if (!(__n10 <= 9007199254740991 && __n10 >= -9007199254740991)) __termIntStop(__n10); const slot: number = __n10
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

export function setIn211<V>(map: TernaryMap<V>, key: string, value: V): TernaryMap<V> {
  const one: MapEntryIn01<V>[] = ([] as MapEntryIn01<V>[])
  one.push({ key: key, value: value })
  const change: TrieChange<V> = writeAt(map.root, keyTrits(key), 0, one)
  return { root: change.node, size: __termInt(map.size + change.delta) }
}

export function lookupIn230<V>(map: TernaryMap<V>, key: string, fallback: V): V {
  const node: TrieNode<V> = findNode(map.root, keyTrits(key))
  const entry: MapEntryIn01<V>[] = node.entry
  if (entry.length === 0) {
    return fallback
  }
  const first: MapEntryIn01<V> = (0 < entry.length ? entry[0]! : __termReadPast(entry, 0))
  return first.value
}

export function has<V>(map: TernaryMap<V>, key: string): boolean {
  const node: TrieNode<V> = findNode(map.root, keyTrits(key))
  const entry: MapEntryIn01<V>[] = node.entry
  return entry.length > 0
}

export function remove<V>(map: TernaryMap<V>, key: string): TernaryMap<V> {
  if (has(map, key)) {} else {
    return map
  }
  const none: MapEntryIn01<V>[] = ([] as MapEntryIn01<V>[])
  const change: TrieChange<V> = writeAt(map.root, keyTrits(key), 0, none)
  return { root: change.node, size: __termInt(map.size + change.delta) }
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

export type ValueForm =
  | { form: "unit" }
  | { form: "boolean"; value: number }
  | { form: "integer"; value: TernaryInteger }
  | { form: "float"; value: TernaryFloat }
  | { form: "string"; value: Rope }
  | { form: "array"; value: Vector<ValueForm> }
  | { form: "map"; value: MapCell }
  | { form: "function"; value: ClosureValue }
  | { form: "native"; name: string }
  | { form: "task"; value: TaskCell }

export interface MapCell {
  map: TernaryMap<ValueForm>
}

export interface TaskCell {
  result: ValueForm
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
  vars: Map<string, ValueForm>
  consts: Map<string, boolean>
  parent: Scope[]
}

export function integer(value: BigInteger): ValueForm {
  return { form: "integer", value: makeInteger(value, "") }
}

export function integerOf(value: number): ValueForm {
  return integer({ dock: BigInt(value) })
}

export function float(value: number): ValueForm {
  return { form: "float", value: fromNumber(value, defaultPrecision) }
}

export function boolean(truth: boolean): ValueForm {
  let trit: number = -1
  if (truth) {
    trit = 1
  }
  return { form: "boolean", value: trit }
}

export function string(text: string): ValueForm {
  return { form: "string", value: build(Array.from(text, function (rune) { return rune.codePointAt(0) ?? 0 })) }
}

export function integerValue(held: TernaryInteger): ValueForm {
  return { form: "integer", value: held }
}

export function floatValue(held: TernaryFloat): ValueForm {
  return { form: "float", value: held }
}

export function ropeValue(held: Rope): ValueForm {
  return { form: "string", value: held }
}

export function arrayOf(items: Vector<ValueForm>): ValueForm {
  return { form: "array", value: items }
}

export function truthy(v: ValueForm): boolean {
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

export function valuesEqual(a: ValueForm, b: ValueForm): boolean {
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

export function keyOf(v: ValueForm): string {
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

export function toFormName(v: ValueForm): string {
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

export function display(v: ValueForm): string {
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

export function writeLine(message: string): void {
  console.log(message)
}

export function log(message: string): void {
  writeLine(message)
}

export type Signal =
  | { form: "normal" }
  | { form: "returned"; value: ValueForm }
  | { form: "broke" }
  | { form: "continued" }
  | { form: "thrown"; value: ValueForm }

export type Outcome =
  | { form: "done"; value: ValueForm }
  | { form: "thrown"; value: ValueForm }

export function nativeNames(): string[] {
  return ["print", "len", "push", "str", "int", "keys", "float", "abs", "min", "max", "pow", "sqrt", "floor", "ceil", "range", "pop", "slice", "reverse", "first", "last", "contains", "indexOf", "sort", "map", "filter", "reduce", "sortBy", "split", "join", "upper", "lower", "replace", "trim", "has", "get", "setKey", "del", "entries"]
}

export function finish(v: ValueForm): Outcome {
  return { form: "done", value: v }
}

export function failWith(v: ValueForm): Outcome {
  return { form: "thrown", value: v }
}

export function isThrown(o: Outcome): boolean {
  if (o.form === "thrown") {
    return true
  } else {
    return false
  }
}

export function valueOf(o: Outcome): ValueForm {
  if (o.form === "done") {
    const value = o.value
    return value
  } else {
    const value = o.value
    return value
  }
}

export function signalOf(o: Outcome): Signal {
  return { form: "thrown", value: valueOf(o) }
}

export function normal(): Signal {
  return __termVariantNormal
}

export function isNormal(s: Signal): boolean {
  if (s.form === "normal") {
    return true
  } else {
    return false
  }
}

export function makeScope(parent: Scope[]): Scope {
  return __termShare({ vars: new Map(), consts: new Map(), parent: parent })
}

export function childScope(parent: Scope): Scope {
  const parents: Scope[] = ([] as Scope[])
  parents.push(parent)
  return __termShare({ vars: new Map(), consts: new Map(), parent: parents })
}

export function define(into: Scope, name: string, v: ValueForm, mutable: boolean): void {
  into.vars.set(name, v)
  if (!mutable) {
    into.consts.set(name, true)
  }
}

export function lookup(from: Scope, name: string): ValueForm {
  let here: Scope = from
  while (true) {
    if (here.vars.has(name)) {
      return here.vars.get(name)!
    }
    if (here.parent.length === 0) {
      throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`undefined variable "${name}"`)
    }
    here = listGet(here.parent, 0)
  }
  throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`undefined variable "${name}"`)
}

export function assignVar(into: Scope, name: string, v: ValueForm): void {
  let here: Scope = into
  while (true) {
    if (here.vars.has(name)) {
      if (here.consts.has(name)) {
        throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`cannot assign to const "${name}"`)
      }
      here.vars.set(name, v)
      return
    }
    if (here.parent.length === 0) {
      throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`assignment to undefined variable "${name}"`)
    }
    here = listGet(here.parent, 0)
  }
}

export function numberOfBig(big: BigInteger): number {
  return parseFloat(big.dock.toString())
}

export function indexOfValue(index: ValueForm): number {
  if (index.form === "integer") {
    const value = index.value
    return Math.trunc(parseFloat(value.value.dock.toString()))
  } else {
    throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`an index must be an integer, not ${toFormName(index)}`)
  }
}

export function numberOf(v: ValueForm): number {
  if (v.form === "integer") {
    const value = v.value
    return parseFloat(value.value.dock.toString())
  } else if (v.form === "float") {
    const value = v.value
    return toNumberIn150(value)
  } else if (v.form === "string") {
    const value = v.value
    return parseFloat(trim(toStringIn142(value)))
  } else {
    throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`int of ${toFormName(v)}`)
  }
}

export function integerOfNumber(n: number): ValueForm {
  return integer(wholeToBig(n))
}

export function toFloat(v: ValueForm): TernaryFloat {
  if (v.form === "float") {
    const value = v.value
    return value
  } else if (v.form === "integer") {
    const value = v.value
    return fromNumber(parseFloat(value.value.dock.toString()), defaultPrecision)
  } else {
    throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`expected a number, got ${toFormName(v)}`)
  }
}

export function compareResult(op: BinaryOp, c: number): ValueForm {
  if (op === "<") {
    return boolean(c < 0)
  } else if (op === "<=") {
    return boolean(c <= 0)
  } else if (op === ">") {
    return boolean(c > 0)
  } else if (op === ">=") {
    return boolean(c >= 0)
  } else {
    throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`bad comparison ${toTextIn0110(op)}`)
  }
}

export function compareTexts(a: string, b: string): number {
  const order: Ordering = fromTexts(a, b)
  if (orderingIsLess(order)) {
    return -1
  }
  if (orderingIsGreater(order)) {
    return 1
  }
  return 0
}

export function binary(op: BinaryOp, a: ValueForm, b: ValueForm): ValueForm {
  if (op === "==") {
    return boolean(valuesEqual(a, b))
  } else if (op === "!=") {
    return boolean(!valuesEqual(a, b))
  } else {
    const other: boolean = true
  }
  if (a.form === "string") {
    const left = a.value
    if (b.form === "string") {
      const value = b.value
      if (op === "+") {
        return ropeValue(concatIn42(left, value))
      } else {
        return compareResult(op, compareTexts(toStringIn142(left), toStringIn142(value)))
      }
    } else {
      const other: boolean = true
    }
  } else if (a.form === "array") {
    const left = a.value
    if (b.form === "array") {
      const value = b.value
      if (op === "+") {
        return arrayOf(concatIn41(left, value))
      } else {
        const other: boolean = true
      }
    } else {
      const other: boolean = true
    }
  } else if (a.form === "integer") {
    const left = a.value
    if (b.form === "integer") {
      const value = b.value
      if (op === "+") {
        return integerValue(wrap(bigAdd(left.value, value.value)))
      } else if (op === "-") {
        return integerValue(wrap(bigSubtract(left.value, value.value)))
      } else if (op === "*") {
        return integerValue(wrap(bigMultiply(left.value, value.value)))
      } else if (op === "/") {
        return integerValue(divideTernary(left, value))
      } else if (op === "%") {
        return integerValue(remainderTernary(left, value))
      } else {
        return compareResult(op, bigCompare(left.value, value.value))
      }
    } else {
      const other: boolean = true
    }
  } else {
    const other: boolean = true
  }
  const af: TernaryFloat = toFloat(a)
  const bf: TernaryFloat = toFloat(b)
  if (op === "+") {
    return floatValue(addTernaryIn90(af, bf, defaultPrecision))
  } else if (op === "-") {
    return floatValue(addTernaryIn90(af, negateTernaryIn120(bf), defaultPrecision))
  } else if (op === "*") {
    return floatValue(roundTo(normalizeIn61(bigMultiply(af.mantissa, bf.mantissa), __termInt(af.exponent + bf.exponent)), defaultPrecision))
  } else if (op === "/") {
    return float(toNumberIn150(af) / toNumberIn150(bf))
  } else if (op === "%") {
    const x: number = toNumberIn150(af)
    const y: number = toNumberIn150(bf)
    let whole: number = x / y
    whole = roundTowardZero(whole)
    return { form: "float", value: fromNumber(x - whole * y, defaultPrecision) }
  } else {
    return compareResult(op, compareTernaryIn130(af, bf))
  }
}

export function roundTowardZero(x: number): number {
  if (x < 0) {
    return math.ceil(x)
  }
  return math.floor(x)
}

export function indexGet(target: ValueForm, index: ValueForm): ValueForm {
  if (target.form === "array") {
    const value = target.value
    return getIn200(value, indexOfValue(index))
  } else if (target.form === "string") {
    const value = target.value
    return string(charAtIn21(value, indexOfValue(index)))
  } else if (target.form === "map") {
    const value = target.value
    return lookupIn230(value.map, keyOf(index), __termVariantUnit)
  } else {
    throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`cannot index a ${toFormName(target)}`)
  }
}

export function memberGet(target: ValueForm, name: string): ValueForm {
  if (name === "length") {
    if (target.form === "string") {
      const value = target.value
      return integerOf(measureIn181(value))
    } else if (target.form === "array") {
      const value = target.value
      return integerOf(measureIn180(value))
    } else if (target.form === "map") {
      const value = target.value
      return integer({ dock: BigInt(value.map.size) })
    } else {}
  }
  if (target.form === "map") {
    const value = target.value
    return lookupIn230(value.map, `s:${name}`, __termVariantUnit)
  } else {
    throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`no member "${name}" on ${toFormName(target)}`)
  }
}

export function evaluate(expr: ExpressionForm, within: Scope): Outcome {
  {
    const __at1 = expr
    if (__at1.form === "integer") {
    const value = __at1.value
    {
      const __at2 = value
      if (__at2.form === "small") {
      const value = __at2.value
      return finish(integer({ dock: BigInt(value) }))
    } else {
      const value = __at2.value
      return finish({ form: "integer", value: makeInteger(value, "") })
    }
    }
  } else if (__at1.form === "float") {
    const value = __at1.value
    return finish({ form: "float", value: fromNumber(value, defaultPrecision) })
  } else if (__at1.form === "boolean") {
    const value = __at1.value
    return finish(boolean(value))
  } else if (__at1.form === "string") {
    const value = __at1.value
    return finish({ form: "string", value: build(Array.from(value, function (rune) { return rune.codePointAt(0) ?? 0 })) })
  } else if (__at1.form === "template") {
    const parts = __at1.parts
    let out: string = ""
    for (const part of parts) {
      if (part.form === "chunk") {
        const value = part.value
        out = `${out}${value}`
      } else {
        const value = part.value
        const o: Outcome = evaluate(value, within)
        if (isThrown(o)) {
          return o
        }
        out = `${out}${display(valueOf(o))}`
      }
    }
    return finish({ form: "string", value: build(Array.from(out, function (rune) { return rune.codePointAt(0) ?? 0 })) })
  } else if (__at1.form === "unit") {
    return { form: "done", value: __termVariantUnit }
  } else if (__at1.form === "variable") {
    const name = __at1.name
    return finish(lookup(within, name))
  } else if (__at1.form === "array") {
    const items = __at1.items
    const made: ValueForm[] = ([] as ValueForm[])
    for (const item of items) {
      const o: Outcome = evaluate(item, within)
      if (isThrown(o)) {
        return o
      }
      made.push(valueOf(o))
    }
    return finish(arrayOf(fromArray(made)))
  } else if (__at1.form === "map") {
    const entries = __at1.entries
    const cell: MapCell = __termShare({ map: makeMap() })
    for (const entry of entries) {
      const o: Outcome = evaluate(entry.value, within)
      if (isThrown(o)) {
        return o
      }
      cell.map = setIn211(cell.map, `s:${entry.key}`, valueOf(o))
    }
    return { form: "done", value: { form: "map", value: cell } }
  } else if (__at1.form === "closure") {
    const params = __at1.params
    const body = __at1.body
    const isAsync = __at1.isAsync
    const made: ClosureValue = __termShare({ params: copyTexts(params), body: copyStatements(body), env: within, isAsync: definitely(isAsync), name: "" })
    return { form: "done", value: { form: "function", value: made } }
  } else if (__at1.form === "unary") {
    const op = __at1.op
    const operand = __at1.operand
    const o: Outcome = evaluate(operand, within)
    if (isThrown(o)) {
      return o
    }
    const v: ValueForm = valueOf(o)
    if (op === "!") {
      return finish(boolean(!truthy(v)))
    } else {
      if (v.form === "integer") {
        const value = v.value
        return finish(integerValue(negateTernaryIn121(value)))
      } else if (v.form === "float") {
        const value = v.value
        return finish(floatValue(negateTernaryIn120(value)))
      } else {
        throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`unary - on ${toFormName(v)}`)
      }
    }
  } else if (__at1.form === "binary") {
    const op = __at1.op
    const left = __at1.left
    const right = __at1.right
    const lo: Outcome = evaluate(left, within)
    if (isThrown(lo)) {
      return lo
    }
    const l: ValueForm = valueOf(lo)
    if (op === "&&") {
      if (truthy(l)) {
        return evaluate(right, within)
      }
      return lo
    } else if (op === "||") {
      if (truthy(l)) {
        return lo
      }
      return evaluate(right, within)
    } else {
      const ro: Outcome = evaluate(right, within)
      if (isThrown(ro)) {
        return ro
      }
      return finish(binary(op, l, valueOf(ro)))
    }
  } else if (__at1.form === "index") {
    const target = __at1.target
    const index = __at1.index
    const t: Outcome = evaluate(target, within)
    if (isThrown(t)) {
      return t
    }
    const i: Outcome = evaluate(index, within)
    if (isThrown(i)) {
      return i
    }
    return finish(indexGet(valueOf(t), valueOf(i)))
  } else if (__at1.form === "member") {
    const target = __at1.target
    const name = __at1.name
    const t: Outcome = evaluate(target, within)
    if (isThrown(t)) {
      return t
    }
    return finish(memberGet(valueOf(t), name))
  } else if (__at1.form === "await") {
    const expr = __at1.expr
    const o: Outcome = evaluate(expr, within)
    if (isThrown(o)) {
      return o
    }
    const v: ValueForm = valueOf(o)
    if (v.form === "task") {
      const value = v.value
      if (value.thrown) {
        return { form: "thrown", value: value.result }
      }
      return { form: "done", value: value.result }
    } else {
      return o
    }
  } else {
    const callee = __at1.callee
    const args = __at1.args
    const f: Outcome = evaluate(callee, within)
    if (isThrown(f)) {
      return f
    }
    const given: ValueForm[] = ([] as ValueForm[])
    for (const arg of args) {
      const o: Outcome = evaluate(arg, within)
      if (isThrown(o)) {
        return o
      }
      given.push(valueOf(o))
    }
    const fn: ValueForm = valueOf(f)
    if (fn.form === "native") {
      const name = fn.name
      return callNative(name, given)
    } else if (fn.form === "function") {
      const value = fn.value
      if (value.isAsync) {
        const ran: Outcome = applyClosure(value, given)
        const cell: TaskCell = __termShare({ result: valueOf(ran), thrown: isThrown(ran) })
        return { form: "done", value: { form: "task", value: cell } }
      }
      return applyClosure(value, given)
    } else {
      throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`cannot call a ${toFormName(fn)}`)
    }
  }
  }
}

export function execute(stmt: Statement, within: Scope): Signal {
  if (stmt.form === "let") {
    const name = stmt.name
    const init = stmt.init
    const mutable = stmt.mutable
    const o: Outcome = evaluate(init, within)
    if (isThrown(o)) {
      return { form: "thrown", value: valueOf(o) }
    }
    define(within, name, valueOf(o), mutable)
    return __termVariantNormal
  } else if (stmt.form === "expression") {
    const expr = stmt.expr
    const o: Outcome = evaluate(expr, within)
    if (isThrown(o)) {
      return { form: "thrown", value: valueOf(o) }
    }
    return __termVariantNormal
  } else if (stmt.form === "return") {
    const value = stmt.value
    const o: Outcome = evaluate(value, within)
    if (isThrown(o)) {
      return { form: "thrown", value: valueOf(o) }
    }
    return { form: "returned", value: valueOf(o) }
  } else if (stmt.form === "break") {
    return __termVariantBroke
  } else if (stmt.form === "continue") {
    return __termVariantContinued
  } else if (stmt.form === "block") {
    const body = stmt.body
    return executeBlock(body, childScope(within))
  } else if (stmt.form === "throw") {
    const value = stmt.value
    const o: Outcome = evaluate(value, within)
    if (isThrown(o)) {
      return { form: "thrown", value: valueOf(o) }
    }
    return { form: "thrown", value: valueOf(o) }
  } else if (stmt.form === "try") {
    const body = stmt.body
    const catches = stmt.catches
    const finallyBody = stmt.finallyBody
    let result: Signal = executeBlock(body, childScope(within))
    if (result.form === "thrown") {
      const caught = result.value
      if (catches.length > 0) {
        const clause: CatchClause = (0 < catches.length ? catches[0]! : __termReadPast(catches, 0))
        const inside: Scope = childScope(within)
        if (clause.name !== "") {
          define(inside, clause.name, caught, true)
        }
        result = executeBlock(clause.body, inside)
      }
    } else {
      const kept: boolean = true
    }
    if (finallyBody.length > 0) {
      const after: Signal = executeBlock(finallyBody, childScope(within))
      if (!isNormal(after)) {
        return after
      }
    }
    return result
  } else if (stmt.form === "for") {
    const name = stmt.name
    const iterable = stmt.iterable
    const body = stmt.body
    const o: Outcome = evaluate(iterable, within)
    if (isThrown(o)) {
      return { form: "thrown", value: valueOf(o) }
    }
    for (const item of forItems(valueOf(o))) {
      const inner: Scope = childScope(within)
      define(inner, name, item, true)
      const sig: Signal = executeBlock(body, inner)
      if (sig.form === "broke") {
        break
      } else if (sig.form === "returned") {
        return sig
      } else if (sig.form === "thrown") {
        return sig
      } else {
        const kept: boolean = true
      }
    }
    return __termVariantNormal
  } else if (stmt.form === "function") {
    const name = stmt.name
    const params = stmt.params
    const body = stmt.body
    const isAsync = stmt.isAsync
    const made: ClosureValue = __termShare({ params: copyTexts(params), body: copyStatements(body), env: within, isAsync: definitely(isAsync), name: name })
    define(within, name, { form: "function", value: made }, false)
    return __termVariantNormal
  } else if (stmt.form === "assign") {
    const target = stmt.target
    const op = stmt.op
    const value = stmt.value
    return assign(target, op, value, within)
  } else if (stmt.form === "if") {
    const branches = stmt.branches
    const otherwise = stmt.otherwise
    for (const branch of branches) {
      const o: Outcome = evaluate(branch.cond, within)
      if (isThrown(o)) {
        return { form: "thrown", value: valueOf(o) }
      }
      if (truthy(valueOf(o))) {
        return executeBlock(branch.body, childScope(within))
      }
    }
    return executeBlock(otherwise, childScope(within))
  } else if (stmt.form === "while") {
    const cond = stmt.cond
    const body = stmt.body
    while (true) {
      const o: Outcome = evaluate(cond, within)
      if (isThrown(o)) {
        return { form: "thrown", value: valueOf(o) }
      }
      if (!truthy(valueOf(o))) {
        break
      }
      const sig: Signal = executeBlock(body, childScope(within))
      if (sig.form === "broke") {
        break
      } else if (sig.form === "returned") {
        return sig
      } else {
        const kept: boolean = true
      }
    }
    return __termVariantNormal
  } else {
    const subject = stmt.subject
    const cases = stmt.cases
    const otherwise = stmt.otherwise
    const o: Outcome = evaluate(subject, within)
    if (isThrown(o)) {
      return { form: "thrown", value: valueOf(o) }
    }
    let matched: number = -1
    let at: number = 0
    for (const one of cases) {
      const m: Outcome = evaluate(one.match, within)
      if (isThrown(m)) {
        return { form: "thrown", value: valueOf(m) }
      }
      if (valuesEqual(valueOf(o), valueOf(m))) {
        matched = at
        break
      }
      const __n11 = at + 1; if (!(__n11 <= 9007199254740991 && __n11 >= -9007199254740991)) __termIntStop(__n11); at = __n11
    }
    const inner: Scope = childScope(within)
    if (matched < 0) {
      return executeBlock(otherwise, inner)
    }
    at = matched
    while (at < cases.length) {
      const one: SwitchCase = listGet(cases, at)
      const sig: Signal = executeBlock(one.body, inner)
      if (sig.form === "broke") {
        return __termVariantNormal
      } else if (sig.form === "returned") {
        return sig
      } else if (sig.form === "continued") {
        return sig
      } else {
        const kept: boolean = true
      }
      at = at + 1
    }
    return __termVariantNormal
  }
}

export function executeBlock(body: Statement[], within: Scope): Signal {
  for (const stmt of body) {
    const sig: Signal = execute(stmt, within)
    if (!isNormal(sig)) {
      return sig
    }
  }
  return __termVariantNormal
}

export function opOf(op: AssignOp): BinaryOp {
  if (op === "+=") {
    return "+"
  } else if (op === "-=") {
    return "-"
  } else if (op === "*=") {
    return "*"
  } else if (op === "/=") {
    return "/"
  } else {
    return "+"
  }
}

export function updated(op: AssignOp, current: ValueForm, rhs: ValueForm): ValueForm {
  if (op === "=") {
    return rhs
  } else {
    return binary(opOf(op), current, rhs)
  }
}

export function assign(target: ExpressionForm, op: AssignOp, valueExpression: ExpressionForm, within: Scope): Signal {
  const o: Outcome = evaluate(valueExpression, within)
  if (isThrown(o)) {
    return { form: "thrown", value: valueOf(o) }
  }
  const rhs: ValueForm = valueOf(o)
  let plain: boolean = false
  if (op === "=") {
    plain = true
  } else {
    plain = false
  }
  if (target.form === "variable") {
    const name = target.name
    let next: ValueForm = rhs
    if (!plain) {
      next = updated(op, lookup(within, name), rhs)
    }
    assignVar(within, name, next)
    return __termVariantNormal
  } else if (target.form === "index") {
    const holder = target.target
    const at = target.index
    let heldName: string = ""
    if (holder.form === "variable") {
      const name1 = holder.name
      heldName = name1
    } else {
      throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`${"index assignment target must be a variable"}`)
    }
    const container: ValueForm = lookup(within, heldName)
    const io: Outcome = evaluate(at, within)
    if (isThrown(io)) {
      return { form: "thrown", value: valueOf(io) }
    }
    const index: ValueForm = valueOf(io)
    if (container.form === "array") {
      const value = container.value
      let i: number = 0
      if (index.form === "integer") {
        const value1 = index.value
        i = Math.trunc(parseFloat(value1.value.dock.toString()))
      } else {
        throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`an index must be an integer, not ${toFormName(index)}`)
      }
      let current: ValueForm = __termVariantUnit
      if (!plain) {
        current = getIn200(value, i)
      }
      assignVar(within, heldName, arrayOf(setIn210(value, i, updated(op, current, rhs))))
      return __termVariantNormal
    } else if (container.form === "map") {
      const value = container.value
      let k: string = ""
      if (index.form === "integer") {
        const value2 = index.value
        k = `i:${value2.value.dock.toString()}`
      } else if (index.form === "string") {
        const value2 = index.value
        k = `s:${toStringIn142(value2)}`
      } else if (index.form === "boolean") {
        const value2 = index.value
        k = `b:${value2}`
      } else if (index.form === "float") {
        const value2 = index.value
        k = `f:${floatText(value2)}`
      } else if (index.form === "unit") {
        k = "unit"
      } else {
        throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`value of form ${toFormName(index)} cannot be a map key`)
      }
      let current: ValueForm = __termVariantUnit
      if (!plain) {
        current = lookupIn230(value.map, k, __termVariantUnit)
      }
      value.map = setIn211(value.map, k, updated(op, current, rhs))
      return __termVariantNormal
    } else {
      throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`cannot index-assign a ${toFormName(container)}`)
    }
  } else if (target.form === "member") {
    const holder = target.target
    const field = target.name
    let heldName: string = ""
    if (holder.form === "variable") {
      const name2 = holder.name
      heldName = name2
    } else {
      throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`${"member assignment target must be a variable"}`)
    }
    const container: ValueForm = lookup(within, heldName)
    if (container.form === "map") {
      const value = container.value
      let k: string = `s:${field}`
      let current: ValueForm = __termVariantUnit
      if (!plain) {
        current = lookupIn230(value.map, k, __termVariantUnit)
      }
      value.map = setIn211(value.map, k, updated(op, current, rhs))
      return __termVariantNormal
    } else {
      throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`cannot set member on a ${toFormName(container)}`)
    }
  } else {
    throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))("invalid assignment target")
  }
}

export function nameOfVariable(e: ExpressionForm, refusal: string): string {
  if (e.form === "variable") {
    const name = e.name
    return name
  } else {
    throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`${refusal}`)
  }
}

export function definitely(flag?: boolean): boolean {
  if (flag) {
    return true
  }
  return false
}

export function applyClosure(fn: ClosureValue, given: ValueForm[]): Outcome {
  const inner: Scope = childScope(fn.env)
  { const __walked1 = fn.params; for (let i = 0; i < __walked1.length; i++) {
    const param = __walked1[i]!
    let v: ValueForm = __termVariantUnit
    if (i < given.length) {
      v = listGet(given, i)
    }
    define(inner, param, v, true)
  } }
  const sig: Signal = executeBlock(fn.body, inner)
  if (sig.form === "thrown") {
    const value = sig.value
    return { form: "thrown", value: value }
  } else if (sig.form === "returned") {
    const value = sig.value
    return { form: "done", value: value }
  } else {
    return { form: "done", value: __termVariantUnit }
  }
}

export function callValue(fn: ValueForm, given: ValueForm[]): Outcome {
  if (fn.form === "function") {
    const value = fn.value
    return applyClosure(value, given)
  } else if (fn.form === "native") {
    const name = fn.name
    return callNative(name, given)
  } else if (fn.form === "task") {
    const value = fn.value
    if (value.thrown) {
      return { form: "thrown", value: value.result }
    }
    return { form: "done", value: value.result }
  } else {
    throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`cannot call a ${toFormName(fn)}`)
  }
}

export function stripPrefix(key: string, prefixes: string[]): string {
  for (const prefix of prefixes) {
    if (__termText.startsWith(key, prefix)) {
      return substring(key, Array.from(prefix).length, Array.from(key).length)
    }
  }
  return key
}

export function forItems(v: ValueForm): ValueForm[] {
  const out: ValueForm[] = ([] as ValueForm[])
  if (v.form === "array") {
    const value = v.value
    return toArray(value)
  } else if (v.form === "string") {
    const value = v.value
    for (const rune of Array.from(toStringIn142(value), function (rune) { return rune.codePointAt(0) ?? 0 })) {
      out.push(string(String.fromCodePoint(rune)))
    }
    return out
  } else if (v.form === "map") {
    const value = v.value
    for (const key of keys(value.map)) {
      out.push(string(stripPrefix(key, ["s:"])))
    }
    return out
  } else {
    throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`cannot iterate a ${toFormName(v)}`)
  }
}

export function arg(given: ValueForm[], i: number): ValueForm {
  if (i < given.length) {
    return listGet(given, i)
  }
  return __termVariantUnit
}

export function itemsOf(v: ValueForm, op: string): ValueForm[] {
  if (v.form === "array") {
    const value = v.value
    return toArray(value)
  } else {
    throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`${op} needs an array, got ${toFormName(v)}`)
  }
}

export function indexLength(v: ValueForm): ValueForm {
  if (v.form === "string") {
    const value = v.value
    return integerOf(measureIn181(value))
  } else if (v.form === "array") {
    const value = v.value
    return integerOf(measureIn180(value))
  } else if (v.form === "map") {
    const value = v.value
    return integer({ dock: BigInt(value.map.size) })
  } else {
    throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`len of ${toFormName(v)}`)
  }
}

export function compareValues(a: ValueForm, b: ValueForm): Ordering {
  const below: BinaryOp = "<"
  if (truthy(binary(below, a, b))) {
    return __termVariantLess
  }
  const above: BinaryOp = ">"
  if (truthy(binary(above, a, b))) {
    return __termVariantGreater
  }
  return __termVariantEqual
}

export function compareValuesNumber(a: ValueForm, b: ValueForm): number {
  {
    const __at1 = compareValues(a, b)
    if (__at1.form === "less") {
    return -1
  } else if (__at1.form === "greater") {
    return 1
  } else {
    return 0
  }
  }
}

export function bigPower(base: BigInteger, exponent: number): BigInteger {
  let out: BigInteger = { dock: BigInt(1) }
  let square: BigInteger = base
  let left: number = exponent
  while (left > 0) {
    const half: number = Math.trunc(left / 2)
    if (__termInt(left - __termInt(half * 2)) !== 0) {
      out = { dock: out.dock * square.dock }
    }
    square = { dock: square.dock * square.dock }
    left = half
  }
  return out
}

export function callNative(name: string, given: ValueForm[]): Outcome {
  const a0: ValueForm = arg(given, 0)
  const a1: ValueForm = arg(given, 1)
  const a2: ValueForm = arg(given, 2)
  if (name === "print") {
    const shown: string[] = ([] as string[])
    for (const one of given) {
      shown.push(display(one))
    }
    log(shown.join(" "))
    return { form: "done", value: __termVariantUnit }
  }
  if (name === "len") {
    return finish(indexLength(a0))
  }
  if (name === "push") {
    if (a0.form === "array") {
      const value = a0.value
      return finish(arrayOf(pushIn220(value, a1)))
    } else {
      throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))("push needs an array")
    }
  }
  if (name === "str") {
    return finish(string(display(a0)))
  }
  if (name === "int") {
    return finish(integerOfNumber(numberOf(a0)))
  }
  if (name === "keys") {
    if (a0.form === "map") {
      const value = a0.value
      const out: ValueForm[] = ([] as ValueForm[])
      for (const key of keys(value.map)) {
        out.push(string(stripPrefix(key, ["s:"])))
      }
      return finish(arrayOf(fromArray(out)))
    } else {
      throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))("keys needs a map")
    }
  }
  if (name === "float") {
    return finish(float(numberOf(a0)))
  }
  if (name === "abs") {
    if (a0.form === "integer") {
      const value = a0.value
      return finish(integerValue(absoluteTernary(value)))
    } else {
      return finish(float(math.abs(numberOf(a0))))
    }
  }
  if (name === "min") {
    if (compareValuesNumber(a0, a1) <= 0) {
      return { form: "done", value: a0 }
    }
    return { form: "done", value: a1 }
  }
  if (name === "max") {
    if (compareValuesNumber(a0, a1) >= 0) {
      return { form: "done", value: a0 }
    }
    return { form: "done", value: a1 }
  }
  if (name === "pow") {
    if (a0.form === "integer") {
      const x = a0.value
      if (a1.form === "integer") {
        const value = a1.value
        if (parseFloat(value.value.dock.toString()) >= 0) {
          return finish(integer(bigPower(x.value, Math.trunc(parseFloat(value.value.dock.toString())))))
        }
      } else {
        const other: boolean = true
      }
    } else {
      const other: boolean = true
    }
    return finish(float(math.pow(numberOf(a0), numberOf(a1))))
  }
  if (name === "sqrt") {
    return finish(float(math.sqrt(numberOf(a0))))
  }
  if (name === "floor") {
    return finish(integerOfNumber(math.floor(numberOf(a0))))
  }
  if (name === "ceil") {
    return finish(integerOfNumber(math.ceil(numberOf(a0))))
  }
  if (name === "range") {
    let first: number = 0
    if (given.length > 1) {
      first = numberOf(a0)
    }
    let last: number = 0
    const v1: ValueForm = listGet(given, __termInt(given.length - 1))
    if (v1.form === "integer") {
      const value3 = v1.value
      last = parseFloat(value3.value.dock.toString())
    } else if (v1.form === "float") {
      const value3 = v1.value
      last = toNumberIn150(value3)
    } else if (v1.form === "string") {
      const value3 = v1.value
      last = parseFloat(trim(toStringIn142(value3)))
    } else {
      throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`int of ${toFormName(v1)}`)
    }
    const out: ValueForm[] = ([] as ValueForm[])
    let i: number = first
    while (i < last) {
      out.push(integer(wholeToBig(i)))
      i = i + 1
    }
    return finish(arrayOf(fromArray(out)))
  }
  if (name === "pop") {
    if (a0.form === "array") {
      const value = a0.value
      return finish(arrayOf(pop(value)))
    } else {
      throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))("pop needs an array")
    }
  }
  if (name === "slice") {
    const s: number = Math.trunc(numberOf(a1))
    if (a0.form === "array") {
      const value = a0.value
      let e: number = measureIn180(value)
      if (given.length > 2) {
        e = Math.trunc(numberOf(a2))
      }
      return finish(arrayOf(sliceIn51(value, s, e)))
    } else if (a0.form === "string") {
      const value = a0.value
      let e: number = measureIn181(value)
      if (given.length > 2) {
        e = Math.trunc(numberOf(a2))
      }
      return finish(ropeValue(sliceIn52(value, s, e)))
    } else {
      throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`slice of ${toFormName(a0)}`)
    }
  }
  if (name === "reverse") {
    const xs: ValueForm[] = itemsOf(a0, "reverse")
    const out: ValueForm[] = ([] as ValueForm[])
    const __n12 = xs.length - 1; if (!(__n12 <= 9007199254740991 && __n12 >= -9007199254740991)) __termIntStop(__n12); let i: number = __n12
    while (i >= 0) {
      out.push(listGet(xs, i))
      i = i - 1
    }
    return finish(arrayOf(fromArray(out)))
  }
  if (name === "first") {
    return finish(arg(itemsOf(a0, "first"), 0))
  }
  if (name === "last") {
    const xs: ValueForm[] = itemsOf(a0, "last")
    return finish(arg(xs, __termInt(xs.length - 1)))
  }
  if (name === "contains") {
    if (a0.form === "array") {
      const value = a0.value
      for (const one of toArray(value)) {
        if (valuesEqual(one, a1)) {
          return finish(boolean(true))
        }
      }
      return finish(boolean(false))
    } else if (a0.form === "string") {
      const value = a0.value
      return finish(boolean(contains(toStringIn142(value), display(a1))))
    } else if (a0.form === "map") {
      const value = a0.value
      return finish(boolean(has(value.map, keyOf(a1))))
    } else {
      throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`contains on ${toFormName(a0)}`)
    }
  }
  if (name === "indexOf") {
    let at: number = 0
    for (const one of itemsOf(a0, "indexOf")) {
      if (valuesEqual(one, a1)) {
        return finish(integer({ dock: BigInt(at) }))
      }
      const __n13 = at + 1; if (!(__n13 <= 9007199254740991 && __n13 >= -9007199254740991)) __termIntStop(__n13); at = __n13
    }
    return finish(integer({ dock: BigInt(-1) }))
  }
  if (name === "sort") {
    const sorted: ValueForm[] = sortValues(itemsOf(a0, "sort"))
    return finish(arrayOf(fromArray(sorted)))
  }
  if (name === "map") {
    const out: ValueForm[] = ([] as ValueForm[])
    let at: number = 0
    for (const one of itemsOf(a0, "map")) {
      const called: ValueForm[] = ([] as ValueForm[])
      called.push(one)
      called.push(integer({ dock: BigInt(at) }))
      const o: Outcome = callValue(a1, called)
      if (isThrown(o)) {
        return o
      }
      out.push(valueOf(o))
      const __n14 = at + 1; if (!(__n14 <= 9007199254740991 && __n14 >= -9007199254740991)) __termIntStop(__n14); at = __n14
    }
    return finish(arrayOf(fromArray(out)))
  }
  if (name === "filter") {
    const out: ValueForm[] = ([] as ValueForm[])
    for (const one of itemsOf(a0, "filter")) {
      const called: ValueForm[] = ([] as ValueForm[])
      called.push(one)
      const o: Outcome = callValue(a1, called)
      if (isThrown(o)) {
        return o
      }
      if (truthy(valueOf(o))) {
        out.push(one)
      }
    }
    return finish(arrayOf(fromArray(out)))
  }
  if (name === "reduce") {
    let acc: ValueForm = a2
    for (const one of itemsOf(a0, "reduce")) {
      const called: ValueForm[] = ([] as ValueForm[])
      called.push(acc)
      called.push(one)
      const o: Outcome = callValue(a1, called)
      if (isThrown(o)) {
        return o
      }
      acc = valueOf(o)
    }
    return { form: "done", value: acc }
  }
  if (name === "sortBy") {
    const keyed: ValueForm[][] = ([] as ValueForm[][])
    for (const one of itemsOf(a0, "sortBy")) {
      const called: ValueForm[] = ([] as ValueForm[])
      called.push(one)
      const o: Outcome = callValue(a1, called)
      if (isThrown(o)) {
        return o
      }
      const pair: ValueForm[] = ([] as ValueForm[])
      pair.push(valueOf(o))
      pair.push(one)
      keyed.push(pair)
    }
    const sorted: ValueForm[][] = sortKeyed(keyed)
    const out: ValueForm[] = ([] as ValueForm[])
    for (const pair of sorted) {
      out.push((1 < pair.length ? pair[1]! : __termReadPast(pair, 1)))
    }
    return finish(arrayOf(fromArray(out)))
  }
  if (name === "split") {
    const out: ValueForm[] = ([] as ValueForm[])
    for (const part of split(display(a0), display(a1))) {
      out.push({ form: "string", value: build(Array.from(part, function (rune) { return rune.codePointAt(0) ?? 0 })) })
    }
    return finish(arrayOf(fromArray(out)))
  }
  if (name === "join") {
    const shown: string[] = ([] as string[])
    for (const one of itemsOf(a0, "join")) {
      shown.push(display(one))
    }
    let separator: string = ""
    if (given.length > 1) {
      separator = display(a1)
    }
    return finish(string(listJoin(shown, separator)))
  }
  if (name === "upper") {
    return finish(string(toUpperCase(display(a0))))
  }
  if (name === "lower") {
    return finish(string(toLowerCase(display(a0))))
  }
  if (name === "replace") {
    return finish(string(listJoin(split(display(a0), display(a1)), display(a2))))
  }
  if (name === "trim") {
    return finish(string(trim(display(a0))))
  }
  if (name === "has") {
    if (a0.form === "map") {
      const value = a0.value
      return finish(boolean(has(value.map, keyOf(a1))))
    } else {
      for (const one of itemsOf(a0, "has")) {
        if (valuesEqual(one, a1)) {
          return finish(boolean(true))
        }
      }
      return finish(boolean(false))
    }
  }
  if (name === "get") {
    return finish(indexGet(a0, a1))
  }
  if (name === "setKey") {
    if (a0.form === "map") {
      const value = a0.value
      value.map = setIn211(value.map, keyOf(a1), a2)
      return { form: "done", value: a0 }
    } else {
      throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))("setKey needs a map")
    }
  }
  if (name === "del") {
    if (a0.form === "map") {
      const value = a0.value
      value.map = remove(value.map, keyOf(a1))
      return { form: "done", value: a0 }
    } else {
      throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))("del needs a map")
    }
  }
  if (name === "entries") {
    if (a0.form === "map") {
      const value = a0.value
      const out: ValueForm[] = ([] as ValueForm[])
      for (const entry of entries(value.map)) {
        const pair: ValueForm[] = ([] as ValueForm[])
        pair.push(string(stripPrefix(entry.key, ["s:", "i:", "f:"])))
        pair.push(entry.value)
        out.push(arrayOf(fromArray(pair)))
      }
      return finish(arrayOf(fromArray(out)))
    } else {
      throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))("entries needs a map")
    }
  }
  throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`no built-in named "${name}"`)
}

export function copyTexts(xs: string[]): string[] {
  const out: string[] = ([] as string[])
  for (const x of xs) {
    out.push(x)
  }
  return out
}

export function copyStatements(xs: Statement[]): Statement[] {
  const out: Statement[] = ([] as Statement[])
  for (const x of xs) {
    out.push(x)
  }
  return out
}

export function sortValues(items: ValueForm[]): ValueForm[] {
  const keyed: ValueForm[][] = ([] as ValueForm[][])
  for (const one of items) {
    const pair: ValueForm[] = ([] as ValueForm[])
    pair.push(one)
    pair.push(one)
    keyed.push(pair)
  }
  const out: ValueForm[] = ([] as ValueForm[])
  for (const pair of sortKeyed(keyed)) {
    out.push((1 < pair.length ? pair[1]! : __termReadPast(pair, 1)))
  }
  return out
}

export function sortKeyed(pairs: ValueForm[][]): ValueForm[][] {
  let source: ValueForm[][] = ([] as ValueForm[][])
  for (const one of pairs) {
    source.push(one)
  }
  const total: number = source.length
  let width: number = 1
  while (width < total) {
    const merged: ValueForm[][] = ([] as ValueForm[][])
    let low: number = 0
    while (low < total) {
      const middle: number = minOf(__termInt(low + width), total)
      const high: number = minOf(__termInt(middle + width), total)
      let i: number = low
      let j: number = middle
      while (i < middle && j < high) {
        const left: ValueForm[] = listGet(source, i)
        const right: ValueForm[] = listGet(source, j)
        if (compareValuesNumber((0 < right.length ? right[0]! : __termReadPast(right, 0)), (0 < left.length ? left[0]! : __termReadPast(left, 0))) < 0) {
          merged.push(right)
          const __n15 = j + 1; if (!(__n15 <= 9007199254740991 && __n15 >= -9007199254740991)) __termIntStop(__n15); j = __n15
        } else {
          merged.push(left)
          const __n16 = i + 1; if (!(__n16 <= 9007199254740991 && __n16 >= -9007199254740991)) __termIntStop(__n16); i = __n16
        }
      }
      while (i < middle) {
        merged.push(listGet(source, i))
        i = i + 1
      }
      while (j < high) {
        merged.push(listGet(source, j))
        j = j + 1
      }
      low = high
    }
    source = merged
    const __n17 = width * 2; if (!(__n17 <= 9007199254740991 && __n17 >= -9007199254740991)) __termIntStop(__n17); width = __n17
  }
  return source
}

export function minOf(a: number, b: number): number {
  if (a < b) {
    return a
  }
  return b
}

export function makeGlobalScope(extra: Map<string, ValueForm>): Scope {
  const g: Scope = __termShare({ vars: new Map(), consts: new Map(), parent: ([] as Scope[]) })
  for (const name of nativeNames()) {
    define(g, name, { form: "native", name: name }, false)
  }
  for (const key of Array.from(extra.keys())) {
    define(g, key, extra.get(key)!, false)
  }
  return g
}

export function hoist(code: Statement[], g: Scope): void {
  for (const stmt of code) {
    if (stmt.form === "function") {
      execute(stmt, g)
    } else {}
  }
}

export function run(code: Statement[]): ValueForm {
  return runWith(code, new Map())
}

export function runWith(code: Statement[], extra: Map<string, ValueForm>): ValueForm {
  const g: Scope = makeGlobalScope(extra)
  hoist(code, g)
  let last: ValueForm = __termVariantUnit
  for (const stmt of code) {
    if (stmt.form === "function") {
      continue
    } else if (stmt.form === "expression") {
      const expr = stmt.expr
      const o: Outcome = evaluate(expr, g)
      if (isThrown(o)) {
        throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`vibe throw: ${display(valueOf(o))}`)
      }
      last = valueOf(o)
    } else {
      const sig: Signal = execute(stmt, g)
      if (sig.form === "returned") {
        const value = sig.value
        return value
      } else {}
    }
  }
  return last
}

export function callFunction(code: Statement[], name: string, given: ValueForm[]): ValueForm {
  return callFunctionWith(code, name, given, new Map())
}

export function callFunctionWith(code: Statement[], name: string, given: ValueForm[], extra: Map<string, ValueForm>): ValueForm {
  const g: Scope = makeGlobalScope(extra)
  hoist(code, g)
  const fn: ValueForm = lookup(g, name)
  if (fn.form === "function") {
    const value = fn.value
    const o: Outcome = applyClosure(value, given)
    if (isThrown(o)) {
      throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`vibe throw: ${display(valueOf(o))}`)
    }
    return valueOf(o)
  } else if (fn.form === "native") {
    const name = fn.name
    const o: Outcome = callNative(name, given)
    if (isThrown(o)) {
      throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`vibe throw: ${display(valueOf(o))}`)
    }
    return valueOf(o)
  } else {
    throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(`"${name}" is not a function`)
  }
}

export interface MismatchLink {
  thing: string
  expected?: string
  actual?: string
}

export interface RefusalLink {
  thing: string
  reason?: string
}

export interface NumberMismatchLink {
  thing: string
  expected?: string
  actual?: string
  at: number
  reason: string
}
