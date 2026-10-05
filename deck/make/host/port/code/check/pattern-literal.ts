;
// The one regex primitive over the host RegExp, with the u flag (code points) and the d flag (group indices). The
// pattern arrives in a form this engine reads as Term does (regex/dialect.tree, pattern/feature.tree), so this only
// runs it and turns UTF-16
// offsets into code point offsets.
const regex = {
  compiled: new Map<string, RegExp>(),
  search: (pattern: string, text: string, from: number): Array<number> => {
    let engine = regex.compiled.get(pattern)
    if (engine === undefined) {
      // an engine that refuses the pattern answers [-2], never "no match": Term answers it with its own tier
      try {
        engine = new RegExp(pattern, 'gud')
      } catch {
        return [-2]
      }
      regex.compiled.set(pattern, engine)
    }
    if (from < 0) return []
    let unit = 0
    let point = 0
    while (point < from && unit < text.length) {
      unit += (text.codePointAt(unit) ?? 0) > 0xffff ? 2 : 1
      point += 1
    }
    if (point < from) return []
    engine.lastIndex = unit
    const found = engine.exec(text)
    if (found === null || found.indices === undefined) return []
    // counted on from where the search began, or from the text's start for a group a lookbehind found before it
    const toPoint = (at: number): number => {
      let u = at < unit ? 0 : unit
      let p = at < unit ? 0 : from
      while (u < at) {
        u += (text.codePointAt(u) ?? 0) > 0xffff ? 2 : 1
        p += 1
      }
      return p
    }
    const out: Array<number> = []
    for (const span of found.indices) {
      if (span === undefined) {
        out.push(-1, -1)
      } else {
        out.push(toPoint(span[0]), toPoint(span[1]))
      }
    }
    return out
  },
  // every match left to right, none overlapping, in one pass: the width of one match's slots first (two per group,
  // group 0 the whole match), then each match's slots in code points. After an empty match the search moves on one
  // code point, as the Term search does, so every engine iterates alike. One pass keeps the UTF-16 to code point
  // count moving forwards, where a search per match would recount from the start each time.
  searchAll: (pattern: string, text: string): Array<number> => {
    let engine = regex.compiled.get(pattern)
    if (engine === undefined) {
      // an engine that refuses the pattern answers [-2], never "no match": Term answers it with its own tier
      try {
        engine = new RegExp(pattern, 'gud')
      } catch {
        return [-2]
      }
      regex.compiled.set(pattern, engine)
    }
    const out: Array<number> = [-1]
    // a cursor: the code point count at a UTF-16 offset, moved forwards only
    let cursorUnit = 0
    let cursorPoint = 0
    // counted on from a known offset, or from the text's start for a group a lookbehind found before that offset
    const pointAt = (at: number, fromUnit: number, fromPoint: number): number => {
      let u = at < fromUnit ? 0 : fromUnit
      let p = at < fromUnit ? 0 : fromPoint
      while (u < at) {
        u += (text.codePointAt(u) ?? 0) > 0xffff ? 2 : 1
        p += 1
      }
      return p
    }
    let unit = 0
    while (unit <= text.length) {
      engine.lastIndex = unit
      const found = engine.exec(text)
      if (found === null || found.indices === undefined) break
      const startUnit = found.indices[0]![0]
      const endUnit = found.indices[0]![1]
      const startPoint = pointAt(startUnit, cursorUnit, cursorPoint)
      cursorUnit = startUnit
      cursorPoint = startPoint
      out[0] = found.indices.length * 2
      for (const span of found.indices) {
        if (span === undefined) {
          out.push(-1, -1)
        } else {
          out.push(pointAt(span[0], startUnit, startPoint), pointAt(span[1], startUnit, startPoint))
        }
      }
      if (endUnit > startUnit) {
        unit = endUnit
      } else {
        unit = endUnit + ((text.codePointAt(endUnit) ?? 0) > 0xffff ? 2 : 1)
      }
    }
    return out
  },
}

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

const __termVariantBlank = Object.freeze({ form: "blank" as const })

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

export function listReverse<T>(self: T[]): T[] {
  return self.toReversed()
}

export function listSlice<T>(self: T[], start: number, end: number): T[] {
  return __termSlice(self, start, end)
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

export function listProduct<T>(self: number[]): number {
  let total: number = 1
  for (const value of self) {
    const __n1 = total * value; if (!(__n1 <= 9007199254740991 && __n1 >= -9007199254740991)) __termIntStop(__n1); total = __n1
  }
  return total
}

function mergePass<T>(source: T[], width: number, compare: (a0: T, a1: T) => Ordering): T[] {
  const n: number = source.length
  const merged: T[] = ([] as T[])
  let low: number = 0
  while (low < n) {
    const __n2 = low + width; if (!(__n2 <= 9007199254740991 && __n2 >= -9007199254740991)) __termIntStop(__n2); let middle: number = __n2
    if (middle > n) {
      middle = n
    }
    const __n3 = middle + width; if (!(__n3 <= 9007199254740991 && __n3 >= -9007199254740991)) __termIntStop(__n3); let high: number = __n3
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
        const __n4 = j + 1; if (!(__n4 <= 9007199254740991 && __n4 >= -9007199254740991)) __termIntStop(__n4); j = __n4
      } else {
        merged.push(left)
        const __n5 = i + 1; if (!(__n5 <= 9007199254740991 && __n5 >= -9007199254740991)) __termIntStop(__n5); i = __n5
      }
    }
    while (i < middle && i < source.length) {
      merged.push(listGet(source, i))
      const __n6 = i + 1; if (!(__n6 <= 9007199254740991 && __n6 >= -9007199254740991)) __termIntStop(__n6); i = __n6
    }
    while (j < high && j < source.length) {
      merged.push(listGet(source, j))
      const __n7 = j + 1; if (!(__n7 <= 9007199254740991 && __n7 >= -9007199254740991)) __termIntStop(__n7); j = __n7
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
    const __n8 = width * 2; if (!(__n8 <= 9007199254740991 && __n8 >= -9007199254740991)) __termIntStop(__n8); const doubled: number = __n8
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

export function booleanAnd(self: boolean, other: boolean): boolean {
  if (self) {
    return other
  } else {
    return false
  }
}

export function fromRunes(runes: number[]): string {
  let result: string = ""
  for (const code of runes) {
    result = result + String.fromCodePoint(code)
  }
  return result
}

export function engineSearch(pattern: string, input: string, from: number): number[] {
  return regex.search(pattern, input, from)
}

export function engineFeatures(): string[] {
  const out: string[] = ([] as string[])
  out.push("look-ahead")
  out.push("look-behind")
  out.push("look-ahead-unbounded")
  out.push("look-behind-unbounded")
  out.push("look-capture")
  out.push("refer-set")
  out.push("refer-unset")
  out.push("refer-behind")
  out.push("word-edge")
  out.push("line-edge")
  out.push("loop-capture")
  out.push("empty-loop")
  out.push("empty-set")
  out.push("big-count")
  out.push("refer-fold")
  return out
}

export function split(value: string, delimiter: string): string[] {
  return __termText.split(value, delimiter)
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

export function now(): number {
  return date.now()
}

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

export interface Excess {
  host: string
  form: string
  note: string
  code: string
  time: number
  link: ExcessLink
  base: Maybe
  site: Maybe
  flow: any[]
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

export interface Failure {
  host: string
  form: string
  note: string
  code: string
  time: number
  link: FailureLink
  base: Maybe
  site: Maybe
  flow: any[]
}

export function regexLiteral(c: number): string {
  const backslash: string = String.fromCodePoint(92)
  if (c === 9) {
    return `${backslash}t`
  }
  if (c === 10) {
    return `${backslash}n`
  }
  if (c === 13) {
    return `${backslash}r`
  }
  if (c === 12) {
    return `${backslash}f`
  }
  if (c === 11) {
    return `${backslash}x0B`
  }
  const char: string = String.fromCodePoint(c)
  if (c === 92 || c === 94 || (c === 36 || c === 46) || (c === 124 || c === 63 || (c === 42 || c === 43)) || (c === 40 || c === 41 || (c === 91 || c === 93) || (c === 123 || c === 125))) {
    return `${backslash}${char}`
  }
  return char
}

export function regexClassLiteral(c: number): string {
  const backslash: string = String.fromCodePoint(92)
  if (c === 38) {
    return `${backslash}x26`
  }
  if (c === 126) {
    return `${backslash}x7E`
  }
  if (c === 92 || c === 93 || (c === 91 || c === 94) || (c === 45 || c === 36)) {
    const char: string = String.fromCodePoint(c)
    return `${backslash}${char}`
  }
  return regexLiteral(c)
}

export type Piece =
  | { form: "blank" }
  | { form: "letter"; point: number }
  | { form: "ranges"; set: number[] }
  | { form: "edge"; kind: number }
  | { form: "chain"; parts: Piece[] }
  | { form: "choice"; parts: Piece[] }
  | { form: "loop"; body: Piece; least: number; most: number; greedy: boolean; possessive: boolean }
  | { form: "group"; body: Piece; index: number; label: string }
  | { form: "atom"; body: Piece }
  | { form: "look"; body: Piece; behind: boolean; negate: boolean }
  | { form: "refer"; index: number; fold: boolean }

const edgeTextStart: number = 0

const edgeTextEnd: number = 1

const edgeLineStart: number = 2

const edgeLineEnd: number = 3

const edgeWord: number = 4

const edgeNotWord: number = 5

export interface PatternMismatch {
  host: string
  form: string
  note: string
  code: string
  time: number
  link: PatternMismatchLink
  base: Maybe
  site: Maybe
  flow: any[]
}

export interface PatternBudget {
  host: string
  form: string
  note: string
  code: string
  time: number
  link: PatternBudgetLink
  base: Maybe
  site: Maybe
  flow: any[]
}

export function isZeroWidth(p: Piece): boolean {
  if (p.form === "blank") {
    return true
  } else if (p.form === "edge") {
    return true
  } else if (p.form === "look") {
    return true
  } else if (p.form === "letter") {
    return false
  } else if (p.form === "ranges") {
    return false
  } else if (p.form === "chain") {
    return false
  } else if (p.form === "choice") {
    return false
  } else if (p.form === "loop") {
    return false
  } else if (p.form === "group") {
    return false
  } else if (p.form === "atom") {
    return false
  } else {
    return false
  }
}

export function refusePattern(at: number, reason: string): Piece {
  throw new TermException({ host: "@local", form: "pattern-mismatch", code: exceptionCode(), time: date.now(), note: "Not a pattern", link: { thing: "pattern", at: at, reason: reason }, base: undefined as any, site: undefined as any, flow: [] })
}

const lastCodePoint: number = 1114111

export function numberAt(values: number[], index: number, fallback: number): number {
  if (index >= 0 && index < values.length) {
    return (index >= 0 && index < values.length ? values[index]! : __termReadPast(values, index))
  }
  return fallback
}

export function putNumber(values: number[], index: number, value: number): boolean {
  if (index >= 0 && index < values.length) {
    index >= 0 && index < values.length ? (values[index] = value) : __termWritePast(values, index)
    return true
  }
  return false
}

export function copyNumbers(values: number[]): number[] {
  const out: number[] = ([] as number[])
  for (const value of values) {
    out.push(value)
  }
  return out
}

export function setHas(set: number[], code: number): boolean {
  let low: number = 0
  let high: number = Math.trunc(set.length / 2)
  let turns: number = 0
  while (low < high && turns < 64) {
    turns = turns + 1
    const middle: number = Math.trunc(__termInt(low + high) / 2)
    const start: number = numberAt(set, __termInt(middle * 2), 0)
    const end: number = numberAt(set, __termInt(__termInt(middle * 2) + 1), -1)
    if (code < start) {
      high = middle
    } else if (code > end) {
      const __n9 = middle + 1; if (!(__n9 <= 9007199254740991 && __n9 >= -9007199254740991)) __termIntStop(__n9); low = __n9
    } else {
      return true
    }
  }
  return false
}

export function rangeSet(start: number, end: number): number[] {
  const out: number[] = ([] as number[])
  if (start <= end) {
    out.push(start)
    out.push(end)
  }
  return out
}

export function pushRange(out: number[], start: number, end: number): number {
  const n: number = out.length
  if (n >= 2) {
    const last: number = numberAt(out, __termInt(n - 1), -1)
    if (last >= __termInt(start - 1)) {
      if (end > last) {
        putNumber(out, __termInt(n - 1), end)
      }
      return out.length
    }
  }
  out.push(start)
  out.push(end)
  return out.length
}

export function mergeSets(a: number[], b: number[]): number[] {
  const out: number[] = ([] as number[])
  let i: number = 0
  let j: number = 0
  const __n10 = __termInt(a.length + b.length) + 2; if (!(__n10 <= 9007199254740991 && __n10 >= -9007199254740991)) __termIntStop(__n10); const limit: number = __n10
  let turns: number = 0
  while ((i < a.length || j < b.length) && turns < limit) {
    const __n11 = turns + 1; if (!(__n11 <= 9007199254740991 && __n11 >= -9007199254740991)) __termIntStop(__n11); turns = __n11
    const aStart: number = numberAt(a, i, -1)
    const bStart: number = numberAt(b, j, -1)
    const fromA: boolean = i < a.length && (j >= b.length || aStart <= bStart)
    if (fromA && i < a.length) {
      pushRange(out, aStart, numberAt(a, __termInt(i + 1), -1))
      const __n12 = i + 2; if (!(__n12 <= 9007199254740991 && __n12 >= -9007199254740991)) __termIntStop(__n12); i = __n12
    } else {
      pushRange(out, bStart, numberAt(b, __termInt(j + 1), -1))
      const __n13 = j + 2; if (!(__n13 <= 9007199254740991 && __n13 >= -9007199254740991)) __termIntStop(__n13); j = __n13
    }
  }
  return out
}

export function negateSet(set: number[]): number[] {
  const out: number[] = ([] as number[])
  let next: number = 0
  let i: number = 0
  while (i < set.length) {
    const start: number = numberAt(set, i, 0)
    const end: number = numberAt(set, __termInt(i + 1), -1)
    if (start > next) {
      out.push(next)
      out.push(__termInt(start - 1))
    }
    const __n14 = end + 1; if (!(__n14 <= 9007199254740991 && __n14 >= -9007199254740991)) __termIntStop(__n14); next = __n14
    const __n15 = i + 2; if (!(__n15 <= 9007199254740991 && __n15 >= -9007199254740991)) __termIntStop(__n15); i = __n15
  }
  if (next <= lastCodePoint) {
    out.push(next)
    out.push(lastCodePoint)
  }
  return out
}

export function intersectSets(a: number[], b: number[]): number[] {
  return negateSet(mergeSets(negateSet(a), negateSet(b)))
}

export function setsAreApart(a: number[], b: number[]): boolean {
  const both: number[] = intersectSets(a, b)
  return both.length === 0
}

export function normalizeSet(ranges: number[]): number[] {
  let out: number[] = ([] as number[])
  let i: number = 0
  while (__termInt(i + 1) < ranges.length) {
    const start: number = numberAt(ranges, i, 0)
    const end: number = numberAt(ranges, __termInt(i + 1), -1)
    out = mergeSets(out, rangeSet(start, end))
    const __n16 = i + 2; if (!(__n16 <= 9007199254740991 && __n16 >= -9007199254740991)) __termIntStop(__n16); i = __n16
  }
  return out
}

export function setSize(set: number[]): number {
  let total: number = 0
  let i: number = 0
  while (__termInt(i + 1) < set.length) {
    const __n17 = total + __termInt(__termInt(numberAt(set, __termInt(i + 1), 0) + 1) - numberAt(set, i, 0)); if (!(__n17 <= 9007199254740991 && __n17 >= -9007199254740991)) __termIntStop(__n17); total = __n17
    const __n18 = i + 2; if (!(__n18 <= 9007199254740991 && __n18 >= -9007199254740991)) __termIntStop(__n18); i = __n18
  }
  return total
}

const unicodeVersion: string = "17.0"

const categoryCodes: string[] = ["Lu,Ll,Lt,Lm,Lo,Mn,Mc,Me,Nd,Nl,No,Pc,Pd,Ps,Pe,Pi,Pf,Po,Sm,Sc,Sk,So,Zs,Zl,Zp,Cc,Cf,Cs,Co,Cn"]

const categoryNames: string[] = ["C,Cased_Letter,Cc,Cf,Close_Punctuation,Cn,Co,Combining_Mark,Connector_Punctuation,Control,Cs,Cur", "rency_Symbol,Dash_Punctuation,Decimal_Number,Enclosing_Mark,Final_Punctuation,Format,Initial_Pun", "ctuation,L,LC,Letter,Letter_Number,Line_Separator,Ll,Lm,Lo,Lowercase_Letter,Lt,Lu,M,Mark,Math_Sy", "mbol,Mc,Me,Mn,Modifier_Letter,Modifier_Symbol,N,Nd,Nl,No,Nonspacing_Mark,Number,Open_Punctuation", ",Other,Other_Letter,Other_Number,Other_Punctuation,Other_Symbol,P,Paragraph_Separator,Pc,Pd,Pe,P", "f,Pi,Po,Private_Use,Ps,Punctuation,S,Sc,Separator,Sk,Sm,So,Space_Separator,Spacing_Mark,Surrogat", "e,Symbol,Titlecase_Letter,Unassigned,Uppercase_Letter,Z,Zl,Zp,Zs,cntrl,digit,punct"]

const categoryMasks: string[] = ["h7atq8,7,jz6rk,13ydj4,cn4,8vn08w,4fti4g,68,1kw,jz6rk,27wr28,b8jk,35s,74,3k,1ekg,13ydj4,pa8,v,7,v", ",e8,4zsow,2,8,g,2,4,1,68,68,5m9s,1s,3k,w,8,mh34,1ds,74,e8,sg,w,1ds,6bk,h7atq8,g,sg,2t4w,18y68,5k", "ow,9zlds,1kw,35s,cn4,1ekg,pa8,2t4w,4fti4g,6bk,5kow,2ca2o,b8jk,hhaf4,mh34,5m9s,18y68,2hwcg,1s,27w", "r28,2ca2o,4,8vn08w,1,hhaf4,4zsow,9zlds,2hwcg,jz6rk,74,5kow"]

const categoryTable: string[] = ["v,p,0,m,2,h,0,j,2,h,0,d,0,e,0,h,0,i,0,h,0,c,1,h,9,8,1,h,2,i,1,h,p,0,0,d,0,h,0,e,0,k,0,b,0,k,p,1,", "0,d,0,i,0,e,0,i,w,p,0,m,0,h,3,j,0,l,0,h,0,k,0,l,0,4,0,f,0,i,0,q,0,l,0,k,0,l,0,i,1,a,0,k,0,1,1,h,", "0,k,0,a,0,4,0,g,2,a,0,h,m,0,0,i,6,0,n,1,0,i,7,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,", "0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,", "0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,1,1,0,0,0,1,0,0,0,1,", "0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,1,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,", "0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,", "0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,1,0,0,1,0,0,0,1,0,0,2,1,1,0,0,1,0,0,0,1,1,0,0,1,2,0,1,1,", "3,0,0,1,1,0,0,1,2,0,2,1,1,0,0,1,1,0,0,1,0,0,0,1,0,0,0,1,1,0,0,1,0,0,1,1,0,0,0,1,1,0,0,1,2,0,0,1,", "0,0,0,1,1,0,1,1,0,4,0,0,2,1,3,4,0,0,0,2,0,1,0,0,0,2,0,1,0,0,0,2,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,", "0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,1,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,", "0,1,0,0,1,1,0,0,0,2,0,1,0,0,0,1,2,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,", "0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,", "0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,6,1,1,0,0,1,1,0,1,1,", "0,0,0,1,3,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,1w,1,1,4,p,1,h,3,3,k,b,3,d,k,4,3,6,k,0,3,0,k,0,3,g,k", ",33,5,0,0,0,1,0,0,0,1,0,3,0,k,0,0,0,1,1,t,0,3,2,1,0,h,0,0,3,t,1,k,0,0,0,h,2,0,0,t,0,0,0,t,1,0,0,", "1,g,0,0,t,8,0,y,1,0,0,1,1,2,0,2,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,", "1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,4,1,0,0,0,1,0,i,0,0,0,1,1,0,1,1,1e,0,1b,1,0,0,0,1,0,0,0,1,0,0,0,1,", "0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,", "0,0,0,1,0,0,0,1,0,l,4,5,1,7,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,", "0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,", "0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,1,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,", "0,1,0,0,1,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,", "0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,", "0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,", "0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,", "0,1,0,0,0,1,0,t,11,0,1,t,0,3,5,h,14,1,0,h,0,c,1,t,1,l,0,j,0,t,18,5,0,c,0,5,0,h,1,5,0,h,1,5,0,h,0", ",5,7,t,q,4,3,t,3,4,1,h,a,t,5,q,2,i,1,h,0,j,1,h,1,l,a,5,0,h,0,q,2,h,v,4,0,3,9,4,k,5,9,8,3,h,1,4,0", ",5,2q,4,0,h,0,4,6,5,0,q,0,l,5,5,1,3,1,5,0,l,3,5,1,4,9,8,2,4,1,l,0,4,d,h,0,t,0,q,0,4,0,5,t,4,q,5,", "1,t,2g,4,a,5,0,4,d,t,9,8,w,4,8,5,1,3,0,l,2,h,0,3,1,t,0,5,1,j,l,4,3,5,0,3,8,5,0,3,2,5,0,3,4,5,1,t", ",e,h,0,t,o,4,2,5,1,t,0,h,0,t,a,4,4,t,n,4,0,k,6,4,1,q,4,t,8,5,14,4,0,3,n,5,0,q,v,5,0,6,1h,4,0,5,0", ",6,0,5,0,4,2,6,7,5,3,6,0,5,1,6,0,4,6,5,9,4,1,5,1,h,9,8,0,h,0,3,e,4,0,5,1,6,0,t,7,4,1,t,1,4,1,t,l", ",4,0,t,6,4,0,t,0,4,2,t,3,4,1,t,0,5,0,4,2,6,3,5,1,t,1,6,1,t,1,6,0,5,0,4,7,t,0,6,3,t,1,4,0,t,2,4,1", ",5,1,t,9,8,1,4,1,j,5,a,0,l,0,j,0,4,0,h,0,5,1,t,1,5,0,6,0,t,5,4,3,t,1,4,1,t,l,4,0,t,6,4,0,t,1,4,0", ",t,1,4,0,t,1,4,1,t,0,5,0,t,2,6,1,5,3,t,1,5,1,t,2,5,2,t,0,5,6,t,3,4,0,t,0,4,6,t,9,8,1,5,2,4,0,5,0", ",h,9,t,1,5,0,6,0,t,8,4,0,t,2,4,0,t,l,4,0,t,6,4,0,t,1,4,0,t,4,4,1,t,0,5,0,4,2,6,4,5,0,t,1,5,0,6,0", ",t,1,6,0,5,1,t,0,4,e,t,1,4,1,5,1,t,9,8,0,h,0,j,6,t,0,4,5,5,0,t,0,5,1,6,0,t,7,4,1,t,1,4,1,t,l,4,0", ",t,6,4,0,t,1,4,0,t,4,4,1,t,0,5,0,4,0,6,0,5,0,6,3,5,1,t,1,6,1,t,1,6,0,5,6,t,1,5,0,6,3,t,1,4,0,t,2", ",4,1,5,1,t,9,8,0,l,0,4,5,a,9,t,0,5,0,4,0,t,5,4,2,t,2,4,0,t,3,4,2,t,1,4,0,t,0,4,0,t,1,4,2,t,1,4,2", ",t,2,4,2,t,b,4,3,t,1,6,0,5,1,6,2,t,2,6,0,t,2,6,0,5,1,t,0,4,5,t,0,6,d,t,9,8,2,a,5,l,0,j,0,l,4,t,0", ",5,2,6,0,5,7,4,0,t,2,4,0,t,m,4,0,t,f,4,1,t,0,5,0,4,2,5,3,6,0,t,2,5,0,t,3,5,6,t,1,5,0,t,2,4,0,t,1", ",4,1,t,1,4,1,5,1,t,9,8,6,t,0,h,6,a,0,l,0,4,0,5,1,6,0,h,7,4,0,t,2,4,0,t,m,4,0,t,9,4,0,t,4,4,1,t,0", ",5,0,4,0,6,0,5,4,6,0,t,0,5,1,6,0,t,1,6,1,5,6,t,1,6,4,t,2,4,0,t,1,4,1,5,1,t,9,8,0,t,1,4,0,6,b,t,1", ",5,1,6,8,4,0,t,2,4,0,t,14,4,1,5,0,4,2,6,3,5,0,t,2,6,0,t,2,6,0,5,0,4,0,l,3,t,2,4,0,6,6,a,2,4,1,5,", "1,t,9,8,8,a,0,l,5,4,0,t,0,5,1,6,0,t,h,4,2,t,n,4,0,t,8,4,0,t,0,4,1,t,6,4,2,t,0,5,3,t,2,6,2,5,0,t,", "0,5,0,t,7,6,5,t,9,8,1,t,1,6,0,h,b,t,1b,4,0,5,1,4,6,5,3,t,0,j,5,4,0,3,7,5,0,h,9,8,1,h,10,t,1,4,0,", "t,0,4,0,t,4,4,0,t,n,4,0,t,0,4,0,t,9,4,0,5,1,4,8,5,0,4,1,t,4,4,0,t,0,3,0,t,6,5,0,t,9,8,1,t,3,4,v,", "t,0,4,2,l,e,h,0,l,0,h,2,l,1,5,5,l,9,8,9,a,0,l,0,5,0,l,0,5,0,l,0,5,0,d,0,e,0,d,0,e,1,6,7,4,0,t,z,", "4,3,t,d,5,0,6,4,5,0,h,1,5,4,4,a,5,0,t,z,5,0,t,7,l,0,5,5,l,0,t,1,l,4,h,3,l,1,h,10,t,16,4,1,6,3,5,", "0,6,5,5,0,6,1,5,1,6,1,5,0,4,9,8,5,h,5,4,1,6,1,5,3,4,2,5,0,4,2,6,1,4,6,6,2,4,3,5,c,4,0,5,1,6,1,5,", "5,6,0,5,0,4,0,6,9,8,2,6,0,5,1,l,11,0,0,t,0,0,4,t,0,0,1,t,16,1,0,h,0,3,2,1,94,4,0,t,3,4,1,t,6,4,0", ",t,0,4,0,t,3,4,1,t,14,4,0,t,3,4,1,t,w,4,0,t,3,4,1,t,6,4,0,t,0,4,0,t,3,4,1,t,e,4,0,t,1k,4,0,t,3,4", ",1,t,1u,4,1,t,2,5,8,h,j,a,2,t,f,4,9,l,5,t,2d,0,1,t,5,1,1,t,0,c,h7,4,0,l,0,h,g,4,0,m,p,4,0,d,0,e,", "2,t,22,4,2,h,2,9,7,4,6,t,h,4,2,5,0,6,8,t,i,4,1,5,0,6,1,h,8,t,h,4,1,5,b,t,c,4,0,t,2,4,0,t,1,5,b,t", ",1f,4,1,5,0,6,6,5,7,6,0,5,1,6,a,5,2,h,0,3,2,h,0,j,0,4,0,5,1,t,9,8,5,t,9,a,5,t,5,h,0,c,3,h,2,5,0,", "q,0,5,9,8,5,t,y,4,0,3,1g,4,6,t,4,4,1,5,x,4,0,5,0,4,4,t,1x,4,9,t,u,4,0,t,2,5,3,6,1,5,2,6,3,t,1,6,", "0,5,5,6,2,5,3,t,0,l,2,t,1,h,9,8,t,4,1,t,4,4,a,t,17,4,3,t,p,4,5,t,9,8,0,a,2,t,x,l,m,4,1,5,1,6,0,5", ",1,t,1,h,1g,4,0,6,0,5,0,6,6,5,0,t,0,5,0,6,0,5,1,6,7,5,5,6,9,5,1,t,0,5,9,8,5,t,9,8,5,t,6,h,0,3,5,", "h,1,t,d,5,0,7,u,5,1,t,b,5,j,t,3,5,0,6,1a,4,0,5,0,6,4,5,0,6,0,5,4,6,0,5,1,6,7,4,0,t,1,h,9,8,6,h,9", ",l,8,5,8,l,2,h,1,5,0,6,t,4,0,6,3,5,1,6,1,5,0,6,2,5,1,4,9,8,17,4,0,5,0,6,1,5,2,6,0,5,0,6,2,5,1,6,", "7,t,3,h,z,4,7,6,7,5,1,6,1,5,2,t,4,h,9,8,2,t,2,4,9,8,t,4,5,3,1,h,8,1,0,0,0,1,4,t,16,0,1,t,2,0,7,h", ",7,t,2,5,0,h,c,5,0,6,6,5,3,4,0,5,5,4,0,5,1,4,0,6,1,5,0,4,4,t,17,1,1q,3,c,1,0,3,x,1,10,3,1r,5,0,0", ",0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0", ",0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0", ",0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0", ",0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0", ",0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0", ",0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0", ",0,1,0,0,0,1,0,0,8,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0", ",0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0", ",0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0", ",0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0", ",0,1,0,0,0,1,0,0,0,1,0,0,8,1,7,0,5,1,1,t,5,0,1,t,7,1,7,0,7,1,7,0,5,1,1,t,5,0,1,t,7,1,0,t,0,0,0,t", ",0,0,0,t,0,0,0,t,0,0,7,1,7,0,d,1,1,t,7,1,7,2,7,1,7,2,7,1,7,2,4,1,0,t,1,1,3,0,0,2,0,k,0,1,2,k,2,1", ",0,t,1,1,3,0,0,2,2,k,3,1,1,t,1,1,3,0,0,t,2,k,7,1,4,0,2,k,1,t,2,1,0,t,1,1,3,0,0,2,1,k,0,t,a,m,4,q", ",5,c,1,h,0,f,0,g,0,d,1,f,0,g,0,d,0,f,7,h,0,n,0,o,4,q,0,m,8,h,0,f,0,g,3,h,1,b,2,h,0,i,0,d,0,e,a,h", ",0,i,0,h,0,b,9,h,0,m,4,q,0,t,9,q,0,a,0,3,1,t,5,a,2,i,0,d,0,e,0,3,9,a,2,i,0,d,0,e,0,t,c,3,2,t,x,j", ",d,t,c,5,3,7,0,5,2,7,b,5,e,t,1,l,0,0,3,l,0,0,1,l,0,1,2,0,1,1,2,0,0,1,0,l,0,0,1,l,0,i,4,0,5,l,0,0", ",0,l,0,0,0,l,0,0,0,l,3,0,0,l,0,1,3,0,0,1,3,4,0,1,1,l,1,1,1,0,4,i,0,0,3,1,0,l,0,i,1,l,0,1,0,l,f,a", ",y,9,0,0,0,1,3,9,0,a,1,l,3,t,4,i,4,l,1,i,3,l,0,i,1,l,0,i,1,l,0,i,6,l,0,i,u,l,1,i,1,l,0,i,0,l,0,i", ",u,l,7f,i,7,l,0,d,0,e,0,d,0,e,j,l,1,i,6,l,0,d,0,e,28,l,0,i,t,l,o,i,13,l,5,i,1z,l,l,t,a,l,k,t,1n,", "a,25,l,l,a,52,l,0,i,8,l,0,i,1h,l,7,i,32,l,0,i,6v,l,0,d,0,e,0,d,0,e,0,d,0,e,0,d,0,e,0,d,0,e,0,d,0", ",e,0,d,0,e,t,a,17,l,4,i,0,d,0,e,u,i,0,d,0,e,0,d,0,e,0,d,0,e,0,d,0,e,0,d,0,e,f,i,73,l,3m,i,0,d,0,", "e,0,d,0,e,0,d,0,e,0,d,0,e,0,d,0,e,0,d,0,e,0,d,0,e,0,d,0,e,0,d,0,e,0,d,0,e,0,d,0,e,1q,i,0,d,0,e,0", ",d,0,e,v,i,0,d,0,e,75,i,1b,l,k,i,1,l,5,i,12,l,1,t,3t,l,1b,0,1b,1,0,0,0,1,2,0,1,1,0,0,0,1,0,0,0,1", ",0,0,0,1,3,0,0,1,0,0,1,1,0,0,5,1,1,3,2,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0", ",0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0", ",0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0", ",0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0", ",0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,1,1,5,l,0,0,0,1,0,0,0,1,2,5,0,0,0,1,4,t,3,h,0,a", ",1,h,11,1,0,t,0,1,4,t,0,1,1,t,1j,4,6,t,0,3,0,h,d,t,0,5,m,4,8,t,6,4,0,t,6,4,0,t,6,4,0,t,6,4,0,t,6", ",4,0,t,6,4,0,t,6,4,0,t,6,4,0,t,v,5,1,h,0,f,0,g,0,f,0,g,2,h,0,f,0,g,0,h,0,f,0,g,8,h,0,c,1,h,0,c,0", ",h,0,f,0,g,1,h,0,f,0,g,0,d,0,e,0,d,0,e,0,d,0,e,0,d,0,e,4,h,0,3,9,h,1,c,3,h,0,c,0,h,0,d,c,h,1,l,2", ",h,0,d,0,e,0,d,0,e,0,d,0,e,0,d,0,e,0,c,x,t,p,l,0,t,2g,l,b,t,5x,l,p,t,f,l,0,m,2,h,0,l,0,3,0,4,0,9", ",0,d,0,e,0,d,0,e,0,d,0,e,0,d,0,e,0,d,0,e,1,l,0,d,0,e,0,d,0,e,0,d,0,e,0,d,0,e,0,c,0,d,1,e,0,l,8,9", ",3,5,1,6,0,c,4,3,1,l,2,9,0,3,0,4,0,h,1,l,0,t,2d,4,1,t,1,5,1,k,1,3,0,4,0,c,2h,4,0,h,2,3,0,4,4,t,1", "6,4,0,t,2l,4,0,t,1,l,3,a,9,l,v,4,11,l,8,t,0,l,f,4,u,l,0,t,9,a,t,l,7,a,0,l,e,a,v,l,9,a,12,l,e,a,8", "v,l,533,4,1r,l,g7o,4,0,3,vq,4,2,t,1i,l,8,t,13,4,5,3,1,h,7f,4,0,3,2,h,f,4,9,8,1,4,j,t,0,0,0,1,0,0", ",0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0", ",0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,4,0,5,2,7,0,h,9,5", ",0,h,0,3,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1", ",0,0,0,1,0,0,0,1,0,0,0,1,1,3,1,5,1x,4,9,9,1,5,5,h,7,t,m,k,8,3,1,k,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,", "1,0,0,0,1,0,0,0,1,0,0,2,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,", "1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,", "1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,3,7,1,0,0,0,", "1,0,0,0,1,1,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,3,1,k,0,0,0,1,0,0,0,1,0,4,0,0,0,1,0,0,2,1,0,", "0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,4,0,0,1,4,0,0,1,0,", "0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,3,0,0,1,0,0,0,1,1,0,0,1,0,0,0,1,0,0,0,1,0,", "0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,j,t,3,3,0,0,0,1,0,4,1,3,0,1,6,4,0,5,2,4,0,5,3,4,0,5,m,", "4,1,6,1,5,0,6,3,l,0,5,2,t,5,a,1,l,0,j,0,l,5,t,1f,4,3,h,7,t,1,6,1d,4,f,6,1,5,7,t,1,h,9,8,5,t,h,5,", "5,4,2,h,0,4,0,h,1,4,0,5,9,8,r,4,7,5,1,h,m,4,a,5,1,6,a,t,0,h,s,4,2,t,2,5,0,6,1a,4,0,5,1,6,3,5,1,6", ",1,5,2,6,c,h,0,t,0,3,9,8,3,t,1,h,4,4,0,5,0,3,8,4,9,8,4,4,0,t,14,4,5,5,1,6,1,5,1,6,1,5,8,t,2,4,0,", "5,7,4,0,5,0,6,1,t,9,8,1,t,3,h,f,4,0,3,5,4,2,l,0,4,0,6,0,5,0,6,1d,4,0,5,0,4,2,5,1,4,1,5,4,4,1,5,0", ",4,0,5,0,4,n,t,1,4,0,3,1,h,a,4,0,6,1,5,1,6,1,h,0,4,1,3,0,6,0,5,9,t,5,4,1,t,5,4,1,t,5,4,8,t,6,4,0", ",t,6,4,0,t,16,1,0,k,3,3,8,1,0,3,1,k,3,t,27,1,y,4,1,6,0,5,1,6,0,5,1,6,0,h,0,6,0,5,1,t,9,8,5,t,8mb", ",4,b,t,m,4,3,t,1c,4,3,t,1kv,r,4xr,s,a5,4,1,t,2x,4,11,t,6,1,b,t,4,1,4,t,0,4,0,5,9,4,0,i,c,4,0,t,4", ",4,0,t,0,4,0,t,1,4,0,t,1,4,0,t,2z,4,g,k,f,l,a2,4,0,e,0,d,f,l,1r,4,1,l,1h,4,7,l,v,t,b,4,0,j,2,l,f", ",5,6,h,0,d,0,e,0,h,5,t,f,5,0,h,1,c,1,b,0,d,0,e,0,d,0,e,0,d,0,e,0,d,0,e,0,d,0,e,0,d,0,e,0,d,0,e,0", ",d,0,e,1,h,0,d,0,e,3,h,2,b,2,h,0,t,3,h,0,c,0,d,0,e,0,d,0,e,0,d,0,e,2,h,0,i,0,c,2,i,0,t,0,h,0,j,1", ",h,3,t,4,4,0,t,3q,4,1,t,0,q,0,t,2,h,0,j,2,h,0,d,0,e,0,h,0,i,0,h,0,c,1,h,9,8,1,h,2,i,1,h,p,0,0,d,", "0,h,0,e,0,k,0,b,0,k,p,1,0,d,0,i,0,e,0,i,0,d,0,e,0,h,0,d,0,e,1,h,9,4,0,3,18,4,1,3,u,4,2,t,5,4,1,t", ",5,4,1,t,5,4,1,t,2,4,2,t,1,j,0,i,0,k,0,l,1,j,0,t,0,l,3,i,1,l,9,t,2,q,1,l,1,t,b,4,0,t,p,4,0,t,i,4", ",0,t,1,4,0,t,e,4,1,t,d,4,x,t,3e,4,4,t,2,h,3,t,18,a,2,t,8,l,1g,9,3,a,g,l,1,a,2,l,0,t,c,l,2,t,0,l,", "1a,t,18,l,0,5,3l,t,s,4,2,t,1c,4,e,t,0,5,q,a,3,t,v,4,3,a,8,t,j,4,0,9,7,4,0,9,4,t,11,4,4,5,4,t,t,4", ",0,t,0,h,z,4,3,t,7,4,0,h,4,9,15,t,13,0,13,1,25,4,1,t,9,8,5,t,z,0,3,t,z,1,3,t,13,4,7,t,1f,4,a,t,0", ",h,a,0,0,t,e,0,0,t,6,0,0,t,1,0,0,t,a,1,0,t,e,1,0,t,6,1,0,t,1,1,2,t,1f,4,b,t,8m,4,8,t,l,4,9,t,7,4", ",n,t,5,3,0,t,15,3,0,t,8,3,1w,t,5,4,1,t,0,4,0,t,17,4,0,t,1,4,2,t,0,4,1,t,m,4,0,t,0,h,7,a,m,4,1,l,", "6,a,u,4,7,t,8,a,1b,t,i,4,0,t,1,4,4,t,4,a,l,4,5,a,2,t,0,h,p,4,4,t,0,h,p,4,11,t,1j,4,3,t,1,a,1,4,f", ",a,1,t,19,a,0,4,2,5,0,t,1,5,4,t,3,5,3,4,0,t,2,4,0,t,s,4,1,t,2,5,3,t,0,5,8,a,6,t,8,h,6,t,s,4,1,a,", "0,h,s,4,2,a,v,t,7,4,0,l,r,4,1,5,3,t,4,a,6,h,8,t,1h,4,2,t,6,h,l,4,1,t,7,a,i,4,4,t,7,a,h,4,6,t,3,h", ",b,t,6,a,27,t,20,4,1i,t,1e,0,c,t,1e,1,6,t,5,a,z,4,3,5,7,t,9,8,5,t,9,8,3,4,0,3,0,4,l,0,2,t,4,5,0,", "c,0,3,l,1,7,t,1,i,5r,t,u,a,0,t,15,4,0,t,1,5,0,c,1,t,1,4,f,t,2,4,0,3,1,4,7,t,0,h,7,l,w,t,5,5,s,4,", "9,a,0,4,7,t,l,4,a,5,3,a,4,h,l,t,h,4,3,5,3,h,11,t,k,4,6,a,j,t,m,4,8,t,0,6,0,5,0,6,1g,4,e,5,6,h,3,", "t,j,a,9,8,0,5,1,4,1,5,0,4,8,t,2,5,0,6,18,4,2,6,3,5,1,6,1,5,1,h,0,q,3,h,0,5,9,t,0,q,1,t,o,4,6,t,9", ",8,5,t,2,5,z,4,4,5,0,6,7,5,0,t,9,8,3,h,0,4,1,6,0,4,7,t,y,4,0,5,1,h,0,4,8,t,1,5,0,6,1b,4,2,6,8,5,", "1,6,3,4,3,h,3,5,0,h,0,6,0,5,9,8,0,4,0,h,0,4,2,h,0,t,j,a,a,t,h,4,0,t,o,4,2,6,2,5,1,6,0,5,0,6,1,5,", "5,h,0,5,1,4,0,5,1p,t,6,4,0,t,0,4,0,t,3,4,0,t,e,4,0,t,9,4,0,h,5,t,1a,4,0,5,2,6,7,5,4,t,9,8,5,t,1,", "5,1,6,0,t,7,4,1,t,1,4,1,t,l,4,0,t,6,4,0,t,1,4,0,t,4,4,0,t,1,5,0,4,1,6,0,5,3,6,1,t,1,6,1,t,2,6,1,", "t,0,4,5,t,0,6,4,t,4,4,1,6,1,t,6,5,2,t,4,5,a,t,9,4,0,t,0,4,1,t,0,4,0,t,11,4,0,t,0,4,2,6,5,5,0,t,0", ",6,1,t,0,6,0,t,3,6,0,t,1,6,0,5,0,6,0,5,0,4,0,5,0,4,1,h,0,t,1,h,7,t,1,5,s,t,1g,4,2,6,7,5,1,6,2,5,", "0,6,0,5,3,4,4,h,9,8,1,h,0,t,0,h,0,5,2,4,t,t,1b,4,2,6,5,5,0,6,0,5,3,6,1,5,0,6,1,5,1,4,0,h,0,4,7,t", ",9,8,4l,t,1a,4,2,6,3,5,1,t,3,6,1,5,0,6,1,5,m,h,3,4,1,5,x,t,1b,4,2,6,7,5,1,6,0,5,0,6,1,5,2,h,0,4,", "a,t,9,8,5,t,c,h,i,t,16,4,0,5,0,6,0,5,1,6,5,5,0,6,0,5,0,4,0,h,5,t,9,8,5,t,j,8,r,t,q,4,1,t,0,5,0,6", ",0,5,1,6,3,5,0,6,4,5,3,t,9,8,1,a,2,h,0,l,6,4,54,t,17,4,2,6,8,5,0,6,1,5,0,h,2r,t,v,0,v,1,9,8,8,a,", "b,t,7,4,1,t,0,4,1,t,7,4,0,t,1,4,0,t,n,4,5,6,0,t,1,6,1,t,1,5,0,6,0,5,0,4,0,6,0,4,0,6,0,5,2,h,8,t,", "9,8,1x,t,7,4,1,t,12,4,2,6,3,5,1,t,1,5,3,6,0,5,0,4,0,h,0,4,0,6,q,t,0,4,9,5,13,4,5,5,0,6,0,4,3,5,7", ",h,0,5,7,t,0,4,5,5,1,6,2,5,19,4,c,5,0,6,1,5,2,h,0,4,4,h,c,t,20,4,6,t,9,h,2d,t,0,5,0,6,2,5,0,6,0,", "5,0,6,2f,t,w,4,0,h,d,t,9,8,5,t,8,4,0,t,10,4,0,6,6,5,0,t,5,5,0,6,0,5,0,4,4,h,9,t,9,8,i,a,2,t,1,h,", "t,4,1,t,l,5,0,t,0,6,6,5,0,6,1,5,0,6,1,5,20,t,6,4,0,t,1,4,0,t,11,4,5,5,2,t,0,5,0,t,1,5,0,t,6,5,0,", "4,0,5,7,t,9,8,5,t,5,4,0,t,1,4,0,t,v,4,4,6,0,t,1,5,0,t,1,6,0,5,0,6,0,5,0,4,6,t,9,8,5,t,14,4,0,3,1", ",4,3,t,9,8,6t,t,i,4,1,5,1,6,1,h,6,t,1,5,0,4,0,6,c,4,0,t,x,4,1,6,4,5,2,t,1,6,0,5,0,6,0,5,c,h,9,8,", "0,5,2c,t,0,4,e,t,k,a,7,l,3,j,g,l,c,t,0,h,pl,4,2t,t,32,9,0,t,4,h,a,t,5f,4,217,t,2o,4,1,h,c,t,tr,4", ",f,q,0,5,5,4,e,5,9,t,32y,4,4,t,g6,4,5a0,t,t,4,b,5,2,6,2,5,9,8,1c5,t,fs,4,6,t,u,4,0,t,9,8,3,t,1,h", ",26,4,0,t,9,8,5,t,t,4,1,t,4,5,0,h,9,t,1b,4,6,5,4,h,3,l,3,3,0,h,0,l,9,t,9,8,0,t,6,a,0,t,k,4,4,t,i", ",4,bz,t,2,3,13,4,1,3,2,h,9,8,5h,t,v,0,v,1,m,a,3,h,4,t,o,0,1,t,o,1,17,t,22,4,3,t,0,5,0,4,1i,6,6,t", ",3,5,c,3,1r,t,1,3,0,h,0,3,0,5,a,t,1,6,1,3,2,9,8,t,5p1,4,14,t,v,4,2o,t,36,4,6po,t,3,3,0,t,6,3,0,t", ",1,3,0,t,82,4,e,t,0,4,s,t,2,4,1,t,0,4,d,t,3,4,7,t,az,4,1s3,t,2y,4,4,t,c,4,2,t,8,4,6,t,9,4,1,t,0,", "l,1,5,0,h,3,q,317,t,6n,l,9,8,2,l,2,t,c3,l,5,t,m,l,e,t,f,l,0,i,e,t,19,5,1,t,m,5,8,t,37,l,1n,t,6t,", "l,9,t,12,l,1,t,1n,l,1,6,2,5,2,l,5,6,7,q,7,5,1,l,6,5,t,l,3,5,1o,l,k,t,1t,l,2,5,0,l,3d,t,j,a,b,t,j", ",a,b,t,2e,l,8,t,o,a,3q,t,p,0,p,1,p,0,6,1,0,t,h,1,p,0,p,1,0,0,0,t,1,0,1,t,0,0,1,t,1,0,1,t,3,0,0,t", ",7,0,3,1,0,t,0,1,0,t,6,1,0,t,a,1,p,0,p,1,1,0,0,t,3,0,1,t,7,0,0,t,6,0,0,t,p,1,1,0,0,t,3,0,0,t,4,0", ",0,t,0,0,2,t,6,0,0,t,p,1,p,0,p,1,p,0,p,1,p,0,p,1,p,0,p,1,p,0,p,1,p,0,r,1,1,t,o,0,0,i,o,1,0,i,5,1", ",o,0,0,i,o,1,0,i,5,1,o,0,0,i,o,1,0,i,5,1,o,0,0,i,o,1,0,i,5,1,o,0,0,i,o,1,0,i,5,1,0,0,0,1,1,t,1d,", "8,e7,l,1i,5,3,l,1d,5,7,l,0,5,d,l,0,5,1,l,4,h,e,t,4,5,0,t,e,5,un,t,9,1,0,4,j,1,5,t,5,1,5w,t,6,5,0", ",t,g,5,1,t,6,5,0,t,1,5,0,t,4,5,4,t,1p,3,w,t,0,5,33,t,18,4,2,t,6,5,6,3,1,t,9,8,3,t,0,4,0,l,8v,t,t", ",4,0,5,g,t,17,4,3,5,9,8,4,t,0,j,cv,t,q,4,0,3,3,5,9,8,5x,t,t,4,1,5,0,4,9,8,3,t,0,h,5b,t,u,4,0,t,2", ",4,0,5,1,4,0,5,6,4,1,5,4,4,0,5,7,t,0,4,0,3,67,t,6,4,0,t,3,4,0,t,1,4,0,t,e,4,0,t,5g,4,1,t,8,a,6,5", ",14,t,x,0,x,1,6,5,0,3,3,t,9,8,3,t,1,h,ls,t,1m,a,0,l,2,a,0,j,3,a,23,t,18,a,0,l,e,a,5d,t,3,4,0,t,q", ",4,0,t,1,4,0,t,0,4,1,t,0,4,0,t,9,4,0,t,3,4,0,t,0,4,0,t,0,4,5,t,0,4,3,t,0,4,0,t,0,4,0,t,0,4,0,t,2", ",4,0,t,1,4,0,t,0,4,1,t,0,4,0,t,0,4,0,t,0,4,0,t,0,4,0,t,0,4,0,t,1,4,0,t,0,4,1,t,3,4,0,t,6,4,0,t,3", ",4,0,t,3,4,0,t,0,4,0,t,9,4,0,t,g,4,4,t,2,4,0,t,4,4,0,t,g,4,1f,t,1,i,7h,t,17,l,3,t,2r,l,b,t,e,l,1", ",t,e,l,0,t,e,l,0,t,10,l,9,t,c,a,4g,l,1j,t,s,l,c,t,17,l,3,t,8,l,6,t,1,l,d,t,5,l,49,t,6y,l,4,k,k8,", "l,2,t,g,l,2,t,c,l,2,t,61,l,5,t,b,l,3,t,0,l,e,t,b,l,3,t,1j,l,7,t,9,l,5,t,13,l,7,t,t,l,1,t,b,l,3,t", ",1,l,d,t,8,i,12,t,9j,l,7,t,d,l,1,t,c,l,2,t,a,l,2,t,1k,l,0,t,0,l,3,t,f,l,1,t,b,l,3,t,9,l,6,t,42,l", ",0,t,2j,l,9,8,0,l,sk,t,wyn,4,v,t,3dp,4,1,t,4gd,4,1,t,5rk,4,e,t,h9,4,1wh,t,f1,4,15t,t,3t6,4,4,t,6", "jt,4,f5vq,t,0,q,t,t,2n,q,3j,t,6n,5,1e6n,t,1ekd,s,1,t,1ekd,s,1,t"]

const wordTable: string[] = ["1c,9,7,p,4,0,1,p,1b,0,7,1,1,0,3,1,1,2,1,m,1,u,1,cp,4,b,e,4,7,0,1,0,h,38,1,1,2,3,1,0,6,0,1,2,1,0,", "1,j,1,2a,1,3u,1,4s,1,11,2,0,6,14,8,18,1,0,1,1,1,1,1,0,8,q,4,3,t,a,5,21,4,2t,1,7,2,9,1,i,2,0,g,1m", ",2,2s,e,1h,4,0,2,0,2,19,i,r,4,a,5,n,1,6,7,22,1,3k,2,9,1,i,1,7,2,1,2,l,1,6,1,0,3,3,2,8,2,1,2,3,8,", "0,4,1,1,4,2,b,2,5,2,0,1,0,2,2,1,5,4,1,2,l,1,6,1,1,1,1,1,1,2,0,1,4,4,1,2,2,3,0,7,3,1,0,7,f,b,2,1,", "8,1,2,1,l,1,6,1,1,1,4,2,9,1,2,1,2,2,0,f,3,2,9,9,6,1,2,1,7,2,1,2,l,1,6,1,1,1,4,2,8,2,1,2,2,7,2,4,", "1,1,4,2,9,1,6,a,1,1,5,3,2,1,3,3,1,1,0,1,1,3,1,3,2,3,b,4,4,3,2,1,3,2,0,6,0,e,c,d,c,1,2,1,m,1,f,2,", "8,1,2,1,3,7,1,1,2,1,1,2,3,2,9,8,6,1,3,1,7,1,2,1,m,1,9,1,4,2,8,1,2,1,3,7,1,5,2,1,3,2,9,1,2,c,c,1,", "2,1,1e,1,2,1,4,5,f,2,i,1,5,1,2,1,h,3,n,1,8,1,0,2,6,3,0,4,5,1,0,1,7,6,9,2,1,d,1l,5,e,1,9,13,1,1,0", ",1,4,1,n,1,0,1,m,2,4,1,0,1,6,1,9,2,3,w,0,n,1,6,j,1,0,1,0,1,0,4,9,1,z,4,j,1,h,1,z,9,0,1l,21,6,25,", "2,11,1,0,5,0,2,16,1,98,1,3,2,6,1,0,1,3,2,14,1,3,2,w,1,3,2,6,1,0,1,3,2,e,1,1k,1,3,2,1u,2,2,9,j,3,", "f,g,2d,2,5,3,h7,2,g,1,p,5,22,3,a,7,l,9,l,b,j,c,c,1,2,1,1,c,2b,3,0,4,1,2,9,6,9,h,2,1,a,6,2g,7,16,", "5,1x,a,u,1,b,4,b,a,13,2,4,b,17,4,p,6,a,11,r,4,1q,1,s,2,a,6,9,d,0,8,19,2,b,k,24,3,9,h,8,c,37,c,1j", ",8,9,3,1c,2,a,5,16,2,2,g,2,1,12,5,et,2,5,2,11,2,5,2,7,1,0,1,0,1,0,1,u,2,1g,1,6,1,0,3,2,1,6,3,3,2", ",5,4,c,5,2,1,6,1u,1,j,0,r,1,2,5,5,a,6,c,1f,w,h,0,4,0,2,9,1,0,3,4,6,0,1,0,1,0,1,3,1,a,2,3,5,4,4,0", ",1,1l,k6,1n,26,l,hi,t,vg,6c,6,8,9,0,2,11,1,0,5,0,2,1j,7,0,f,n,9,6,1,6,1,6,1,6,1,6,1,6,1,6,1,6,1,", "v,1b,0,d1,2,p,e,1,4,2,4,4,2d,2,1,2,2,1,2h,1,3,5,16,1,2l,3,3,a,v,1c,f,w,9,u,7,1,e,w,9,13,e,8w,533", ",1s,h3g,1v,19,2,7g,3,r,k,1e,1,9,1,36,11,8,2,2u,2,29,k,1i,4,0,3,5,a,1f,c,1x,a,9,6,n,3,0,1,1c,2,z,", "c,s,3,1s,e,a,6,u,1,1i,9,d,2,9,6,m,3,20,o,2,2,f,2,4,a,5,2,5,2,5,9,6,1,6,1,16,1,d,6,3e,1,1,2,9,6,8", "mb,c,m,4,1c,6is,a5,2,2x,12,6,c,4,5,b,1,c,1,4,1,0,1,1,1,1,1,2z,x,a2,i,1r,2,1h,14,b,4,f,g,f,3,1,o,", "2,w,4,1,3q,j,9,7,p,4,0,1,p,b,2g,3,5,2,5,2,5,2,2,z,b,1,p,1,i,1,1,1,e,2,d,y,3e,c,18,c,1k,h,1,35,0,", "3m,s,3,1c,f,r,4,z,9,t,5,16,5,t,2,z,4,7,1,4,16,4d,2,9,6,z,4,z,4,13,8,1f,c,a,1,e,1,6,1,1,1,a,1,e,1", ",6,1,1,3,1f,c,8m,9,l,a,7,o,5,1,15,1,8,1x,5,2,0,1,17,1,1,3,0,2,m,2,u,2,11,8,8,1c,i,1,1,5,w,4,p,6,", "p,12,1j,4,j,2,1d,1,1,5,7,1,2,1,s,2,2,4,9,n,u,1,v,w,7,1,t,4,4,g,1h,a,l,2,q,5,p,n,6,28,20,1j,1e,d,", "1e,7,19,8,9,6,11,3,4,1,m,62,u,1,15,1,1,3,1,g,5,1e,19,8,10,r,l,16,r,k,m,9,1y,b,z,9,1n,7,0,d,o,7,9", ",6,1g,1,9,4,3,8,z,2,0,9,1w,4,3,1,c,1,0,4,j,b,h,1,10,6,3,1q,6,1,0,1,3,1,e,1,9,7,1m,5,9,6,3,1,7,2,", "1,2,l,1,6,1,1,1,4,1,9,2,1,2,2,2,0,6,0,5,6,2,6,3,4,b,9,1,0,2,0,1,11,1,9,1,0,2,0,1,3,1,7,d,1,t,22,", "5,9,4,3,u,1x,1,0,8,9,4m,1h,2,8,n,5,y,1s,3,0,b,9,12,1k,7,9,6,j,s,q,2,e,4,b,4,6,55,1m,2t,2a,c,7,2,", "0,2,7,1,1,1,t,1,1,2,8,c,9,1y,7,2,19,2,7,1,1,r,1q,8,0,8,21,3,0,i,20,2v,7,2g,w,f,9,6,8,1,18,1,8,f,", "s,5,t,2,l,1,d,21,6,1,1,1,17,3,0,1,1,1,8,8,9,6,5,1,1,1,10,1,1,1,5,7,9,6,17,4,9,6u,m,9,g,1,14,3,4,", "d,a,2d,0,f,k,17,pl,2u,32,h,5f,218,2o,f,tr,g,l,a,32y,5,g6,5a1,1l,1c6,fs,7,u,1,9,6,26,1,9,6,t,2,4,", "b,1i,9,3,c,9,1,6,1,k,5,i,c0,18,3,9,5i,2e,9,o,2,o,18,22,4,1k,7,g,1s,1,1,1,b,6,9,5p1,15,v,2p,36,6p", "p,3,1,6,1,1,1,82,f,0,t,2,2,0,e,3,8,az,1s4,2y,5,c,3,8,7,9,3,1,381,9,ee,19,2,m,f2,4,3,5,8,7,2,6,u,", "3,44,2,3f,j,c,j,30,o,3r,2c,1,1y,1,1,2,0,2,1,2,3,1,b,1,0,1,6,1,1s,1,3,2,7,1,6,1,r,1,3,1,4,1,0,3,6", ",1,9f,2,o,1,o,1,u,1,o,1,u,1,o,1,u,1,o,1,u,1,o,1,7,2,1d,e8,1i,4,1d,8,0,e,0,m,4,1,e,uo,u,6,5,5x,6,", "1,g,2,6,1,1,1,4,5,1p,x,0,34,18,3,d,2,9,4,0,8x,u,h,1l,d2,15,5y,16,5h,u,1,l,8,1,68,6,1,3,1,1,1,e,1", ",5g,2,f,15,23,4,9,lz,1m,1,2,1,3,24,18,1,e,5e,3,1,q,1,1,1,0,2,0,1,9,1,3,1,0,1,0,6,0,4,0,1,0,1,0,1", ",2,1,1,1,0,2,0,1,0,1,0,1,0,1,0,1,1,1,0,2,3,1,6,1,3,1,3,1,0,1,9,1,g,5,2,1,4,1,g,g4,c,25f,9,sm,wyn", ",w,3dp,2,4gd,2,5rk,f,h9,1wi,f1,15u,3t6,5,6jt,f62u,6n"]

const scriptNames: string[] = ["Adlam,Adlm,Aghb,Caucasian_Albanian,Ahom,Anatolian_Hieroglyphs,Hluw,Arab,Arabic,Armenian,Armn,Arm", "i,Imperial_Aramaic,Avestan,Avst,Bali,Balinese,Bamu,Bamum,Bass,Bassa_Vah,Batak,Batk,Beng,Bengali,", "Bhaiksuki,Bhks,Bopo,Bopomofo,Brah,Brahmi,Brai,Braille,Bugi,Buginese,Buhd,Buhid,Cakm,Chakma,Canad", "ian_Aboriginal,Cans,Cari,Carian,Cham,Cher,Cherokee,Common,Zyyy,Copt,Coptic,Qaac,Cprt,Cypriot,Cun", "eiform,Xsux,Cyrillic,Cyrl,Deseret,Dsrt,Deva,Devanagari,Dupl,Duployan,Egyp,Egyptian_Hieroglyphs,E", "lba,Elbasan,Ethi,Ethiopic,Geor,Georgian,Glag,Glagolitic,Gonm,Masaram_Gondi,Goth,Gothic,Gran,Gran", "tha,Greek,Grek,Gujarati,Gujr,Gurmukhi,Guru,Han,Hani,Hang,Hangul,Hano,Hanunoo,Hatr,Hatran,Hebr,He", "brew,Hira,Hiragana,Hmng,Pahawh_Hmong,Hung,Old_Hungarian,Inherited,Qaai,Zinh,Inscriptional_Pahlav", "i,Phli,Inscriptional_Parthian,Prti,Ital,Old_Italic,Java,Javanese,Kaithi,Kthi,Kali,Kayah_Li,Kana,", "Katakana,Kannada,Knda,Khar,Kharoshthi,Khmer,Khmr,Khoj,Khojki,Khudawadi,Sind,Lana,Tai_Tham,Lao,La", "oo,Latin,Latn,Lepc,Lepcha,Limb,Limbu,Lina,Linear_A,Linb,Linear_B,Lisu,Lyci,Lycian,Lydi,Lydian,Ma", "hajani,Mahj,Malayalam,Mlym,Mand,Mandaic,Mani,Manichaean,Marc,Marchen,Meetei_Mayek,Mtei,Mend,Mend", "e_Kikakui,Merc,Meroitic_Cursive,Mero,Meroitic_Hieroglyphs,Miao,Plrd,Modi,Mong,Mongolian,Mro,Mroo", ",Mult,Multani,Myanmar,Mymr,Nabataean,Nbat,Narb,Old_North_Arabian,New_Tai_Lue,Talu,Newa,Nko,Nkoo,", "Nshu,Nushu,Ogam,Ogham,Ol_Chiki,Olck,Old_Permic,Perm,Old_Persian,Xpeo,Old_South_Arabian,Sarb,Old_", "Turkic,Orkh,Oriya,Orya,Osage,Osge,Osma,Osmanya,Palm,Palmyrene,Pau_Cin_Hau,Pauc,Phag,Phags_Pa,Phl", "p,Psalter_Pahlavi,Phnx,Phoenician,Rejang,Rjng,Runic,Runr,Samaritan,Samr,Saur,Saurashtra,Sgnw,Sig", "nWriting,Sharada,Shrd,Shavian,Shaw,Sidd,Siddham,Sinh,Sinhala,Sora,Sora_Sompeng,Soyo,Soyombo,Sund", ",Sundanese,Sylo,Syloti_Nagri,Syrc,Syriac,Tagalog,Tglg,Tagb,Tagbanwa,Tai_Le,Tale,Tai_Viet,Tavt,Ta", "kr,Takri,Tamil,Taml,Tang,Tangut,Telu,Telugu,Tfng,Tifinagh,Thaa,Thaana,Thai,Tibetan,Tibt,Tirh,Tir", "huta,Ugar,Ugaritic,Vai,Vaii,Wara,Warang_Citi,Yi,Yiii,Zanabazar_Square,Zanb,Dogr,Dogra,Gong,Gunja", "la_Gondi,Hanifi_Rohingya,Rohg,Maka,Makasar,Medefaidrin,Medf,Old_Sogdian,Sogo,Sogd,Sogdian,Elym,E", "lymaic,Hmnp,Nyiakeng_Puachue_Hmong,Nand,Nandinagari,Wancho,Wcho,Chorasmian,Chrs,Diak,Dives_Akuru", ",Khitan_Small_Script,Kits,Yezi,Yezidi,Cpmn,Cypro_Minoan,Old_Uyghur,Ougr,Tangsa,Tnsa,Toto,Vith,Vi", "thkuqi,Gara,Garay,Gukh,Gurung_Khema,Kawi,Kirat_Rai,Krai,Nag_Mundari,Nagm,Ol_Onal,Onao,Sunu,Sunuw", "ar,Todhri,Todr,Tulu_Tigalari,Tutg,Unknown,Zzzz"]

const scriptNameIds: string[] = ["0,0,1,1,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,a,a,b,b,c,c,d,d,e,e,f,f,g,g,h,h,i,i,j,j,k,k,l,l,m,n,n,o,o,", "p,p,p,q,q,r,r,s,s,t,t,u,u,v,v,w,w,x,x,y,y,z,z,10,10,11,11,12,12,13,13,14,14,15,15,16,16,17,17,18", ",18,19,19,1a,1a,1b,1b,1c,1c,1d,1d,1e,1e,1f,1f,1f,1g,1g,1h,1h,1i,1i,1j,1j,1k,1k,1l,1l,1m,1m,1n,1n", ",1o,1o,1p,1p,1q,1q,1r,1r,1s,1s,1t,1t,1u,1u,1v,1v,1w,1w,1x,1x,1y,1y,1z,20,20,21,21,22,22,23,23,24", ",24,25,25,26,26,27,27,28,28,29,29,2a,2a,2b,2b,2c,2d,2d,2e,2e,2f,2f,2g,2g,2h,2h,2i,2i,2j,2j,2k,2l", ",2l,2m,2m,2n,2n,2o,2o,2p,2p,2q,2q,2r,2r,2s,2s,2t,2t,2u,2u,2v,2v,2w,2w,2x,2x,2y,2y,2z,2z,30,30,31", ",31,32,32,33,33,34,34,35,35,36,36,37,37,38,38,39,39,3a,3a,3b,3b,3c,3c,3d,3d,3e,3e,3f,3f,3g,3g,3h", ",3h,3i,3i,3j,3j,3k,3k,3l,3l,3m,3m,3n,3n,3o,3o,3p,3q,3q,3r,3r,3s,3s,3t,3t,3u,3u,3v,3v,3w,3w,3x,3x", ",3y,3y,3z,3z,40,40,41,41,42,42,43,43,44,44,45,45,46,46,47,47,48,48,49,49,4a,4a,4b,4b,4c,4c,4d,4d", ",4e,4e,4f,4g,4g,4h,4h,4i,4i,4j,4k,4k,4l,4l,4m,4m,4n,4n,4o,4o,4p,4p,4q,4q"]

const scriptTable: string[] = ["1s,o,p,1u,5,o,p,1u,1a,o,0,1u,e,o,0,1u,4,o,m,1u,0,o,u,1u,0,o,cg,1u,12,o,4,1u,4,o,1,e,j,o,33,1f,3,", "14,0,o,2,14,1,4q,3,14,0,o,0,14,3,4q,0,14,0,o,0,14,0,o,2,14,0,4q,0,14,0,4q,j,14,0,4q,1q,14,d,p,f,", "14,3o,s,1,1f,4o,s,0,4q,11,5,1,4q,1d,5,1,4q,2,5,0,4q,1i,1b,7,4q,q,1b,3,4q,5,1b,a,4q,4,4,0,o,5,4,0", ",o,d,4,0,o,2,4,0,o,v,4,0,o,9,4,a,1f,p,4,0,1f,2z,4,0,o,x,4,d,3e,0,4q,1n,3e,1,4q,2,3e,1b,4,1d,3o,d", ",4q,1m,2l,1,4q,2,2l,19,33,1,4q,e,33,0,4q,r,24,1,4q,0,24,0,4q,a,3e,4,4q,x,4,4,4q,22,4,0,o,s,4,28,", "u,3,1f,e,u,1,o,p,u,3,c,0,4q,7,c,1,4q,1,c,1,4q,l,c,0,4q,6,c,0,4q,0,c,2,4q,3,c,1,4q,8,c,1,4q,1,c,1", ",4q,3,c,7,4q,0,c,3,4q,1,c,0,4q,4,c,1,4q,o,c,1,4q,2,16,0,4q,5,16,3,4q,1,16,1,4q,l,16,0,4q,6,16,0,", "4q,1,16,0,4q,1,16,0,4q,1,16,1,4q,0,16,0,4q,4,16,3,4q,1,16,1,4q,2,16,2,4q,0,16,6,4q,3,16,0,4q,0,1", "6,6,4q,g,16,9,4q,2,15,0,4q,8,15,0,4q,2,15,0,4q,l,15,0,4q,6,15,0,4q,1,15,0,4q,4,15,1,4q,9,15,0,4q", ",2,15,0,4q,2,15,1,4q,0,15,e,4q,3,15,1,4q,b,15,6,4q,6,15,0,4q,2,2t,0,4q,7,2t,1,4q,1,2t,1,4q,l,2t,", "0,4q,6,2t,0,4q,1,2t,0,4q,4,2t,1,4q,8,2t,1,4q,1,2t,1,4q,2,2t,6,4q,2,2t,3,4q,1,2t,0,4q,4,2t,1,4q,h", ",2t,9,4q,1,3k,0,4q,5,3k,2,4q,2,3k,0,4q,3,3k,2,4q,1,3k,0,4q,0,3k,0,4q,1,3k,2,4q,1,3k,2,4q,2,3k,2,", "4q,b,3k,3,4q,4,3k,2,4q,2,3k,0,4q,3,3k,1,4q,0,3k,5,4q,0,3k,d,4q,k,3k,4,4q,c,3m,0,4q,2,3m,0,4q,m,3", "m,0,4q,f,3m,1,4q,8,3m,0,4q,2,3m,0,4q,3,3m,6,4q,1,3m,0,4q,2,3m,0,4q,1,3m,1,4q,3,3m,1,4q,9,3m,6,4q", ",8,3m,c,1n,0,4q,2,1n,0,4q,m,1n,0,4q,9,1n,0,4q,4,1n,1,4q,8,1n,0,4q,2,1n,0,4q,3,1n,6,4q,1,1n,4,4q,", "2,1n,0,4q,3,1n,1,4q,9,1n,0,4q,2,1n,b,4q,c,23,0,4q,2,23,0,4q,1e,23,0,4q,2,23,0,4q,5,23,3,4q,f,23,", "1,4q,p,23,0,4q,2,39,0,4q,h,39,2,4q,n,39,0,4q,8,39,0,4q,0,39,1,4q,6,39,2,4q,0,39,3,4q,5,39,0,4q,0", ",39,0,4q,7,39,5,4q,9,39,1,4q,2,39,b,4q,1l,3p,3,4q,0,o,r,3p,10,4q,1,1t,0,4q,0,1t,0,4q,4,1t,0,4q,n", ",1t,0,4q,0,1t,0,4q,m,1t,1,4q,4,1t,0,4q,0,1t,0,4q,6,1t,0,4q,9,1t,1,4q,3,1t,v,4q,1z,3q,0,4q,z,3q,3", ",4q,12,3q,0,4q,z,3q,0,4q,e,3q,0,4q,6,3q,3,o,1,3q,10,4q,4f,2g,11,z,0,4q,0,z,4,4q,0,z,1,4q,16,z,0,", "o,3,z,73,18,20,y,0,4q,3,y,1,4q,6,y,0,4q,0,y,0,4q,3,y,1,4q,14,y,0,4q,3,y,1,4q,w,y,0,4q,3,y,1,4q,6", ",y,0,4q,0,y,0,4q,3,y,1,4q,e,y,0,4q,1k,y,0,4q,3,y,1,4q,1u,y,1,4q,v,y,2,4q,p,y,5,4q,2d,n,1,4q,5,n,", "1,4q,hr,k,s,2n,2,4q,22,32,2,o,a,32,6,4q,l,3f,8,4q,0,3f,k,19,1,o,8,4q,j,i,b,4q,c,3g,0,4q,2,3g,0,4", "q,1,3g,b,4q,2l,1p,1,4q,9,1p,5,4q,9,1p,5,4q,1,2d,1,o,0,2d,0,o,j,2d,5,4q,2g,2d,6,4q,16,2d,4,4q,1x,", "k,9,4q,u,1w,0,4q,b,1w,3,4q,b,1w,3,4q,0,1w,2,4q,b,1w,t,3h,1,4q,4,3h,a,4q,17,2j,3,4q,p,2j,5,4q,a,2", "j,2,4q,1,2j,v,1p,r,h,1,4q,1,h,1q,1s,0,4q,s,1s,1,4q,a,1s,5,4q,9,1s,5,4q,d,1s,1,4q,19,1f,1,4q,b,1f", ",j,4q,24,8,0,4q,1d,8,1r,3c,1f,b,7,4q,3,b,1j,1v,2,4q,e,1v,2,4q,2,1v,1b,2o,a,s,4,4q,16,z,1,4q,2,z,", "7,3c,7,4q,2,1f,0,o,c,1f,0,o,6,1f,3,o,0,1f,5,o,0,1f,2,o,1,1f,0,o,4,4q,11,1u,4,14,0,s,1c,1u,4,14,3", ",1u,4,14,c,1u,0,s,1x,1u,0,14,1r,1f,73,1u,l,14,1,4q,5,14,1,4q,11,14,1,4q,5,14,1,4q,7,14,0,4q,0,14", ",0,4q,0,14,0,4q,0,14,0,4q,u,14,1,4q,1g,14,0,4q,e,14,0,4q,d,14,1,4q,5,14,0,4q,i,14,1,4q,2,14,0,4q", ",8,14,0,4q,b,o,1,1f,2e,o,0,4q,a,o,0,1u,1,4q,a,o,0,1u,e,o,0,4q,c,1u,2,4q,x,o,d,4q,w,1f,e,4q,11,o,", "0,14,2,o,1,1u,5,o,0,1u,q,o,0,1u,g,o,14,1u,2,o,3,4q,ih,o,l,4q,a,o,k,4q,pr,o,73,g,hf,o,1,4q,3t,o,2", "n,10,v,1u,37,p,4,4q,6,p,11,z,0,4q,0,z,4,4q,0,z,1,4q,1j,3n,6,4q,1,3n,d,4q,0,3n,m,y,8,4q,6,y,0,4q,", "6,y,0,4q,6,y,0,4q,6,y,0,4q,6,y,0,4q,6,y,0,4q,6,y,0,4q,6,y,0,4q,v,s,2l,o,x,4q,p,17,0,4q,2g,17,b,4", "q,5x,17,p,4q,k,o,0,17,0,o,0,17,o,o,8,17,3,1f,1,18,7,o,3,17,3,o,0,4q,2d,1c,1,4q,1,1f,1,o,2,1c,0,o", ",2h,1m,1,o,2,1m,4,4q,16,e,0,4q,2l,18,0,4q,f,o,v,e,11,o,8,4q,0,o,f,1m,u,18,0,4q,1r,o,u,18,28,o,1a", ",1m,0,o,2f,1m,4n,o,533,17,1r,o,g73,17,wc,3v,2,4q,1i,3v,8,4q,1b,1z,8b,3t,j,4q,2n,s,2f,9,7,4q,x,o,", "2t,1u,2,o,29,1u,j,4q,e,1u,18,3d,2,4q,9,o,5,4q,1j,2y,7,4q,1x,34,7,4q,b,34,5,4q,v,u,19,1l,0,o,0,1l", ",z,31,a,4q,0,31,s,18,2,4q,25,1j,0,4q,0,o,9,1j,3,4q,1,1j,u,2g,0,4q,1i,m,8,4q,d,m,1,4q,9,m,1,4q,3,", "m,v,2g,1u,3i,n,4q,4,3i,m,27,9,4q,5,y,1,4q,5,y,1,4q,5,y,8,4q,6,y,0,4q,6,y,0,4q,16,1u,0,o,8,1u,0,1", "4,3,1u,1,o,3,4q,27,n,19,27,1,4q,9,27,5,4q,8mb,18,b,4q,m,18,3,4q,1c,18,6ir,4q,a5,17,1,4q,2x,17,11", ",4q,6,1u,b,4q,4,5,4,4q,p,1b,0,4q,4,1b,0,4q,0,1b,0,4q,1,1b,0,4q,1,1b,0,4q,9,1b,dp,4,1,o,3z,4,v,4q", ",f,4,f,1f,9,o,5,4q,d,1f,1,s,y,o,0,4q,i,o,0,4q,3,o,3,4q,4,4,0,4q,3q,4,1,4q,0,o,0,4q,v,o,p,1u,5,o,", "p,1u,a,o,9,1m,0,o,18,1m,1,o,u,18,2,4q,5,18,1,4q,5,18,1,4q,5,18,1,4q,2,18,2,4q,6,o,0,4q,6,o,9,4q,", "4,o,1,4q,b,1y,0,4q,p,1y,0,4q,i,1y,0,4q,1,1y,0,4q,e,1y,1,4q,d,1y,x,4q,3e,1y,4,4q,2,o,3,4q,18,o,2,", "4q,8,o,26,14,0,4q,c,o,2,4q,0,14,1a,4q,18,o,0,1f,3l,4q,s,20,2,4q,1c,l,e,4q,0,1f,q,o,3,4q,z,1i,8,4", "q,2,1i,q,12,4,4q,16,2p,4,4q,t,3s,0,4q,0,3s,z,2q,3,4q,d,2q,15,4q,27,t,1b,37,t,2v,1,4q,9,2v,5,4q,z", ",2u,3,4q,z,2u,3,4q,13,x,7,4q,1f,1,a,4q,0,1,a,4g,0,4q,e,4g,0,4q,6,4g,0,4q,1,4g,0,4q,a,4g,0,4q,e,4", "g,0,4q,6,4g,0,4q,1,4g,2,4q,1f,4o,b,4q,8m,1x,8,4q,l,1x,9,4q,7,1x,n,4q,5,1u,0,4q,15,1u,0,4q,8,1u,1", "w,4q,5,q,1,4q,0,q,0,4q,17,q,0,4q,1,q,2,4q,0,q,1,4q,0,q,l,6,0,4q,8,6,v,2w,u,2h,7,4q,8,2h,1b,4q,i,", "1a,0,4q,1,1a,4,4q,4,1a,r,30,2,4q,0,30,p,21,4,4q,0,21,1r,4q,v,2a,n,29,3,4q,j,29,1,4q,19,29,3,1o,0", ",4q,1,1o,4,4q,7,1o,0,4q,2,1o,0,4q,s,1o,1,4q,2,1o,3,4q,9,1o,6,4q,8,1o,6,4q,v,2r,v,2i,v,4q,12,25,3", ",4q,b,25,8,4q,1h,7,2,4q,6,7,l,1h,1,4q,7,1h,i,1g,4,4q,7,1g,h,2z,6,4q,3,2z,b,4q,6,2z,27,4q,20,2s,1", "i,4q,1e,1e,c,4q,1e,1e,6,4q,5,1e,13,3z,7,4q,9,3z,5,4q,11,4h,2,4q,s,4h,7,4q,1,4h,5r,4q,u,4,0,4q,15", ",4b,0,4q,2,4b,1,4q,1,4b,f,4q,5,4,7,4q,8,4,w,4q,5,4,13,42,7,4q,15,43,l,4q,p,4d,11,4q,r,48,j,4q,m,", "44,8,4q,25,f,3,4q,z,f,8,4q,0,f,1u,1k,9,4q,0,1k,1,4q,o,3a,6,4q,9,3a,5,4q,1g,j,0,4q,h,j,7,4q,12,22", ",8,4q,2n,36,0,4q,j,39,a,4q,h,1q,0,4q,1a,1q,1p,4q,6,2f,0,4q,0,2f,0,4q,3,2f,0,4q,e,2f,0,4q,a,2f,5,", "4q,1m,1r,4,4q,9,1r,5,4q,3,13,0,4q,7,13,1,4q,1,13,1,4q,l,13,0,4q,6,13,0,4q,1,13,0,4q,4,13,0,4q,0,", "1f,8,13,1,4q,1,13,1,4q,2,13,1,4q,0,13,5,4q,0,13,4,4q,6,13,1,4q,6,13,2,4q,4,13,a,4q,9,4p,0,4q,0,4", "p,1,4q,0,4p,0,4q,11,4p,0,4q,9,4p,0,4q,0,4p,1,4q,0,4p,0,4q,3,4p,0,4q,9,4p,0,4q,1,4p,7,4q,1,4p,s,4", "q,2j,2k,0,4q,4,2k,t,4q,1z,3r,7,4q,9,3r,4l,4q,1h,38,1,4q,11,38,x,4q,1w,2c,a,4q,9,2c,5,4q,c,2d,i,4", "q,1l,3j,5,4q,9,3j,5,4q,j,2g,r,4q,q,2,1,4q,e,2,3,4q,m,2,54,4q,1n,3x,2r,4q,2a,3u,b,4q,0,3u,6,49,1,", "4q,0,49,1,4q,7,49,0,4q,1,49,0,4q,t,49,0,4q,1,49,1,4q,b,49,8,4q,9,49,1x,4q,7,46,1,4q,19,46,1,4q,a", ",46,q,4q,1z,3w,7,4q,2a,3b,c,4q,f,k,1k,2x,6,4q,9,u,2d,4q,7,36,2f,4q,x,4n,d,4q,9,4n,5,4q,8,d,0,4q,", "18,d,0,4q,d,d,9,4q,s,d,2,4q,v,26,1,4q,l,26,0,4q,d,26,20,4q,6,11,0,4q,1,11,0,4q,17,11,2,4q,0,11,0", ",4q,1,11,0,4q,8,11,7,4q,9,11,5,4q,5,3y,0,4q,1,3y,0,4q,10,3y,0,4q,1,3y,0,4q,5,3y,6,4q,9,3y,8l,4q,", "o,40,6,4q,g,4j,0,4q,14,4j,2,4q,s,4j,2c,4q,0,1z,e,4q,1d,3k,c,4q,0,3k,pl,r,2t,4q,32,r,0,4q,4,r,a,4", "q,5f,r,217,4q,2q,4c,c,4q,ut,w,9,4q,32y,w,4,4q,g6,3,5a0,4q,1l,4i,1c5,4q,fs,9,6,4q,u,2e,0,4q,9,2e,", "3,4q,1,2e,26,4e,0,4q,9,4e,5,4q,t,a,1,4q,5,a,9,4q,1x,1d,9,4q,9,1d,0,4q,6,1d,0,4q,k,1d,4,4q,i,1d,b", "z,4q,1l,4k,5h,4q,2i,41,2s,4q,22,2b,3,4q,1k,2b,6,4q,g,2b,1r,4q,0,3l,0,2m,1,17,0,4a,a,4q,6,17,8,4q", ",5bz,3l,d1,4a,14,4q,0,4a,u,3l,2o,4q,36,3l,6po,4q,3,1m,0,4q,6,1m,0,4q,1,1m,0,4q,0,1m,7y,1c,2,1m,e", ",4q,0,1c,s,4q,2,1c,1,4q,0,1m,d,4q,3,1m,7,4q,az,2m,1s3,4q,2y,v,4,4q,c,v,2,4q,8,v,6,4q,9,v,1,4q,3,", "v,3,o,317,4q,70,o,2,4q,c3,o,5,4q,m,o,e,4q,g,o,e,4q,19,1f,1,4q,m,1f,8,4q,37,o,1n,4q,6t,o,9,4q,12,", "o,1,4q,1p,o,2,1f,g,o,7,1f,1,o,6,1f,t,o,3,1f,1o,o,k,4q,1x,14,3d,4q,j,o,b,4q,j,o,b,4q,2e,o,8,4q,o,", "o,3q,4q,2c,o,0,4q,1y,o,0,4q,1,o,1,4q,0,o,1,4q,1,o,1,4q,3,o,0,4q,b,o,0,4q,0,o,0,4q,6,o,0,4q,1s,o,", "0,4q,3,o,1,4q,7,o,0,4q,6,o,0,4q,r,o,0,4q,3,o,0,4q,4,o,0,4q,0,o,2,4q,6,o,0,4q,9f,o,1,4q,83,o,1,4q", ",1d,o,i3,35,e,4q,4,35,0,4q,e,35,un,4q,u,1u,5,4q,5,1u,5w,4q,6,10,0,4q,g,10,1,4q,6,10,0,4q,1,10,0,", "4q,4,10,4,4q,1p,s,w,4q,0,s,33,4q,18,45,2,4q,d,45,1,4q,9,45,3,4q,1,45,8v,4q,u,4f,g,4q,1l,47,4,4q,", "0,47,cv,4q,15,4l,5x,4q,16,4m,3,4q,0,4m,db,4q,6,y,0,4q,3,y,0,4q,1,y,0,4q,e,y,0,4q,5g,28,1,4q,f,28", ",14,4q,23,0,3,4q,9,0,3,4q,1,0,ls,4q,1v,o,23,4q,1o,o,5d,4q,3,4,0,4q,q,4,0,4q,1,4,0,4q,0,4,1,4q,0,", "4,0,4q,9,4,0,4q,3,4,0,4q,0,4,0,4q,0,4,5,4q,0,4,3,4q,0,4,0,4q,0,4,0,4q,0,4,0,4q,2,4,0,4q,1,4,0,4q", ",0,4,1,4q,0,4,0,4q,0,4,0,4q,0,4,0,4q,0,4,0,4q,0,4,0,4q,1,4,0,4q,0,4,1,4q,3,4,0,4q,6,4,0,4q,3,4,0", ",4q,3,4,0,4q,0,4,0,4q,9,4,0,4q,g,4,4,4q,2,4,0,4q,4,4,0,4q,g,4,1f,4q,1,4,7h,4q,17,o,3,4q,2r,o,b,4", "q,e,o,1,4q,e,o,0,4q,e,o,0,4q,10,o,9,4q,4t,o,1j,4q,p,o,0,1c,1,o,c,4q,17,o,3,4q,8,o,6,4q,1,o,d,4q,", "5,o,49,4q,rc,o,2,4q,g,o,2,4q,c,o,2,4q,61,o,5,4q,b,o,3,4q,0,o,e,4q,b,o,3,4q,1j,o,7,4q,9,o,5,4q,13", ",o,7,4q,t,o,1,4q,b,o,3,4q,1,o,d,4q,8,o,12,4q,9j,o,7,4q,d,o,1,4q,c,o,2,4q,a,o,2,4q,1k,o,0,4q,0,o,", "3,4q,f,o,1,4q,b,o,3,4q,9,o,6,4q,42,o,0,4q,2u,o,sk,4q,wyn,17,v,4q,3dp,17,1,4q,4gd,17,1,4q,5rk,17,", "e,4q,h9,17,1wh,4q,f1,17,15t,4q,3t6,17,4,4q,6jt,17,f5vq,4q,0,o,t,4q,2n,o,3j,4q,6n,1f,47bj,4q"]

const binaryNames: string[] = ["AHex,ASCII_Hex_Digit,ASCII,Alpha,Alphabetic,Any,Assigned,Bidi_C,Bidi_Control,Bidi_M,Bidi_Mirrore", "d,CI,Case_Ignorable,CWCF,Changes_When_Casefolded,CWCM,Changes_When_Casemapped,CWKCF,Changes_When", "_NFKC_Casefolded,CWL,Changes_When_Lowercased,CWT,Changes_When_Titlecased,CWU,Changes_When_Upperc", "ased,Cased,DI,Default_Ignorable_Code_Point,Dash,Dep,Deprecated,Dia,Diacritic,Emoji,Emoji_Compone", "nt,EComp,Emoji_Modifier,EMod,Emoji_Modifier_Base,EBase,Emoji_Presentation,EPres,Ext,Extender,Gr_", "Base,Grapheme_Base,Gr_Ext,Grapheme_Extend,Hex,Hex_Digit,IDC,ID_Continue,IDS,ID_Start,IDSB,IDS_Bi", "nary_Operator,IDST,IDS_Trinary_Operator,Ideo,Ideographic,Join_C,Join_Control,LOE,Logical_Order_E", "xception,Lower,Lowercase,Math,NChar,Noncharacter_Code_Point,Pat_Syn,Pattern_Syntax,Pat_WS,Patter", "n_White_Space,QMark,Quotation_Mark,RI,Regional_Indicator,Radical,SD,Soft_Dotted,STerm,Sentence_T", "erminal,Term,Terminal_Punctuation,UIdeo,Unified_Ideograph,Upper,Uppercase,VS,Variation_Selector,", "White_Space,space,XIDC,XID_Continue,XIDS,XID_Start,Extended_Pictographic,ExtPict"]

const binaryNameIds: string[] = ["0,0,1,2,2,3,4,5,5,6,6,7,7,8,8,9,9,a,a,b,b,c,c,d,d,e,f,f,g,h,h,i,i,j,k,k,l,l,m,m,n,n,o,o,p,p,q,q,", "r,r,s,s,t,t,u,u,v,v,w,w,x,x,y,y,z,z,10,11,11,12,12,13,13,14,14,15,15,16,17,17,18,18,19,19,1a,1a,", "1b,1b,1c,1c,1d,1d,1e,1e,1f,1f,1g,1g"]

const binaryTable: string[] = ["1c,9,7,5,q,5;0,3j;1t,p,6,p,1b,0,a,0,4,0,5,m,1,u,1,cp,4,b,e,4,7,0,1,0,2e,0,t,h,1,1,2,3,1,0,6,0,1,", "2,1,0,1,j,1,2a,1,3u,8,4l,1,11,2,0,6,14,13,d,1,0,1,1,1,1,1,0,8,q,4,3,t,a,5,1j,1,6,e,2t,1,7,4,7,4,", "2,a,2,2,0,g,1b,d,2s,o,w,9,1,4,0,5,n,2,i,j,o,7,a,5,n,1,6,7,0,8,15,a,b,3,6,6,23,1,f,1,2,4,e,d,i,1,", "7,2,1,2,l,1,6,1,0,3,3,3,7,2,1,2,1,1,0,8,0,4,1,1,4,c,1,a,0,4,2,1,5,4,1,2,l,1,6,1,1,1,1,1,1,4,4,4,", "1,2,1,4,0,7,3,1,0,h,5,b,2,1,8,1,2,1,l,1,6,1,1,1,4,3,8,1,2,1,1,3,0,f,3,l,3,4,2,1,7,2,1,2,l,1,6,1,", "1,1,4,3,7,2,1,2,1,9,1,4,1,1,4,d,0,g,1,1,5,3,2,1,3,3,1,1,0,1,1,3,1,3,2,3,b,4,4,3,2,1,2,3,0,6,0,14", ",c,1,2,1,m,1,f,3,7,1,2,1,2,8,1,1,2,1,1,2,3,s,3,1,7,1,2,1,m,1,9,1,4,3,7,1,2,1,2,8,1,5,2,1,3,d,2,c", ",c,1,2,1,14,2,7,1,2,1,2,1,0,5,3,7,4,m,5,1,2,1,h,3,n,1,8,1,0,2,6,8,5,1,0,1,7,i,1,d,1l,5,6,6,0,1f,", "1,1,0,1,4,1,n,1,0,1,i,1,2,2,4,1,0,6,0,e,3,w,0,1r,7,1,z,4,i,4,f,1,z,1v,1i,1,0,2,4,g,1r,a,3,2,11,1", ",0,5,0,2,16,1,98,1,3,2,6,1,0,1,3,2,14,1,3,2,w,1,3,2,6,1,0,1,3,2,e,1,1k,1,3,2,1u,11,f,g,2d,2,5,3,", "h7,2,g,1,p,5,22,3,a,7,j,b,k,c,j,c,c,1,2,1,1,c,1f,2,i,e,0,4,0,1v,2g,7,16,5,1x,a,u,1,b,4,8,n,t,2,4", ",b,17,4,p,1i,r,4,1q,2,j,1e,0,n,1,b,2,1d,1f,1,e,1,7,1f,15,2,3,a,17,1,a,e,1i,m,2,a,z,2,a,5,16,2,2,", "15,3,1,5,1,1,3,0,5,5b,j,x,b,7p,2,5,2,11,2,5,2,7,1,0,1,0,1,0,1,u,2,1g,1,6,1,0,3,2,1,6,3,3,2,5,4,c", ",5,2,1,6,38,0,d,0,g,c,2t,0,4,0,2,9,1,0,3,4,6,0,1,0,1,0,1,3,1,a,2,3,5,4,4,0,h,14,ml,1f,1ee,6c,6,3", ",3,1,c,11,1,0,5,0,2,1j,7,0,g,m,9,6,1,6,1,6,1,6,1,6,1,6,1,6,1,6,1,v,1b,0,d1,2,p,8,7,4,2,4,4,2d,6,", "2,1,2h,1,3,5,16,1,2l,h,v,1c,f,e8,533,1s,h3g,1v,19,2,7g,3,f,a,1,k,1a,5,7,3,34,13,8,2,2u,2,29,k,k,", "1,w,o,1f,c,1v,1,0,18,5,3,0,1,2,a,w,5,y,d,s,3,1e,1,b,f,0,g,f,a,4,1,1i,9,d,i,m,3,1w,1,0,1,0,o,2,2,", "f,2,3,b,5,2,5,2,5,9,6,1,6,1,16,1,d,6,3e,l,8mb,c,m,4,1c,6is,a5,2,2x,12,6,c,4,5,b,1,c,1,4,1,0,1,1,", "1,1,1,2z,x,a2,i,1r,2,1h,14,b,38,4,1,3q,10,p,6,p,b,2g,3,5,2,5,2,5,2,2,z,b,1,p,1,i,1,1,1,e,2,d,y,3", "e,1x,1g,7f,s,3,1c,1b,v,d,t,5,16,5,t,2,z,4,7,1,4,16,4d,i,z,4,z,4,13,8,1f,c,a,1,e,1,6,1,1,1,a,1,e,", "1,6,1,1,3,1f,c,8m,9,l,a,7,o,5,1,15,1,8,1x,5,2,0,1,17,1,1,3,0,2,m,a,m,9,u,1t,i,1,1,a,l,a,p,6,p,12", ",1j,6,1,1s,3,1,1,5,7,1,2,1,s,16,s,3,s,z,7,1,r,r,1h,a,l,a,i,d,h,32,20,1j,1e,d,1e,d,13,y,r,3,0,5,m", ",6y,15,1,1,3,1,g,5,1e,2,3,s,a,0,8,l,16,h,1a,k,r,m,9,1x,17,4,a,1k,9,0,d,o,n,1e,h,3,8,y,3,0,9,1r,1", ",3,9,1,a,0,1,0,z,h,1,x,2,0,6,3,1q,6,1,0,1,3,1,e,1,9,7,1k,n,3,1,7,2,1,2,l,1,6,1,1,1,4,3,7,2,1,2,1", ",3,0,6,0,5,6,s,9,1,0,2,0,1,11,1,9,1,0,2,0,1,3,1,1,3,0,1,0,18,1t,1,2,1,3,k,2,u,1t,2,1,1,0,54,1h,2", ",6,p,5,y,1q,1,0,3,0,1n,1h,2,0,1z,q,2,d,l,6,55,1k,2v,1r,v,7,2,0,2,7,1,1,1,t,1,1,2,1,2,3,2l,7,2,19", ",2,5,1,0,1,1,r,1e,2,9,h,1z,5,0,i,20,2v,7,2g,w,v,8,1,18,1,6,1,0,1d,t,2,l,1,d,21,6,1,1,1,17,3,0,1,", "1,1,2,1,0,2,1,o,5,1,1,1,10,1,1,1,3,1,0,n,17,78,m,9,g,1,14,3,2,33,0,27,pl,2u,32,h,5f,218,2o,f,tr,", "h,5,p,32y,5,g6,5a1,1a,1ch,fs,7,u,h,26,h,t,i,1b,g,3,v,k,5,i,c0,18,5v,1r,w,o,2,o,18,22,4,1k,7,g,1s", ",1,1,0,c,6,9,5p1,15,v,2p,36,6pp,3,1,6,1,1,1,82,f,0,t,2,2,0,e,3,8,az,1s4,2y,5,c,3,8,7,9,4,0,4m9,2", "c,1,1y,1,1,2,0,2,1,2,3,1,b,1,0,1,6,1,1s,1,3,2,7,1,6,1,r,1,3,1,4,1,0,3,6,1,9f,2,o,1,o,1,u,1,o,1,u", ",1,o,1,u,1,o,1,u,1,o,1,7,1f8,u,6,5,5x,6,1,g,2,6,1,1,1,4,5,1p,x,0,34,18,a,6,g,0,8x,t,i,17,dg,r,6c", ",t,2,0,5r,u,1,l,8,1,68,6,1,3,1,1,1,e,1,5g,1n,1v,3,0,3,0,xg,3,1,q,1,1,1,0,2,0,1,9,1,3,1,0,1,0,6,0", ",4,0,1,0,1,0,1,2,1,1,1,0,2,0,1,0,1,0,1,0,1,0,1,1,1,0,2,3,1,6,1,3,1,3,1,0,1,9,1,g,5,2,1,4,1,g,hg,", "p,6,p,6,p,2uu,wyn,w,3dp,2,4gd,2,5rk,f,h9,1wi,f1,15u,3t6,5,6jt;0,16nz,1kw,mnen;0,on,2,5,4,6,1,0,1", ",j,1,b0,1,11,2,1d,2,2,1,1i,8,q,4,5,b,7h,1,1n,2,2s,e,1m,2,1c,2,e,1,r,2,0,1,a,5,x,5,6k,1,7,2,1,2,l", ",1,6,1,0,3,3,2,8,2,1,2,3,8,0,4,1,1,4,2,o,2,2,1,5,4,1,2,l,1,6,1,1,1,1,1,1,2,0,1,4,4,1,2,2,3,0,7,3", ",1,0,7,g,a,2,1,8,1,2,1,l,1,6,1,1,1,4,2,9,1,2,1,2,2,0,f,3,2,b,7,6,1,2,1,7,2,1,2,l,1,6,1,1,1,4,2,8", ",2,1,2,2,7,2,4,1,1,4,2,h,a,1,1,5,3,2,1,3,3,1,1,0,1,1,3,1,3,2,3,b,4,4,3,2,1,3,2,0,6,0,e,k,5,c,1,2", ",1,m,1,f,2,8,1,2,1,3,7,1,1,2,1,1,2,3,2,9,7,l,1,2,1,m,1,9,1,4,2,8,1,2,1,3,7,1,5,2,1,3,2,9,1,2,c,c", ",1,2,1,1e,1,2,1,5,4,f,2,p,1,2,1,h,3,n,1,8,1,0,2,6,3,0,4,5,1,0,1,7,6,9,2,2,c,1l,4,s,11,1,1,0,1,4,", "1,n,1,0,1,m,2,4,1,0,1,6,1,9,2,3,w,1z,1,z,4,12,1,z,1,e,1,c,11,5h,1,0,5,0,2,ag,1,3,2,6,1,0,1,3,2,1", "4,1,3,2,w,1,3,2,6,1,0,1,3,2,e,1,1k,1,3,2,1u,2,v,3,p,6,2d,2,5,2,ik,3,2g,7,l,9,n,9,j,c,c,1,2,1,1,c", ",2l,2,9,6,9,6,p,6,2g,7,16,5,1x,a,u,1,b,4,b,4,0,3,15,2,4,b,17,4,p,6,a,3,1p,2,1s,1,s,2,a,6,9,6,d,2", ",19,2,b,k,24,1,4l,8,1n,3,e,3,1p,5,16,2,a,8,16,5,et,2,5,2,11,2,5,2,7,1,0,1,0,1,0,1,u,2,1g,1,e,1,d", ",2,5,1,i,2,2,1,8,1,2s,1,b,2,q,1,c,3,x,e,w,f,3v,4,ih,m,a,l,1eb,2,al,5,18,1,0,5,0,2,1j,7,1,e,n,9,6", ",1,6,1,6,1,6,1,6,1,6,1,6,1,6,1,3h,y,p,1,2g,c,5x,q,27,1,2d,2,2u,5,16,1,2l,1,2d,9,1b,1,mlo,3,1i,9,", "9n,k,53,8,64,k,1n,3,9,6,1j,8,1x,8,b,6,37,b,t,3,25,1,a,4,w,1,1i,9,d,2,9,2,2u,o,r,a,5,2,5,2,5,9,6,", "1,6,1,1n,4,3h,2,9,6,8mb,c,m,4,1c,1l0,57x,2,2x,12,6,c,4,5,p,1,4,1,0,1,1,1,1,1,i1,w,15,6,1e,1,i,1,", "3,4,4,1,3q,2,0,1,59,3,5,2,5,2,5,2,2,3,6,1,6,a,4,2,b,1,p,1,i,1,1,1,e,2,d,y,3e,5,2,4,18,3,2f,1,c,3", ",0,1b,19,3m,s,3,1c,f,r,4,z,9,t,5,16,5,t,1,10,4,d,16,4d,2,9,6,z,4,z,4,13,8,1f,b,b,1,e,1,6,1,1,1,a", ",1,e,1,6,1,1,3,1f,c,8m,9,l,a,7,o,5,1,15,1,8,1x,5,2,0,1,17,1,1,3,0,2,m,1,1z,8,8,1c,i,1,1,5,w,3,q,", "5,q,12,1j,4,j,2,1d,1,1,5,7,1,2,1,s,2,2,4,9,7,8,7,1r,w,12,4,b,9,1h,3,s,2,q,5,p,7,3,c,6,28,20,1j,1", "e,d,1e,7,19,8,9,6,11,3,s,8,1,5s,u,1,15,1,2,2,1,g,5,8,8,x,19,8,15,m,p,12,r,k,m,9,25,4,z,9,1v,a,0,", "2,o,7,9,6,1g,1,h,8,12,9,2n,1,j,b,h,1,1a,1q,6,1,0,1,3,1,e,1,a,6,1m,5,9,6,3,1,7,2,1,2,l,1,6,1,1,1,", "4,1,9,2,1,2,2,2,0,6,0,5,6,2,6,3,4,b,9,1,0,2,0,1,11,1,9,1,0,2,0,1,3,1,9,1,1,8,1,t,2j,1,4,u,1z,8,9", ",4m,1h,2,11,y,1w,b,9,6,c,j,1l,6,9,6,j,s,q,2,e,4,m,55,1n,2s,2a,c,7,2,0,2,7,1,1,1,t,1,1,2,b,9,9,1y", ",7,2,19,2,a,r,1z,8,2a,d,20,7,9,2e,7,2g,x,e,9,6,8,1,18,1,d,a,s,3,v,2,l,1,d,21,6,1,1,1,17,3,0,1,1,", "1,8,8,9,6,5,1,1,1,10,1,1,1,5,7,9,6,17,4,9,6u,o,7,g,1,14,3,s,2d,0,f,1d,d,pm,2u,32,1,4,b,5f,218,2q", ",d,ut,a,32y,5,g6,5a1,1l,1c6,fs,7,u,1,9,4,28,1,9,6,t,2,5,a,1x,a,9,1,6,1,k,5,i,c0,1l,5i,2i,5,o,2,o", ",18,22,4,1k,7,g,1s,4,b,6,9,5p1,15,v,2p,36,6pp,3,1,6,1,1,1,82,f,0,t,2,2,0,e,3,8,az,1s4,2y,5,c,3,8", ",7,9,2,7,318,70,3,c3,6,m,f,g,f,19,2,m,9,37,1o,6t,a,12,2,5d,l,1x,3e,j,c,j,c,2e,9,o,3r,2c,1,1y,1,1", ",2,0,2,1,2,3,1,b,1,0,1,6,1,1s,1,3,2,7,1,6,1,r,1,3,1,4,1,0,3,6,1,9f,2,83,2,jh,f,4,1,e,uo,u,6,5,5x", ",6,1,g,2,6,1,1,1,4,5,1p,x,0,34,18,3,d,2,9,4,1,8w,u,h,1l,5,0,cw,15,5y,16,4,0,5c,u,1,l,8,1,68,6,1,", "3,1,1,1,e,1,5g,2,f,15,23,4,9,4,1,lt,1v,24,1o,5e,3,1,q,1,1,1,0,2,0,1,9,1,3,1,0,1,0,6,0,4,0,1,0,1,", "0,1,2,1,1,1,0,2,0,1,0,1,0,1,0,1,0,1,1,1,0,2,3,1,6,1,3,1,3,1,0,1,9,1,g,5,2,1,4,1,g,1g,1,7i,17,4,2", "r,c,e,2,e,1,e,1,10,a,4t,1k,s,d,17,4,8,7,1,e,5,4a,rc,3,g,3,c,3,61,6,b,4,0,f,b,4,1j,8,9,6,13,8,t,2", ",b,4,1,e,8,13,9j,8,d,2,c,3,a,3,1k,1,0,4,f,2,b,4,9,7,42,1,2u,sl,wyn,w,3dp,2,4gd,2,5rk,f,h9,1wi,f1", ",15u,3t6,5,6jt,f5vr,0,u,2n,3k,6n,1e6o,1ekd,2,1ekd;17g,0,54h,1,q,4,1j,3;14,1,i,0,1,0,s,0,1,0,t,0,", "1,0,19,0,f,0,2v2,3,1gd,1,1wc,1,a,1,1i,1,e,1,4x,0,5c,3,3,5,3,0,3,1,3,3,1,3,1,0,1,0,4,8,5,0,1,h,5,", "3,9,1,1,0,1,7,1,v,2,3,5,0,9,1,2,i,5,1,9,4,2,1,4,n,2,f,8,3,k,1,7,1,u5,d,22,0,2,3,1,1,1,2,5,3,5,2,", "3,d,b7,l,2,5,1,d,8,0,7,5,3,0,4,4,1,1,2,4,4,0,1,2,2,1,a,5,2,1,c,i,1,3,2,0,1,0,2,0,1,3,5,1,6,2,o,1", ",b,1,4,3,1,1,2,1,4,16,2,7,1,13,5,0,1,0,3,4,5,2,4,0,3,4,1,0,74,0,eb,3,3,1,1,1,e,1,2,9,17,7,bv,9,2", ",7,14ql,5,5,1,4i,1,i,0,1,0,s,0,1,0,t,0,1,0,1,1,1,1,16k7,0,1l,0,1l,0,1l,0,1l,0;13,0,6,0,b,0,z,0,1", ",0,1z,0,4,0,1,0,4,0,2,1,dz,5b,4,1,4,0,9,1,1,0,6z,6,5r,0,5,0,1d,18,1,0,1,1,1,1,1,0,18,0,b,5,a,a,1", ",0,z,0,a,k,g,0,2t,7,1,9,1,3,x,0,1,0,u,q,2j,a,1m,a,4,0,2,0,o,n,17,2,18,0,7,1,5,8,15,1l,1j,0,1,0,4", ",7,4,0,3,6,a,1,d,0,f,0,1m,0,4,3,8,0,k,1,q,0,2,1,1l,0,4,1,4,1,2,2,3,0,u,1,3,0,b,1,1l,0,4,4,1,1,4,", "0,k,1,m,5,1,0,1m,0,2,0,1,3,8,0,7,1,b,1,u,0,1p,0,c,0,1e,0,3,0,1j,0,1,2,5,2,1,3,7,1,b,1,t,0,1m,0,2", ",0,6,0,5,1,k,1,s,1,1l,1,4,3,8,0,k,1,t,0,20,0,7,2,1,0,2i,0,2,6,b,8,2q,0,2,8,9,0,1,6,21,1,r,0,1,0,", "1,0,1j,d,1,4,1,1,5,a,1,z,9,0,2u,3,1,5,1,1,2,1,p,1,4,2,g,3,d,0,2,1,6,0,f,0,2m,0,gw,2,qa,2,t,1,u,1", ",u,1,1s,1,1,6,8,0,2,a,3,0,5,0,19,4,1f,0,1t,1,y,0,3a,2,4,1,9,0,6,2,63,1,2,0,1m,0,1,6,1,0,1,0,2,7,", "6,9,2,0,13,0,8,19,2,b,k,3,1c,0,1,4,1,0,5,0,14,8,c,1,w,3,2,1,1,2,1k,0,1,1,3,0,1,2,1m,7,2,1,1s,5,2", "a,2,1,c,1,6,4,0,6,0,3,1,1e,1q,d,0,y,2s,cd,0,1,2,b,2,d,2,d,2,d,1,c,4,8,1,a,0,2,0,2,4,1d,4,1,9,1,0", ",d,0,g,c,1f,w,2a3,1,35,2,3h,0,f,0,2o,v,1b,0,d1,0,10,3,3,4,5,0,2l,5,2l,2,lxy,0,yq,5,7i,0,2q,3,1,9", ",1,0,s,3,28,1,e,x,26,0,n,2,2u,3,3,1,8,0,3,0,4,0,p,1,5,0,47,1,q,h,d,0,12,7,p,a,1a,2,1c,0,2,3,2,1,", "h,0,l,1,1u,5,2,1,2,1,c,0,8,0,z,0,b,0,1f,0,1,2,2,1,5,1,1,0,r,0,e,1,5,1,1,0,2s,4,9,2,3d,0,2,0,4,0,", "fn4,0,43,g,fx,f,3,0,c,f,y,0,2,0,4p,0,7,0,6,0,b,0,z,0,1,0,1b,0,19,1,1v,0,l,2,e9,0,6a,0,45,4,sl,5,", "1,15,1,8,g6,2,1,1,5,3,14,2,4,0,4l,1,fx,3,12,0,q,4,1,0,8r,1,o,0,1g,5,1y,a,1d,3,3f,0,1i,e,15,0,2,1", ",a,2,1d,3,2,1,2,0,4,0,a,0,1e,2,10,4,1,7,1q,0,c,1,1g,8,a,3,2,0,2n,2,2,0,1,1,6,0,2,0,4d,0,3,7,l,1,", "1l,1,3,0,11,6,3,4,1y,5,d,0,1,0,1,0,e,1,2d,7,2,2,1,0,n,0,2c,5,1,0,4,1,1,1,6m,3,6,1,1,1,r,1,2d,7,2", ",0,1,1,2y,0,1,0,2,5,1,0,2t,0,1,0,2,3,1,4,77,8,1,1,74,1,1,0,4,0,40,3,2,1,4,0,w,9,14,5,2,3,8,0,9,5", ",2,2,1a,c,1,1,5i,0,1,2,1,0,5l,6,1,5,1,0,2a,l,2,6,1,1,1,1,3e,5,3,0,1,1,1,6,1,0,20,1,3,0,1,0,1t,0,", "7t,1,b,1,1g,4,5,0,1,0,n,0,445,g,6,e,8ug,b,3,2,1xc,4,1n,6,9,3,e4,2,14,1,de,0,1r,g,1s,1,1,1,d,1,cn", "0,3,1,6,1,1,2hq,1,1,3,3mk,19,2,m,f4,2,9,f,2,6,u,3,44,2,1iz,1i,4,1d,8,0,e,0,m,4,1,e,11s,6,1,g,2,6", ",1,1,1,4,5,1p,x,0,4g,d,a8,0,1p,3,e3,4,72,1,6r,0,2,0,7,1,5,0,9,0,cw,6,31,7,23z,4,gx6p,0,u,2n,3k,6", "n;1t,p,2i,0,a,m,1,7,w,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,2,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,1,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,1,1,0,1,0,1,0,1,1,1,0,1,1,1,2,", "2,3,1,1,1,2,3,1,1,1,1,0,1,0,1,1,1,0,2,0,1,1,1,2,1,0,1,1,3,0,7,1,1,1,1,1,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,2,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,2,1,1,0,1,2,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,7,1,1,1,2,0,1,3,1,0,", "1,0,1,0,1,0,6u,0,16,0,1,0,3,0,8,0,6,0,1,2,1,0,1,1,1,g,1,8,m,0,c,2,3,1,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,1,2,1,1,0,1,1,2,1e,1c,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,9,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,1,1,0,1,0,1,0,1,0,1,0,1,0,2,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,2,11,1c,0,26w,11,1,0,5,0,mi,5,1oi,9,6,16", ",2,2,8w,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,5,1,2,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,9,7,8,5,a,7,8,7,8,5,b,0,1,0,1,0,1,0,8,7,g,1b,2,2,2,5,5,2,2,5,b,3,c,4,5", ",2,2,5,89,0,3,1,6,0,19,f,j,0,mq,p,1f4,1b,1c,0,1,2,2,0,1,0,1,0,1,3,1,0,2,0,8,2,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,8,0,1,0,4,0,ny", "l,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,j,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,3r,0,1,0,1,0,1,0,1,0,1,0,1,0,3,0,1,0,1,0,1,0", ",1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0", ",1,0,1,0,1,0,a,0,1,0,1,1,1,0,1,0,1,0,1,0,4,0,1,0,2,0,1,0,3,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0", ",1,4,1,4,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,3,1,0,1,1,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,o,0,oq,27,fnk,6", ",c,4,sp,p,xx,13,3s,z,4c,a,1,e,1,6,1,1,1d6,1e,4d,l,27u,v,gw0,v,1s,o,o5j,x;1t,p,6,p,1m,0,a,m,1,u,1", ",1r,1,2b,1,r,2,d,2,1,1,0,4,2k,1,h,6,q,1,1,1,0,1,1,3,1,1,3,1,4,2,0,1,1,2,0,7,0,2,0,1,1,3,5,5,0,a,", "1,4m,0,16,3,2,1,3,2,1,0,6,0,1,2,1,0,1,j,1,1a,3,w,1,4,1,3o,8,4l,1,11,a,12,26w,11,1,0,5,0,2,16,2,2", ",io,2d,2,5,1oi,a,5,16,2,2,55,0,3,0,g,0,35,4b,2,0,1,39,2,5,2,11,2,5,2,7,1,0,1,0,1,0,1,u,2,1g,1,6,", "1,0,3,2,1,6,3,3,2,5,4,c,5,2,1,6,89,0,3,1,6,0,r,0,h,v,3,1,mp,1f,1ee,34,1,1,1,1,7,2t,7,3,3,1,c,11,", "1,0,5,0,nwy,19,i,r,3q,d,2,1p,9,e,3,2,2,4,1,o,1,18,o,1,nw,0,s,27,fnk,6,c,4,sp,p,6,p,x1,27,2o,z,4,", "z,38,a,1,e,1,6,1,1,1,a,1,e,1,6,1,1,1c3,1e,d,1e,2l,l,a,l,26y,1r,gv4,1r,w,o,2,o,o4s,1v;1t,p,1x,0,7", ",0,1,0,2,0,1,0,2,3,2,2,1,2,1,m,1,7,w,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1", ",0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,2,1,0,2,0,1,0,1,0,1,2,1,0,1,0,1,0,1,1,1,0,1,0,1,0,1,0,1", ",0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,1,1,0,1,0,1,0,1,1,1,0,1", ",1,1,2,2,3,1,1,1,2,3,1,1,1,1,0,1,0,1,1,1,0,2,0,1,1,1,2,1,0,1,1,3,0,7,9,1,0,1,0,1,0,1,0,1,0,1,0,1", ",0,2,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,2,3,1,2,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1", ",0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,7,1,1,1,2,0,1,3,1,0,1,0,1,0,1", ",0,2p,8,v,5,2,4,2j,1,1,2,9,0,w,0,1,0,1,0,1,0,3,0,3,1,4,6,1,0,1,1,1,g,1,8,m,0,c,7,1,0,1,0,1,0,1,0", ",1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,2,1,1,1,0,1,1,2,1e,1c,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1", ",0,1,0,1,0,1,0,1,0,1,0,1,0,9,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1", ",0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,1,1,0,1,0,1,0,1,0,1,0,1,0,2,0,1,0,1,0,1,0,1,0,1,0,1,0,1", ",0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1", ",0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,2,11,1c,0,44,0,2g,3,kf,7,3g,1", ",1,0,2b,0,2,0,y,2,2,0,71,1,k5,0,3j,0,14,1,1a,0,1i,0,9,0,4,0,4,0,4,0,c,0,9,0,1,4,7,0,h,0,9,0,4,0,", "4,0,4,0,c,0,6e,11,1,0,5,0,1a,0,2q,1,if,5,qe,1,2d,4,vk,9,6,16,2,2,30,2,1,a,1,h,1,r,d,0,y,10,1s,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,5,1,2,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,9,7,8,5,a,7,8,7,8,5,b,0,1,0,1,0,1,0,8,7,1,0,1,0,1,0,1,0,1,0,1,0,1,0,2,1b,2,2,2,d", ",2,8,3,0,4,3,1,2,3,0,4,7,2,2,2,7,1,f,1,0,5,0,c,2,3,5,3,1,1,1,4,0,1,0,8,2,d,0,7,i,2,q,1,c,b,0,2f,", "3,1,2,1,a,1,1,2,4,2,2,1,0,1,0,1,0,1,3,1,a,1,5,4,4,6,1b,3,0,5,0,4i,1,1,1,6w,1,8l,3u,10h,0,2v,2,2t", ",0,83,1b,1c,0,1,2,2,0,1,0,1,0,1,3,1,0,2,0,6,4,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,8,0,1,0,4,0,3g,0,8f,0,2b,0,c,5x,16,0,1h,0,1,2,", "2o,1,2,0,2n,0,1d,2l,3,d,2o,u,1,13,8,1a,1,an,mkg,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,j,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,1,3o,0,1,0,1,0,1,0,1,0,1,0,1,0,3,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1", ",0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,8,0,1,0,1,1,1,0,1,0,1,0,1,0,4", ",0,1,0,2,0,1,0,3,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,4,1,4,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,3,1", ",0,1,1,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,k,4,2,1,o2,3,9,0,6,27,f9c,7h,2,0,1,0,2,9,1,0,1,0,2,1,3,1v", ",2,2x,12,6,c,4,5,0,1,n,1,4,1,0,1,1,1,1,1,2z,x,a2,i,1r,2,1h,14,c,3,p,m,k,2,b,1,i,1,3,4,2,1,0,1,3q", ",2,0,1,59,3,5,2,5,2,5,2,2,3,6,1,6,1,8,sn,13,3s,z,4c,a,1,e,1,6,1,1,dn,4,1,15,1,8,xx,1e,4d,l,27u,v", ",gw0,v,1s,o,fdz,3,376,z,v8,6,e,7,1s,5,fz,2c,1,1y,1,1,2,0,2,1,2,3,1,b,1,0,1,6,1,1s,1,3,2,7,1,6,1,", "r,1,3,1,4,1,0,3,6,1,9f,2,83,2,1d,1m8,1p,1oy,x,ym,3,1,q,1,1,1,0,2,0,1,9,1,3,1,0,1,0,6,0,4,0,1,0,1", ",0,1,2,1,1,1,0,2,0,1,0,1,0,1,0,1,0,1,1,1,0,2,3,1,6,1,3,1,3,1,0,1,9,1,g,5,2,1,4,1,g,g4,a,5,u,1,v,", "q,2,z,0,33,2,d,17,4,8,7,1,1we,9,1ds6,f1,fheq,35r;1t,p,2t,m,1,6,x,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1", ",0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,2,0,1,0,1,0,1,0,1", ",0,1,0,1,0,1,0,2,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1", ",0,1,0,1,0,1,1,1,0,1,0,3,1,1,0,1,1,1,2,2,3,1,1,1,2,3,1,1,1,1,0,1,0,1,1,1,0,2,0,1,1,1,2,1,0,1,1,3", ",0,7,1,1,1,1,1,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,2,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,2,1,1,0,1,2,1", ",0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1", ",0,1,0,1,0,1,0,1,0,7,1,1,1,2,0,1,3,1,0,1,0,1,0,1,0,81,0,1,0,3,0,8,0,6,0,1,2,1,0,1,1,1,g,1,8,z,0,", "8,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,5,0,2,0,1,1,2,1e,1c,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,9,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,1,1,0,1,0,1,0,1,0,1,0,1,0,2,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,2,11,289,11,1,0,5,", "0,k2,2d,1oz,0,6,16,2,2,8w,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,9,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,9,7,8,5,a,7,8,7,8,5,b,0,1,0,1,0,1,0,8,7,o,7,8,7,8,7,8,4,", "b,4,b,3,c,4,b,4,89,0,3,1,6,0,19,f,j,0,mq,p,1f4,1b,1c,0,1,2,2,0,1,0,1,0,1,3,1,0,2,0,8,2,1,0,1,0,1", ",0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1", ",0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,8,0,1", ",0,4,0,nyl,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0", ",1,0,j,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,3r,0,1,0,1,0,1,0,1,0,1,0,1,0,3,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,a,0,1,0,1,1,1,0,1,0,1,0,1,0,4,0,1,0,2,0,1,0,3,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,4,1,4,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,3,1,0,1,1,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,o,0,h7", "v,p,xx,13,3s,z,4c,a,1,e,1,6,1,1,1d6,1e,4d,l,27u,v,gw0,v,1s,o,o5j,x;2p,p,1m,0,15,n,1,7,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,2,0,1,0,1,0,1,0,1,0,1,0,1,0,1,1,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,2,0,1,0,1,2,2,0,1,0,2,0,3,0,5,0,2,0,3,2,2,0,2,0,1,0,1,0,2,0,4,", "0,2,0,3,0,1,0,2,0,3,0,1,0,4,0,1,1,1,1,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,1,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,2,1,0,1,0,3,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,3,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,8,0,2,1,1,0,4,0,1,0,1,0,1,0,1,5,1,1,1,0,1,1,3,1,1,3,1,", "4,2,0,1,1,2,0,7,0,2,0,1,1,3,5,5,0,a,1,4m,0,17,0,1,0,3,0,3,2,i,0,r,y,1,1,3,2,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,4,1,0,2,0,2,0,1g,1b,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,9,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,2,0,1,0,1,0,1,0,1,0,1,0,1,1,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1d,12,2uo,5,1oi,8,1,0,6m,0,3,0,g,0,36,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,6,5,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,8,8,5,a,7,8,7,8,5,a,7,8,7,8,d,2,7,8,7,8,7,8,4,1,1,6,0,3,2,1,1,8,3,2,1,8,7,a,2,1,1,9i,0,x", ",f,4,0,nf,p,1fq,1b,1,0,3,1,1,0,1,0,1,0,6,0,2,0,a,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1", ",0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1", ",0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,8,0,1,0,4,0,c,11,1,0,5,0,nwz,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,j,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,3r,0,1,0,1,0,1,0,1,0,1,0,1,0,3,0,1,0,1,0,1,0,1,0,1,0,1,0,1", ",0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,a", ",0,1,0,2,0,1,0,1,0,1,0,1,0,4,0,4,0,1,1,2,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,b,0,1,0,1,0,1,0,1", ",0,1,0,1,0,1,0,4,0,1,0,2,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,q,0,nw,0,s,27,fnk,6,c,4,tl,p,y5,13,3s,z,4", "b,a,1,e,1,6,1,1,1dv,1e,3h,l,27u,v,gw0,v,1n,o,o5q,x;2p,p,1m,0,15,n,1,7,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,2,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,1,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,2,0,1,0,1,2,2,0,1,0,2,0,3,0,5,0,2,0,3,2,2,0,2,0,1,0,1,0,2,0,4,0,2,0,3,0,1,0,2,", "0,3,0,1,0,5,1,1,1,1,1,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,1,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,1,1,1,1,", "0,3,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,3,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,8,0,2,1,1,0,4,0,1,0,1,0,1,0,1,5,1,1,1,0,1,1,3,1,1,3,1,4,2,0,1,1,2,0,7,0,2,", "0,1,1,3,5,5,0,a,1,4m,0,17,0,1,0,3,0,3,2,i,0,r,y,1,1,3,2,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,4,1,0,2,0,2,0,1g,1b,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,9,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,2,0,1,0,1,0,1,0,1,0,1,0,1,1,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1d,12,288,16,2,2,l4,5,1oi,8,1,0,6m,0,3,0,g,0,36,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,6,", "5,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,8,", "8,5,a,7,8,7,8,5,a,7,8,7,8,d,2,1g,1,1,4,0,1,0,3,2,1,1,4,0,3,3,2,1,8,7,a,2,1,1,4,0,9d,0,x,f,4,0,nf", ",p,1fq,1b,1,0,3,1,1,0,1,0,1,0,6,0,2,0,a,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,8,0,1,0,4,0,c,11,1,0,5,0,nwz,0,1,0,1,0,1,0,1,0,1,0", ",1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,j,0,1,0,1,0,1,0,1,0,1,0,1,0", ",1,0,1,0,1,0,1,0,1,0,1,0,1,0,3r,0,1,0,1,0,1,0,1,0,1,0,1,0,3,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,a,0,1,0,2,", "0,1,0,1,0,1,0,1,0,4,0,4,0,1,1,2,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,b,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,4,0,1,0,2,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,q,0,nw,0,s,27,fnk,6,c,4,tl,p,y5,13,3s,z,4b,a,1,e,1", ",6,1,1,1dv,1e,3h,l,27u,v,gw0,v,1n,o,o5q,x;1t,p,6,p,1b,0,a,0,4,0,5,m,1,u,1,5e,1,3,4,5r,2,y,7,1,u,", "4,2o,0,16,3,2,1,2,3,1,0,6,0,1,2,1,0,1,j,1,2a,1,3u,8,4l,1,11,9,14,26v,11,1,0,5,0,2,16,1,3,io,2d,2", ",5,1oi,a,5,16,2,2,1s,5b,1s,7p,2,5,2,11,2,5,2,7,1,0,1,0,1,0,1,u,2,1g,1,6,1,0,3,2,1,6,3,3,2,5,4,c,", "5,2,1,6,38,0,d,0,g,c,2t,0,4,0,2,9,1,0,3,4,6,0,1,0,1,0,1,3,1,5,4,0,2,3,5,4,4,0,h,v,3,1,mp,1f,1ee,", "6c,6,3,3,1,c,11,1,0,5,0,nwy,19,i,t,3o,2t,3,3,1,24,k,5,1,2,mt,16,1,d,6,27,fnk,6,c,4,sp,p,6,p,x1,2", "7,2o,z,4,z,38,a,1,e,1,6,1,1,1,a,1,e,1,6,1,1,cj,0,2,2,1,15,1,8,xx,1e,d,1e,2l,l,a,l,26y,1r,gv4,1r,", "w,o,2,o,jzg,2c,1,1y,1,1,2,0,2,1,2,3,1,b,1,0,1,6,1,1s,1,3,2,7,1,6,1,r,1,3,1,4,1,0,3,6,1,9f,2,o,1,", "o,1,u,1,o,1,u,1,o,1,u,1,o,1,u,1,o,1,7,1f8,9,1,j,6,5,79,1p,1oy,1v,1kc,p,6,p,6,p;4t,0,ip,0,jw,0,28", "2,1,18z,1,2d,4,1kr,4,q,4,1d,f,3ck,0,14ez,f,6n,0,4g,0,27,8,119j,3,43z,7,h405,35r;19,0,124,0,1f,0,", "2td,0,sl,0,1l5,5,1p,0,13,0,f,0,au,0,2dg,0,2,0,v,1,4,0,s,0,ce,0,j,0,33,0,14ls,1,11,0,a,0,4p,0,2u8", ",0,8u,0;95,0,10p,0,1s3,0,1,0,1m1,1,1qd,5,jd,1,jh06,0;2m,0,1,0,1z,0,6,0,4,0,2,1,dz,4e,1,7,5,5,h,1", ",4,0,9,1,71,4,5t,0,1j,18,1,0,1,1,1,1,1,0,3n,7,4,1,3q,1,4,1,3,2,1v,q,2j,a,1m,a,y,1,3i,7,15,9,g,r,", "1p,0,g,0,3,3,s,0,22,0,g,0,32,0,g,0,32,0,g,0,1b,2,1o,0,g,0,7,0,3b,0,32,0,g,0,32,0,g,0,31,1,g,0,3g", ",0,33,0,c,5,1,0,2z,0,d,4,23,1,r,0,1,0,1,0,4,1,1u,2,1,1,1q,0,34,0,1,1,14,1,4,4,p,6,1,0,a,1,jl,2,q", "c,1,u,0,44,a,9,0,9n,2,84,0,k,7,2,0,1c,e,2,a,3,e,2,b,20,0,f,0,12,8,1i,1,1m,0,b,1,1u,1,1s,5,2a,o,4", ",0,6,0,2,2,1e,1q,1c,z,5,b,11,a,cd,0,1,2,b,2,d,2,d,2,d,1,2k0,2,8t,0,e2,5,2x,3,2n,0,n76,0,c,1,1,0,", "s,1,2a,1,e,x,2u,2,2u,0,6,1,c,0,11,0,47,0,r,h,1l,3,10,0,2n,0,c,0,10,0,45,2,1t,3,1f,0,2s,4,9,2,3k,", "1,fn4,0,ld,f,7i,0,1,0,1b,0,19,1,1v,0,l8,0,wv,5,1,15,1,8,hp,2,4,0,4l,1,fv,5,12,0,q,4,b0,0,2,2,1y,", "a,1d,3,5c,0,15,0,20,1,3c,1,1q,0,24,0,9,2,2w,1,4y,1,28,1,g,0,o,6,3,4,2h,2,1,1,d,1,2n,0,3,0,3f,1,6", "z,1,3i,0,3a,1,37,0,7h,1,76,1,4,0,4c,0,2b,0,i,0,29,0,bp,0,76,0,1,1,29,0,1t,0,9z,1,n,0,44s,e,8ux,0", ",1xc,4,1n,6,fo,1,f6,g,28,1,cn2,3,1,6,1,1,64h,19,2,m,f4,2,3,5,8,7,2,6,u,3,2v6,1p,5e,6,af,0,1p,3,l", "a,1,kg,6,31,2,1,2;z,0,6,0,5,9,33,0,4,0,68d,0,c,0,60,0,m,0,2i,5,f,1,a7,1,c,0,4m,0,p,a,4,2,5j,0,6f", ",1,a,0,9,0,1m,3,1,4,9,0,2,0,2,1,2,0,4,0,2,0,1,1,2,0,3,0,3,1,8,2,5,0,1,0,5,b,b,1,2,0,1,1,1,0,i,0,", "2,1,i,5,1,0,1,1,3,1,5,0,2,1,4,1,b,1,5,1,2,0,5,1,1,0,1,1,k,1,5,5,1,3,2,0,4,0,2,0,2,5,1,0,2,0,1,0,", "1,0,6,0,3,0,6,0,a,1,f,0,2,0,4,0,1,0,4,2,1,0,b,1,1c,2,9,0,e,0,e,0,ac,1,cv,2,j,1,1f,0,4,0,yi,0,c,0", ",gp,0,1,0,2fze,0,5m,0,4g,1,c,1,e,0,2,9,23,p,1,1,n,0,k,0,2,8,l,1,4u,x,2,33,2,1,1,2,2,2a,2,2,1,7a,", "1,1q,b,5,1,n,7,1,2,7,c,0,2,3,2,0,4,1,d,1,2,0,8,1,9,0,5,2,c,2,8,2,2,0,1,0,4,0,6,0,3,0,6,2d,1c,1x,", "5,7,2,3,3,9,3,0,1,1,3,0,2,9,6b,b,4,0,7v,1a,1,9,1,54,34,c,3,a,3,1k,1,0,4,f,2,b,4,9;z,0,6,0,5,9,6a", "b,0,5x,0,17or,0,1c5y,p,e3,4,14g,3,gw30,2n;2qrf,4;7j1,0,63,0,g,3,2iyf,0,1o,2,2,0,2,2,39,1,2,a,l,i", ",3,0,4,2,1,2,7,0,1,0,o,0,5l,1,4,0,l,0,4,1,4u,2,3,4,2b,0,g,2,9,0,b,0,fz,0,2,0,8,7,6,0,9,9,2,2,1k,", "0,1p,1,1,1,1,0,h,2,1,c,6d,2,16,8;6xm,1,5p,3,3,0,2,0,eh,1,l,1,1e,b,17,0,j,0,d,0,8,1,h,1,5,1,8,0,5", ",0,l,0,7,1,1,0,4,0,2,0,7,0,4,1,s,0,z,0,1,0,4,2,1,0,1p,2,o,0,e,0,nv,1,1f,0,4,0,2hf2,0,5m,0,5a,0,2", ",9,23,p,1,0,o,0,k,0,2,4,1,2,l,1,4u,w,c,8,1,1x,1,l,c,16,4,4,c,g,3,0,3,1y,1,0,1,56,2,1q,d,3,1,n,i,", "0,q,1,d,0,2e,2c,1c,1x,6,0,3,2,2,3,3,3,b,1,7,8,6b,b,4,0,7v,1a,1,9,1,54,34,c,3,a,3,1k,1,0,4,f,2,b,", "4,9;53,0,ew,1,oe,0,c9,0,hi,0,3t,0,2h,0,kw,0,3j,0,1tv,0,1k,0,gz,0,b2,0,1w,0,3ux,0,17,4,2v,1,2l,2,", "lxy,0,16e,0,qq,0,m,0,3t,0,30,0,l,1,gor,0,1lc,1,157,0,r,0,4,0,xz,0,85,0,38,1,du,2,y7,0,n4,0,fag,1", ",ws,1,1,0,e,1,mdk,1,xd,0,no,2;w,2m,x,c,1,gh,34,7,2,5,4,6,1,0,1,j,1,67,7,4l,1,11,2,1d,2,2,1a,0,1,", "0,2,0,2,0,9,q,4,5,h,9,b,0,1,19,l,f,1,2s,8,0,6,1,2,0,4,v,2,0,1,t,t,2g,b,0,e,16,9,6,3,n,4,0,9,0,3,", "0,7,e,1,o,5,0,1,a,5,v,g,15,1l,1i,1,0,1,3,8,3,1,2,7,9,2,s,1,1,1,7,2,1,2,l,1,6,1,0,3,3,3,0,1,1,6,1", ",2,1,1,0,d,1,1,2,4,n,5,0,1,5,4,1,2,l,1,6,1,1,1,1,1,1,4,2,o,3,1,0,7,9,2,2,1,0,c,0,1,8,1,2,1,l,1,6", ",1,1,1,4,3,3,8,0,1,1,3,0,f,1,4,b,7,0,8,1,1,7,2,1,2,l,1,6,1,1,1,4,3,0,2,0,6,1,2,1,f,1,1,2,4,h,b,0", ",1,5,3,2,1,3,3,1,1,0,1,1,3,1,3,2,3,b,5,0,1,1,3,2,1,2,3,0,l,k,6,2,1,7,1,2,1,m,1,f,3,0,3,3,j,2,1,1", ",2,1,4,9,7,9,1,a,1,2,1,m,1,9,1,4,3,1,2,0,1,1,n,2,1,1,4,9,1,2,e,a,1,2,1,14,2,0,1,1,5,2,1,2,1,1,4,", "2,1,9,4,p,2,1,1,h,3,n,1,8,1,0,2,6,9,1,6,6,7,9,2,2,c,1b,1,1,b,7,8,c,11,1,1,0,1,4,1,n,1,0,1,9,1,1,", "9,0,2,4,1,0,9,9,2,3,w,n,2,q,1,0,1,0,1,d,1,z,i,0,5,0,2,4,1d,7,1,5,1,c,11,18,4,0,6,0,2,1,2,o,2,3,3", ",f,4,c,1,1,2,5,1,e,1,13,1,0,5,0,2,ag,1,3,2,6,1,0,1,3,2,14,1,3,2,w,1,3,2,6,1,0,1,3,2,e,1,1k,1,3,2", ",1u,5,s,3,p,6,2d,2,5,2,ik,3,2g,7,h,d,i,3,1,9,h,e,c,1,2,f,1f,2,0,7,7,1,1,b,8,3,9,6,9,6,a,5,9,6,2g", ",7,4,2,x,1,0,5,1x,a,u,4,3,2,2,4,1,1,5,7,0,3,15,2,4,b,17,4,p,6,a,3,1k,2,1,3,1j,1,0,9,0,1,1,8,5,d,", "9,6,9,6,d,2e,1b,a,3,3,7,1,s,9,b,2,v,4,1,6,1j,1,0,2,2,1,0,d,1b,8,1,5,e,3,1p,5,16,2,a,b,0,d,0,7,3,", "1,5,1,2,2,0,5,5b,1s,7p,2,5,2,11,2,5,2,7,1,0,1,0,1,0,1,u,2,1g,1,e,1,d,2,5,1,i,2,2,1,8,1,a,5,n,7,1", "c,g,1,2,q,1,c,3,x,1q,3v,4,ih,m,a,l,1eb,2,ag,3,1,5,18,1,0,5,0,2,1j,7,1,f,m,9,6,1,6,1,6,1,6,1,6,1,", "6,1,6,1,6,x,2l,y,p,1,2g,c,5x,q,1l,6,f,1,2d,4,2s,5,16,1,2l,1,2d,9,1b,1,mlo,3,1i,9,9n,k,1a,4,0,a,v", ",2,27,2,5,8,64,k,g,1,2,1,3,1,o,2,4,4,9,6,1j,8,1v,a,b,o,c,1,11,8,o,b,0,c,t,6,1b,1,1,4,1,2,1,1,c,1", ",a,4,6,1,o,1,14,6,1,2,1,b,2,1,7,1,0,2,9,2,v,1,1e,1,0,3,1,2,4,2,0,1,0,o,g,2,7,b,5,2,5,2,5,9,6,1,6", ",1,1n,4,38,1,1,1,3,3,9,6,8mb,c,m,4,1c,6is,a5,2,2x,12,6,c,4,5,0,1,n,1,4,1,0,1,1,1,1,1,i1,w,f,g,9,", "m,y,1,i,1,3,4,4,1,3q,4,4c,2,u,3,5,2,5,2,5,2,2,3,6,1,6,d,1,2,b,1,p,1,i,1,1,1,e,2,d,y,3e,5,2,4,18,", "3,2f,1,c,3,0,1b,18,3n,s,3,1c,g,q,4,z,9,t,5,11,a,t,1,10,4,d,16,4d,2,9,6,z,4,z,4,13,8,1f,b,b,1,e,1", ",6,1,1,1,a,1,e,1,6,1,1,3,1f,c,8m,9,l,a,7,o,5,1,15,1,8,1x,5,2,0,1,17,1,1,3,0,2,m,1,1z,8,8,1c,i,1,", "1,5,w,3,q,5,q,12,1j,4,j,2,1a,f,3,1,2,1,s,a,8,7,8,7,1r,w,10,6,b,9,1h,3,s,2,q,5,p,7,3,c,6,28,20,1j", ",1e,d,1e,7,15,c,9,6,11,8,n,8,1,5s,u,1,15,3,0,2,1,g,5,8,8,13,13,8,l,b,8,m,h,4,3,12,r,k,m,9,0,1,1h", ",f,6,4,t,1,1,2,0,c,1c,4,1,2,1,1,3,e,o,7,9,9,z,5,0,9,h,8,y,1,2,b,1f,9,0,1,7,4,1,1,f,1,j,b,h,1,r,3", ",1,4,5,1,1,1r,6,1,0,1,3,1,e,1,a,6,1a,1,2,d,9,8,1,1,7,2,1,2,l,1,6,1,1,1,4,3,0,1,0,1,3,2,1,2,1,3,0", ",c,6,s,9,1,0,2,0,1,11,1,0,1,1,f,0,1,1,3,0,1,2,1,1,13,1j,8,1,3,0,1,k,1,0,1,2,u,1b,1,1,6,0,1,1,1,0", ",2,0,2,3,8,9,4m,1a,1,1,6,3,2,0,2,q,10,1e,8,1,1,0,2,3,b,9,6,c,j,16,1,0,1,1,8,1,6,9,6,j,s,q,3,0,1,", "1,4,0,9,m,55,1a,9,0,2,0,2s,2a,c,7,2,0,2,7,1,1,1,n,1,4,1,1,6,3,1,2,9,9,1y,7,2,15,8,3,1,3,r,0,a,13", ",6,1,4,7,9,0,6,1,3,19,d,0,2,8,d,20,7,9,2f,0,3,0,1,0,2g,x,e,9,6,8,1,11,e,0,1,5,a,s,3,v,p,0,7,0,2,", "0,23,6,1,1,1,11,l,0,9,9,6,5,1,1,1,10,4,1,1,0,1,0,7,9,6,17,4,9,6u,i,2,3,9,e,1,z,8,1,3,m,2e,0,f,1d", ",d,pm,2u,32,1,4,b,5f,218,2q,d,tr,h,5,p,32y,5,g6,5a1,t,c,2,3,9,1c6,fs,7,u,1,9,4,28,1,9,6,t,7,0,a,", "1b,7,e,a,9,1,6,1,k,5,i,c0,1l,5i,2i,5,o,2,o,18,22,5,1j,b,c,1s,3,e,4,9,5p1,15,v,2p,36,6pp,3,1,6,1,", "1,1,82,f,0,t,2,2,0,e,3,8,az,1s4,2y,5,c,3,8,7,9,2,0,2,0,31c,70,3,c3,6,m,f,g,2n,37,1o,6t,a,12,2,1n", ",5,2,m,1,7,t,4,1o,l,1t,3,0,3e,j,c,j,c,2e,9,o,3r,2c,1,1y,1,1,2,0,2,1,2,3,1,b,1,0,1,6,1,1s,1,3,2,7", ",1,6,1,r,1,3,1,4,1,0,3,6,1,9f,2,83,2,fl,1j,3,1e,7,1,d,1,6,vo,u,6,5,79,1p,42,18,a,6,2,9,4,1,8w,t,", "i,17,4,9,5,0,cw,r,4,9,5y,t,2,a,4,0,5c,u,1,2,1,1,1,6,2,4,9,1,68,6,1,3,1,1,1,e,1,5g,2,8,1c,1v,7,0,", "4,9,4,1,lt,1v,24,1o,5e,3,1,q,1,1,1,0,2,0,1,9,1,3,1,0,1,0,6,0,4,0,1,0,1,0,1,2,1,1,1,0,2,0,1,0,1,0", ",1,0,1,0,1,1,1,0,2,3,1,6,1,3,1,3,1,0,1,9,1,g,5,2,1,4,1,g,1g,1,7i,17,4,2r,c,e,2,e,1,e,1,10,a,4t,1", "k,s,d,17,4,8,7,1,e,5,4a,rc,3,g,3,c,3,61,6,b,4,0,f,b,4,1j,8,9,6,13,8,t,2,b,4,1,e,8,13,9j,8,d,2,c,", "3,a,3,1k,1,0,4,f,2,b,4,9,7,42,1,2u,sl,wyn,w,3dp,2,4gd,2,5rk,f,h9,1wi,f1,15u,3t6,5,6jt;lc,33,7n,6", ",7b,18,1,0,1,1,1,1,1,0,20,a,1c,k,g,0,2t,6,2,5,2,1,1,3,z,0,u,q,2j,a,1m,8,9,0,o,3,1,8,1,2,1,4,17,2", ",1n,8,16,n,1,v,1j,0,1,0,4,7,4,0,3,6,a,1,t,0,1m,0,1,0,2,3,8,0,9,0,a,1,q,0,2,1,1l,0,4,1,4,1,2,2,3,", "0,u,1,3,0,b,1,1l,0,4,4,1,1,4,0,k,1,m,5,1,0,1m,0,1,1,1,3,8,0,7,2,a,1,u,0,1n,0,1,0,c,0,9,0,14,0,3,", "0,1j,0,1,2,5,2,1,3,7,1,b,1,t,0,1m,0,2,1,1,0,3,2,1,3,7,1,b,1,s,1,1l,1,1,0,2,3,8,0,9,0,a,1,t,0,20,", "0,4,0,2,2,1,0,8,0,29,0,2,6,c,7,2q,0,2,8,b,6,21,1,r,0,1,0,1,0,1j,d,1,4,1,1,5,a,1,z,9,0,2u,3,1,5,1", ",1,2,1,p,1,4,2,g,3,d,0,2,1,6,0,f,0,jj,2,qa,3,s,2,t,1,u,1,1s,1,1,6,8,0,2,a,9,0,19,2,1,0,39,1,y,0,", "3a,2,4,1,9,0,6,2,63,1,2,0,1m,0,1,6,1,0,1,0,2,7,6,9,2,0,1c,19,2,b,k,3,1c,9,4,2,12,8,c,1,w,3,2,5,1", "k,0,1,1,3,0,1,4,1k,7,2,1,48,2,1,c,1,6,4,0,6,0,3,1,5i,1r,ek,0,5f,w,2da,2,3x,0,2o,v,fe,5,2x,1,n9w,", "3,1,9,w,1,28,1,7k,0,3,0,4,0,p,1,5,0,47,1,q,h,d,0,12,7,p,a,1,0,18,2,1c,0,2,3,2,1,2,0,10,0,1v,5,2,", "1,2,1,c,0,8,0,1b,0,1f,0,1,2,2,1,5,1,1,0,16,1,8,0,6m,0,2,0,4,0,fn4,0,kh,f,g,f,a6,1,gt,0,6a,0,45,4", ",1ae,2,1,1,5,3,14,2,4,0,4l,1,fx,3,1t,4,8t,1,25,5,1y,a,1d,3,3f,0,1i,e,15,0,2,1,a,2,1d,3,2,1,7,0,1", "p,2,10,4,1,7,1q,0,c,1,1g,8,1,0,8,3,2,0,2n,2,2,3,6,0,2,0,4d,0,3,7,l,1,1l,1,1,0,1,0,c,0,9,0,e,6,3,", "4,1v,0,2,5,1,0,2,0,1,2,4,2,1,0,e,1,2d,7,2,2,1,0,n,0,29,0,2,5,1,0,2,0,1,1,1,1,6j,0,2,3,6,1,1,1,r,", "1,2d,7,2,0,1,1,2y,0,1,0,2,7,2t,0,1,0,2,3,1,4,77,8,1,1,6t,0,a,3,4,0,40,3,2,1,4,0,w,9,14,5,2,3,8,0", ",9,5,2,2,1a,c,1,1,5i,0,1,2,1,0,5l,6,1,5,1,0,2a,l,2,6,1,1,1,1,3e,5,3,0,1,1,1,6,1,0,20,1,3,0,1,0,9", "n,1,b,1,1g,4,5,2,n,0,44l,0,6,e,8ug,b,3,2,1xc,4,1n,6,t4,0,1r,3,29,0,b,1,f57,1,3mp,19,2,m,f2,4,3,5", ",8,7,2,6,u,3,44,2,1iz,1i,4,1d,8,0,e,0,m,4,1,e,11s,6,1,g,2,6,1,1,1,4,2s,0,4g,6,af,0,1p,3,e4,3,72,", "1,6r,0,2,0,7,1,5,0,d6,6,31,6,gzbp,2n,3k,6n;1c,9,7,5,q,5,1eax,9,7,5,q,5;1c,9,7,p,4,0,1,p,1b,0,a,0", ",1,0,2,0,5,m,1,u,1,cp,4,b,e,4,7,0,1,0,h,38,1,1,2,3,1,0,6,4,1,0,1,j,1,2a,1,3u,1,4,2,4l,1,11,2,0,6", ",14,8,18,1,0,1,1,1,1,1,0,8,q,4,3,t,a,5,21,4,2t,1,7,2,9,1,i,2,0,g,1m,2,2s,e,1h,4,0,2,0,2,19,i,r,4", ",a,5,n,1,6,7,22,1,3k,2,9,1,i,1,7,2,1,2,l,1,6,1,0,3,3,2,8,2,1,2,3,8,0,4,1,1,4,2,b,a,0,1,0,2,2,1,5", ",4,1,2,l,1,6,1,1,1,1,1,1,2,0,1,4,4,1,2,2,3,0,7,3,1,0,7,f,b,2,1,8,1,2,1,l,1,6,1,1,1,4,2,9,1,2,1,2", ",2,0,f,3,2,9,9,6,1,2,1,7,2,1,2,l,1,6,1,1,1,4,2,8,2,1,2,2,7,2,4,1,1,4,2,9,1,0,g,1,1,5,3,2,1,3,3,1", ",1,0,1,1,3,1,3,2,3,b,4,4,3,2,1,3,2,0,6,0,e,9,g,c,1,2,1,m,1,f,2,8,1,2,1,3,7,1,1,2,1,1,2,3,2,9,g,3", ",1,7,1,2,1,m,1,9,1,4,2,8,1,2,1,3,7,1,5,2,1,3,2,9,1,2,c,c,1,2,1,1e,1,2,1,4,5,3,7,4,2,9,a,5,1,2,1,", "h,3,n,1,8,1,0,2,6,3,0,4,5,1,0,1,7,6,9,2,1,d,1l,5,e,1,9,13,1,1,0,1,4,1,n,1,0,1,m,2,4,1,0,1,6,1,9,", "2,3,w,0,n,1,6,9,b,0,1,0,1,0,4,9,1,z,4,j,1,h,1,z,9,0,1l,21,6,25,2,11,1,0,5,0,2,16,1,98,1,3,2,6,1,", "0,1,3,2,14,1,3,2,w,1,3,2,6,1,0,1,3,2,e,1,1k,1,3,2,1u,2,2,9,8,e,f,g,2d,2,5,3,h7,2,g,1,p,5,22,3,a,", "7,l,9,l,b,j,c,c,1,2,1,1,c,2b,3,0,4,1,2,9,x,2,1,a,6,2g,7,16,5,1x,a,u,1,b,4,b,a,13,2,4,b,17,4,p,6,", "a,11,r,4,1q,1,s,2,a,6,9,d,0,8,d,1,u,2,b,k,24,3,9,h,8,c,37,c,1j,8,9,3,1c,2,a,5,16,2,2,g,2,1,12,5,", "et,2,5,2,11,2,5,2,7,1,0,1,0,1,0,1,u,2,1g,1,6,1,0,3,2,1,6,3,3,2,5,4,c,5,2,1,6,f,1,1d,1,j,0,s,0,d,", "0,g,c,1f,c,4,0,3,b,h,0,4,0,2,9,1,0,2,5,6,0,1,0,1,0,1,f,2,3,5,4,4,0,h,14,22f,6c,6,8,c,11,1,0,5,0,", "2,1j,7,0,f,n,9,6,1,6,1,6,1,6,1,6,1,6,1,6,1,6,1,v,ed,2,p,e,1,4,2,4,4,2d,2,6,1,2m,5,16,1,2l,h,v,1c", ",f,e8,533,1s,h3g,1v,19,2,7g,3,r,k,1b,4,9,1,36,11,8,2,2u,2,29,k,1i,4,0,j,1f,c,1x,a,9,6,n,3,0,1,1c", ",2,z,c,s,3,1s,e,a,6,u,1,1i,9,d,2,9,6,m,3,20,o,2,2,f,2,4,a,5,2,5,2,5,9,6,1,6,1,16,1,d,6,3e,1,1,2,", "9,6,8mb,c,m,4,1c,6is,a5,2,2x,12,6,c,4,5,b,1,c,1,4,1,0,1,1,1,1,1,2z,x,a2,i,1r,2,1h,14,b,4,f,g,f,3", ",1,o,2,w,4,1,3q,j,9,7,p,4,0,1,p,a,2h,3,5,2,5,2,5,2,2,z,b,1,p,1,i,1,1,1,e,2,d,y,3e,1x,1g,3s,0,3m,", "s,3,1c,f,0,v,v,d,t,5,16,5,t,2,z,4,7,1,4,16,4d,2,9,6,z,4,z,4,13,8,1f,c,a,1,e,1,6,1,1,1,a,1,e,1,6,", "1,1,3,1f,c,8m,9,l,a,7,o,5,1,15,1,8,1x,5,2,0,1,17,1,1,3,0,2,m,a,m,9,u,1t,i,1,1,a,l,a,p,6,p,12,1j,", "6,1,1s,3,1,1,5,7,1,2,1,s,2,2,4,0,w,s,3,s,z,7,1,t,p,1h,a,l,a,i,d,h,32,20,1j,1e,d,1e,d,13,8,9,6,11", ",3,4,1,m,6y,15,1,1,3,1,g,5,1e,y,a,0,8,w,v,l,16,k,r,m,9,1y,v,f,9,1n,7,0,d,o,7,9,6,1g,1,9,4,3,8,z,", "2,0,9,1w,4,3,1,c,1,0,z,h,1,10,6,3,1q,6,1,0,1,3,1,e,1,9,7,1m,5,9,6,3,1,7,2,1,2,l,1,6,1,1,1,4,1,9,", "2,1,2,2,2,0,6,0,5,6,2,6,3,4,b,9,1,0,2,0,1,11,1,9,1,0,2,0,1,3,1,7,d,1,t,22,5,9,4,3,u,1x,1,0,8,9,4", "m,1h,2,8,n,5,y,1s,3,0,b,9,12,1k,7,9,6,j,s,q,2,e,4,9,6,6,55,1m,2t,21,l,7,2,0,2,7,1,1,1,t,1,1,2,8,", "c,9,1y,7,2,19,2,7,1,1,r,1q,8,0,8,21,3,0,i,20,2v,7,2g,w,f,9,6,8,1,18,1,8,f,9,o,t,2,l,1,d,21,6,1,1", ",1,17,3,0,1,1,1,8,8,9,6,5,1,1,1,10,1,1,1,5,7,9,6,17,4,9,6u,m,9,g,1,14,3,4,d,a,2d,0,27,pl,2u,32,h", ",5f,218,2o,f,tr,g,l,a,32y,5,g6,5a1,1l,1c6,fs,7,u,1,9,6,26,1,9,6,t,2,4,b,1i,9,3,c,9,9,k,5,i,c0,18", ",3,9,5i,1r,w,o,2,o,18,22,4,1k,7,g,1s,1,1,1,b,6,9,5p1,15,v,2p,36,6pp,3,1,6,1,1,1,82,f,0,t,2,2,0,e", ",3,8,az,1s4,2y,5,c,3,8,7,9,3,1,381,9,ee,19,2,m,f2,4,3,5,8,7,2,6,u,3,44,2,cb,2c,1,1y,1,1,2,0,2,1,", "2,3,1,b,1,0,1,6,1,1s,1,3,2,7,1,6,1,r,1,3,1,4,1,0,3,6,1,9f,2,o,1,o,1,u,1,o,1,u,1,o,1,u,1,o,1,u,1,", "o,1,7,2,1d,e8,1i,4,1d,8,0,e,0,m,4,1,e,uo,u,6,5,5x,6,1,g,2,6,1,1,1,4,5,1p,x,0,34,18,3,d,2,9,4,0,8", "x,u,h,1l,d2,15,5y,16,5h,u,1,l,8,1,68,6,1,3,1,1,1,e,1,5g,b,6,15,23,4,9,x2,3,1,q,1,1,1,0,2,0,1,9,1", ",3,1,0,1,0,6,0,4,0,1,0,1,0,1,2,1,1,1,0,2,0,1,0,1,0,1,0,1,0,1,1,1,0,2,3,1,6,1,3,1,3,1,0,1,9,1,g,5", ",2,1,4,1,g,2lw,9,sm,wyn,w,3dp,2,4gd,2,5rk,f,h9,1wi,f1,15u,3t6,5,6jt,f62u,6n;1t,p,6,p,1b,0,a,0,4,", "0,5,m,1,u,1,cp,4,b,e,4,7,0,1,0,3l,4,1,1,2,3,1,0,6,0,1,2,1,0,1,j,1,2a,1,3u,8,4l,1,11,2,0,6,14,1z,", "q,4,3,19,16,z,1,1,2q,1,0,f,1,7,1,a,2,2,0,g,0,1,t,t,2g,b,0,o,w,9,1,4,0,5,l,4,0,9,0,3,0,n,o,7,a,5,", "n,1,6,g,15,1m,1h,3,0,i,0,7,9,f,f,4,7,2,1,2,l,1,6,1,0,3,3,3,0,g,0,d,1,1,2,e,1,a,0,8,5,4,1,2,l,1,6", ",1,1,1,1,1,1,v,3,1,0,j,2,g,8,1,2,1,l,1,6,1,1,1,4,3,0,i,0,f,1,n,0,b,7,2,1,2,l,1,6,1,1,1,4,3,0,u,1", ",1,2,f,0,h,0,1,5,3,2,1,3,3,1,1,0,1,1,3,1,3,2,3,b,m,0,1g,7,1,2,1,m,1,f,3,0,q,2,1,1,2,1,u,0,4,7,1,", "2,1,m,1,9,1,4,3,0,u,2,1,1,f,1,h,8,1,2,1,14,2,0,g,0,5,2,8,2,o,5,5,h,3,n,1,8,1,0,2,6,1m,1b,1,1,c,6", ",1m,1,1,0,1,4,1,n,1,0,1,9,1,1,9,0,2,4,1,0,l,3,w,0,1r,7,1,z,r,4,37,16,k,0,g,5,4,3,3,0,3,1,7,2,4,c", ",c,0,h,11,1,0,5,0,2,16,1,98,1,3,2,6,1,0,1,3,2,14,1,3,2,w,1,3,2,6,1,0,1,3,2,e,1,1k,1,3,2,1u,11,f,", "g,2d,2,5,3,h7,2,g,1,p,5,22,3,a,7,h,d,i,e,h,e,c,1,2,f,1f,z,0,4,0,1v,2g,7,14,1,0,5,1x,a,u,1d,t,2,4", ",b,17,4,p,1i,m,9,1g,2a,0,2l,1a,h,7,1i,t,d,1,a,17,q,z,15,2,a,z,2,a,5,16,2,2,15,3,1,5,1,1,3,0,5,5b", ",1s,7p,2,5,2,11,2,5,2,7,1,0,1,0,1,0,1,u,2,1g,1,6,1,0,3,2,1,6,3,3,2,5,4,c,5,2,1,6,38,0,d,0,g,c,2t", ",0,4,0,2,9,1,0,2,5,6,0,1,0,1,0,1,f,2,3,5,4,4,0,h,14,22f,6c,6,3,3,1,c,11,1,0,5,0,2,1j,7,0,g,m,9,6", ",1,6,1,6,1,6,1,6,1,6,1,6,1,6,fa,2,p,8,7,4,2,4,4,2d,4,4,1,2h,1,3,5,16,1,2l,h,v,1c,f,e8,533,1s,h3g", ",1v,19,2,7g,3,f,a,1,k,1a,g,u,2,27,13,8,2,2u,2,29,k,g,1,2,1,3,1,m,t,1f,e,1d,1q,5,3,0,1,1,b,r,a,m,", "p,s,7,1a,s,0,g,4,1,9,a,4,1,14,n,2,1,7,k,m,3,0,3,1d,1,0,3,1,2,4,2,0,1,0,o,2,2,a,7,2,c,5,2,5,2,5,9", ",6,1,6,1,16,1,d,6,36,t,8mb,c,m,4,1c,6is,a5,2,2x,12,6,c,4,5,0,1,9,1,c,1,4,1,0,1,1,1,1,1,2z,x,a2,i", ",1r,2,1h,14,b,38,4,1,3q,10,p,6,p,b,2g,3,5,2,5,2,5,2,2,z,b,1,p,1,i,1,1,1,e,2,d,y,3e,1x,1g,7f,s,3,", "1c,1b,v,d,t,5,11,a,t,2,z,4,7,1,4,16,4d,i,z,4,z,4,13,8,1f,c,a,1,e,1,6,1,1,1,a,1,e,1,6,1,1,3,1f,c,", "8m,9,l,a,7,o,5,1,15,1,8,1x,5,2,0,1,17,1,1,3,0,2,m,a,m,9,u,1t,i,1,1,a,l,a,p,6,p,12,1j,6,1,1s,0,f,", "3,1,2,1,s,16,s,3,s,z,7,1,r,r,1h,a,l,a,i,d,h,32,20,1j,1e,d,1e,d,z,12,r,9,m,6y,15,6,1,g,5,1k,s,a,0", ",8,l,16,h,1a,k,r,m,c,1g,1l,1,2,0,d,18,w,o,q,z,t,0,2,0,8,y,3,0,c,1b,e,3,l,0,1,0,z,h,1,o,j,1,1r,6,", "1,0,1,3,1,e,1,9,7,1a,12,7,2,1,2,l,1,6,1,1,1,4,3,0,i,0,c,4,u,9,1,0,2,0,1,11,1,0,p,0,1,0,18,1g,i,3", ",k,2,u,1b,k,1,1,0,54,1a,15,3,10,1b,k,0,1n,16,d,0,1z,q,11,6,55,17,38,1r,v,7,2,0,2,7,1,1,1,n,f,0,1", ",0,2m,7,2,12,g,0,1,0,s,0,a,13,7,0,l,0,b,19,j,0,i,20,5j,w,v,8,1,10,h,0,1d,t,34,6,1,1,1,11,l,0,p,5", ",1,1,1,v,e,0,n,17,78,i,f,0,1,c,1,x,3g,0,27,pl,2u,32,h,5f,218,2o,f,tr,h,5,p,32y,5,g6,5a1,t,1cy,fs", ",7,u,h,26,h,t,i,1b,g,3,v,k,5,i,c0,18,5v,1r,w,o,2,o,18,22,5,0,1u,c,1s,1,1,0,e,4,9,5p1,15,v,2p,36,", "6pp,3,1,6,1,1,1,82,f,0,t,2,2,0,e,3,8,az,1s4,2y,5,c,3,8,7,9,4me,2c,1,1y,1,1,2,0,2,1,2,3,1,b,1,0,1", ",6,1,1s,1,3,2,7,1,6,1,r,1,3,1,4,1,0,3,6,1,9f,2,o,1,o,1,u,1,o,1,u,1,o,1,u,1,o,1,u,1,o,1,7,1f8,u,6", ",5,79,1p,42,18,a,6,g,0,8x,t,i,17,dg,r,6c,t,2,0,5r,u,1,2,1,1,1,6,2,4,9,1,68,6,1,3,1,1,1,e,1,5g,1n", ",1v,7,0,xg,3,1,q,1,1,1,0,2,0,1,9,1,3,1,0,1,0,6,0,4,0,1,0,1,0,1,2,1,1,1,0,2,0,1,0,1,0,1,0,1,0,1,1", ",1,0,2,3,1,6,1,3,1,3,1,0,1,9,1,g,5,2,1,4,1,g,3es,wyn,w,3dp,2,4gd,2,5rk,f,h9,1wi,f1,15u,3t6,5,6jt", ";9gw,1,2,9,dt,0;9gy,1;9hi,1,p,8,e,2,qt,533,1s,g73,hkw,a5,2,2x,n4a,0,d,4,9,5p1,15,v,2p,36,70d,az,", "f7o,wyn,w,3dp,2,4gd,2,5rk,f,h9,1wi,f1,15u,3t6,5,6jt;6bw,1;2tc,4,3f,4,25s,2,2,0,smy,1,2,0,1,1;2p,", "p,1b,0,a,0,4,0,10,n,1,7,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,1,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,1,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,2,0,1,0,1,2,2,0,1,0,2,0,3,1,", "4,0,2,0,3,2,2,0,2,0,1,0,1,0,2,0,1,1,1,0,2,0,3,0,1,0,2,1,2,2,6,0,2,0,2,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,1,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,1,2,0,1,0,3,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,6,2,0,2,1,1,0,4,0,1,0,", "1,0,1,0,1,1w,2,y,7,1,u,4,2o,0,17,0,1,0,3,0,2,3,i,0,r,y,1,1,3,2,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1", ",0,1,0,1,0,1,4,1,0,2,0,2,1,1f,1b,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0", ",1,0,9,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0", ",1,0,1,0,1,0,1,0,2,0,1,0,1,0,1,0,1,0,1,0,1,1,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0", ",1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0", ",1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1c,14,287,16,1,3,l4,5,1oi,8,1,0,39,5b,1t,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,8,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,8,8,5,a,7,8,7,8,5,a,7,8,7,8,d,2,7,8,7,8,7,8,4,1,1,6,0,3,2,1,1,8,3,2,1,8,7,a,2,1,1,3d,0,d,0,g,c", ",31,0,3,1,3,0,r,0,4,0,4,0,2,1,8,3,4,0,x,f,4,0,nf,p,1fq,1b,1,0,3,1,1,0,1,0,1,0,4,0,1,1,1,7,3,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "1,7,0,1,0,4,0,c,11,1,0,5,0,nwz,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0", ",1,0,1,0,1,0,1,0,1,0,1,0,j,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,2,3p,0,1,0,1,0,1,", "0,1,0,1,0,1,2,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,9,1,0,1,0,2,0,1,0,1,0,1,0,1,0,4,0,1,0,2,0,1,2,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,5,0,5,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,4,0,1,0,2,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,l,3,1,0,1,2,mt,16,1,d,6,27,fnk,6,c,4,tl,p,y5,13,3s,z,4b,a,1,e,1,6,1,1,cj,0,2,2,1,15,1,", "8,zp,1e,3h,l,27u,v,gw0,v,1n,o,k06,p,q,6,1,h,q,p,q,3,1,0,1,6,1,a,q,p,q,p,q,p,q,p,q,p,q,p,q,p,q,p,", "q,r,s,o,1,5,q,o,1,5,q,o,1,5,q,o,1,5,q,o,1,5,1,0,1f8,9,1,j,6,5,79,1p,1pw,x;17,0,g,2,v,0,t,0,1,0,1", "9,0,4,0,11,0,v,0,k8,2,2,0,q,1,2,2,en,2,559,0,r,2,b,0,3,0,d,0,e,3,l,4,b,4,1t,c,4,0,3,1,4,4,i,0,4,", "0,2,9,1,0,2,5,6,0,3,1,2,1,1,2,1,5,3,d,1,0,1w,n,1,5,1,1,4,1,4,v,1,0,6,1,e,7f,8,3,k,1,2i,0,u,q,1,0", ",o,0,b,6,cd,1,c,9,4,5,4,1,2,1,3,4,e,0,1,0,2,5,b,7,5,1,1l,0,1,0,t,3,9,2,9c,1r,74,e7,1c,k,2,5,1524", ",0,mv,5,1,0,4i,0,g,2,t,0,1,0,t,0,1,0,3n,0,6,3,2ox,1,1274,0,zz,2c,1,1y,1,1,2,0,2,1,2,3,1,b,1,0,1,", "6,1,1s,1,3,2,7,1,6,1,r,1,3,1,4,1,0,3,6,1,9f,2,83,2,1d,4cg,3,1,q,1,1,1,0,2,0,1,9,1,3,1,0,1,0,6,0,", "4,0,1,0,1,0,1,2,1,1,1,0,2,0,1,0,1,0,1,0,1,0,1,1,1,0,2,3,1,6,1,3,1,3,1,0,1,9,1,g,5,2,1,4,1,g,1g,1", ",1y6,8;1e4w,v,em,1,1eke,1,1eke,1,1eke,1,1eke,1,1eke,1,1eke,1,1eke,1,1eke,1,1eke,1,1eke,1,1eke,1,", "1eke,1,1eke,1,1eke,1,1eke,1,1eke,1;x,e,a,6,q,3,1,0,q,3,y,6,1,0,1,1,1,0,1,1,4,0,4,0,3,0,n,0,v,0,6", "54,n,8,e,2,i,1,9,8h,jz,4g,hh,u,vf,e8,3j,ap,2,4,o,f,0,14i5,1,79,1;9,4,i,0,2s,0,688,1,o,1;y,0,4,0,", "3n,0,f,0,670,7,p,1,2rr,0,cp,3,d,2,14pt,3,59,0,4,0,2i,1;2qcm,p;96o,p,1,2g,c,5x;2x,1,5g,0,7t,0,u,0", ",1g,0,k,0,8w,0,2q,0,1,0,4y1,0,1f,0,d,0,3,0,3o,0,4d,0,bp,0,5y,1,27m,0,2bol,1,1e,1,1e,1,1e,1,1e,1,", "1e,1,1e,1,1e,1,1e,1,1e,1,1e,1,1e,1,1e,1,1om,0,8h,1,q,0;x,0,c,0,g,0,11l,0,43,2,50,0,17,2,6u,0,1p,", "0,1,0,3,1,85,1,1d0,1,ly,0,4,1,lh,0,5i,1,4d,1,19,0,5,0,8q,1,9u,3,4i,1,a,1,2,1,t,2,57,1,1t,1,pw,0,", "n,1,9,2,2i7,2,8i,0,d,0,m,1,bx,0,n3w,0,7i,1,6b,0,3,0,am,1,2e,1,2n,0,48,1,43,2,40,1,6x,0,g86,0,2,1", ",1n,0,3,1,4p,0,c,0,g,0,1t,0,25w,1,zh,4,18,3,59,1,39,3,3j,2,3l,1,6,0,g,1,2g,1,1,1,30,0,8a,1,39,1,", "ad,1,5,e,2x,1,6x,2,ed,0,1,0,6z,1,2f,1,bo,1,j8,1,22,1,euh,1,3p,0,1t,1,b,0,fd,1,88,0,feu,0,5wo,0;x", ",0,a,0,1,0,b,1,3,0,n2,0,8,0,e9,0,1l,0,20,0,e,0,1,2,50,0,17,a,1,0,6j,1,1i,5,1,7,v,0,79,1,z8,1,4s,", "0,4,5,8n,1,lx,7,lh,0,3g,2,1z,1,4d,2,3,0,13,3,2,1,8q,1,9u,3,4i,1,a,1,1,2,t,2,57,4,1q,1,pw,0,n,1,9", ",2,2i7,2,8i,0,d,0,4,0,a,0,1,1,3,1,bw,1,n3v,1,7h,2,6b,4,am,1,2e,1,2n,0,47,2,43,2,3j,0,g,1,6x,0,g8", "6,0,2,1,1l,2,1,3,4p,0,a,0,1,0,b,1,3,0,1t,0,2,0,u2,0,1c,0,w6,0,5j,0,8m,1,48,5,1w,5,2h,3,qg,4,18,3", ",59,6,34,3,3j,2,3l,1,6,0,g,1,2g,4,30,0,8a,1,39,2,c,1,9y,3,3,e,2x,1,6x,2,ed,0,1,0,6z,1,2f,1,4,1,b", "i,2,19,0,hx,1,22,1,10r,4,dtl,1,3p,0,1t,2,a,0,fd,1,87,1,feu,0,5wn,3;a9s,533,1s,g73,hse,1,1,0,1,1,", "a,0,1,0,1,1,2,2,1fpy,wyn,w,3dp,2,4gd,2,5rk,f,h9,3he,3t6,5,6jt;1t,p,2t,m,1,6,x,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,2,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,2,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,1,1,0,1,0,3,1,1,0,1,1,1,2,2,3,1,1,1,2,3,1,1,1,1,0,1,0,1,1,1,0,2,0,1,1,", "1,2,1,0,1,1,3,0,7,0,2,0,2,0,2,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,2,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "2,0,2,0,1,2,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,7,1,1,1,2,0,1,3,1,0,1,0,1,0,1,0,81,0,1,0,3,0,8,0,6,0,1,2,1,0,1,1", ",1,g,1,8,z,0,2,2,3,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,5,0,2,0,1,1,2,1e,1c,0,1,0,1,0,1", ",0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,9,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1", ",0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,1,1,0,1,0,1,0,1,0,1,0,1,0,2", ",0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1", ",0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,2", ",11,289,11,1,0,5,0,k2,2d,1oz,0,6,16,2,2,8w,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0", ",1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0", ",1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0", ",1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,9,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0", ",1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0", ",1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,9,7,8,5,a,7,8,7,8,5,b,0,1,0,1,0,1,0,8,7", ",20,3,c,3,c,3,c,4,b,3,7a,0,4,0,3,2,2,2,2,0,3,4,6,0,1,0,1,0,1,3,2,3,a,1,5,0,q,f,j,0,mq,p,1f4,1b,1", "c,0,1,2,2,0,1,0,1,0,1,3,1,0,2,0,8,2,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,8,0,1,0,4,0,nyl,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,j,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,3r,0,1,0,1,0,1,0,1,0,1,0,1,0,3,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1", ",0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,a,0,1,0,1,1,1,0,1,0,1,0,1,0,4", ",0,1,0,2,0,1,0,3,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,4,1,4,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,3,1", ",0,1,1,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,o,0,h7v,p,xx,13,3s,z,4c,a,1,e,1,6,1,1,1d6,1e,4d,l,27u,v,g", "w0,v,1s,o,k07,p,q,p,q,p,q,0,1,1,2,0,2,1,2,3,1,7,q,p,q,1,1,3,2,7,1,6,r,1,1,3,1,4,1,0,3,6,r,p,q,p,", "q,p,q,p,q,p,q,p,u,o,x,o,x,o,x,o,x,o,x,0,3ed,x,1la,p,6,p,6,p;4qz,2,1,0,19f4,f,i9yo,6n;9,4,i,0,2s,", "0,q,0,4bj,0,1vj,a,t,1,5,0,1b,0,334,0;1c,9,7,p,4,0,1,p,1b,0,a,0,1,0,2,0,5,m,1,u,1,cp,4,b,e,4,7,0,", "1,0,h,38,1,1,3,2,1,0,6,4,1,0,1,j,1,2a,1,3u,1,4,2,4l,1,11,2,0,6,14,8,18,1,0,1,1,1,1,1,0,8,q,4,3,t", ",a,5,21,4,2t,1,7,2,9,1,i,2,0,g,1m,2,2s,e,1h,4,0,2,0,2,19,i,r,4,a,5,n,1,6,7,22,1,3k,2,9,1,i,1,7,2", ",1,2,l,1,6,1,0,3,3,2,8,2,1,2,3,8,0,4,1,1,4,2,b,a,0,1,0,2,2,1,5,4,1,2,l,1,6,1,1,1,1,1,1,2,0,1,4,4", ",1,2,2,3,0,7,3,1,0,7,f,b,2,1,8,1,2,1,l,1,6,1,1,1,4,2,9,1,2,1,2,2,0,f,3,2,9,9,6,1,2,1,7,2,1,2,l,1", ",6,1,1,1,4,2,8,2,1,2,2,7,2,4,1,1,4,2,9,1,0,g,1,1,5,3,2,1,3,3,1,1,0,1,1,3,1,3,2,3,b,4,4,3,2,1,3,2", ",0,6,0,e,9,g,c,1,2,1,m,1,f,2,8,1,2,1,3,7,1,1,2,1,1,2,3,2,9,g,3,1,7,1,2,1,m,1,9,1,4,2,8,1,2,1,3,7", ",1,5,2,1,3,2,9,1,2,c,c,1,2,1,1e,1,2,1,4,5,3,7,4,2,9,a,5,1,2,1,h,3,n,1,8,1,0,2,6,3,0,4,5,1,0,1,7,", "6,9,2,1,d,1l,5,e,1,9,13,1,1,0,1,4,1,n,1,0,1,m,2,4,1,0,1,6,1,9,2,3,w,0,n,1,6,9,b,0,1,0,1,0,4,9,1,", "z,4,j,1,h,1,z,9,0,1l,21,6,25,2,11,1,0,5,0,2,16,1,98,1,3,2,6,1,0,1,3,2,14,1,3,2,w,1,3,2,6,1,0,1,3", ",2,e,1,1k,1,3,2,1u,2,2,9,8,e,f,g,2d,2,5,3,h7,2,g,1,p,5,22,3,a,7,l,9,l,b,j,c,c,1,2,1,1,c,2b,3,0,4", ",1,2,9,x,2,1,a,6,2g,7,16,5,1x,a,u,1,b,4,b,a,13,2,4,b,17,4,p,6,a,11,r,4,1q,1,s,2,a,6,9,d,0,8,d,1,", "u,2,b,k,24,3,9,h,8,c,37,c,1j,8,9,3,1c,2,a,5,16,2,2,g,2,1,12,5,et,2,5,2,11,2,5,2,7,1,0,1,0,1,0,1,", "u,2,1g,1,6,1,0,3,2,1,6,3,3,2,5,4,c,5,2,1,6,f,1,1d,1,j,0,s,0,d,0,g,c,1f,c,4,0,3,b,h,0,4,0,2,9,1,0", ",2,5,6,0,1,0,1,0,1,f,2,3,5,4,4,0,h,14,22f,6c,6,8,c,11,1,0,5,0,2,1j,7,0,f,n,9,6,1,6,1,6,1,6,1,6,1", ",6,1,6,1,6,1,v,ed,2,p,e,1,4,2,4,4,2d,2,1,2,2,1,2m,5,16,1,2l,h,v,1c,f,e8,533,1s,h3g,1v,19,2,7g,3,", "r,k,1b,4,9,1,36,11,8,2,2u,2,29,k,1i,4,0,j,1f,c,1x,a,9,6,n,3,0,1,1c,2,z,c,s,3,1s,e,a,6,u,1,1i,9,d", ",2,9,6,m,3,20,o,2,2,f,2,4,a,5,2,5,2,5,9,6,1,6,1,16,1,d,6,3e,1,1,2,9,6,8mb,c,m,4,1c,6is,a5,2,2x,1", "2,6,c,4,5,b,1,c,1,4,1,0,1,1,1,1,1,2z,x,3u,6,61,i,1r,2,1h,14,9,6,f,g,f,3,1,o,2,x,0,1,0,3,0,1,0,1,", "0,1,0,1,3h,j,9,7,p,4,0,1,p,a,2h,3,5,2,5,2,5,2,2,z,b,1,p,1,i,1,1,1,e,2,d,y,3e,1x,1g,3s,0,3m,s,3,1", "c,f,0,v,v,d,t,5,16,5,t,2,z,4,7,1,4,16,4d,2,9,6,z,4,z,4,13,8,1f,c,a,1,e,1,6,1,1,1,a,1,e,1,6,1,1,3", ",1f,c,8m,9,l,a,7,o,5,1,15,1,8,1x,5,2,0,1,17,1,1,3,0,2,m,a,m,9,u,1t,i,1,1,a,l,a,p,6,p,12,1j,6,1,1", "s,3,1,1,5,7,1,2,1,s,2,2,4,0,w,s,3,s,z,7,1,t,p,1h,a,l,a,i,d,h,32,20,1j,1e,d,1e,d,13,8,9,6,11,3,4,", "1,m,6y,15,1,1,3,1,g,5,1e,y,a,0,8,w,v,l,16,k,r,m,9,1y,v,f,9,1n,7,0,d,o,7,9,6,1g,1,9,4,3,8,z,2,0,9", ",1w,4,3,1,c,1,0,z,h,1,10,6,3,1q,6,1,0,1,3,1,e,1,9,7,1m,5,9,6,3,1,7,2,1,2,l,1,6,1,1,1,4,1,9,2,1,2", ",2,2,0,6,0,5,6,2,6,3,4,b,9,1,0,2,0,1,11,1,9,1,0,2,0,1,3,1,7,d,1,t,22,5,9,4,3,u,1x,1,0,8,9,4m,1h,", "2,8,n,5,y,1s,3,0,b,9,12,1k,7,9,6,j,s,q,2,e,4,9,6,6,55,1m,2t,21,l,7,2,0,2,7,1,1,1,t,1,1,2,8,c,9,1", "y,7,2,19,2,7,1,1,r,1q,8,0,8,21,3,0,i,20,2v,7,2g,w,f,9,6,8,1,18,1,8,f,9,o,t,2,l,1,d,21,6,1,1,1,17", ",3,0,1,1,1,8,8,9,6,5,1,1,1,10,1,1,1,5,7,9,6,17,4,9,6u,m,9,g,1,14,3,4,d,a,2d,0,27,pl,2u,32,h,5f,2", "18,2o,f,tr,g,l,a,32y,5,g6,5a1,1l,1c6,fs,7,u,1,9,6,26,1,9,6,t,2,4,b,1i,9,3,c,9,9,k,5,i,c0,18,3,9,", "5i,1r,w,o,2,o,18,22,4,1k,7,g,1s,1,1,1,b,6,9,5p1,15,v,2p,36,6pp,3,1,6,1,1,1,82,f,0,t,2,2,0,e,3,8,", "az,1s4,2y,5,c,3,8,7,9,3,1,381,9,ee,19,2,m,f2,4,3,5,8,7,2,6,u,3,44,2,cb,2c,1,1y,1,1,2,0,2,1,2,3,1", ",b,1,0,1,6,1,1s,1,3,2,7,1,6,1,r,1,3,1,4,1,0,3,6,1,9f,2,o,1,o,1,u,1,o,1,u,1,o,1,u,1,o,1,u,1,o,1,7", ",2,1d,e8,1i,4,1d,8,0,e,0,m,4,1,e,uo,u,6,5,5x,6,1,g,2,6,1,1,1,4,5,1p,x,0,34,18,3,d,2,9,4,0,8x,u,h", ",1l,d2,15,5y,16,5h,u,1,l,8,1,68,6,1,3,1,1,1,e,1,5g,b,6,15,23,4,9,x2,3,1,q,1,1,1,0,2,0,1,9,1,3,1,", "0,1,0,6,0,4,0,1,0,1,0,1,2,1,1,1,0,2,0,1,0,1,0,1,0,1,0,1,1,1,0,2,3,1,6,1,3,1,3,1,0,1,9,1,g,5,2,1,", "4,1,g,2lw,9,sm,wyn,w,3dp,2,4gd,2,5rk,f,h9,1wi,f1,15u,3t6,5,6jt,f62u,6n;1t,p,6,p,1b,0,a,0,4,0,5,m", ",1,u,1,cp,4,b,e,4,7,0,1,0,3l,4,1,1,3,2,1,0,6,0,1,2,1,0,1,j,1,2a,1,3u,8,4l,1,11,2,0,6,14,1z,q,4,3", ",19,16,z,1,1,2q,1,0,f,1,7,1,a,2,2,0,g,0,1,t,t,2g,b,0,o,w,9,1,4,0,5,l,4,0,9,0,3,0,n,o,7,a,5,n,1,6", ",g,15,1m,1h,3,0,i,0,7,9,f,f,4,7,2,1,2,l,1,6,1,0,3,3,3,0,g,0,d,1,1,2,e,1,a,0,8,5,4,1,2,l,1,6,1,1,", "1,1,1,1,v,3,1,0,j,2,g,8,1,2,1,l,1,6,1,1,1,4,3,0,i,0,f,1,n,0,b,7,2,1,2,l,1,6,1,1,1,4,3,0,u,1,1,2,", "f,0,h,0,1,5,3,2,1,3,3,1,1,0,1,1,3,1,3,2,3,b,m,0,1g,7,1,2,1,m,1,f,3,0,q,2,1,1,2,1,u,0,4,7,1,2,1,m", ",1,9,1,4,3,0,u,2,1,1,f,1,h,8,1,2,1,14,2,0,g,0,5,2,8,2,o,5,5,h,3,n,1,8,1,0,2,6,1m,1b,1,0,d,6,1m,1", ",1,0,1,4,1,n,1,0,1,9,1,0,a,0,2,4,1,0,l,3,w,0,1r,7,1,z,r,4,37,16,k,0,g,5,4,3,3,0,3,1,7,2,4,c,c,0,", "h,11,1,0,5,0,2,16,1,98,1,3,2,6,1,0,1,3,2,14,1,3,2,w,1,3,2,6,1,0,1,3,2,e,1,1k,1,3,2,1u,11,f,g,2d,", "2,5,3,h7,2,g,1,p,5,22,3,a,7,h,d,i,e,h,e,c,1,2,f,1f,z,0,4,0,1v,2g,7,14,1,0,5,1x,a,u,1d,t,2,4,b,17", ",4,p,1i,m,9,1g,2a,0,2l,1a,h,7,1i,t,d,1,a,17,q,z,15,2,a,z,2,a,5,16,2,2,15,3,1,5,1,1,3,0,5,5b,1s,7", "p,2,5,2,11,2,5,2,7,1,0,1,0,1,0,1,u,2,1g,1,6,1,0,3,2,1,6,3,3,2,5,4,c,5,2,1,6,38,0,d,0,g,c,2t,0,4,", "0,2,9,1,0,2,5,6,0,1,0,1,0,1,f,2,3,5,4,4,0,h,14,22f,6c,6,3,3,1,c,11,1,0,5,0,2,1j,7,0,g,m,9,6,1,6,", "1,6,1,6,1,6,1,6,1,6,1,6,fa,2,p,8,7,4,2,4,4,2d,6,2,1,2h,1,3,5,16,1,2l,h,v,1c,f,e8,533,1s,h3g,1v,1", "9,2,7g,3,f,a,1,k,1a,g,u,2,27,13,8,2,2u,2,29,k,g,1,2,1,3,1,m,t,1f,e,1d,1q,5,3,0,1,1,b,r,a,m,p,s,7", ",1a,s,0,g,4,1,9,a,4,1,14,n,2,1,7,k,m,3,0,3,1d,1,0,3,1,2,4,2,0,1,0,o,2,2,a,7,2,c,5,2,5,2,5,9,6,1,", "6,1,16,1,d,6,36,t,8mb,c,m,4,1c,6is,a5,2,2x,12,6,c,4,5,0,1,9,1,c,1,4,1,0,1,1,1,1,1,2z,x,3u,6,61,i", ",1r,2,1h,14,9,3b,0,1,0,3,0,1,0,1,0,1,0,1,3h,10,p,6,p,b,1j,2,u,3,5,2,5,2,5,2,2,z,b,1,p,1,i,1,1,1,", "e,2,d,y,3e,1x,1g,7f,s,3,1c,1b,v,d,t,5,11,a,t,2,z,4,7,1,4,16,4d,i,z,4,z,4,13,8,1f,c,a,1,e,1,6,1,1", ",1,a,1,e,1,6,1,1,3,1f,c,8m,9,l,a,7,o,5,1,15,1,8,1x,5,2,0,1,17,1,1,3,0,2,m,a,m,9,u,1t,i,1,1,a,l,a", ",p,6,p,12,1j,6,1,1s,0,f,3,1,2,1,s,16,s,3,s,z,7,1,r,r,1h,a,l,a,i,d,h,32,20,1j,1e,d,1e,d,z,12,r,9,", "m,6y,15,6,1,g,5,1k,s,a,0,8,l,16,h,1a,k,r,m,c,1g,1l,1,2,0,d,18,w,o,q,z,t,0,2,0,8,y,3,0,c,1b,e,3,l", ",0,1,0,z,h,1,o,j,1,1r,6,1,0,1,3,1,e,1,9,7,1a,12,7,2,1,2,l,1,6,1,1,1,4,3,0,i,0,c,4,u,9,1,0,2,0,1,", "11,1,0,p,0,1,0,18,1g,i,3,k,2,u,1b,k,1,1,0,54,1a,15,3,10,1b,k,0,1n,16,d,0,1z,q,11,6,55,17,38,1r,v", ",7,2,0,2,7,1,1,1,n,f,0,1,0,2m,7,2,12,g,0,1,0,s,0,a,13,7,0,l,0,b,19,j,0,i,20,5j,w,v,8,1,10,h,0,1d", ",t,34,6,1,1,1,11,l,0,p,5,1,1,1,v,e,0,n,17,78,i,f,0,1,c,1,x,3g,0,27,pl,2u,32,h,5f,218,2o,f,tr,h,5", ",p,32y,5,g6,5a1,t,1cy,fs,7,u,h,26,h,t,i,1b,g,3,v,k,5,i,c0,18,5v,1r,w,o,2,o,18,22,5,0,1u,c,1s,1,1", ",0,e,4,9,5p1,15,v,2p,36,6pp,3,1,6,1,1,1,82,f,0,t,2,2,0,e,3,8,az,1s4,2y,5,c,3,8,7,9,4me,2c,1,1y,1", ",1,2,0,2,1,2,3,1,b,1,0,1,6,1,1s,1,3,2,7,1,6,1,r,1,3,1,4,1,0,3,6,1,9f,2,o,1,o,1,u,1,o,1,u,1,o,1,u", ",1,o,1,u,1,o,1,7,1f8,u,6,5,79,1p,42,18,a,6,g,0,8x,t,i,17,dg,r,6c,t,2,0,5r,u,1,2,1,1,1,6,2,4,9,1,", "68,6,1,3,1,1,1,e,1,5g,1n,1v,7,0,xg,3,1,q,1,1,1,0,2,0,1,9,1,3,1,0,1,0,6,0,4,0,1,0,1,0,1,2,1,1,1,0", ",2,0,1,0,1,0,1,0,1,0,1,1,1,0,2,3,1,6,1,3,1,3,1,0,1,9,1,g,5,2,1,4,1,g,3es,wyn,w,3dp,2,4gd,2,5rk,f", ",h9,1wi,f1,15u,3t6,5,6jt;4p,0,4,0,68d,0,c,0,60,0,m,0,2i,5,f,1,a7,1,c,0,4m,0,p,a,4,2,5j,0,6f,1,a,", "0,9,0,1m,3,1,4,9,0,2,0,2,1,2,0,4,0,2,0,1,1,2,0,3,0,3,1,8,2,5,0,1,0,5,b,b,1,2,0,1,1,1,0,i,0,2,1,i", ",5,1,0,1,1,3,1,5,0,2,1,4,1,b,1,5,1,2,0,5,1,1,0,1,1,k,1,5,5,1,3,2,0,4,0,2,0,2,5,1,0,2,0,1,0,1,0,6", ",0,3,0,6,0,a,1,f,0,2,0,4,0,1,0,4,2,1,0,b,1,1c,2,9,0,e,0,e,0,ac,1,cv,2,j,1,1f,0,4,0,yi,0,c,0,gp,0", ",1,0,2fze,0,13,3,2s,b,f,1,f,0,e,1,11,9,34,1,c,1,e,0,2,9,j,1j,r,e,a,0,k,0,2,8,1,3,9,m,6,57,2,33,2", ",1,1,2,2,2a,2,2,1,3,5,71,1,1q,b,5,1,n,7,1,2,7,c,0,2,3,2,0,4,1,d,1,2,0,8,1,9,0,5,2,c,2,8,2,2,0,1,", "0,4,0,6,0,3,0,6,2d,1c,1x,5,7,2,g,3,0,1,5,2,c,62,11,c,3,1k,7,a,5,14,7,u,1,c,3,2,d,9,12,c,1a,1,9,1", ",54,2g,7,e,41,74,sd"]

const foldTable: string[] = ["1t,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0", ",1,0,1,0,7,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w", ",1,w,1,w,1,w,1,w,1n,0,b,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,2,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,", "w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,2,w,1,w,1,w,1,w,1,w,1,w,1,w,1,0,1,0,1,1,1,0,1,1,1,", "0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,", "0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,3,0,1,1,1,0,1,1,1,", "0,1,1,2,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,2,0,1,1,1,0,1,1,1,0,1,1,1,", "0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,", "0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,3d,1,0,1,1,1,0,1,1,1,0,1,1,1,8c,", "1,0,1,0,1,0,1,1,1,0,1,1,1,0,1,0,1,1,1,0,1,0,1,0,1,1,2,0,1,0,1,0,1,0,1,1,1,0,1,0,1,0,1,0,1,0,1,0,", "1,1,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,0,1,1,1,0,3,0,1,1,1,0,1,0,1,1,1,0,1,0,", "1,0,1,1,1,0,1,1,1,0,1,0,1,1,3,0,1,1,2,0,5,0,1,1,1,2,1,0,1,1,1,2,1,0,1,1,1,2,1,0,1,1,1,0,1,1,1,0,", "1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,27,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1", ",1,0,1,1,1,0,1,1,1,0,1,1,2,0,1,1,1,2,1,0,1,1,1,2p,1,1k,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1", ",0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1", ",0,1,1,1,0,1,1,1,0,1,1,1,3m,2,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,", "1,1,7,0,1,0,1,1,1,4j,1,0,1,0,1,0,1,0,1,1,1,5f,1,0,1,0,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,", "0,1,0,1,0,1,5u,1,5q,2,5p,1,5p,2,5m,2,5n,1,0,4,5p,1,0,2,5r,1,0,1,0,1,0,2,5t,1,5v,1,0,1,0,1,0,3,5v", ",2,0,1,5x,3,5y,8,0,3,62,2,0,1,62,4,0,1,62,1,1x,1,61,1,61,1,1z,6,63,b,0,1,0,4n,0,17,0,1,1,1,0,1,1", ",3,0,1,1,4,0,1,0,1,0,2,0,7,0,2,0,1,0,1,0,2,0,2,0,1,0,2,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,2c,1,0,1,", "0,1,kn,1,0,1,0,1,0,1,0,1,0,2,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,12,1,11,1,11,1,11,2,w,1,w,1,w,1", ",w,1,w,1,w,1,w,1,w,1,38,1,w,1,w,1,lj,1,w,1,w,1,w,1,w,1,w,1,v,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w", ",1,1s,1,1r,1,1r,1,0,1,1q,1,1l,4,1b,1,1i,1,8,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,", "1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,2e,1,28,1,0,1,38,1,2k,1,2o,2,0,1,1,1,7,1,0,1,1,2,3", "m,1,3m,1,3m,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,", "1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,28,1,28,1,28,1,28,1,28,1,28,1,28,1,28,1,28,1,28,1,", "28,1,28,1,28,1,28,1,28,1,28,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,", "1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,9,0,1,1,1,0,1,1,1,0,1,1,1,0,", "1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,", "1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,", "1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,f,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,", "1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,", "1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,", "1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,", "1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,2,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,b,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1", ",1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,", "1c,1,1c,1,1c,1,1c,26y,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,2,0,6,0,3,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,3,0,1,0,1,0,ip,0,1,0,1,0,1,0,1,0", ",1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0", ",1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0", ",1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0", ",1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,3,8,1,8,1,8,1,8,1,8,1,8,1oj,4tq,1,4tp,1,4tg,1,4te,1,4te,1,4", "tf,1,4t8,1,4rp,1,0,1,0,1,1,6,2bk,1,2bk,1,2bk,1,2bk,1,2bk,1,2bk,1,2bk,1,2bk,1,2bk,1,2bk,1,2bk,1,2", "bk,1,2bk,1,2bk,1,2bk,1,2bk,1,2bk,1,2bk,1,2bk,1,2bk,1,2bk,1,2bk,1,2bk,1,2bk,1,2bk,1,2bk,1,2bk,1,2", "bk,1,2bk,1,2bk,1,2bk,1,2bk,1,2bk,1,2bk,1,2bk,1,2bk,1,2bk,1,2bk,1,2bk,1,2bk,1,2bk,1,2bk,1,2bk,3,2", "bk,1,2bk,1,2bk,56,0,4,0,h,0,36,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0", ",1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0", ",1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0", ",1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0", ",1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0", ",1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0", ",1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,6,1n,3,5vj,2,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,", "1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,", "1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,", "1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,", "1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,8,1,8,1,8,1,8,1,8,1,8,1,8,1,8,1,0,1,0,1,0,1,0,1,0,1,0,3,8,1,8,1,8,1,8,1,8,1,8,3,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,8,1,8,1,8,1,8,1,8,1,8,1,8,1,8,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,8,1,8,1,8,1,8,", "1,8,1,8,1,8,1,8,1,0,1,0,1,0,1,0,1,0,1,0,3,8,1,8,1,8,1,8,1,8,1,8,4,0,2,0,2,0,2,0,2,8,2,8,2,8,2,8,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,8,1,8,1,8,1,8,1,8,1,8,1,8,1,8,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,3,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,8,1,8,1,8,1,8,1,8,1,8,1,8,1,8,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,8,1,8,1,8,1,8,1,8,1,8,1,8,1,8,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,8,1,8,", "1,8,1,8,1,8,1,8,1,8,1,8,1,0,1,0,2,0,5,8,1,8,1,22,1,22,1,9,2,5mh,5,0,5,2e,1,2e,1,2e,1,2e,1,9,4,0,", "1,0,7,8,1,8,1,2s,1,2s,5,0,1,0,4,0,3,8,1,8,1,34,1,34,1,7,7,0,5,3k,1,3k,1,3i,1,3i,1,9,8a,5tp,4,6hr", ",1,6ee,7,0,s,s,i,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,g,1,g,1,g,1,g,1", ",g,1,g,1,g,1,g,1,g,1,g,1,g,1,g,1,g,1,g,1,g,1,g,4,0,1,1,mq,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,q,1,q,1,q,1,q,1,q,1,q,1,q,1,q,", "1,q,1,q,1,q,1,q,1,q,1,q,1,q,1,q,1,q,1,q,1,q,1,q,1,q,1,q,1,q,1,q,1,q,1,q,1ef,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,1c,1,1c,1,1c,1,1c,1,", "1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1", "c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c,1,1c", ",1,1c,1,1c,1,1c,1,1c,1,1c,1,0,1,1,1,8af,1,2xy,1,89z,1,8bv,1,8bs,1,0,1,1,1,0,1,1,1,0,1,1,1,8bg,1,", "8al,1,8bj,1,8bi,2,0,1,1,2,0,1,1,8,8cf,1,8cf,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,", "1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,", "1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,", "1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,", "1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,8,0,1,1,1,0,1,1,4,0,1,1,d,5ls,1,5ls,", "1,5ls,1,5ls,1,5ls,1,5ls,1,5ls,1,5ls,1,5ls,1,5ls,1,5ls,1,5ls,1,5ls,1,5ls,1,5ls,1,5ls,1,5ls,1,5ls,", "1,5ls,1,5ls,1,5ls,1,5ls,1,5ls,1,5ls,1,5ls,1,5ls,1,5ls,1,5ls,1,5ls,1,5ls,1,5ls,1,5ls,1,5ls,1,5ls,", "1,5ls,1,5ls,1,5ls,1,5ls,2,5ls,6,5ls,nwz,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,r7m,1,r7n,1,0,1,", "1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,", "1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,j,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,", "1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,3r,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1", ",1,1,0,1,1,3,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1", ",1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1", ",1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,a,0,1,1,1,0,1,1,1,r9g,1,0,1,1", ",1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,4,0,1,1,1,wmg,3,0,1,1,1,0,1,1,1,0,2,0,1,1,1,0,1,1,1,0,1,1,1,0,1", ",1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,wn8,1,wnj,1,wnf,1,wn5,1,wn8,2,wlu,1,wmi,1,w", "lx,1,0,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,1c,1,wn7,1,raw,1,0,1,1,", "1,0,1,1,1,wo7,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,wu9,p,0,1,1,nx,p", "s,t,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tz", "k,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tz", "k,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tz", "k,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tz", "k,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tzk,1,tz", "k,ggy,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,7,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,", "1,w,1,w,1,w,1,w,1,w,x2,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0", ",1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,14,1,14,1", ",14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,", "14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,2p,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,5,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,", "1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1,14,1", ",14,1,14,1,14,1,14,1,14,1,14,1,14,39,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,2,0,1,0,1,0,1,0,1", ",0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,2,0,1,0,1,0,1,0,1,0,1,0,1,0,2,0,1,0,2,13,1,13,1,13,1,", "13,1,13,1,13,1,13,1,13,1,13,1,13,1,13,2,13,1,13,1,13,1,13,1,13,1,13,1,13,1,13,1,13,1,13,1,13,1,1", "3,1,13,1,13,1,13,2,13,1,13,1,13,1,13,1,13,1,13,1,13,2,13,1,13,1c4,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,e,1s,1,1s,1,1s,1,1s,", "1,1s,1,1s,1,1s,1,1s,1,1s,1,1s,1,1s,1,1s,1,1s,1,1s,1,1s,1,1s,1,1s,1,1s,1,1s,1,1s,1,1s,1,1s,1,1s,1", ",1s,1,1s,1,1s,1,1s,1,1s,1,1s,1,1s,1,1s,1,1s,1,1s,1,1s,1,1s,1,1s,1,1s,1,1s,1,1s,1,1s,1,1s,1,1s,1,", "1s,1,1s,1,1s,1,1s,1,1s,1,1s,1,1s,1,1s,1,1s,2m,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,b,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,", "1,w,1,w,1,w,1,w,1,w,1,w,1,w,26z,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,", "w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,gv", "5,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,", "1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,1,w,x,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,", "1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,3,r,1,r,1,r,1,r,1,r,1,r,1,r,", "1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,o4t,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,", "0,1,0,1,0,1,0,1,0,1,y,1,y,1,y,1,y,1,y,1,y,1,y,1,y,1,y,1,y,1,y,1,y,1,y,1,y,1,y,1,y,1,y,1,y,1,y,1,", "y,1,y,1,y,1,y,1,y,1,y,1,y,1,y,1,y,1,y,1,y,1,y,1,y,1,y,1,y"]

const foldClasses: string[] = ["2,1t,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,3,1,w,6hr,2,1,w,2,1,w,2,1,w,2,1,w,2", ",1,w,2,1,w,2,1,w,3,1,w,8c,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,3,2j,kn,lj,2,b,w,2,1,w,2,1,w", ",2,1,w,2,1,w,3,1,w,6ee,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2", ",1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,2,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,5vj,2,w,3d,2,1,1,2,2,", "1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,", "1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,4,1,2,2,1,2,2,1,2,3,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,", "1,2,2,1,2,3,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,", "1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,3,1,2,2,1,2,2,1,2,3,5f,2,1,5u,2,1,1,2,2,1,2,", "2,5q,2,1,1,2,2,5p,2,1,5p,2,1,1,2,3,27,2,1,5m,2,1,5n,2,1,1,2,2,5p,2,1,5r,2,1,2p,2,1,5v,2,1,5t,2,1", ",1,2,2,4j,2,1,wu9,2,1,5v,2,1,5x,2,1,3m,2,1,5y,2,1,1,2,2,1,2,2,1,2,2,62,2,1,1,2,2,62,2,3,1,2,2,62", ",2,1,1,2,2,61,2,1,61,2,1,1,2,2,1,2,2,63,2,1,1,2,4,1,2,3,1k,3,5,1,2,3,3,1,2,3,3,1,2,2,3,1,2,2,1,2", ",2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,3,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,3,3,1,2", ",2,3,1,2,4,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1", ",2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,4,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,8,8bv,2,1", ",1,2,3,8bs,2,1,8cf,2,1,8cf,2,1,1,2,3,1x,2,1,1z,2,1,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,8bj,2,1,8bg,2,1", ",8bi,2,a,wnj,2,5,wnf,2,3,wo7,2,1,wmg,2,1,wn8,2,4,wn8,2,1,8af,2,1,wn5,2,5,8al,2,c,89z,2,5,wn7,2,5", ",wmi,2,m,wlx,2,1,wlu,4,4n,2c,38,5mh,2,17,1,2,2,1,2,4,1,2,5,3m,2,1,3m,2,1,3m,2,2,38,2,7,12,2,2,11", ",2,1,11,2,1,11,2,2,1s,2,2,1r,2,1,1r,2,2,w,3,1,w,1q,2,1,w,2,1,w,3,1,w,2o,2,1,w,2,1,w,4,1,w,1l,2k,", "3,2,w,2e,2,1,w,2,2,w,2,1,w,2,1,w,3,1,w,1i,3,1,w,28,3,2,v,w,2,1,w,2,1,w,3,1,w,1b,2,1,w,2,1,w,3,1,", "w,5tp,2,1,w,2,1,w,2,10,8,2,9,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1", ",2,4,7,2,5,1,2,3,1,2,6,28,2,1,28,2,1,28,2,1,28,2,1,28,2,1,28,2,1,28,2,1,28,2,1,28,2,1,28,2,1,28,", "2,1,28,2,1,28,2,1,28,2,1,28,2,1,28,2,1,w,2,1,w,3,1,w,4tq,2,1,w,3,1,w,4tp,2,1,w,2,1,w,2,1,w,2,1,w", ",2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,3,1,w,4tg,2,1,w,2,1,w,3,1,w,4te,4,1,w,4te,4tf,2,1,w,2,1,w,2,1,w,2", ",1,w,2,1,w,2,1,w,2,1,w,3,1,w,4t8,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1d,1,3,2,1,4rp,2,2,1,2,2,1,2,2,", "1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,a,1,2,2,1,2,2,1,2,2,", "1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,", "1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,f,2,1,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,3,", "1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,", "1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,", "1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,3,", "1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,", "1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,", "2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,28a,5ls,2,1,5ls,2,1,5ls,", "2,1,5ls,2,1,5ls,2,1,5ls,2,1,5ls,2,1,5ls,2,1,5ls,2,1,5ls,2,1,5ls,2,1,5ls,2,1,5ls,2,1,5ls,2,1,5ls,", "2,1,5ls,2,1,5ls,2,1,5ls,2,1,5ls,2,1,5ls,2,1,5ls,2,1,5ls,2,1,5ls,2,1,5ls,2,1,5ls,2,1,5ls,2,1,5ls,", "2,1,5ls,2,1,5ls,2,1,5ls,2,1,5ls,2,1,5ls,2,1,5ls,2,1,5ls,2,1,5ls,2,1,5ls,2,1,5ls,2,1,5ls,2,2,5ls,", "2,6,5ls,2,3,2bk,2,1,2bk,2,1,2bk,2,1,2bk,2,1,2bk,2,1,2bk,2,1,2bk,2,1,2bk,2,1,2bk,2,1,2bk,2,1,2bk,", "2,1,2bk,2,1,2bk,2,1,2bk,2,1,2bk,2,1,2bk,2,1,2bk,2,1,2bk,2,1,2bk,2,1,2bk,2,1,2bk,2,1,2bk,2,1,2bk,", "2,1,2bk,2,1,2bk,2,1,2bk,2,1,2bk,2,1,2bk,2,1,2bk,2,1,2bk,2,1,2bk,2,1,2bk,2,1,2bk,2,1,2bk,2,1,2bk,", "2,1,2bk,2,1,2bk,2,1,2bk,2,1,2bk,2,1,2bk,2,1,2bk,2,1,2bk,2,1,2bk,2,3,2bk,2,1,2bk,2,1,2bk,2,ip,tzk", ",2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk", ",2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk", ",2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk", ",2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk", ",2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk", ",2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk", ",2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,tzk,2,1,8,2,1,8,2,1,8,2,1,8,2,1,8,2,1,8,3,1", "oz,r7m,r7n,2,1,1,2,6o,r9g,2,4,2xy,2,h,raw,2,36,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1", ",2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1", ",2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1", ",2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,3,2,1,1n,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,", "2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,", "2,1,2,2,1,2,2,1,2,c,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,", "2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,", "2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,", "2,1,2,2,1,2,2,1,2,2,8,2,1,8,2,1,8,2,1,8,2,1,8,2,1,8,2,1,8,2,1,8,2,9,8,2,1,8,2,1,8,2,1,8,2,1,8,2,", "1,8,2,b,8,2,1,8,2,1,8,2,1,8,2,1,8,2,1,8,2,1,8,2,1,8,2,9,8,2,1,8,2,1,8,2,1,8,2,1,8,2,1,8,2,1,8,2,", "1,8,2,9,8,2,1,8,2,1,8,2,1,8,2,1,8,2,1,8,2,c,8,2,2,8,2,2,8,2,2,8,2,9,8,2,1,8,2,1,8,2,1,8,2,1,8,2,", "1,8,2,1,8,2,1,8,2,9,22,2,1,22,2,1,2e,2,1,2e,2,1,2e,2,1,2e,2,1,2s,2,1,2s,2,1,3k,2,1,3k,2,1,34,2,1", ",34,2,1,3i,2,1,3i,2,3,8,2,1,8,2,1,8,2,1,8,2,1,8,2,1,8,2,1,8,2,1,8,2,9,8,2,1,8,2,1,8,2,1,8,2,1,8,", "2,1,8,2,1,8,2,1,8,2,9,8,2,1,8,2,1,8,2,1,8,2,1,8,2,1,8,2,1,8,2,1,8,2,9,8,2,1,8,2,2,9,2,g,9,2,d,8,", "2,1,8,2,f,8,2,1,8,2,4,7,2,e,9,2,8v,s,2,1a,g,2,1,g,2,1,g,2,1,g,2,1,g,2,1,g,2,1,g,2,1,g,2,1,g,2,1,", "g,2,1,g,2,1,g,2,1,g,2,1,g,2,1,g,2,1,g,2,k,1,2,mr,q,2,1,q,2,1,q,2,1,q,2,1,q,2,1,q,2,1,q,2,1,q,2,1", ",q,2,1,q,2,1,q,2,1,q,2,1,q,2,1,q,2,1,q,2,1,q,2,1,q,2,1,q,2,1,q,2,1,q,2,1,q,2,1,q,2,1,q,2,1,q,2,1", ",q,2,1,q,2,1f5,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2", ",1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c", ",2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,", "1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1,1c,2,1d,1,2,7,1,2,2,1,2,2,1,2,7,1,2,3,1,", "2,b,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,", "2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,", "2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,", "2,2,1,2,2,1,2,9,1,2,2,1,2,5,1,2,nym,1,2,2,1,2,2,1,2,2,1,2,2,1,2,4,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,", "1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,k,1,2,2,1,2,2,1,2,2,1,2,2,", "1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,3s,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2", ",1,2,4,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2", ",1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,b", ",1,2,2,1,2,3,1,2,2,1,2,2,1,2,2,1,2,2,1,2,5,1,2,5,1,2,2,1,2,2,1c,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,", "2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,b,ps,2,1,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,5,1,2,2,1,2", ",3,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,2,1,2,r,1,2,h7w,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w", ",2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w", ",2,1,w,2,1,w,2,1,w,2,xy,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14", ",2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,", "14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,", "1,14,2,1,14,2,3t,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14", ",2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,", "14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,1,14,2,4d,13,2,1,13,2,1,13,2", ",1,13,2,1,13,2,1,13,2,1,13,2,1,13,2,1,13,2,1,13,2,1,13,2,2,13,2,1,13,2,1,13,2,1,13,2,1,13,2,1,13", ",2,1,13,2,1,13,2,1,13,2,1,13,2,1,13,2,1,13,2,1,13,2,1,13,2,1,13,2,2,13,2,1,13,2,1,13,2,1,13,2,1,", "13,2,1,13,2,1,13,2,2,13,2,1,13,2,1d7,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,", "2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1", "s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1", ",1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2,1,1s,2", ",1,1s,2,4e,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w", ",2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,27v,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1", ",w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1", ",w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,gw1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2", ",1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2", ",1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1,w,2,1t,r,2,1,r,2,1,r,2,1,r,2,1,r,2,1,r,2,1,r,2,1,r,", "2,1,r,2,1,r,2,1,r,2,1,r,2,1,r,2,1,r,2,1,r,2,1,r,2,1,r,2,1,r,2,1,r,2,1,r,2,1,r,2,1,r,2,1,r,2,1,r,", "2,1,r,2,o5k,y,2,1,y,2,1,y,2,1,y,2,1,y,2,1,y,2,1,y,2,1,y,2,1,y,2,1,y,2,1,y,2,1,y,2,1,y,2,1,y,2,1,", "y,2,1,y,2,1,y,2,1,y,2,1,y,2,1,y,2,1,y,2,1,y,2,1,y,2,1,y,2,1,y,2,1,y,2,1,y,2,1,y,2,1,y,2,1,y,2,1,", "y,2,1,y,2,1,y,2,1,y"]

export function digitValue(c: number): number {
  if (c >= 48 && c <= 57) {
    return c - 48
  } else if (c >= 97 && c <= 122) {
    return c - 87
  }
  return -1
}

export function decodeRow(chunks: string[], row: number): number[] {
  const out: number[] = ([] as number[])
  let value: number = 0
  let started: boolean = false
  let atRow: number = 0
  for (const chunk of chunks) {
    for (const c of Array.from(chunk, function (rune) { return rune.codePointAt(0) ?? 0 })) {
      const d: number = digitValue(c)
      if (d >= 0) {
        const __n19 = __termInt(value * 36) + d; if (!(__n19 <= 9007199254740991 && __n19 >= -9007199254740991)) __termIntStop(__n19); value = __n19
        started = true
      } else {
        if (started && atRow === row) {
          out.push(value)
        }
        value = 0
        started = false
        if (c === 59) {
          const __n20 = atRow + 1; if (!(__n20 <= 9007199254740991 && __n20 >= -9007199254740991)) __termIntStop(__n20); atRow = __n20
        }
      }
    }
  }
  if (started && atRow === row) {
    out.push(value)
  }
  return out
}

export function decodeNumbers(chunks: string[]): number[] {
  return decodeRow(chunks, 0)
}

export function decodeNames(chunks: string[]): string[] {
  const out: string[] = ([] as string[])
  let name: number[] = ([] as number[])
  for (const chunk of chunks) {
    for (const c of Array.from(chunk, function (rune) { return rune.codePointAt(0) ?? 0 })) {
      if (c === 44) {
        out.push(fromRunes(name))
        name = ([] as number[])
      } else {
        name.push(c)
      }
    }
  }
  if (name.length > 0) {
    out.push(fromRunes(name))
  }
  return out
}

export function nameIndex(names: string[], name: string): number {
  let i: number = 0
  for (const each of names) {
    if (each === name) {
      return i
    }
    const __n21 = i + 1; if (!(__n21 <= 9007199254740991 && __n21 >= -9007199254740991)) __termIntStop(__n21); i = __n21
  }
  return -1
}

export function coveringSet(table: number[], keep: (a0: number) => boolean): number[] {
  const out: number[] = ([] as number[])
  let start: number = 0
  let i: number = 0
  const count: number = table.length
  while (__termInt(i + 1) < count) {
    const size: number = numberAt(table, i, 0)
    const value: number = numberAt(table, __termInt(i + 1), -1)
    const __n22 = start + size; if (!(__n22 <= 9007199254740991 && __n22 >= -9007199254740991)) __termIntStop(__n22); const end: number = __n22
    if (keep(value)) {
      pushRange(out, start, end)
    }
    const __n23 = end + 1; if (!(__n23 <= 9007199254740991 && __n23 >= -9007199254740991)) __termIntStop(__n23); start = __n23
    const __n24 = i + 2; if (!(__n24 <= 9007199254740991 && __n24 >= -9007199254740991)) __termIntStop(__n24); i = __n24
  }
  return out
}

export function gappedSet(table: number[]): number[] {
  const out: number[] = ([] as number[])
  let next: number = 0
  let i: number = 0
  const count: number = table.length
  while (__termInt(i + 1) < count) {
    const __n25 = next + numberAt(table, i, 0); if (!(__n25 <= 9007199254740991 && __n25 >= -9007199254740991)) __termIntStop(__n25); const start: number = __n25
    const __n26 = start + numberAt(table, __termInt(i + 1), 0); if (!(__n26 <= 9007199254740991 && __n26 >= -9007199254740991)) __termIntStop(__n26); const end: number = __n26
    pushRange(out, start, end)
    const __n27 = end + 1; if (!(__n27 <= 9007199254740991 && __n27 >= -9007199254740991)) __termIntStop(__n27); next = __n27
    const __n28 = i + 2; if (!(__n28 <= 9007199254740991 && __n28 >= -9007199254740991)) __termIntStop(__n28); i = __n28
  }
  return out
}

export function categoryMask(name: string): number {
  const at: number = nameIndex(decodeNames(categoryNames), name)
  if (at < 0) {
    return -1
  }
  return numberAt(decodeNumbers(categoryMasks), at, -1)
}

export function categorySet(mask: number): number[] {
  return coveringSet(decodeNumbers(categoryTable), (value: number) => (bit.and(mask, bit.shiftLeft(1, value)) > 0))
}

export function scriptId(name: string): number {
  const at: number = nameIndex(decodeNames(scriptNames), name)
  if (at < 0) {
    return -1
  }
  return numberAt(decodeNumbers(scriptNameIds), at, -1)
}

export function scriptSet(id: number): number[] {
  return coveringSet(decodeNumbers(scriptTable), (value: number) => (value === id))
}

export function binaryRow(name: string): number {
  const at: number = nameIndex(decodeNames(binaryNames), name)
  if (at < 0) {
    return -1
  }
  return numberAt(decodeNumbers(binaryNameIds), at, -1)
}

export function binarySet(row: number): number[] {
  return gappedSet(decodeRow(binaryTable, row))
}

export function wordSet(): number[] {
  return gappedSet(decodeNumbers(wordTable))
}

export function foldPairs(): number[] {
  const table: number[] = decodeNumbers(foldTable)
  const out: number[] = ([] as number[])
  let c: number = 0
  let i: number = 0
  while (__termInt(i + 1) < table.length) {
    const __n29 = c + numberAt(table, i, 0); if (!(__n29 <= 9007199254740991 && __n29 >= -9007199254740991)) __termIntStop(__n29); c = __n29
    out.push(c)
    out.push(__termInt(c - numberAt(table, __termInt(i + 1), 0)))
    const __n30 = i + 2; if (!(__n30 <= 9007199254740991 && __n30 >= -9007199254740991)) __termIntStop(__n30); i = __n30
  }
  return out
}

export function foldLeast(pairs: number[], c: number): number {
  let low: number = 0
  let high: number = Math.trunc(pairs.length / 2)
  let turns: number = 0
  while (low < high && turns < 64) {
    turns = turns + 1
    const middle: number = Math.trunc(__termInt(low + high) / 2)
    const key: number = numberAt(pairs, __termInt(middle * 2), -1)
    if (c < key) {
      high = middle
    } else if (c > key) {
      const __n31 = middle + 1; if (!(__n31 <= 9007199254740991 && __n31 >= -9007199254740991)) __termIntStop(__n31); low = __n31
    } else {
      return numberAt(pairs, __termInt(__termInt(middle * 2) + 1), c)
    }
  }
  return c
}

export function closeUnderCase(set: number[]): number[] {
  const table: number[] = decodeNumbers(foldClasses)
  const added: number[] = ([] as number[])
  let least: number = 0
  let i: number = 0
  const size: number = table.length
  while (i < size) {
    let count: number = numberAt(table, i, 1)
    if (count < 1) {
      count = 1
    }
    const __n32 = least + numberAt(table, __termInt(i + 1), 0); if (!(__n32 <= 9007199254740991 && __n32 >= -9007199254740991)) __termIntStop(__n32); least = __n32
    const members: number[] = ([] as number[])
    members.push(least)
    let k: number = 2
    while (k <= count) {
      members.push(__termInt(least + numberAt(table, __termInt(i + k), 0)))
      const __n33 = k + 1; if (!(__n33 <= 9007199254740991 && __n33 >= -9007199254740991)) __termIntStop(__n33); k = __n33
    }
    let hit: boolean = false
    for (const m of members) {
      if (setHas(set, m)) {
        hit = true
      }
    }
    if (hit) {
      for (const m of members) {
        added.push(m)
      }
    }
    const __n34 = i + __termInt(count + 1); if (!(__n34 <= 9007199254740991 && __n34 >= -9007199254740991)) __termIntStop(__n34); i = __n34
  }
  const sorted: number[] = sort(added, fromNumbers)
  const extra: number[] = ([] as number[])
  for (const m of sorted) {
    pushRange(extra, m, m)
  }
  return mergeSets(set, extra)
}

export interface Parsed {
  root: Piece
  groups: number
  names: string[]
}

export interface Reading {
  runes: number[]
  cursor: number[]
  flags: number[]
  nextGroup: number[]
  names: string[]
  total: number
}

const mostCount: number = 100000

export function advance(r: Reading, count: number): number {
  const cursor: number[] = r.cursor
  const __n35 = numberAt(r.cursor, 0, 0) + count; if (!(__n35 <= 9007199254740991 && __n35 >= -9007199254740991)) __termIntStop(__n35); const next: number = __n35
  putNumber(cursor, 0, next)
  return next
}

export function setFlag(r: Reading, flag: number, on: boolean): number {
  const flags: number[] = r.flags
  if (on) {
    putNumber(flags, flag, 1)
  } else {
    putNumber(flags, flag, 0)
  }
  return flag
}

export function refuseHere(r: Reading, reason: string): Piece {
  return refusePattern(numberAt(r.cursor, 0, 0), reason)
}

export function isAsciiDigit(c: number): boolean {
  return c >= 48 && c <= 57
}

export function hexValue(c: number): number {
  if (c >= 48 && c <= 57) {
    return c - 48
  } else if (c >= 97 && c <= 102) {
    return c - 87
  } else if (c >= 65 && c <= 70) {
    return c - 55
  }
  return -1
}

export function skipExtended(r: Reading): number {
  if (numberAt(r.flags, 3, 0) !== 1) {
    return 0
  }
  let skipped: number = 0
  let going: boolean = true
  let turnsL: number = 0
  const __n36 = r.runes.length + 3; if (!(__n36 <= 9007199254740991 && __n36 >= -9007199254740991)) __termIntStop(__n36); const limitL: number = __n36
  while (going && numberAt(r.cursor, 0, 0) < r.runes.length && turnsL < limitL) {
    const __n37 = turnsL + 1; if (!(__n37 <= 9007199254740991 && __n37 >= -9007199254740991)) __termIntStop(__n37); turnsL = __n37
    const c: number = numberAt(r.runes, numberAt(r.cursor, 0, 0), -1)
    if (c === 32 || c >= 9 && c <= 13) {
      advance(r, 1)
      const __n38 = skipped + 1; if (!(__n38 <= 9007199254740991 && __n38 >= -9007199254740991)) __termIntStop(__n38); skipped = __n38
    } else if (c === 35) {
      let turnsK: number = 0
      const __n39 = r.runes.length + 3; if (!(__n39 <= 9007199254740991 && __n39 >= -9007199254740991)) __termIntStop(__n39); const limitK: number = __n39
      while (numberAt(r.cursor, 0, 0) < r.runes.length && numberAt(r.runes, numberAt(r.cursor, 0, 0), -1) !== 10 && turnsK < limitK) {
        const __n40 = turnsK + 1; if (!(__n40 <= 9007199254740991 && __n40 >= -9007199254740991)) __termIntStop(__n40); turnsK = __n40
        advance(r, 1)
      }
      const __n41 = skipped + 1; if (!(__n41 <= 9007199254740991 && __n41 >= -9007199254740991)) __termIntStop(__n41); skipped = __n41
    } else {
      going = false
    }
  }
  return skipped
}

export function scanGroups(runes: number[], names: string[]): number {
  let count: number = 0
  let i: number = 0
  let inClass: boolean = false
  let turnsJ: number = 0
  const __n42 = runes.length + 3; if (!(__n42 <= 9007199254740991 && __n42 >= -9007199254740991)) __termIntStop(__n42); const limitJ: number = __n42
  while (i < runes.length && turnsJ < limitJ) {
    const __n43 = turnsJ + 1; if (!(__n43 <= 9007199254740991 && __n43 >= -9007199254740991)) __termIntStop(__n43); turnsJ = __n43
    const c: number = numberAt(runes, i, -1)
    const next: number = numberAt(runes, __termInt(i + 1), -1)
    if (c === 92) {
      const __n44 = i + 2; if (!(__n44 <= 9007199254740991 && __n44 >= -9007199254740991)) __termIntStop(__n44); i = __n44
      continue
    }
    if (inClass) {
      if (c === 93) {
        inClass = false
      }
      const __n45 = i + 1; if (!(__n45 <= 9007199254740991 && __n45 >= -9007199254740991)) __termIntStop(__n45); i = __n45
      continue
    }
    if (c === 91) {
      inClass = true
      const __n46 = i + 1; if (!(__n46 <= 9007199254740991 && __n46 >= -9007199254740991)) __termIntStop(__n46); i = __n46
      continue
    }
    if (c === 40) {
      if (next !== 63) {
        const __n47 = count + 1; if (!(__n47 <= 9007199254740991 && __n47 >= -9007199254740991)) __termIntStop(__n47); count = __n47
        names.push("")
      } else {
        const after: number = numberAt(runes, __termInt(i + 2), -1)
        const beyond: number = numberAt(runes, __termInt(i + 3), -1)
        if (after === 60 && (beyond !== 61 && beyond !== 33)) {
          const __n48 = count + 1; if (!(__n48 <= 9007199254740991 && __n48 >= -9007199254740991)) __termIntStop(__n48); count = __n48
          const name: number[] = ([] as number[])
          const __n49 = i + 3; if (!(__n49 <= 9007199254740991 && __n49 >= -9007199254740991)) __termIntStop(__n49); let k: number = __n49
          while (k < runes.length && numberAt(runes, k, -1) !== 62) {
            name.push(numberAt(runes, k, 0))
            const __n50 = k + 1; if (!(__n50 <= 9007199254740991 && __n50 >= -9007199254740991)) __termIntStop(__n50); k = __n50
          }
          names.push(fromRunes(name))
        }
      }
    }
    const __n51 = i + 1; if (!(__n51 <= 9007199254740991 && __n51 >= -9007199254740991)) __termIntStop(__n51); i = __n51
  }
  return count
}

export function parsePattern(source: string): Parsed {
  const runes: number[] = Array.from(source, function (rune) { return rune.codePointAt(0) ?? 0 })
  const names: string[] = ([] as string[])
  const total: number = scanGroups(runes, names)
  const cursor: number[] = ([] as number[])
  cursor.push(0)
  const flags: number[] = ([] as number[])
  flags.push(0)
  flags.push(0)
  flags.push(0)
  flags.push(0)
  const nextGroup: number[] = ([] as number[])
  nextGroup.push(1)
  const r: Reading = { runes: runes, cursor: cursor, flags: flags, nextGroup: nextGroup, names: names, total: total }
  const root: Piece = parseChoice(r)
  if (numberAt(r.cursor, 0, 0) < runes.length) {
    refusePattern(numberAt(r.cursor, 0, 0), "a ) with no ( before it")
  }
  return { root: root, groups: total, names: names }
}

export function parseChoice(r: Reading): Piece {
  const parts: Piece[] = ([] as Piece[])
  parts.push(parseChain(r))
  let turnsI: number = 0
  const __n52 = r.runes.length + 3; if (!(__n52 <= 9007199254740991 && __n52 >= -9007199254740991)) __termIntStop(__n52); const limitI: number = __n52
  while (numberAt(r.runes, numberAt(r.cursor, 0, 0), -1) === 124 && turnsI < limitI) {
    const __n53 = turnsI + 1; if (!(__n53 <= 9007199254740991 && __n53 >= -9007199254740991)) __termIntStop(__n53); turnsI = __n53
    advance(r, 1)
    parts.push(parseChain(r))
  }
  if (parts.length === 1) {
    return (0 < parts.length ? parts[0]! : __termReadPast(parts, 0))
  }
  return { form: "choice", parts: parts }
}

export function parseChain(r: Reading): Piece {
  const parts: Piece[] = ([] as Piece[])
  let going: boolean = true
  let turnsH: number = 0
  const __n54 = r.runes.length + 3; if (!(__n54 <= 9007199254740991 && __n54 >= -9007199254740991)) __termIntStop(__n54); const limitH: number = __n54
  while (going && turnsH < limitH) {
    const __n55 = turnsH + 1; if (!(__n55 <= 9007199254740991 && __n55 >= -9007199254740991)) __termIntStop(__n55); turnsH = __n55
    skipExtended(r)
    const c: number = numberAt(r.runes, numberAt(r.cursor, 0, 0), -1)
    if (c < 0 || (c === 124 || c === 41)) {
      going = false
      continue
    }
    if (isFlagSwitch(r)) {
      readFlags(r)
      continue
    }
    const atom: Piece = parseAtom(r)
    parts.push(parseQuantifier(r, atom))
  }
  if (parts.length === 1) {
    return (0 < parts.length ? parts[0]! : __termReadPast(parts, 0))
  }
  if (parts.length === 0) {
    return __termVariantBlank
  }
  return { form: "chain", parts: parts }
}

export function isFlagSwitch(r: Reading): boolean {
  if (!(numberAt(r.runes, numberAt(r.cursor, 0, 0), -1) === 40 && numberAt(r.runes, __termInt(numberAt(r.cursor, 0, 0) + 1), -1) === 63)) {
    return false
  }
  let k: number = 2
  let going: boolean = true
  let turnsG: number = 0
  const __n56 = r.runes.length + 3; if (!(__n56 <= 9007199254740991 && __n56 >= -9007199254740991)) __termIntStop(__n56); const limitG: number = __n56
  while (going && turnsG < limitG) {
    const __n57 = turnsG + 1; if (!(__n57 <= 9007199254740991 && __n57 >= -9007199254740991)) __termIntStop(__n57); turnsG = __n57
    const c: number = numberAt(r.runes, __termInt(numberAt(r.cursor, 0, 0) + k), -1)
    if (c === 105 || c === 109 || (c === 115 || c === 120)) {
      const __n58 = k + 1; if (!(__n58 <= 9007199254740991 && __n58 >= -9007199254740991)) __termIntStop(__n58); k = __n58
    } else if (c === 45) {
      const __n59 = k + 1; if (!(__n59 <= 9007199254740991 && __n59 >= -9007199254740991)) __termIntStop(__n59); k = __n59
    } else {
      going = false
    }
  }
  return k > 2 && numberAt(r.runes, __termInt(numberAt(r.cursor, 0, 0) + k), -1) === 41
}

export function flagOf(c: number): number {
  if (c === 105) {
    return 0
  } else if (c === 109) {
    return 1
  } else if (c === 115) {
    return 2
  }
  return 3
}

export function readFlags(r: Reading): boolean {
  advance(r, 2)
  let on: boolean = true
  let seen: boolean = false
  let turnsF: number = 0
  const __n60 = r.runes.length + 3; if (!(__n60 <= 9007199254740991 && __n60 >= -9007199254740991)) __termIntStop(__n60); const limitF: number = __n60
  while (numberAt(r.cursor, 0, 0) < r.runes.length && turnsF < limitF) {
    const __n61 = turnsF + 1; if (!(__n61 <= 9007199254740991 && __n61 >= -9007199254740991)) __termIntStop(__n61); turnsF = __n61
    const c: number = numberAt(r.runes, numberAt(r.cursor, 0, 0), -1)
    advance(r, 1)
    if (c === 105 || c === 109 || (c === 115 || c === 120)) {
      setFlag(r, flagOf(c), on)
      seen = true
    } else if (c === 45 && on) {
      on = false
    } else if (c === 41) {
      return false
    } else if (c === 58 && seen) {
      return true
    } else {
      refusePattern(numberAt(r.cursor, 0, 0), "a flag group takes only i, m, s and x")
    }
  }
  refusePattern(numberAt(r.cursor, 0, 0), "a flag group with no )")
  return false
}

export function parseQuantifier(r: Reading, atom: Piece): Piece {
  skipExtended(r)
  const c: number = numberAt(r.runes, numberAt(r.cursor, 0, 0), -1)
  let least: number = -1
  let most: number = -1
  if (c === 42) {
    least = 0
    most = -1
    advance(r, 1)
  } else if (c === 43) {
    least = 1
    most = -1
    advance(r, 1)
  } else if (c === 63) {
    least = 0
    most = 1
    advance(r, 1)
  } else if (c === 123) {
    const counts: number[] = readCounts(r)
    least = numberAt(counts, 0, 0)
    most = numberAt(counts, 1, -1)
  }
  if (least < 0) {
    return atom
  }
  if (isZeroWidth(atom)) {
    refusePattern(numberAt(r.cursor, 0, 0), "nothing to repeat")
  }
  let greedy: boolean = true
  let possessive: boolean = false
  const after: number = numberAt(r.runes, numberAt(r.cursor, 0, 0), -1)
  if (after === 63) {
    greedy = false
    advance(r, 1)
  } else if (after === 43) {
    possessive = true
    advance(r, 1)
  }
  const then: number = numberAt(r.runes, numberAt(r.cursor, 0, 0), -1)
  if (then === 42 || then === 43 || (then === 63 || then === 123)) {
    refusePattern(numberAt(r.cursor, 0, 0), "nothing to repeat")
  }
  return { form: "loop", body: atom, least: least, most: most, greedy: greedy, possessive: possessive }
}

export function readCounts(r: Reading): number[] {
  const start: number = numberAt(r.cursor, 0, 0)
  advance(r, 1)
  const least: number = readDecimal(r)
  if (least < 0) {
    refusePattern(numberAt(r.cursor, 0, 0), "a brace that is not a count: escape it with a backslash")
  }
  let most: number = least
  if (numberAt(r.runes, numberAt(r.cursor, 0, 0), -1) === 44) {
    advance(r, 1)
    most = readDecimal(r)
  }
  if (numberAt(r.runes, numberAt(r.cursor, 0, 0), -1) !== 125) {
    refusePattern(numberAt(r.cursor, 0, 0), "a brace that is not a count: escape it with a backslash")
  }
  advance(r, 1)
  if (least > mostCount || most > mostCount) {
    refusePattern(start, "a count above 100000")
  }
  if (most >= 0 && most < least) {
    refusePattern(start, "a count whose most is below its least")
  }
  const out: number[] = ([] as number[])
  out.push(least)
  out.push(most)
  return out
}

export function readDecimal(r: Reading): number {
  let value: number = -1
  let turnsE: number = 0
  const __n62 = r.runes.length + 3; if (!(__n62 <= 9007199254740991 && __n62 >= -9007199254740991)) __termIntStop(__n62); const limitE: number = __n62
  while (isAsciiDigit(numberAt(r.runes, numberAt(r.cursor, 0, 0), -1)) && turnsE < limitE) {
    const __n63 = turnsE + 1; if (!(__n63 <= 9007199254740991 && __n63 >= -9007199254740991)) __termIntStop(__n63); turnsE = __n63
    const __n64 = maxOf(value, 0) * 10 + __termInt(numberAt(r.runes, numberAt(r.cursor, 0, 0), -1) - 48); if (!(__n64 <= 9007199254740991 && __n64 >= -9007199254740991)) __termIntStop(__n64); value = __n64
    if (value > 10000000) {
      value = 10000000
    }
    advance(r, 1)
  }
  return value
}

export function maxOf(a: number, b: number): number {
  if (a > b) {
    return a
  }
  return b
}

export function letterPiece(r: Reading, c: number): Piece {
  if (numberAt(r.flags, 0, 0) === 1) {
    const closed: number[] = closeUnderCase(rangeSet(c, c))
    if (setSize(closed) > 1) {
      return { form: "ranges", set: closed }
    }
  }
  return { form: "letter", point: c }
}

export function parseAtom(r: Reading): Piece {
  const c: number = numberAt(r.runes, numberAt(r.cursor, 0, 0), -1)
  if (c === 40) {
    return parseGroup(r)
  } else if (c === 91) {
    return { form: "ranges", set: parseClass(r) }
  } else if (c === 46) {
    advance(r, 1)
    if (numberAt(r.flags, 2, 0) === 1) {
      return { form: "ranges", set: rangeSet(0, lastCodePoint) }
    }
    return { form: "ranges", set: negateSet(rangeSet(10, 10)) }
  } else if (c === 94) {
    advance(r, 1)
    if (numberAt(r.flags, 1, 0) === 1) {
      return { form: "edge", kind: edgeLineStart }
    }
    return { form: "edge", kind: edgeTextStart }
  } else if (c === 36) {
    advance(r, 1)
    if (numberAt(r.flags, 1, 0) === 1) {
      return { form: "edge", kind: edgeLineEnd }
    }
    return { form: "edge", kind: edgeTextEnd }
  } else if (c === 92) {
    return parseEscape(r)
  } else if (c === 42 || c === 43 || (c === 63 || c === 123)) {
    return refusePattern(numberAt(r.cursor, 0, 0), "nothing to repeat")
  } else if (c === 125 || c === 93) {
    return refusePattern(numberAt(r.cursor, 0, 0), "a lone closing brace or bracket: escape it with a backslash")
  }
  advance(r, 1)
  return letterPiece(r, c)
}

export function parseGroup(r: Reading): Piece {
  const start: number = numberAt(r.cursor, 0, 0)
  const outer: number[] = ([] as number[])
  for (const f of r.flags) {
    outer.push(f)
  }
  let kind: number = 0
  let index: number = 0
  let name: string = ""
  const second: number = numberAt(r.runes, __termInt(numberAt(r.cursor, 0, 0) + 1), -1)
  if (second !== 63) {
    kind = 1
    const nextGroup: number[] = r.nextGroup
    index = numberAt(nextGroup, 0, 1)
    putNumber(nextGroup, 0, __termInt(index + 1))
    advance(r, 1)
  } else {
    const third: number = numberAt(r.runes, __termInt(numberAt(r.cursor, 0, 0) + 2), -1)
    const fourth: number = numberAt(r.runes, __termInt(numberAt(r.cursor, 0, 0) + 3), -1)
    if (third === 58) {
      kind = 2
      advance(r, 3)
    } else if (third === 61) {
      kind = 3
      advance(r, 3)
    } else if (third === 33) {
      kind = 4
      advance(r, 3)
    } else if (third === 60 && fourth === 61) {
      kind = 5
      advance(r, 4)
    } else if (third === 60 && fourth === 33) {
      kind = 6
      advance(r, 4)
    } else if (third === 62) {
      kind = 7
      advance(r, 3)
    } else if (third === 60) {
      kind = 1
      advance(r, 3)
      name = readGroupName(r)
      const nextGroup: number[] = r.nextGroup
      index = numberAt(nextGroup, 0, 1)
      putNumber(nextGroup, 0, __termInt(index + 1))
    } else {
      const goesOn: boolean = readFlags(r)
      if (!goesOn) {
        refusePattern(start, "a flag group here must open with : ")
      }
      kind = 2
    }
  }
  const body: Piece = parseChoice(r)
  if (numberAt(r.runes, numberAt(r.cursor, 0, 0), -1) !== 41) {
    refusePattern(start, "a ( with no ) after it")
  }
  advance(r, 1)
  const flags: number[] = r.flags
  let f: number = 0
  for (const value of outer) {
    putNumber(flags, f, value)
    const __n65 = f + 1; if (!(__n65 <= 9007199254740991 && __n65 >= -9007199254740991)) __termIntStop(__n65); f = __n65
  }
  if (kind === 1) {
    return { form: "group", body: body, index: index, label: name }
  } else if (kind === 3) {
    return { form: "look", body: body, behind: false, negate: false }
  } else if (kind === 4) {
    return { form: "look", body: body, behind: false, negate: true }
  } else if (kind === 5) {
    return { form: "look", body: body, behind: true, negate: false }
  } else if (kind === 6) {
    return { form: "look", body: body, behind: true, negate: true }
  } else if (kind === 7) {
    return { form: "atom", body: body }
  }
  return body
}

export function readGroupName(r: Reading): string {
  const name: number[] = ([] as number[])
  let turnsD: number = 0
  const __n66 = r.runes.length + 3; if (!(__n66 <= 9007199254740991 && __n66 >= -9007199254740991)) __termIntStop(__n66); const limitD: number = __n66
  while (numberAt(r.cursor, 0, 0) < r.runes.length && numberAt(r.runes, numberAt(r.cursor, 0, 0), -1) !== 62 && turnsD < limitD) {
    const __n67 = turnsD + 1; if (!(__n67 <= 9007199254740991 && __n67 >= -9007199254740991)) __termIntStop(__n67); turnsD = __n67
    const c: number = numberAt(r.runes, numberAt(r.cursor, 0, 0), -1)
    const fits: boolean = c >= 65 && c <= 90 || c >= 97 && c <= 122 || c === 95 || c >= 48 && c <= 57 && name.length > 0
    if (!fits) {
      refusePattern(numberAt(r.cursor, 0, 0), "a group name is a letter or _ then letters, digits and _")
    }
    name.push(c)
    advance(r, 1)
  }
  if (name.length === 0 || numberAt(r.runes, numberAt(r.cursor, 0, 0), -1) !== 62) {
    refusePattern(numberAt(r.cursor, 0, 0), "a group name, then a closing angle bracket")
  }
  advance(r, 1)
  const written: string = fromRunes(name)
  let seen: number = 0
  for (const each of r.names) {
    if (each === written) {
      const __n68 = seen + 1; if (!(__n68 <= 9007199254740991 && __n68 >= -9007199254740991)) __termIntStop(__n68); seen = __n68
    }
  }
  if (seen > 1) {
    refuseHere(r, `two groups named ${written}`)
  }
  return written
}

export function escapeClass(c: number): number[] {
  const digits: number[] = rangeSet(48, 57)
  const word: number[] = normalizeSet([48, 57, 65, 90, 95, 95, 97, 122])
  const space: number[] = normalizeSet([9, 13, 32, 32])
  if (c === 100) {
    return digits
  } else if (c === 68) {
    return negateSet(digits)
  } else if (c === 119) {
    return word
  } else if (c === 87) {
    return negateSet(word)
  } else if (c === 115) {
    return space
  } else if (c === 83) {
    return negateSet(space)
  }
  const none: number[] = ([] as number[])
  return none
}

export function readProperty(r: Reading, negate: boolean): number[] {
  if (numberAt(r.runes, numberAt(r.cursor, 0, 0), -1) !== 123) {
    refusePattern(numberAt(r.cursor, 0, 0), "a property escape takes a name in braces")
  }
  advance(r, 1)
  const key: number[] = ([] as number[])
  const value: number[] = ([] as number[])
  let inValue: boolean = false
  let turnsC: number = 0
  const __n69 = r.runes.length + 3; if (!(__n69 <= 9007199254740991 && __n69 >= -9007199254740991)) __termIntStop(__n69); const limitC: number = __n69
  while (numberAt(r.cursor, 0, 0) < r.runes.length && numberAt(r.runes, numberAt(r.cursor, 0, 0), -1) !== 125 && turnsC < limitC) {
    const __n70 = turnsC + 1; if (!(__n70 <= 9007199254740991 && __n70 >= -9007199254740991)) __termIntStop(__n70); turnsC = __n70
    const c: number = numberAt(r.runes, numberAt(r.cursor, 0, 0), -1)
    if (c === 61 && !inValue) {
      inValue = true
    } else if (inValue) {
      value.push(c)
    } else {
      key.push(c)
    }
    advance(r, 1)
  }
  if (numberAt(r.runes, numberAt(r.cursor, 0, 0), -1) !== 125) {
    refusePattern(numberAt(r.cursor, 0, 0), "a property name with no closing brace")
  }
  advance(r, 1)
  const k: string = fromRunes(key)
  const v: string = fromRunes(value)
  let set: number[] = ([] as number[])
  if (inValue) {
    if (k === "General_Category" || k === "gc") {
      const mask: number = categoryMask(v)
      if (mask < 0) {
        refuseHere(r, `no General_Category is named ${v}`)
      }
      set = categorySet(mask)
    } else if (k === "Script" || k === "sc") {
      const id: number = scriptId(v)
      if (id < 0) {
        refuseHere(r, `no script is named ${v}`)
      }
      set = scriptSet(id)
    } else {
      refuseHere(r, `${k} is not a property this reader knows: General_Category, gc, Script and sc are`)
    }
  } else {
    const mask: number = categoryMask(k)
    if (mask >= 0) {
      set = categorySet(mask)
    } else {
      const row: number = binaryRow(k)
      if (row < 0) {
        refuseHere(r, `no property is named ${k}`)
      }
      set = binarySet(row)
    }
  }
  if (negate) {
    return negateSet(set)
  }
  return set
}

export function readEscapedCode(r: Reading): number {
  const c: number = numberAt(r.runes, numberAt(r.cursor, 0, 0), -1)
  if (c === 116) {
    advance(r, 1)
    return 9
  } else if (c === 110) {
    advance(r, 1)
    return 10
  } else if (c === 114) {
    advance(r, 1)
    return 13
  } else if (c === 102) {
    advance(r, 1)
    return 12
  } else if (c === 118) {
    advance(r, 1)
    return 11
  } else if (c === 48) {
    if (isAsciiDigit(numberAt(r.runes, __termInt(numberAt(r.cursor, 0, 0) + 1), -1))) {
      refusePattern(numberAt(r.cursor, 0, 0), "a zero escape followed by a digit: write the code point in hex")
    }
    advance(r, 1)
    return 0
  } else if (c === 120 || c === 117) {
    advance(r, 1)
    if (numberAt(r.runes, numberAt(r.cursor, 0, 0), -1) === 123) {
      advance(r, 1)
      let value: number = 0
      let digits: number = 0
      let turnsB: number = 0
      const __n71 = r.runes.length + 3; if (!(__n71 <= 9007199254740991 && __n71 >= -9007199254740991)) __termIntStop(__n71); const limitB: number = __n71
      while (hexValue(numberAt(r.runes, numberAt(r.cursor, 0, 0), -1)) >= 0 && turnsB < limitB) {
        const __n72 = turnsB + 1; if (!(__n72 <= 9007199254740991 && __n72 >= -9007199254740991)) __termIntStop(__n72); turnsB = __n72
        const __n73 = __termInt(value * 16) + hexValue(numberAt(r.runes, numberAt(r.cursor, 0, 0), -1)); if (!(__n73 <= 9007199254740991 && __n73 >= -9007199254740991)) __termIntStop(__n73); value = __n73
        const __n74 = digits + 1; if (!(__n74 <= 9007199254740991 && __n74 >= -9007199254740991)) __termIntStop(__n74); digits = __n74
        if (value > lastCodePoint) {
          refusePattern(numberAt(r.cursor, 0, 0), "a code point above 10FFFF")
        }
        advance(r, 1)
      }
      if (digits === 0 || numberAt(r.runes, numberAt(r.cursor, 0, 0), -1) !== 125) {
        refusePattern(numberAt(r.cursor, 0, 0), "a code point escape takes hex digits, then a closing brace")
      }
      advance(r, 1)
      return value
    }
    let width: number = 2
    if (c === 117) {
      width = 4
    }
    let value: number = 0
    let k: number = 0
    while (k < width) {
      const d: number = hexValue(numberAt(r.runes, numberAt(r.cursor, 0, 0), -1))
      if (d < 0) {
        refusePattern(numberAt(r.cursor, 0, 0), "a hex escape takes two digits, a unicode escape four, or either takes a code point in braces")
      }
      const __n75 = __termInt(value * 16) + d; if (!(__n75 <= 9007199254740991 && __n75 >= -9007199254740991)) __termIntStop(__n75); value = __n75
      advance(r, 1)
      k = k + 1
    }
    return value
  }
  if (c >= 65 && c <= 90 || c >= 97 && c <= 122 || c >= 48 && c <= 57 || c < 0) {
    return -1
  }
  advance(r, 1)
  return c
}

export function parseEscape(r: Reading): Piece {
  advance(r, 1)
  const c: number = numberAt(r.runes, numberAt(r.cursor, 0, 0), -1)
  const class_: number[] = escapeClass(c)
  if (class_.length > 0) {
    advance(r, 1)
    return { form: "ranges", set: class_ }
  }
  if (c === 112 || c === 80) {
    advance(r, 1)
    return { form: "ranges", set: readProperty(r, c === 80) }
  } else if (c === 98) {
    advance(r, 1)
    return { form: "edge", kind: edgeWord }
  } else if (c === 66) {
    advance(r, 1)
    return { form: "edge", kind: edgeNotWord }
  } else if (c === 65) {
    advance(r, 1)
    return { form: "edge", kind: edgeTextStart }
  } else if (c === 122) {
    advance(r, 1)
    return { form: "edge", kind: edgeTextEnd }
  } else if (c === 107) {
    advance(r, 1)
    if (numberAt(r.runes, numberAt(r.cursor, 0, 0), -1) !== 60) {
      return refusePattern(numberAt(r.cursor, 0, 0), "a named back reference takes a group name in angle brackets")
    }
    advance(r, 1)
    const name: string = readGroupName(r)
    let index: number = 0
    let k: number = 1
    for (const each of r.names) {
      if (each === name && index === 0) {
        index = k
      }
      const __n76 = k + 1; if (!(__n76 <= 9007199254740991 && __n76 >= -9007199254740991)) __termIntStop(__n76); k = __n76
    }
    if (index === 0) {
      return refuseHere(r, `no group is named ${name}`)
    }
    return { form: "refer", index: index, fold: numberAt(r.flags, 0, 0) === 1 }
  } else if (c >= 48 && c <= 57 && c !== 48) {
    const value: number = readDecimal(r)
    if (value > r.total) {
      return refuseHere(r, `back reference ${value} names a group the pattern does not have`)
    }
    return { form: "refer", index: value, fold: numberAt(r.flags, 0, 0) === 1 }
  }
  const code: number = readEscapedCode(r)
  if (code < 0) {
    return refusePattern(numberAt(r.cursor, 0, 0), "an escape this reader does not know")
  }
  return letterPiece(r, code)
}

export function parseClass(r: Reading): number[] {
  const start: number = numberAt(r.cursor, 0, 0)
  advance(r, 1)
  let negate: boolean = false
  if (numberAt(r.runes, numberAt(r.cursor, 0, 0), -1) === 94) {
    negate = true
    advance(r, 1)
  }
  const ranges: number[] = ([] as number[])
  let going: boolean = true
  let turnsA: number = 0
  const __n77 = r.runes.length + 3; if (!(__n77 <= 9007199254740991 && __n77 >= -9007199254740991)) __termIntStop(__n77); const limitA: number = __n77
  while (going && turnsA < limitA) {
    const __n78 = turnsA + 1; if (!(__n78 <= 9007199254740991 && __n78 >= -9007199254740991)) __termIntStop(__n78); turnsA = __n78
    const c: number = numberAt(r.runes, numberAt(r.cursor, 0, 0), -1)
    if (c < 0) {
      refusePattern(start, "a [ with no ] after it")
    }
    if (c === 93) {
      advance(r, 1)
      going = false
      continue
    }
    const low: number = classMember(r, ranges)
    if (low < 0) {
      continue
    }
    if (numberAt(r.runes, numberAt(r.cursor, 0, 0), -1) === 45 && numberAt(r.runes, __termInt(numberAt(r.cursor, 0, 0) + 1), -1) !== 93) {
      advance(r, 1)
      const high: number = classMember(r, ranges)
      if (high < 0) {
        refusePattern(numberAt(r.cursor, 0, 0), "a range in a class cannot end at a class escape")
      }
      if (high < low) {
        refusePattern(numberAt(r.cursor, 0, 0), "a range whose end comes before its start")
      }
      ranges.push(low)
      ranges.push(high)
    } else {
      ranges.push(low)
      ranges.push(low)
    }
  }
  let set: number[] = normalizeSet(ranges)
  if (numberAt(r.flags, 0, 0) === 1) {
    set = closeUnderCase(set)
  }
  if (negate) {
    return negateSet(set)
  }
  return set
}

export function classMember(r: Reading, ranges: number[]): number {
  const c: number = numberAt(r.runes, numberAt(r.cursor, 0, 0), -1)
  if (c !== 92) {
    advance(r, 1)
    return c
  }
  advance(r, 1)
  const e: number = numberAt(r.runes, numberAt(r.cursor, 0, 0), -1)
  const class_: number[] = escapeClass(e)
  let set: number[] = ([] as number[])
  let wasClass: boolean = false
  if (class_.length > 0) {
    advance(r, 1)
    set = class_
    wasClass = true
  } else if (e === 112 || e === 80) {
    advance(r, 1)
    set = readProperty(r, e === 80)
    wasClass = true
  } else if (e === 45) {
    advance(r, 1)
    return 45
  }
  if (wasClass) {
    for (const n of set) {
      ranges.push(n)
    }
    return -1
  }
  const code: number = readEscapedCode(r)
  if (code < 0) {
    refusePattern(numberAt(r.cursor, 0, 0), "an escape this reader does not know inside a class")
  }
  return code
}

export interface Program {
  ops: number[]
  a: number[]
  b: number[]
  partEntry: number[]
  partBackward: number[]
  sets: number[][]
  looks: number[]
  atoms: number[]
  groups: number
  starts: number[]
  slots: number[]
}

const opMatch: number = 0

const opChar: number = 1

const opSet: number = 2

const opSplit: number = 3

const opJump: number = 4

const opSave: number = 5

const opEdge: number = 6

const opLook: number = 7

const opRefer: number = 8

const opAtom: number = 9

const opClear: number = 10

const opMark: number = 11

const opCheck: number = 12

const mostInstructions: number = 200000

export function emit(g: Program, op: number, a: number, b: number): number {
  const at: number = g.ops.length
  if (at >= mostInstructions) {
    refusePattern(0, "the pattern compiles to more than 200000 instructions")
  }
  const ops: number[] = g.ops
  const as: number[] = g.a
  const bs: number[] = g.b
  ops.push(op)
  as.push(a)
  bs.push(b)
  return at
}

export function patchA(g: Program, at: number, value: number): number {
  const as: number[] = g.a
  if (at >= 0 && at < as.length) {
    putNumber(as, at, value)
  }
  return at
}

export function patchB(g: Program, at: number, value: number): number {
  const bs: number[] = g.b
  if (at >= 0 && at < bs.length) {
    putNumber(bs, at, value)
  }
  return at
}

export function newSlot(g: Program): number {
  const slots: number[] = g.slots
  const at: number = numberAt(slots, 0, 0)
  putNumber(slots, 0, __termInt(at + 1))
  return at
}

export function canBeEmpty(p: Piece): boolean {
  if (p.form === "blank") {
    return true
  } else if (p.form === "letter") {
    return false
  } else if (p.form === "ranges") {
    return false
  } else if (p.form === "edge") {
    return true
  } else if (p.form === "chain") {
    const parts = p.parts
    for (const part of parts) {
      if (!canBeEmpty(part)) {
        return false
      }
    }
    return true
  } else if (p.form === "choice") {
    const parts = p.parts
    for (const part of parts) {
      if (canBeEmpty(part)) {
        return true
      }
    }
    return false
  } else if (p.form === "loop") {
    const body = p.body
    const least = p.least
    if (least === 0) {
      return true
    }
    return canBeEmpty(body)
  } else if (p.form === "group") {
    const body = p.body
    return canBeEmpty(body)
  } else if (p.form === "atom") {
    const body = p.body
    return canBeEmpty(body)
  } else if (p.form === "look") {
    return true
  } else {
    return true
  }
}

export function firstSet(p: Piece): number[] {
  const none: number[] = ([] as number[])
  if (p.form === "blank") {
    return none
  } else if (p.form === "letter") {
    const point = p.point
    return rangeSet(point, point)
  } else if (p.form === "ranges") {
    const set = p.set
    return set
  } else if (p.form === "edge") {
    return none
  } else if (p.form === "chain") {
    const parts = p.parts
    let out: number[] = ([] as number[])
    for (const part of parts) {
      out = mergeSets(out, firstSet(part))
      if (!canBeEmpty(part)) {
        return out
      }
    }
    return out
  } else if (p.form === "choice") {
    const parts = p.parts
    let out: number[] = ([] as number[])
    for (const part of parts) {
      out = mergeSets(out, firstSet(part))
    }
    return out
  } else if (p.form === "loop") {
    const body = p.body
    return firstSet(body)
  } else if (p.form === "group") {
    const body = p.body
    return firstSet(body)
  } else if (p.form === "atom") {
    const body = p.body
    return firstSet(body)
  } else if (p.form === "look") {
    return none
  } else {
    return rangeSet(0, lastCodePoint)
  }
}

export function startSet(p: Piece): number[] {
  const none: number[] = ([] as number[])
  if (canBeEmpty(p)) {
    return none
  }
  const starts: number[] = firstSet(p)
  if (setSize(starts) === __termInt(lastCodePoint + 1)) {
    return none
  }
  return starts
}

export function groupRange(p: Piece): number[] {
  const out: number[] = ([] as number[])
  out.push(0)
  out.push(-1)
  widenGroupRange(p, out)
  return out
}

export function widenGroupRange(p: Piece, out: number[]): number {
  if (p.form === "group") {
    const body = p.body
    const index = p.index
    const low: number = numberAt(out, 0, 0)
    const high: number = numberAt(out, 1, -1)
    if (high < 0 || index < low) {
      putNumber(out, 0, index)
    }
    if (index > high) {
      putNumber(out, 1, index)
    }
    widenGroupRange(body, out)
  } else if (p.form === "chain") {
    const parts = p.parts
    for (const part of parts) {
      widenGroupRange(part, out)
    }
  } else if (p.form === "choice") {
    const parts = p.parts
    for (const part of parts) {
      widenGroupRange(part, out)
    }
  } else if (p.form === "loop") {
    const body = p.body
    widenGroupRange(body, out)
  } else if (p.form === "atom") {
    const body = p.body
    widenGroupRange(body, out)
  } else if (p.form === "look") {
    const body = p.body
    widenGroupRange(body, out)
  } else if (p.form === "blank") {
    return 0
  } else if (p.form === "letter") {
    return 0
  } else if (p.form === "ranges") {
    return 0
  } else if (p.form === "edge") {
    return 0
  } else {
    return 0
  }
  return 0
}

export function usesWordEdge(g: Program): boolean {
  let k: number = 0
  while (k < g.ops.length) {
    if (numberAt(g.ops, k, -1) === opEdge && numberAt(g.a, k, 0) >= 4) {
      return true
    }
    k = k + 1
  }
  return false
}

export function compilePattern(source: Parsed): Program {
  const slots: number[] = ([] as number[])
  slots.push(__termInt(__termInt(source.groups + 1) * 2))
  const g: Program = { ops: ([] as number[]), a: ([] as number[]), b: ([] as number[]), partEntry: ([] as number[]), partBackward: ([] as number[]), sets: ([] as number[][]), looks: ([] as number[]), atoms: ([] as number[]), groups: source.groups, starts: startSet(source.root), slots: slots }
  const entries: number[] = g.partEntry
  const ways: number[] = g.partBackward
  entries.push(0)
  ways.push(0)
  emit(g, opSave, 0, 0)
  compilePiece(g, source.root, false)
  emit(g, opSave, 1, 0)
  emit(g, opMatch, 0, 0)
  return g
}

export function compilePart(g: Program, p: Piece, backward: boolean): number {
  const index: number = g.partEntry.length
  const entries: number[] = g.partEntry
  const ways: number[] = g.partBackward
  entries.push(g.ops.length)
  if (backward) {
    ways.push(1)
  } else {
    ways.push(0)
  }
  compilePiece(g, p, backward)
  emit(g, opMatch, 0, 0)
  return index
}

export function compilePiece(g: Program, p: Piece, backward: boolean): number {
  if (p.form === "blank") {
    return 0
  } else if (p.form === "letter") {
    const point = p.point
    emit(g, opChar, point, 0)
  } else if (p.form === "ranges") {
    const set = p.set
    const sets: number[][] = g.sets
    const at: number = sets.length
    sets.push(set)
    emit(g, opSet, at, 0)
  } else if (p.form === "edge") {
    const kind = p.kind
    emit(g, opEdge, kind, 0)
  } else if (p.form === "chain") {
    const parts = p.parts
    const count: number = parts.length
    let k: number = 0
    while (k < count) {
      let which: number = k
      if (backward) {
        const __n79 = __termInt(count - 1) - k; if (!(__n79 <= 9007199254740991 && __n79 >= -9007199254740991)) __termIntStop(__n79); which = __n79
      }
      compilePiece(g, pieceAt(parts, which), backward)
      k = k + 1
    }
  } else if (p.form === "choice") {
    const parts = p.parts
    const jumps: number[] = ([] as number[])
    const count: number = parts.length
    let k: number = 0
    while (k < count) {
      const part: Piece = pieceAt(parts, k)
      if (k < __termInt(count - 1)) {
        const split: number = emit(g, opSplit, 0, 0)
        patchA(g, split, g.ops.length)
        compilePiece(g, part, backward)
        jumps.push(emit(g, opJump, 0, 0))
        patchB(g, split, g.ops.length)
      } else {
        compilePiece(g, part, backward)
      }
      k = k + 1
    }
    const end: number = g.ops.length
    for (const at of jumps) {
      patchA(g, at, end)
    }
  } else if (p.form === "group") {
    const body = p.body
    const index = p.index
    const __n80 = index * 2; if (!(__n80 <= 9007199254740991 && __n80 >= -9007199254740991)) __termIntStop(__n80); const first: number = __n80
    const __n81 = first + 1; if (!(__n81 <= 9007199254740991 && __n81 >= -9007199254740991)) __termIntStop(__n81); const last: number = __n81
    if (backward) {
      emit(g, opSave, last, 0)
      compilePiece(g, body, backward)
      emit(g, opSave, first, 0)
    } else {
      emit(g, opSave, first, 0)
      compilePiece(g, body, backward)
      emit(g, opSave, last, 0)
    }
  } else if (p.form === "loop") {
    const body = p.body
    const least = p.least
    const most = p.most
    const greedy = p.greedy
    const possessive = p.possessive
    if (possessive) {
      return compilePiece(g, { form: "atom", body: { form: "loop", body: body, least: least, most: most, greedy: true, possessive: false } }, backward)
    }
    compileLoop(g, body, least, most, greedy, backward)
  } else if (p.form === "atom") {
    const body = p.body
    const part: number = compileNested(g, body, backward)
    const atoms: number[] = g.atoms
    const at: number = atoms.length
    atoms.push(part)
    emit(g, opAtom, at, 0)
  } else if (p.form === "look") {
    const body = p.body
    const behind = p.behind
    const negate = p.negate
    const forward: number = compileNested(g, body, false)
    const reverse: number = compileNested(g, body, true)
    const range: number[] = groupRange(body)
    let stamp: number = -1
    if (!negate && numberAt(range, 1, -1) >= 1) {
      stamp = newSlot(g)
    }
    const looks: number[] = g.looks
    const at: number = Math.trunc(looks.length / 7)
    looks.push(forward)
    looks.push(reverse)
    if (behind) {
      looks.push(1)
    } else {
      looks.push(0)
    }
    if (negate) {
      looks.push(1)
    } else {
      looks.push(0)
    }
    looks.push(stamp)
    looks.push(numberAt(range, 0, 0))
    looks.push(numberAt(range, 1, -1))
    emit(g, opLook, at, stamp)
  } else {
    const index = p.index
    const fold = p.fold
    let folded: number = 0
    if (fold) {
      folded = 1
    }
    emit(g, opRefer, index, folded)
  }
  return 0
}

export function pieceAt(parts: Piece[], k: number): Piece {
  if (k >= 0 && k < parts.length) {
    return (k >= 0 && k < parts.length ? parts[k]! : __termReadPast(parts, k))
  }
  return __termVariantBlank
}

export function compileNested(g: Program, body: Piece, backward: boolean): number {
  const over: number = emit(g, opJump, 0, 0)
  const part: number = compilePart(g, body, backward)
  patchA(g, over, g.ops.length)
  return part
}

export function compileIteration(g: Program, body: Piece, backward: boolean, optional: boolean, range: number[]): number {
  const low: number = numberAt(range, 0, 0)
  const high: number = numberAt(range, 1, -1)
  if (high >= 1) {
    emit(g, opClear, __termInt(low * 2), __termInt(__termInt(high * 2) + 1))
  }
  const guard: boolean = optional && canBeEmpty(body)
  let mark: number = -1
  if (guard) {
    mark = newSlot(g)
    emit(g, opMark, mark, 0)
  }
  const registersFrom: number = numberAt(g.slots, 0, 0)
  const clearAt: number = emit(g, opJump, 0, 0)
  compilePiece(g, body, backward)
  const registersTo: number = numberAt(g.slots, 0, 0)
  if (registersTo > registersFrom) {
    const ops: number[] = g.ops
    putNumber(ops, clearAt, opClear)
    patchA(g, clearAt, registersFrom)
    patchB(g, clearAt, __termInt(registersTo - 1))
  } else {
    patchA(g, clearAt, __termInt(clearAt + 1))
  }
  if (guard) {
    emit(g, opCheck, mark, 0)
  }
  return 0
}

export function compileLoop(g: Program, body: Piece, least: number, most: number, greedy: boolean, backward: boolean): number {
  const range: number[] = groupRange(body)
  let k: number = 0
  while (k < least) {
    compileIteration(g, body, backward, false, range)
    k = k + 1
  }
  if (most < 0) {
    const top: number = emit(g, opSplit, 0, 0)
    const inside: number = g.ops.length
    compileIteration(g, body, backward, true, range)
    emit(g, opJump, top, 0)
    const exit: number = g.ops.length
    if (greedy) {
      patchA(g, top, inside)
      patchB(g, top, exit)
    } else {
      patchA(g, top, exit)
      patchB(g, top, inside)
    }
    return 0
  }
  const splits: number[] = ([] as number[])
  k = least
  while (k < most) {
    const split: number = emit(g, opSplit, 0, 0)
    splits.push(split)
    const inside: number = g.ops.length
    if (greedy) {
      patchA(g, split, inside)
    } else {
      patchB(g, split, inside)
    }
    compileIteration(g, body, backward, true, range)
    k = k + 1
  }
  const exit: number = g.ops.length
  for (const split of splits) {
    if (greedy) {
      patchB(g, split, exit)
    } else {
      patchA(g, split, exit)
    }
  }
  return 0
}

export interface Scene {
  runes: number[]
  word: number[]
  wordAt: number[]
  folds: number[]
}

export function makeSceneFor(runes: number[], needsWord: boolean, needsFolds: boolean): Scene {
  let word: number[] = ([] as number[])
  const wordAt: number[] = ([] as number[])
  if (needsWord) {
    word = wordSet()
    for (const rune of runes) {
      wordAt.push(-1)
    }
  }
  let folds: number[] = ([] as number[])
  if (needsFolds) {
    folds = foldPairs()
  }
  return { runes: runes, word: word, wordAt: wordAt, folds: folds }
}

export function isWordAt(s: Scene, at: number): boolean {
  if (at < 0 || at >= s.runes.length) {
    return false
  }
  const known: number = numberAt(s.wordAt, at, -1)
  if (known >= 0) {
    return known === 1
  }
  const holds: boolean = setHas(s.word, numberAt(s.runes, at, -1))
  if (at < s.wordAt.length) {
    if (holds) {
      putNumber(s.wordAt, at, 1)
    } else {
      putNumber(s.wordAt, at, 0)
    }
  }
  return holds
}

export function edgeHolds(s: Scene, kind: number, at: number): boolean {
  const n: number = s.runes.length
  if (kind === edgeTextStart) {
    return at === 0
  } else if (kind === edgeTextEnd) {
    return at === n
  } else if (kind === edgeLineStart) {
    return at === 0 || numberAt(s.runes, __termInt(at - 1), -1) === 10
  } else if (kind === edgeLineEnd) {
    return at === n || numberAt(s.runes, at, -1) === 10
  }
  const before: boolean = isWordAt(s, __termInt(at - 1))
  const after: boolean = isWordAt(s, at)
  const boundary: boolean = before !== after
  if (kind === edgeWord) {
    return boundary
  }
  return !boundary
}

export function runeFrom(s: Scene, at: number, backward: boolean): number {
  if (backward) {
    return numberAt(s.runes, __termInt(at - 1), -1)
  }
  return numberAt(s.runes, at, -1)
}

export interface Threads {
  pcs: number[]
  slots: number[][]
}

export function lookHolds(g: Program, tables: number[][], look: number, at: number): boolean {
  let table: number[] = ([] as number[])
  if (look >= 0 && look < tables.length) {
    table = (look >= 0 && look < tables.length ? tables[look]! : __termReadPast(tables, look))
  }
  const holds: boolean = numberAt(table, at, 0) === 1
  const negate: boolean = numberAt(g.looks, __termInt(__termInt(look * 7) + 3), 0) === 1
  if (negate) {
    return !holds
  }
  return holds
}

export function takesRune(g: Program, pc: number, c: number): boolean {
  if (c < 0) {
    return false
  }
  const op: number = numberAt(g.ops, pc, -1)
  if (op === opChar) {
    return c === numberAt(g.a, pc, 0)
  } else if (op === opSet) {
    const index: number = numberAt(g.a, pc, 0)
    if (index >= 0 && index < g.sets.length) {
      return setHas((index >= 0 && index < g.sets.length ? g.sets[index]! : __termReadPast(g.sets, index)), c)
    }
  }
  return false
}

export function follow(g: Program, s: Scene, tables: number[][], into: Threads, seen: number[], stamp: number, start: number, at: number, first: number[], keep: boolean): number {
  const stackPc: number[] = ([] as number[])
  const stackSlots: number[][] = ([] as number[][])
  stackPc.push(start)
  stackSlots.push(first)
  let added: number = 0
  const intoPcs: number[] = into.pcs
  const intoSlots: number[][] = into.slots
  const __n82 = __termInt(g.ops.length * 2) + 3; if (!(__n82 <= 9007199254740991 && __n82 >= -9007199254740991)) __termIntStop(__n82); const limit: number = __n82
  let turns: number = 0
  while (stackPc.length > 0 && turns < limit) {
    const __n83 = turns + 1; if (!(__n83 <= 9007199254740991 && __n83 >= -9007199254740991)) __termIntStop(__n83); turns = __n83
    const pc: number = __termPop(stackPc)
    const slots: number[] = __termPop(stackSlots)
    if (pc < 0 || pc >= seen.length) {
      continue
    }
    if (numberAt(seen, pc, -1) === stamp) {
      continue
    }
    const op: number = numberAt(g.ops, pc, -1)
    if (op === opCheck) {
      if (keep && numberAt(slots, numberAt(g.a, pc, 0), -2) === at) {
        continue
      }
      putNumber(seen, pc, stamp)
      stackPc.push(__termInt(pc + 1))
      stackSlots.push(slots)
      continue
    }
    putNumber(seen, pc, stamp)
    if (op === opJump) {
      stackPc.push(numberAt(g.a, pc, 0))
      stackSlots.push(slots)
    } else if (op === opSplit) {
      stackPc.push(numberAt(g.b, pc, 0))
      stackSlots.push(slots)
      stackPc.push(numberAt(g.a, pc, 0))
      stackSlots.push(slots)
    } else if (op === opSave || op === opMark) {
      let next: number[] = slots
      if (keep) {
        next = copyNumbers(slots)
        putNumber(next, numberAt(g.a, pc, 0), at)
      }
      stackPc.push(__termInt(pc + 1))
      stackSlots.push(next)
    } else if (op === opClear) {
      let next: number[] = slots
      if (keep) {
        next = copyNumbers(slots)
        let k: number = numberAt(g.a, pc, 0)
        const last: number = numberAt(g.b, pc, 0)
        while (k <= last) {
          putNumber(next, k, -1)
          const __n84 = k + 1; if (!(__n84 <= 9007199254740991 && __n84 >= -9007199254740991)) __termIntStop(__n84); k = __n84
        }
      }
      stackPc.push(__termInt(pc + 1))
      stackSlots.push(next)
    } else if (op === opEdge) {
      if (edgeHolds(s, numberAt(g.a, pc, 0), at)) {
        stackPc.push(__termInt(pc + 1))
        stackSlots.push(slots)
      }
    } else if (op === opLook) {
      if (lookHolds(g, tables, numberAt(g.a, pc, 0), at)) {
        let next: number[] = slots
        const stampSlot: number = numberAt(g.b, pc, 0)
        if (keep) {
          next = copyNumbers(slots)
          putNumber(next, stampSlot, at)
        }
        stackPc.push(__termInt(pc + 1))
        stackSlots.push(next)
      }
    } else {
      intoPcs.push(pc)
      intoSlots.push(slots)
      const __n85 = added + 1; if (!(__n85 <= 9007199254740991 && __n85 >= -9007199254740991)) __termIntStop(__n85); added = __n85
    }
  }
  return added
}

export function lookTable(g: Program, s: Scene, tables: number[][], look: number): number[] {
  const __n86 = look * 7; if (!(__n86 <= 9007199254740991 && __n86 >= -9007199254740991)) __termIntStop(__n86); const base: number = __n86
  const behind: boolean = numberAt(g.looks, __termInt(base + 2), 0) === 1
  let part: number = numberAt(g.looks, __termInt(base + 1), 0)
  let backward: boolean = true
  if (behind) {
    part = numberAt(g.looks, base, 0)
    backward = false
  }
  const entry: number = numberAt(g.partEntry, part, 0)
  const n: number = s.runes.length
  const table: number[] = ([] as number[])
  let k: number = 0
  while (k <= n) {
    table.push(0)
    const __n87 = k + 1; if (!(__n87 <= 9007199254740991 && __n87 >= -9007199254740991)) __termIntStop(__n87); k = __n87
  }
  const seen: number[] = ([] as number[])
  for (const op of g.ops) {
    seen.push(-1)
  }
  const none: number[] = ([] as number[])
  let current: Threads = { pcs: ([] as number[]), slots: ([] as number[][]) }
  let stamp: number = 0
  let at: number = n
  if (!backward) {
    at = 0
  }
  let steps: number = 0
  while (steps <= n) {
    follow(g, s, tables, current, seen, stamp, entry, at, none, false)
    const next: Threads = { pcs: ([] as number[]), slots: ([] as number[][]) }
    const __n88 = stamp + 1; if (!(__n88 <= 9007199254740991 && __n88 >= -9007199254740991)) __termIntStop(__n88); stamp = __n88
    let after: number = at
    if (backward) {
      const __n89 = at - 1; if (!(__n89 <= 9007199254740991 && __n89 >= -9007199254740991)) __termIntStop(__n89); after = __n89
    } else {
      const __n90 = at + 1; if (!(__n90 <= 9007199254740991 && __n90 >= -9007199254740991)) __termIntStop(__n90); after = __n90
    }
    const c: number = runeFrom(s, at, backward)
    for (const pc of current.pcs) {
      const op: number = numberAt(g.ops, pc, -1)
      if (op === opMatch) {
        if (at >= 0 && at < table.length) {
          putNumber(table, at, 1)
        }
      } else if (takesRune(g, pc, c)) {
        follow(g, s, tables, next, seen, stamp, __termInt(pc + 1), after, none, false)
      }
    }
    current = next
    at = after
    const __n91 = steps + 1; if (!(__n91 <= 9007199254740991 && __n91 >= -9007199254740991)) __termIntStop(__n91); steps = __n91
  }
  return table
}

export function lookTables(g: Program, s: Scene): number[][] {
  const tables: number[][] = ([] as number[][])
  const count: number = Math.trunc(g.looks.length / 7)
  let k: number = 0
  while (k < count) {
    tables.push(lookTable(g, s, tables, k))
    k = k + 1
  }
  return tables
}

export function runPart(g: Program, s: Scene, tables: number[][], part: number, start: number, first: number[], anchored: boolean): number[] {
  const entry: number = numberAt(g.partEntry, part, 0)
  const backward: boolean = numberAt(g.partBackward, part, 0) === 1
  const n: number = s.runes.length
  const seen: number[] = ([] as number[])
  for (const op of g.ops) {
    seen.push(-1)
  }
  let matched: number[] = ([] as number[])
  let found: boolean = false
  let current: Threads = { pcs: ([] as number[]), slots: ([] as number[][]) }
  let stamp: number = 0
  let at: number = start
  let going: boolean = true
  let starts: number[] = ([] as number[])
  if (part === 0 && (!anchored && !backward)) {
    starts = g.starts
  }
  const filtered: boolean = starts.length > 0
  const __n92 = n + 3; if (!(__n92 <= 9007199254740991 && __n92 >= -9007199254740991)) __termIntStop(__n92); const limit: number = __n92
  let turns: number = 0
  while (going && turns < limit) {
    const __n93 = turns + 1; if (!(__n93 <= 9007199254740991 && __n93 >= -9007199254740991)) __termIntStop(__n93); turns = __n93
    const canStart: boolean = !filtered || setHas(starts, runeFrom(s, at, false))
    if (!found && canStart && (!anchored || at === start)) {
      follow(g, s, tables, current, seen, stamp, entry, at, copyNumbers(first), true)
    }
    const next: Threads = { pcs: ([] as number[]), slots: ([] as number[][]) }
    const __n94 = stamp + 1; if (!(__n94 <= 9007199254740991 && __n94 >= -9007199254740991)) __termIntStop(__n94); stamp = __n94
    let after: number = at
    if (backward) {
      const __n95 = at - 1; if (!(__n95 <= 9007199254740991 && __n95 >= -9007199254740991)) __termIntStop(__n95); after = __n95
    } else {
      const __n96 = at + 1; if (!(__n96 <= 9007199254740991 && __n96 >= -9007199254740991)) __termIntStop(__n96); after = __n96
    }
    const c: number = runeFrom(s, at, backward)
    let i: number = 0
    const waiting: number = current.pcs.length
    while (i < waiting) {
      const pc: number = numberAt(current.pcs, i, -1)
      let slots: number[] = ([] as number[])
      const waitingSlots: number[][] = current.slots
      if (i >= 0 && i < waitingSlots.length) {
        slots = (i >= 0 && i < waitingSlots.length ? waitingSlots[i]! : __termReadPast(waitingSlots, i))
      }
      if (numberAt(g.ops, pc, -1) === opMatch) {
        matched = slots
        found = true
        i = waiting
        continue
      }
      if (takesRune(g, pc, c)) {
        follow(g, s, tables, next, seen, stamp, __termInt(pc + 1), after, slots, true)
      }
      const __n97 = i + 1; if (!(__n97 <= 9007199254740991 && __n97 >= -9007199254740991)) __termIntStop(__n97); i = __n97
    }
    const edgePassed: boolean = after < 0 || after > n
    const idle: boolean = next.pcs.length === 0 && (found || anchored)
    if (edgePassed || idle) {
      going = false
    }
    current = next
    at = after
  }
  return matched
}

export function fillLookGroups(g: Program, s: Scene, tables: number[][], slots: number[]): number[] {
  let out: number[] = slots
  const __n98 = Math.trunc(g.looks.length / 7) - 1; if (!(__n98 <= 9007199254740991 && __n98 >= -9007199254740991)) __termIntStop(__n98); let k: number = __n98
  while (k >= 0) {
    const __n99 = k * 7; if (!(__n99 <= 9007199254740991 && __n99 >= -9007199254740991)) __termIntStop(__n99); const base: number = __n99
    const stamp: number = numberAt(g.looks, __termInt(base + 4), -1)
    const where: number = numberAt(out, stamp, -1)
    if (stamp >= 0 && where >= 0) {
      const behind: boolean = numberAt(g.looks, __termInt(base + 2), 0) === 1
      let part: number = numberAt(g.looks, base, 0)
      if (behind) {
        part = numberAt(g.looks, __termInt(base + 1), 0)
      }
      const inner: number[] = runPart(g, s, tables, part, where, out, true)
      if (inner.length > 0) {
        out = inner
      }
    }
    k = k - 1
  }
  return out
}

export function pikeSearchWith(g: Program, s: Scene, tables: number[][], from: number): number[] {
  const first: number[] = ([] as number[])
  let k: number = 0
  const count: number = numberAt(g.slots, 0, 0)
  while (k < count) {
    first.push(-1)
    k = k + 1
  }
  const slots: number[] = runPart(g, s, tables, 0, from, first, false)
  if (slots.length === 0) {
    return slots
  }
  const filled: number[] = fillLookGroups(g, s, tables, slots)
  const __n100 = __termInt(g.groups + 1) * 2; if (!(__n100 <= 9007199254740991 && __n100 >= -9007199254740991)) __termIntStop(__n100); const width: number = __n100
  const out: number[] = ([] as number[])
  let i: number = 0
  while (i < width) {
    out.push(numberAt(filled, i, -1))
    i = i + 1
  }
  return out
}

export function countStep(budget: number[], at: number): number {
  const __n101 = numberAt(budget, 0, 0) + 1; if (!(__n101 <= 9007199254740991 && __n101 >= -9007199254740991)) __termIntStop(__n101); const taken: number = __n101
  putNumber(budget, 0, taken)
  if (taken > numberAt(budget, 1, 0)) {
    throw new TermException({ host: "@local", form: "pattern-budget", code: exceptionCode(), time: date.now(), note: "Pattern work over its limit", link: { thing: "pattern", limit: numberAt(budget, 1, 0), actual: taken, at: at }, base: undefined as any, site: undefined as any, flow: [] })
  }
  return taken
}

export function referEnd(s: Scene, slots: number[], index: number, fold: boolean, at: number, backward: boolean): number {
  const start: number = numberAt(slots, __termInt(index * 2), -1)
  const end: number = numberAt(slots, __termInt(__termInt(index * 2) + 1), -1)
  if (start < 0 || end < 0) {
    return at
  }
  const __n102 = end - start; if (!(__n102 <= 9007199254740991 && __n102 >= -9007199254740991)) __termIntStop(__n102); const size: number = __n102
  let from: number = at
  if (backward) {
    const __n103 = at - size; if (!(__n103 <= 9007199254740991 && __n103 >= -9007199254740991)) __termIntStop(__n103); from = __n103
  }
  if (from < 0 || __termInt(from + size) > s.runes.length) {
    return -1
  }
  let k: number = 0
  while (k < size) {
    let a: number = numberAt(s.runes, __termInt(start + k), -1)
    let b: number = numberAt(s.runes, __termInt(from + k), -2)
    if (fold) {
      a = foldLeast(s.folds, a)
      b = foldLeast(s.folds, b)
    }
    if (a !== b) {
      return -1
    }
    k = k + 1
  }
  if (backward) {
    return from
  }
  const __n104 = at + size; if (!(__n104 <= 9007199254740991 && __n104 >= -9007199254740991)) __termIntStop(__n104); return __n104
}

export function backRun(g: Program, s: Scene, part: number, at: number, slots: number[], budget: number[]): number {
  const backward: boolean = numberAt(g.partBackward, part, 0) === 1
  let pc: number = numberAt(g.partEntry, part, 0)
  let pos: number = at
  const kinds: number[] = ([] as number[])
  const firsts: number[] = ([] as number[])
  const seconds: number[] = ([] as number[])
  let running: boolean = true
  const __n105 = numberAt(budget, 1, 0) + 2; if (!(__n105 <= 9007199254740991 && __n105 >= -9007199254740991)) __termIntStop(__n105); const limit: number = __n105
  let turns: number = 0
  while (running && turns < limit) {
    const __n106 = turns + 1; if (!(__n106 <= 9007199254740991 && __n106 >= -9007199254740991)) __termIntStop(__n106); turns = __n106
    countStep(budget, at)
    const op: number = numberAt(g.ops, pc, -1)
    let failed: boolean = false
    if (op === opMatch) {
      return pos
    } else if (op === opChar || op === opSet) {
      const c: number = runeFrom(s, pos, backward)
      if (takesRune(g, pc, c)) {
        const __n107 = pc + 1; if (!(__n107 <= 9007199254740991 && __n107 >= -9007199254740991)) __termIntStop(__n107); pc = __n107
        if (backward) {
          const __n108 = pos - 1; if (!(__n108 <= 9007199254740991 && __n108 >= -9007199254740991)) __termIntStop(__n108); pos = __n108
        } else {
          const __n109 = pos + 1; if (!(__n109 <= 9007199254740991 && __n109 >= -9007199254740991)) __termIntStop(__n109); pos = __n109
        }
      } else {
        failed = true
      }
    } else if (op === opSplit) {
      kinds.push(0)
      firsts.push(numberAt(g.b, pc, 0))
      seconds.push(pos)
      pc = numberAt(g.a, pc, 0)
    } else if (op === opJump) {
      pc = numberAt(g.a, pc, 0)
    } else if (op === opSave || op === opMark) {
      const slot: number = numberAt(g.a, pc, 0)
      kinds.push(1)
      firsts.push(slot)
      seconds.push(numberAt(slots, slot, -1))
      putNumber(slots, slot, pos)
      const __n110 = pc + 1; if (!(__n110 <= 9007199254740991 && __n110 >= -9007199254740991)) __termIntStop(__n110); pc = __n110
    } else if (op === opClear) {
      let k: number = numberAt(g.a, pc, 0)
      const last: number = numberAt(g.b, pc, 0)
      while (k <= last) {
        kinds.push(1)
        firsts.push(k)
        seconds.push(numberAt(slots, k, -1))
        putNumber(slots, k, -1)
        const __n111 = k + 1; if (!(__n111 <= 9007199254740991 && __n111 >= -9007199254740991)) __termIntStop(__n111); k = __n111
      }
      const __n112 = pc + 1; if (!(__n112 <= 9007199254740991 && __n112 >= -9007199254740991)) __termIntStop(__n112); pc = __n112
    } else if (op === opCheck) {
      if (numberAt(slots, numberAt(g.a, pc, 0), -2) === pos) {
        failed = true
      } else {
        const __n113 = pc + 1; if (!(__n113 <= 9007199254740991 && __n113 >= -9007199254740991)) __termIntStop(__n113); pc = __n113
      }
    } else if (op === opEdge) {
      if (edgeHolds(s, numberAt(g.a, pc, 0), pos)) {
        const __n114 = pc + 1; if (!(__n114 <= 9007199254740991 && __n114 >= -9007199254740991)) __termIntStop(__n114); pc = __n114
      } else {
        failed = true
      }
    } else if (op === opRefer) {
      const end: number = referEnd(s, slots, numberAt(g.a, pc, 0), numberAt(g.b, pc, 0) === 1, pos, backward)
      if (end >= 0) {
        pos = end
        const __n115 = pc + 1; if (!(__n115 <= 9007199254740991 && __n115 >= -9007199254740991)) __termIntStop(__n115); pc = __n115
      } else {
        failed = true
      }
    } else if (op === opLook) {
      const __n116 = numberAt(g.a, pc, 0) * 7; if (!(__n116 <= 9007199254740991 && __n116 >= -9007199254740991)) __termIntStop(__n116); const base: number = __n116
      const behind: boolean = numberAt(g.looks, __termInt(base + 2), 0) === 1
      const negate: boolean = numberAt(g.looks, __termInt(base + 3), 0) === 1
      part = numberAt(g.looks, base, 0)
      if (behind) {
        part = numberAt(g.looks, __termInt(base + 1), 0)
      }
      const inner: number[] = copyNumbers(slots)
      const end: number = backRun(g, s, part, pos, inner, budget)
      const holds: boolean = end >= 0
      if (negate) {
        if (holds) {
          failed = true
        } else {
          const __n117 = pc + 1; if (!(__n117 <= 9007199254740991 && __n117 >= -9007199254740991)) __termIntStop(__n117); pc = __n117
        }
      } else {
        if (holds) {
          adoptSlots(slots, inner, kinds, firsts, seconds)
          const __n118 = pc + 1; if (!(__n118 <= 9007199254740991 && __n118 >= -9007199254740991)) __termIntStop(__n118); pc = __n118
        } else {
          failed = true
        }
      }
    } else if (op === opAtom) {
      part = numberAt(g.atoms, numberAt(g.a, pc, 0), 0)
      const inner: number[] = copyNumbers(slots)
      const end: number = backRun(g, s, part, pos, inner, budget)
      if (end >= 0) {
        adoptSlots(slots, inner, kinds, firsts, seconds)
        pos = end
        const __n119 = pc + 1; if (!(__n119 <= 9007199254740991 && __n119 >= -9007199254740991)) __termIntStop(__n119); pc = __n119
      } else {
        failed = true
      }
    } else {
      failed = true
    }
    if (failed) {
      let resumed: boolean = false
      const entries: number = kinds.length
      let popped: number = 0
      while (!resumed && popped < entries) {
        const __n120 = popped + 1; if (!(__n120 <= 9007199254740991 && __n120 >= -9007199254740991)) __termIntStop(__n120); popped = __n120
        const kind: number = __termPop(kinds)
        const first: number = __termPop(firsts)
        const second: number = __termPop(seconds)
        if (kind === 0) {
          pc = first
          pos = second
          resumed = true
        } else {
          putNumber(slots, first, second)
        }
      }
      if (!resumed) {
        running = false
      }
    }
  }
  return -1
}

export function adoptSlots(slots: number[], inner: number[], kinds: number[], firsts: number[], seconds: number[]): number {
  let k: number = 0
  const size: number = slots.length
  while (k < size) {
    const was: number = numberAt(slots, k, -1)
    const now: number = numberAt(inner, k, -1)
    if (was !== now) {
      kinds.push(1)
      firsts.push(k)
      seconds.push(was)
      putNumber(slots, k, now)
    }
    k = k + 1
  }
  return k
}

export function backSearch(g: Program, s: Scene, from: number, limit: number): number[] {
  const budget: number[] = ([] as number[])
  budget.push(0)
  budget.push(limit)
  const count: number = numberAt(g.slots, 0, 0)
  const __n121 = __termInt(g.groups + 1) * 2; if (!(__n121 <= 9007199254740991 && __n121 >= -9007199254740991)) __termIntStop(__n121); const width: number = __n121
  let start: number = from
  const n: number = s.runes.length
  while (start <= n) {
    const slots: number[] = ([] as number[])
    let k: number = 0
    while (k < count) {
      slots.push(-1)
      k = k + 1
    }
    const end: number = backRun(g, s, 0, start, slots, budget)
    if (end >= 0) {
      const out: number[] = ([] as number[])
      let i: number = 0
      while (i < width) {
        out.push(numberAt(slots, i, -1))
        i = i + 1
      }
      return out
    }
    const __n122 = start + 1; if (!(__n122 <= 9007199254740991 && __n122 >= -9007199254740991)) __termIntStop(__n122); start = __n122
  }
  const none: number[] = ([] as number[])
  return none
}

const mostStates: number = 4096

const mostClasses: number = 512

export interface Dfa {
  program: Program
  entry: number
  bounds: number[]
  width: number
  edges: boolean
  lookBits: number[]
  keys: Map<string, number>
  pcs: number[][]
  restarts: number[]
  matches: number[]
  cuts: number[]
  moves: number[][]
  seen: number[]
  stamp: number[]
  full: number[]
}

export interface DfaPair {
  fits: boolean
  forward: Dfa
  backward: Dfa
}

export function makeDfaPair(g: Program, source: Parsed): DfaPair {
  const none: DfaPair = noDfaPair()
  if (!dfaFits(g)) {
    return none
  }
  const forward: Dfa = makeDfa(g, numberAt(g.partEntry, 0, 0))
  if (forward.bounds.length > mostClasses) {
    return none
  }
  const reversed: Program = compilePattern(source)
  const part: number = compilePart(reversed, source.root, true)
  if (!dfaFits(reversed)) {
    return none
  }
  return { fits: true, forward: forward, backward: makeDfa(reversed, numberAt(reversed.partEntry, part, 0)) }
}

export function noDfaPair(): DfaPair {
  const blankProgram: Program = compilePattern({ root: __termVariantBlank, groups: 0, names: ([] as string[]) })
  const empty: Dfa = makeDfa(blankProgram, 0)
  return { fits: false, forward: empty, backward: empty }
}

export function dfaFits(g: Program): boolean {
  const bits: number[] = simpleLookBits(g)
  const count: number = g.ops.length
  let pc: number = 0
  while (pc < count) {
    const op: number = numberAt(g.ops, pc, -1)
    const plain: boolean = op === opMatch || op === opChar || (op === opSet || op === opSplit) || (op === opJump || op === opSave || (op === opClear || op === opMark))
    const edge: boolean = op === opEdge
    const look: boolean = op === opLook && numberAt(bits, numberAt(g.a, pc, -1), 0) > 0
    if (!(plain || (edge || look))) {
      return false
    }
    pc = pc + 1
  }
  return true
}

export function classBounds(g: Program): number[] {
  const points: number[] = ([] as number[])
  points.push(0)
  const count: number = g.ops.length
  let pc: number = 0
  while (pc < count) {
    const op: number = numberAt(g.ops, pc, -1)
    const a: number = numberAt(g.a, pc, -1)
    if (op === opChar) {
      points.push(a)
      points.push(__termInt(a + 1))
    } else if (op === opSet && (a >= 0 && a < g.sets.length)) {
      const set: number[] = (a >= 0 && a < g.sets.length ? g.sets[a]! : __termReadPast(g.sets, a))
      let k: number = 0
      const size: number = set.length
      while (__termInt(k + 1) < size) {
        points.push(numberAt(set, k, 0))
        points.push(__termInt(numberAt(set, __termInt(k + 1), 0) + 1))
        const __n123 = k + 2; if (!(__n123 <= 9007199254740991 && __n123 >= -9007199254740991)) __termIntStop(__n123); k = __n123
      }
    }
    pc = pc + 1
  }
  return sortedUnique(points)
}

export function sortedUnique(values: number[]): number[] {
  const sorted: number[] = sort(values, fromNumbers)
  const out: number[] = ([] as number[])
  for (const value of sorted) {
    if (out.length === 0 || value > numberAt(out, __termInt(out.length - 1), -1)) {
      out.push(value)
    }
  }
  return out
}

export function classOf(bounds: number[], c: number): number {
  let low: number = 0
  const __n124 = bounds.length - 1; if (!(__n124 <= 9007199254740991 && __n124 >= -9007199254740991)) __termIntStop(__n124); let high: number = __n124
  let turns: number = 0
  while (low < high && turns < 64) {
    turns = turns + 1
    const middle: number = Math.trunc(__termInt(__termInt(low + high) + 1) / 2)
    if (numberAt(bounds, middle, 0) <= c) {
      low = middle
    } else {
      const __n125 = middle - 1; if (!(__n125 <= 9007199254740991 && __n125 >= -9007199254740991)) __termIntStop(__n125); high = __n125
    }
  }
  return low
}

export function makeDfa(g: Program, entry: number): Dfa {
  const seen: number[] = ([] as number[])
  for (const op of g.ops) {
    seen.push(-1)
  }
  const stamp: number[] = ([] as number[])
  stamp.push(0)
  const full: number[] = ([] as number[])
  full.push(0)
  return { program: g, entry: entry, bounds: classBounds(g), width: contextWidth(g), edges: hasContextEdges(g), lookBits: simpleLookBits(g), keys: new Map(), pcs: ([] as number[][]), restarts: ([] as number[]), matches: ([] as number[]), cuts: ([] as number[]), moves: ([] as number[][]), seen: seen, stamp: stamp, full: full }
}

const mostSimpleLooks: number = 3

export function simpleLookBits(g: Program): number[] {
  const bits: number[] = ([] as number[])
  const looks: number = Math.trunc(g.looks.length / 7)
  let nextBit: number = 8
  let used: number = 0
  let i: number = 0
  while (i < looks) {
    const __n126 = i * 7; if (!(__n126 <= 9007199254740991 && __n126 >= -9007199254740991)) __termIntStop(__n126); const base: number = __n126
    const behind: boolean = numberAt(g.looks, __termInt(base + 2), 0) === 1
    let part: number = numberAt(g.looks, base, -1)
    if (behind) {
      part = numberAt(g.looks, __termInt(base + 1), -1)
    }
    const entry: number = numberAt(g.partEntry, part, -1)
    const first: number = numberAt(g.ops, entry, -1)
    const then: number = numberAt(g.ops, __termInt(entry + 1), -1)
    const noGroups: boolean = numberAt(g.looks, __termInt(base + 6), -1) < numberAt(g.looks, __termInt(base + 5), 0)
    const simple: boolean = (first === opChar || first === opSet) && then === opMatch && (noGroups && used < mostSimpleLooks)
    if (simple) {
      bits.push(nextBit)
      const __n127 = nextBit * 2; if (!(__n127 <= 9007199254740991 && __n127 >= -9007199254740991)) __termIntStop(__n127); nextBit = __n127
      const __n128 = used + 1; if (!(__n128 <= 9007199254740991 && __n128 >= -9007199254740991)) __termIntStop(__n128); used = __n128
    } else {
      bits.push(0)
    }
    i = i + 1
  }
  return bits
}

export function hasContextEdges(g: Program): boolean {
  const count: number = g.ops.length
  let pc: number = 0
  while (pc < count) {
    const a: number = numberAt(g.a, pc, -1)
    if (numberAt(g.ops, pc, -1) === opEdge && !(a === edgeTextStart || a === edgeTextEnd)) {
      return true
    }
    pc = pc + 1
  }
  return false
}

export function contextWidth(g: Program): number {
  let width: number = 1
  if (hasContextEdges(g)) {
    width = 8
  }
  for (const bit of simpleLookBits(g)) {
    if (bit > 0) {
      if (width === 1) {
        width = 8
      }
      const __n129 = width * 2; if (!(__n129 <= 9007199254740991 && __n129 >= -9007199254740991)) __termIntStop(__n129); width = __n129
    }
  }
  return width
}

export function contextAt(d: Dfa, s: Scene, at: number): number {
  if (d.width === 1) {
    return 0
  }
  let bits: number = 0
  if (d.edges) {
    if (edgeHolds(s, edgeLineStart, at)) {
      bits = 1
    }
    if (edgeHolds(s, edgeLineEnd, at)) {
      bits = bits + 2
    }
    if (edgeHolds(s, edgeWord, at)) {
      bits = bits + 4
    }
  }
  const g: Program = d.program
  let i: number = 0
  for (const bit of d.lookBits) {
    if (bit > 0) {
      const __n130 = i * 7; if (!(__n130 <= 9007199254740991 && __n130 >= -9007199254740991)) __termIntStop(__n130); const base: number = __n130
      const behind: boolean = numberAt(g.looks, __termInt(base + 2), 0) === 1
      let part: number = numberAt(g.looks, base, -1)
      let c: number = numberAt(s.runes, at, -1)
      if (behind) {
        part = numberAt(g.looks, __termInt(base + 1), -1)
        c = numberAt(s.runes, __termInt(at - 1), -1)
      }
      const entry: number = numberAt(g.partEntry, part, -1)
      const op: number = numberAt(g.ops, entry, -1)
      const a: number = numberAt(g.a, entry, -1)
      const holds: boolean = c >= 0 && (op === opChar && a === c || op === opSet && (a >= 0 && a < g.sets.length && setHas((a >= 0 && a < g.sets.length ? g.sets[a]! : __termReadPast(g.sets, a)), c)))
      if (holds) {
        const __n131 = bits + bit; if (!(__n131 <= 9007199254740991 && __n131 >= -9007199254740991)) __termIntStop(__n131); bits = __n131
      }
    }
    const __n132 = i + 1; if (!(__n132 <= 9007199254740991 && __n132 >= -9007199254740991)) __termIntStop(__n132); i = __n132
  }
  return bits
}

export function contextHas(context: number, bit: number): boolean {
  if (bit === 1) {
    return context % 2 >= 1
  } else if (bit === 2) {
    return context % 4 >= 2
  } else if (bit === 4) {
    return context % 8 >= 4
  } else if (bit === 8) {
    return context % 16 >= 8
  } else if (bit === 16) {
    return context % 32 >= 16
  } else if (bit === 32) {
    return context % 64 >= 32
  }
  return false
}

export function closure(d: Dfa, seeds: number[], at: number, n: number, context: number): number[] {
  const g: Program = d.program
  const __n133 = numberAt(d.stamp, 0, 0) + 1; if (!(__n133 <= 9007199254740991 && __n133 >= -9007199254740991)) __termIntStop(__n133); const stamp: number = __n133
  putNumber(d.stamp, 0, stamp)
  const out: number[] = ([] as number[])
  const stack: number[] = ([] as number[])
  const __n134 = seeds.length - 1; if (!(__n134 <= 9007199254740991 && __n134 >= -9007199254740991)) __termIntStop(__n134); let k: number = __n134
  while (k >= 0) {
    stack.push(numberAt(seeds, k, -1))
    k = k - 1
  }
  const __n135 = __termInt(g.ops.length * 2) + __termInt(seeds.length + 3); if (!(__n135 <= 9007199254740991 && __n135 >= -9007199254740991)) __termIntStop(__n135); const limit: number = __n135
  let turns: number = 0
  while (stack.length > 0 && turns < limit) {
    const __n136 = turns + 1; if (!(__n136 <= 9007199254740991 && __n136 >= -9007199254740991)) __termIntStop(__n136); turns = __n136
    const pc: number = numberAt(stack, __termInt(stack.length - 1), -1)
    __termPop(stack)
    if (pc < 0 || numberAt(d.seen, pc, -1) === stamp) {
      continue
    }
    putNumber(d.seen, pc, stamp)
    const op: number = numberAt(g.ops, pc, -1)
    const a: number = numberAt(g.a, pc, -1)
    if (op === opMatch || op === opChar || op === opSet) {
      out.push(pc)
    } else if (op === opSplit) {
      stack.push(numberAt(g.b, pc, -1))
      stack.push(a)
    } else if (op === opJump) {
      stack.push(a)
    } else if (op === opEdge) {
      const holds: boolean = a === edgeTextStart && at === 0 || a === edgeTextEnd && at === n || (a === edgeLineStart && contextHas(context, 1) || a === edgeLineEnd && contextHas(context, 2)) || (a === edgeWord && contextHas(context, 4) || a === edgeNotWord && !contextHas(context, 4))
      if (holds) {
        stack.push(__termInt(pc + 1))
      }
    } else if (op === opLook) {
      const seenIt: boolean = contextHas(context, numberAt(d.lookBits, a, 0))
      const negative: boolean = numberAt(g.looks, __termInt(__termInt(a * 7) + 3), 0) === 1
      if (seenIt !== negative) {
        stack.push(__termInt(pc + 1))
      }
    } else {
      stack.push(__termInt(pc + 1))
    }
  }
  return out
}

export function pcsOf(d: Dfa, state: number): number[] {
  const all: number[][] = d.pcs
  if (state >= 0 && state < all.length) {
    return (state >= 0 && state < all.length ? all[state]! : __termReadPast(all, state))
  }
  const none: number[] = ([] as number[])
  return none
}

export function rowOf(d: Dfa, state: number): number[] {
  const all: number[][] = d.moves
  if (state >= 0 && state < all.length) {
    return (state >= 0 && state < all.length ? all[state]! : __termReadPast(all, state))
  }
  const none: number[] = ([] as number[])
  return none
}

export function stateOf(d: Dfa, pcs: number[], restarts: boolean): number {
  let flag: number = 0
  if (restarts) {
    flag = 1
  }
  let key: string = `${flag}:`
  for (const pc of pcs) {
    key = `${key}${pc},`
  }
  const found: number = hashGetOrDefault(d.keys, key, -1)
  if (found >= 0) {
    return found
  }
  const id: number = d.pcs.length
  if (id >= mostStates) {
    putNumber(d.full, 0, 1)
    return -1
  }
  const keys: Map<string, number> = d.keys
  keys.set(key, id)
  const allPcs: number[][] = d.pcs
  allPcs.push(pcs)
  const allRestarts: number[] = d.restarts
  allRestarts.push(flag)
  let firstMatch: number = -1
  let index: number = 0
  for (const pc of pcs) {
    if (firstMatch < 0 && numberAt(d.program.ops, pc, -1) === opMatch) {
      firstMatch = index
    }
    const __n137 = index + 1; if (!(__n137 <= 9007199254740991 && __n137 >= -9007199254740991)) __termIntStop(__n137); index = __n137
  }
  const allMatches: number[] = d.matches
  allMatches.push(firstMatch)
  const allCuts: number[] = d.cuts
  allCuts.push(-1)
  const row: number[] = ([] as number[])
  const __n138 = d.bounds.length * d.width; if (!(__n138 <= 9007199254740991 && __n138 >= -9007199254740991)) __termIntStop(__n138); const cells: number = __n138
  let c: number = 0
  while (c < cells) {
    row.push(-1)
    c = c + 1
  }
  const allMoves: number[][] = d.moves
  allMoves.push(row)
  return id
}

export function step(d: Dfa, state: number, kind: number, at: number, n: number, context: number): number {
  const g: Program = d.program
  const rep: number = numberAt(d.bounds, kind, 0)
  const seeds: number[] = ([] as number[])
  for (const pc of pcsOf(d, state)) {
    const op: number = numberAt(g.ops, pc, -1)
    const a: number = numberAt(g.a, pc, -1)
    if (op === opChar && a === rep || op === opSet && (a >= 0 && a < g.sets.length && setHas((a >= 0 && a < g.sets.length ? g.sets[a]! : __termReadPast(g.sets, a)), rep))) {
      seeds.push(__termInt(pc + 1))
    }
  }
  const restarts: boolean = numberAt(d.restarts, state, 0) === 1
  if (restarts) {
    seeds.push(d.entry)
  }
  return stateOf(d, closure(d, seeds, at, n, context), restarts)
}

export function cut(d: Dfa, state: number): number {
  const known: number = numberAt(d.cuts, state, -1)
  if (known >= 0) {
    return known
  }
  const first: number = numberAt(d.matches, state, -1)
  const kept: number[] = ([] as number[])
  let index: number = 0
  for (const pc of pcsOf(d, state)) {
    if (index < first) {
      kept.push(pc)
    }
    const __n139 = index + 1; if (!(__n139 <= 9007199254740991 && __n139 >= -9007199254740991)) __termIntStop(__n139); index = __n139
  }
  const id: number = stateOf(d, kept, false)
  putNumber(d.cuts, state, id)
  return id
}

export function move(d: Dfa, s: Scene, state: number, c: number, at: number, n: number): number {
  const kind: number = classOf(d.bounds, c)
  const context: number = contextAt(d, s, at)
  if (at >= n || at <= 0) {
    return step(d, state, kind, at, n, context)
  }
  const row: number[] = rowOf(d, state)
  const __n140 = __termInt(kind * d.width) + context; if (!(__n140 <= 9007199254740991 && __n140 >= -9007199254740991)) __termIntStop(__n140); const cell: number = __n140
  const known: number = numberAt(row, cell, -1)
  if (known >= 0) {
    return known
  }
  const next: number = step(d, state, kind, at, n, context)
  if (next >= 0) {
    putNumber(row, cell, next)
  }
  return next
}

export function dfaEnd(d: Dfa, s: Scene, from: number): number {
  const runes: number[] = s.runes
  const n: number = runes.length
  const seeds: number[] = ([] as number[])
  seeds.push(d.entry)
  let state: number = stateOf(d, closure(d, seeds, from, n, contextAt(d, s, from)), true)
  let ended: number = -1
  let at: number = from
  let going: boolean = true
  const __n141 = n + 3; if (!(__n141 <= 9007199254740991 && __n141 >= -9007199254740991)) __termIntStop(__n141); const limit: number = __n141
  let turns: number = 0
  while (going && turns < limit) {
    const __n142 = turns + 1; if (!(__n142 <= 9007199254740991 && __n142 >= -9007199254740991)) __termIntStop(__n142); turns = __n142
    if (state < 0) {
      return -2
    }
    if (numberAt(d.matches, state, -1) >= 0) {
      ended = at
      state = cut(d, state)
      if (state < 0) {
        return -2
      }
    }
    const threads: number[] = pcsOf(d, state)
    const waiting: boolean = threads.length > 0
    const restarting: boolean = numberAt(d.restarts, state, 0) === 1
    if (at >= n || !waiting && !restarting) {
      going = false
      continue
    }
    state = move(d, s, state, numberAt(runes, at, -1), __termInt(at + 1), n)
    const __n143 = at + 1; if (!(__n143 <= 9007199254740991 && __n143 >= -9007199254740991)) __termIntStop(__n143); at = __n143
  }
  return ended
}

export function dfaStart(d: Dfa, s: Scene, end: number, floor: number): number {
  const runes: number[] = s.runes
  const n: number = runes.length
  const seeds: number[] = ([] as number[])
  seeds.push(d.entry)
  let state: number = stateOf(d, closure(d, seeds, end, n, contextAt(d, s, end)), false)
  let started: number = -1
  let at: number = end
  let turns: number = 0
  const __n144 = n + 3; if (!(__n144 <= 9007199254740991 && __n144 >= -9007199254740991)) __termIntStop(__n144); const limit: number = __n144
  while (turns < limit) {
    turns = turns + 1
    if (state < 0) {
      return -2
    }
    if (numberAt(d.matches, state, -1) >= 0) {
      started = at
    }
    const threads: number[] = pcsOf(d, state)
    if (at <= floor || threads.length === 0) {
      return started
    }
    state = move(d, s, state, numberAt(runes, __termInt(at - 1), -1), __termInt(at - 1), n)
    const __n145 = at - 1; if (!(__n145 <= 9007199254740991 && __n145 >= -9007199254740991)) __termIntStop(__n145); at = __n145
  }
  return started
}

export function dfaSearch(forward: Dfa, backward: Dfa, g: Program, s: Scene, tables: number[][], from: number): number[] {
  const none: number[] = ([] as number[])
  const full: number[] = ([] as number[])
  full.push(-2)
  const end: number = dfaEnd(forward, s, from)
  if (end === -2) {
    return full
  }
  if (end < 0) {
    return none
  }
  const start: number = dfaStart(backward, s, end, from)
  if (start < 0) {
    return full
  }
  const __n146 = __termInt(g.groups + 1) * 2; if (!(__n146 <= 9007199254740991 && __n146 >= -9007199254740991)) __termIntStop(__n146); const width: number = __n146
  if (g.groups === 0) {
    const slots: number[] = ([] as number[])
    slots.push(start)
    slots.push(end)
    return slots
  }
  const first: number[] = ([] as number[])
  const count: number = numberAt(g.slots, 0, 0)
  let k: number = 0
  while (k < count) {
    first.push(-1)
    k = k + 1
  }
  const slots: number[] = runPart(g, s, tables, 0, start, first, true)
  if (slots.length === 0) {
    return full
  }
  const out: number[] = ([] as number[])
  let i: number = 0
  while (i < width) {
    out.push(numberAt(slots, i, -1))
    i = i + 1
  }
  return out
}

export function mostLength(p: Piece): number {
  if (p.form === "blank") {
    return 0
  } else if (p.form === "edge") {
    return 0
  } else if (p.form === "look") {
    return 0
  } else if (p.form === "letter") {
    return 1
  } else if (p.form === "ranges") {
    return 1
  } else if (p.form === "refer") {
    return -1
  } else if (p.form === "chain") {
    const parts = p.parts
    let total: number = 0
    for (const part of parts) {
      const one: number = mostLength(part)
      if (one < 0) {
        return -1
      }
      const __n147 = total + one; if (!(__n147 <= 9007199254740991 && __n147 >= -9007199254740991)) __termIntStop(__n147); total = __n147
    }
    return total
  } else if (p.form === "choice") {
    const parts = p.parts
    let longest: number = 0
    for (const part of parts) {
      const one: number = mostLength(part)
      if (one < 0) {
        return -1
      }
      if (one > longest) {
        longest = one
      }
    }
    return longest
  } else if (p.form === "loop") {
    const body = p.body
    const most = p.most
    const one: number = mostLength(body)
    if (one === 0) {
      return 0
    }
    if (one < 0 || most < 0) {
      return -1
    }
    const __n148 = one * most; if (!(__n148 <= 9007199254740991 && __n148 >= -9007199254740991)) __termIntStop(__n148); return __n148
  } else if (p.form === "group") {
    const body = p.body
    return mostLength(body)
  } else {
    const body = p.body
    return mostLength(body)
  }
}

export function holdsName(names: string[], name: string): boolean {
  for (const one of names) {
    if (one === name) {
      return true
    }
  }
  return false
}

export function holdsNumber(numbers: number[], value: number): boolean {
  for (const one of numbers) {
    if (one === value) {
      return true
    }
  }
  return false
}

export function noteFeature(out: string[], name: string): boolean {
  if (holdsName(out, name)) {
    return false
  }
  out.push(name)
  return true
}

export function pieceFeatures(p: Piece): string[] {
  const out: string[] = ([] as string[])
  const sure: number[] = ([] as number[])
  collectFeatures(p, out, sure, false, false, false)
  return out
}

export function collectFeatures(p: Piece, out: string[], sure: number[], inLoop: boolean, inLook: boolean, behind: boolean): number[] {
  if (p.form === "blank") {
    return sure
  } else if (p.form === "letter") {
    return sure
  } else if (p.form === "ranges") {
    const set = p.set
    if (setSize(set) === 0) {
      noteFeature(out, "empty-set")
    }
    return sure
  } else if (p.form === "edge") {
    const kind = p.kind
    if (kind === edgeWord || kind === edgeNotWord) {
      noteFeature(out, "word-edge")
    } else if (kind === edgeLineStart || kind === edgeLineEnd) {
      noteFeature(out, "line-edge")
    }
    return sure
  } else if (p.form === "refer") {
    const index = p.index
    const fold = p.fold
    if (behind) {
      noteFeature(out, "refer-behind")
    }
    if (fold) {
      noteFeature(out, "refer-fold")
    }
    if (holdsNumber(sure, index)) {
      noteFeature(out, "refer-set")
    } else {
      noteFeature(out, "refer-unset")
    }
    return sure
  } else if (p.form === "chain") {
    const parts = p.parts
    let now: number[] = copyNumbers(sure)
    const count: number = parts.length
    let k: number = 0
    while (k < count) {
      let at: number = k
      if (behind) {
        const __n149 = __termInt(count - 1) - k; if (!(__n149 <= 9007199254740991 && __n149 >= -9007199254740991)) __termIntStop(__n149); at = __n149
      }
      let part: Piece = __termVariantBlank
      if (at >= 0 && at < parts.length) {
        part = (at >= 0 && at < parts.length ? parts[at]! : __termReadPast(parts, at))
      }
      now = collectFeatures(part, out, now, inLoop, inLook, behind)
      k = k + 1
    }
    return now
  } else if (p.form === "choice") {
    const parts = p.parts
    for (const part of parts) {
      collectFeatures(part, out, copyNumbers(sure), inLoop, inLook, behind)
    }
    return sure
  } else if (p.form === "loop") {
    const body = p.body
    const least = p.least
    const most = p.most
    const possessive = p.possessive
    if (possessive) {
      noteFeature(out, "possessive")
    }
    if (least > 1000 || most > 1000) {
      noteFeature(out, "big-count")
    }
    if (canBeEmpty(body)) {
      noteFeature(out, "empty-loop")
    }
    const inner: number[] = collectFeatures(body, out, copyNumbers(sure), true, inLook, behind)
    if (least >= 1) {
      return inner
    }
    return sure
  } else if (p.form === "group") {
    const body = p.body
    const index = p.index
    if (inLoop) {
      noteFeature(out, "loop-capture")
    }
    if (inLook) {
      noteFeature(out, "look-capture")
    }
    const inner: number[] = collectFeatures(body, out, sure, inLoop, inLook, behind)
    const after: number[] = copyNumbers(inner)
    after.push(index)
    return after
  } else if (p.form === "atom") {
    const body = p.body
    noteFeature(out, "atomic")
    return collectFeatures(body, out, sure, inLoop, inLook, behind)
  } else {
    const body = p.body
    const lookBehind = p.behind
    const unbounded: boolean = mostLength(body) < 0
    if (unbounded && lookBehind) {
      noteFeature(out, "look-behind-unbounded")
    } else if (unbounded) {
      noteFeature(out, "look-ahead-unbounded")
    } else if (lookBehind) {
      noteFeature(out, "look-behind")
    } else {
      noteFeature(out, "look-ahead")
    }
    collectFeatures(body, out, copyNumbers(sure), inLoop, true, lookBehind)
    return sure
  }
}

export function featuresCovered(used: string[], able: string[]): boolean {
  for (const one of used) {
    if (!holdsName(able, one)) {
      return false
    }
  }
  return true
}

const tierNative: number = 0

const tierLinear: number = 1

const tierBacktrack: number = 2

export interface EngineProfile {
  name: string
  features: string[]
  linear: boolean
  classLimit: number
  end: string
  lineInline: boolean
  foldFlags: string
}

export interface Analysis {
  root: Piece
  tier: number
  native: string
  hasNative: boolean
  folds: boolean
  fallback: number
  features: string[]
  capable: string
}

export function allSet(p: Piece): number[] {
  const none: number[] = ([] as number[])
  if (p.form === "letter") {
    const point = p.point
    return rangeSet(point, point)
  } else if (p.form === "ranges") {
    const set = p.set
    return set
  } else if (p.form === "chain") {
    const parts = p.parts
    let out: number[] = ([] as number[])
    for (const part of parts) {
      out = mergeSets(out, allSet(part))
    }
    return out
  } else if (p.form === "choice") {
    const parts = p.parts
    let out: number[] = ([] as number[])
    for (const part of parts) {
      out = mergeSets(out, allSet(part))
    }
    return out
  } else if (p.form === "loop") {
    const body = p.body
    return allSet(body)
  } else if (p.form === "group") {
    const body = p.body
    return allSet(body)
  } else if (p.form === "atom") {
    const body = p.body
    return allSet(body)
  } else if (p.form === "look") {
    const body = p.body
    return allSet(body)
  } else if (p.form === "refer") {
    return rangeSet(0, lastCodePoint)
  } else if (p.form === "blank") {
    return none
  } else {
    return none
  }
}

export function isAnchored(p: Piece): boolean {
  if (p.form === "edge") {
    const kind = p.kind
    return kind === edgeTextStart
  } else if (p.form === "chain") {
    const parts = p.parts
    for (const part of parts) {
      if (isAnchored(part)) {
        return true
      }
      if (!canBeEmpty(part)) {
        return false
      }
    }
    return false
  } else if (p.form === "choice") {
    const parts = p.parts
    for (const part of parts) {
      if (!isAnchored(part)) {
        return false
      }
    }
    return parts.length > 0
  } else if (p.form === "group") {
    const body = p.body
    return isAnchored(body)
  } else if (p.form === "blank") {
    return false
  } else if (p.form === "letter") {
    return false
  } else if (p.form === "ranges") {
    return false
  } else if (p.form === "loop") {
    return false
  } else if (p.form === "atom") {
    return false
  } else if (p.form === "look") {
    return false
  } else {
    return false
  }
}

export function isDeterministic(p: Piece, follow: number[], inside: boolean, tail: boolean): boolean {
  if (p.form === "chain") {
    const parts = p.parts
    let after: number[] = follow
    let bounded: boolean = tail
    const __n150 = parts.length - 1; if (!(__n150 <= 9007199254740991 && __n150 >= -9007199254740991)) __termIntStop(__n150); let k: number = __n150
    while (k >= 0) {
      let part: Piece = __termVariantBlank
      if (k < parts.length) {
        part = (k >= 0 && k < parts.length ? parts[k]! : __termReadPast(parts, k))
      }
      if (!isDeterministic(part, after, inside, bounded)) {
        return false
      }
      let starts: number[] = firstSet(part)
      if (canBeEmpty(part)) {
        after = mergeSets(starts, after)
      } else {
        after = starts
      }
      bounded = bounded && mostLength(part) >= 0
      k = k - 1
    }
    return true
  } else if (p.form === "choice") {
    const parts = p.parts
    let seen: number[] = ([] as number[])
    for (const part of parts) {
      if (!isDeterministic(part, follow, inside, tail)) {
        return false
      }
      let starts: number[] = firstSet(part)
      if (canBeEmpty(part)) {
        starts = mergeSets(starts, follow)
      }
      if (inside && !setsAreApart(seen, starts)) {
        return false
      }
      seen = mergeSets(seen, starts)
    }
    return true
  } else if (p.form === "loop") {
    const body = p.body
    const least = p.least
    const most = p.most
    const possessive = p.possessive
    if (canBeEmpty(body)) {
      return false
    }
    let starts: number[] = firstSet(body)
    const within: boolean = inside || most < 0
    const bodyTail: boolean = tail && mostLength(p) >= 0
    if (possessive) {
      return isDeterministic(body, starts, within, bodyTail)
    }
    const givesBackLinearly: boolean = most < 0 && !inside && (tail && mostLength(body) === 1)
    if (most !== least && !setsAreApart(starts, follow) && (within && !givesBackLinearly)) {
      return false
    }
    return isDeterministic(body, mergeSets(starts, follow), within, bodyTail)
  } else if (p.form === "group") {
    const body = p.body
    return isDeterministic(body, follow, inside, tail)
  } else if (p.form === "atom") {
    const body = p.body
    const nothing: number[] = ([] as number[])
    return isDeterministic(body, nothing, inside, true)
  } else if (p.form === "look") {
    const body = p.body
    const nothing: number[] = ([] as number[])
    return mostLength(body) >= 0 && isDeterministic(body, nothing, inside, true)
  } else if (p.form === "refer") {
    return true
  } else if (p.form === "blank") {
    return true
  } else if (p.form === "letter") {
    return true
  } else if (p.form === "ranges") {
    return true
  } else {
    return true
  }
}

const mostPaths: number = 10000

export function cappedProduct(a: number, b: number): number {
  if (a > mostPaths || b > mostPaths) {
    const __n151 = mostPaths + 1; if (!(__n151 <= 9007199254740991 && __n151 >= -9007199254740991)) __termIntStop(__n151); return __n151
  }
  const __n152 = a * b; if (!(__n152 <= 9007199254740991 && __n152 >= -9007199254740991)) __termIntStop(__n152); const product: number = __n152
  if (product > mostPaths) {
    const __n153 = mostPaths + 1; if (!(__n153 <= 9007199254740991 && __n153 >= -9007199254740991)) __termIntStop(__n153); return __n153
  }
  return product
}

export function pathCount(p: Piece): number {
  if (p.form === "chain") {
    const parts = p.parts
    let total: number = 1
    for (const part of parts) {
      total = cappedProduct(total, pathCount(part))
    }
    return total
  } else if (p.form === "choice") {
    const parts = p.parts
    let total: number = 0
    for (const part of parts) {
      const __n154 = total + pathCount(part); if (!(__n154 <= 9007199254740991 && __n154 >= -9007199254740991)) __termIntStop(__n154); total = __n154
      if (total > mostPaths) {
        const __n155 = mostPaths + 1; if (!(__n155 <= 9007199254740991 && __n155 >= -9007199254740991)) __termIntStop(__n155); return __n155
      }
    }
    return total
  } else if (p.form === "loop") {
    const body = p.body
    const least = p.least
    const most = p.most
    const inner: number = pathCount(body)
    if (most < 0) {
      return inner
    }
    const __n156 = __termInt(most - least) + 1; if (!(__n156 <= 9007199254740991 && __n156 >= -9007199254740991)) __termIntStop(__n156); let total: number = __n156
    let k: number = 0
    while (k < most && total <= mostPaths) {
      total = cappedProduct(total, inner)
      const __n157 = k + 1; if (!(__n157 <= 9007199254740991 && __n157 >= -9007199254740991)) __termIntStop(__n157); k = __n157
    }
    return total
  } else if (p.form === "group") {
    const body = p.body
    return pathCount(body)
  } else if (p.form === "atom") {
    const body = p.body
    return pathCount(body)
  } else if (p.form === "look") {
    const body = p.body
    return pathCount(body)
  } else if (p.form === "blank") {
    return 1
  } else if (p.form === "letter") {
    return 1
  } else if (p.form === "ranges") {
    return 1
  } else if (p.form === "edge") {
    return 1
  } else {
    return 1
  }
}

export function isSafeToBacktrack(p: Piece): boolean {
  const none: number[] = ([] as number[])
  if (!isDeterministic(p, none, false, true)) {
    return false
  }
  if (pathCount(p) > mostPaths) {
    return false
  }
  if (isAnchored(p)) {
    return true
  }
  return setsAreApart(firstSet(p), riskyLoopSet(p, false))
}

export function canFail(p: Piece): boolean {
  if (p.form === "blank") {
    return false
  } else if (p.form === "edge") {
    return true
  } else if (p.form === "look") {
    return true
  } else if (p.form === "refer") {
    return true
  } else if (p.form === "letter") {
    return true
  } else if (p.form === "ranges") {
    return true
  } else if (p.form === "chain") {
    const parts = p.parts
    for (const part of parts) {
      if (canFail(part)) {
        return true
      }
    }
    return false
  } else if (p.form === "choice") {
    const parts = p.parts
    for (const part of parts) {
      if (!canFail(part)) {
        return false
      }
    }
    return true
  } else if (p.form === "loop") {
    const body = p.body
    const least = p.least
    if (least === 0) {
      return hasTest(body)
    }
    return canFail(body)
  } else if (p.form === "group") {
    const body = p.body
    return canFail(body)
  } else {
    const body = p.body
    return canFail(body)
  }
}

export function hasTest(p: Piece): boolean {
  if (p.form === "edge") {
    return true
  } else if (p.form === "look") {
    return true
  } else if (p.form === "refer") {
    return true
  } else if (p.form === "chain") {
    const parts = p.parts
    for (const part of parts) {
      if (hasTest(part)) {
        return true
      }
    }
    return false
  } else if (p.form === "choice") {
    const parts = p.parts
    for (const part of parts) {
      if (hasTest(part)) {
        return true
      }
    }
    return false
  } else if (p.form === "loop") {
    const body = p.body
    return hasTest(body)
  } else if (p.form === "group") {
    const body = p.body
    return hasTest(body)
  } else if (p.form === "atom") {
    const body = p.body
    return hasTest(body)
  } else if (p.form === "blank") {
    return false
  } else if (p.form === "letter") {
    return false
  } else {
    return false
  }
}

export function riskyLoopSet(p: Piece, restFails: boolean): number[] {
  const none: number[] = ([] as number[])
  if (p.form === "loop") {
    const body = p.body
    const most = p.most
    const inner: number[] = riskyLoopSet(body, true)
    if (restFails && most < 0) {
      return mergeSets(allSet(body), inner)
    }
    return inner
  } else if (p.form === "chain") {
    const parts = p.parts
    let out: number[] = ([] as number[])
    let fails: boolean = restFails
    const __n158 = parts.length - 1; if (!(__n158 <= 9007199254740991 && __n158 >= -9007199254740991)) __termIntStop(__n158); let k: number = __n158
    while (k >= 0) {
      let part: Piece = __termVariantBlank
      if (k < parts.length) {
        part = (k >= 0 && k < parts.length ? parts[k]! : __termReadPast(parts, k))
      }
      out = mergeSets(out, riskyLoopSet(part, fails))
      if (canFail(part)) {
        fails = true
      }
      k = k - 1
    }
    return out
  } else if (p.form === "choice") {
    const parts = p.parts
    let out: number[] = ([] as number[])
    for (const part of parts) {
      out = mergeSets(out, riskyLoopSet(part, restFails))
    }
    return out
  } else if (p.form === "group") {
    const body = p.body
    return riskyLoopSet(body, restFails)
  } else if (p.form === "atom") {
    const body = p.body
    return riskyLoopSet(body, restFails)
  } else if (p.form === "look") {
    const body = p.body
    return riskyLoopSet(body, true)
  } else if (p.form === "blank") {
    return none
  } else if (p.form === "letter") {
    return none
  } else if (p.form === "ranges") {
    return none
  } else if (p.form === "edge") {
    return none
  } else {
    return none
  }
}

export function classText(set: number[]): string {
  const parts: string[] = ([] as string[])
  let i: number = 0
  const count: number = set.length
  while (__termInt(i + 1) < count) {
    const start: number = numberAt(set, i, 0)
    const end: number = numberAt(set, __termInt(i + 1), 0)
    pushRangeText(parts, start, end)
    const __n159 = i + 2; if (!(__n159 <= 9007199254740991 && __n159 >= -9007199254740991)) __termIntStop(__n159); i = __n159
  }
  return parts.join("")
}

export function pushRangeText(parts: string[], start: number, end: number): number {
  if (start < 55296 && end > 57343) {
    pushRangeText(parts, start, 55295)
    return pushRangeText(parts, 57344, end)
  }
  if (start >= 55296 && end <= 57343) {
    return 0
  }
  let low: number = start
  let high: number = end
  if (low >= 55296 && low <= 57343) {
    low = 57344
  }
  if (high >= 55296 && high <= 57343) {
    high = 55295
  }
  const first: string = regexClassLiteral(low)
  if (low === high) {
    parts.push(first)
    return 1
  }
  const last: string = regexClassLiteral(high)
  parts.push(`${first}-${last}`)
  return 1
}

export function nativeText(p: Piece, end: string, lineInline: boolean, foldFlags: string, words: string, lines: string): string[] {
  const no: string[] = ([] as string[])
  const out: string[] = ([] as string[])
  if (p.form === "blank") {
    out.push("(?:)")
    return out
  } else if (p.form === "letter") {
    const point = p.point
    out.push(regexLiteral(point))
    return out
  } else if (p.form === "ranges") {
    const set = p.set
    const body: string = classText(set)
    out.push(`[${body}]`)
    return out
  } else if (p.form === "edge") {
    const kind = p.kind
    if (kind === edgeTextStart) {
      out.push("^")
      return out
    } else if (kind === edgeTextEnd) {
      out.push(end)
      return out
    } else if (kind === edgeLineStart) {
      if (lineInline) {
        out.push("(?m:^)")
      } else {
        out.push(`(?<![${lines}])`)
      }
      return out
    } else if (kind === edgeLineEnd) {
      if (lineInline) {
        out.push("(?m:$)")
      } else {
        out.push(`(?![${lines}])`)
      }
      return out
    }
    if (words === "") {
      return no
    }
    if (kind === edgeWord) {
      out.push(`(?:(?<=[${words}])(?![${words}])|(?<![${words}])(?=[${words}]))`)
    } else {
      out.push(`(?:(?<=[${words}])(?=[${words}])|(?<![${words}])(?![${words}]))`)
    }
    return out
  } else if (p.form === "chain") {
    const parts = p.parts
    const written: string[] = ([] as string[])
    for (const part of parts) {
      const one: string[] = nativeText(part, end, lineInline, foldFlags, words, lines)
      if (one.length === 0) {
        return no
      }
      written.push((0 < one.length ? one[0]! : __termReadPast(one, 0)))
    }
    const joined: string = written.join("")
    out.push(`(?:${joined})`)
    return out
  } else if (p.form === "choice") {
    const parts = p.parts
    const written: string[] = ([] as string[])
    for (const part of parts) {
      const one: string[] = nativeText(part, end, lineInline, foldFlags, words, lines)
      if (one.length === 0) {
        return no
      }
      written.push((0 < one.length ? one[0]! : __termReadPast(one, 0)))
    }
    const joined: string = written.join("|")
    out.push(`(?:${joined})`)
    return out
  } else if (p.form === "group") {
    const body = p.body
    const one: string[] = nativeText(body, end, lineInline, foldFlags, words, lines)
    if (one.length === 0) {
      return no
    }
    out.push(`(${(0 < one.length ? one[0]! : __termReadPast(one, 0))})`)
    return out
  } else if (p.form === "loop") {
    const body = p.body
    const least = p.least
    const most = p.most
    const greedy = p.greedy
    const possessive = p.possessive
    const one: string[] = nativeText(body, end, lineInline, foldFlags, words, lines)
    if (one.length === 0) {
      return no
    }
    let count: string = `{${least},${most}}`
    if (most < 0) {
      count = `{${least},}`
    } else if (least === most) {
      count = `{${least}}`
    }
    if (possessive) {
      count = `${count}+`
    } else if (!greedy) {
      count = `${count}?`
    }
    out.push(`(?:${(0 < one.length ? one[0]! : __termReadPast(one, 0))})${count}`)
    return out
  } else if (p.form === "atom") {
    const body = p.body
    const one: string[] = nativeText(body, end, lineInline, foldFlags, words, lines)
    if (one.length === 0) {
      return no
    }
    out.push(`(?>${(0 < one.length ? one[0]! : __termReadPast(one, 0))})`)
    return out
  } else if (p.form === "look") {
    const body = p.body
    const behind = p.behind
    const negate = p.negate
    const one: string[] = nativeText(body, end, lineInline, foldFlags, words, lines)
    if (one.length === 0) {
      return no
    }
    let opening: string = "(?="
    if (behind && negate) {
      opening = "(?<!"
    } else if (behind) {
      opening = "(?<="
    } else if (negate) {
      opening = "(?!"
    }
    out.push(`${opening}${(0 < one.length ? one[0]! : __termReadPast(one, 0))})`)
    return out
  } else {
    const index = p.index
    const fold = p.fold
    const backslash: string = String.fromCodePoint(92)
    if (fold) {
      out.push(`(?${foldFlags}:${backslash}${index})`)
    } else {
      out.push(`(?:${backslash}${index})`)
    }
    return out
  }
}

export function hasFoldedRefer(p: Piece): boolean {
  if (p.form === "refer") {
    const fold = p.fold
    return fold
  } else if (p.form === "chain") {
    const parts = p.parts
    for (const part of parts) {
      if (hasFoldedRefer(part)) {
        return true
      }
    }
    return false
  } else if (p.form === "choice") {
    const parts = p.parts
    for (const part of parts) {
      if (hasFoldedRefer(part)) {
        return true
      }
    }
    return false
  } else if (p.form === "loop") {
    const body = p.body
    return hasFoldedRefer(body)
  } else if (p.form === "group") {
    const body = p.body
    return hasFoldedRefer(body)
  } else if (p.form === "atom") {
    const body = p.body
    return hasFoldedRefer(body)
  } else if (p.form === "look") {
    const body = p.body
    return hasFoldedRefer(body)
  } else if (p.form === "blank") {
    return false
  } else if (p.form === "letter") {
    return false
  } else if (p.form === "ranges") {
    return false
  } else {
    return false
  }
}

export function needsBacktracking(p: Piece): boolean {
  if (p.form === "refer") {
    return true
  } else if (p.form === "atom") {
    return true
  } else if (p.form === "loop") {
    const body = p.body
    const possessive = p.possessive
    if (possessive) {
      return true
    }
    return needsBacktracking(body)
  } else if (p.form === "chain") {
    const parts = p.parts
    for (const part of parts) {
      if (needsBacktracking(part)) {
        return true
      }
    }
    return false
  } else if (p.form === "choice") {
    const parts = p.parts
    for (const part of parts) {
      if (needsBacktracking(part)) {
        return true
      }
    }
    return false
  } else if (p.form === "group") {
    const body = p.body
    return needsBacktracking(body)
  } else if (p.form === "look") {
    const body = p.body
    return needsBacktracking(body)
  } else if (p.form === "blank") {
    return false
  } else if (p.form === "letter") {
    return false
  } else if (p.form === "ranges") {
    return false
  } else {
    return false
  }
}

export function backtrackCause(p: Piece): string {
  if (p.form === "refer") {
    const index = p.index
    return `the back reference to group ${index}`
  } else if (p.form === "atom") {
    return "an atomic group"
  } else if (p.form === "loop") {
    const body = p.body
    const possessive = p.possessive
    if (possessive) {
      return "a possessive repetition"
    }
    return backtrackCause(body)
  } else if (p.form === "chain") {
    const parts = p.parts
    for (const part of parts) {
      const cause: string = backtrackCause(part)
      if (__termText.length(cause) > 0) {
        return cause
      }
    }
    return ""
  } else if (p.form === "choice") {
    const parts = p.parts
    for (const part of parts) {
      const cause: string = backtrackCause(part)
      if (__termText.length(cause) > 0) {
        return cause
      }
    }
    return ""
  } else if (p.form === "group") {
    const body = p.body
    return backtrackCause(body)
  } else if (p.form === "look") {
    const body = p.body
    return backtrackCause(body)
  } else if (p.form === "blank") {
    return ""
  } else if (p.form === "letter") {
    return ""
  } else if (p.form === "ranges") {
    return ""
  } else {
    return ""
  }
}

export function singleSet(p: Piece): number[] {
  while (true) {
    const none: number[] = ([] as number[])
    if (p.form === "letter") {
      const point = p.point
      return rangeSet(point, point)
    } else if (p.form === "ranges") {
      const set = p.set
      return set
    } else if (p.form === "group") {
      return none
    } else if (p.form === "chain") {
      const parts = p.parts
      if (parts.length === 1) {
        const __tail0_0: Piece = (0 < parts.length ? parts[0]! : __termReadPast(parts, 0))
        p = __tail0_0
        continue
      }
      return none
    } else if (p.form === "blank") {
      return none
    } else if (p.form === "edge") {
      return none
    } else if (p.form === "choice") {
      return none
    } else if (p.form === "loop") {
      return none
    } else if (p.form === "atom") {
      return none
    } else if (p.form === "look") {
      return none
    } else {
      return none
    }
  }
}

export function rewrite(p: Piece, backward: boolean): Piece {
  if (p.form === "loop") {
    const body = p.body
    const least = p.least
    const most = p.most
    const greedy = p.greedy
    const possessive = p.possessive
    const inner: Piece = rewrite(body, backward)
    if (possessive) {
      const only: number[] = singleSet(inner)
      if (only.length > 0) {
        return possessiveOfSet(inner, only, least, most, backward)
      }
    }
    return { form: "loop", body: inner, least: least, most: most, greedy: greedy, possessive: possessive }
  } else if (p.form === "atom") {
    const body = p.body
    const inner: Piece = rewrite(body, backward)
    if (inner.form === "loop") {
      const loopBody = inner.body
      const least = inner.least
      const most = inner.most
      const greedy = inner.greedy
      const only: number[] = singleSet(loopBody)
      if (greedy && only.length > 0) {
        return possessiveOfSet(loopBody, only, least, most, backward)
      }
    } else if (inner.form === "blank") {
      return inner
    } else if (inner.form === "letter") {
      return inner
    } else if (inner.form === "ranges") {
      return inner
    } else if (inner.form === "edge") {
      return inner
    } else if (inner.form === "chain") {
      return { form: "atom", body: inner }
    } else if (inner.form === "choice") {
      return { form: "atom", body: inner }
    } else if (inner.form === "group") {
      return { form: "atom", body: inner }
    } else if (inner.form === "atom") {
      return inner
    } else if (inner.form === "look") {
      return inner
    } else {
      return { form: "atom", body: inner }
    }
    return { form: "atom", body: inner }
  } else if (p.form === "chain") {
    const parts = p.parts
    const out: Piece[] = ([] as Piece[])
    const knownIndex: number[] = ([] as number[])
    const knownText: number[][] = ([] as number[][])
    for (const part of parts) {
      const partOut: Piece = rewrite(part, backward)
      const groupIndex: number = groupIndexOf(partOut)
      if (groupIndex >= 0) {
        const literal: number[] = fixedText(groupBodyOf(partOut))
        if (literal.length > 0) {
          knownIndex.push(groupIndex)
          knownText.push(literal)
        }
      }
      if (backward) {
        out.push(partOut)
      } else {
        out.push(expandRefer(partOut, knownIndex, knownText))
      }
    }
    return { form: "chain", parts: out }
  } else if (p.form === "choice") {
    const parts = p.parts
    const out: Piece[] = ([] as Piece[])
    for (const part of parts) {
      out.push(rewrite(part, backward))
    }
    return { form: "choice", parts: out }
  } else if (p.form === "group") {
    const body = p.body
    const index = p.index
    const label = p.label
    return { form: "group", body: rewrite(body, backward), index: index, label: label }
  } else if (p.form === "look") {
    const body = p.body
    const behind = p.behind
    const negate = p.negate
    return { form: "look", body: rewrite(body, behind), behind: behind, negate: negate }
  } else if (p.form === "blank") {
    return p
  } else if (p.form === "letter") {
    return p
  } else if (p.form === "ranges") {
    return p
  } else if (p.form === "edge") {
    return p
  } else {
    return p
  }
}

export function groupIndexOf(p: Piece): number {
  if (p.form === "group") {
    const index = p.index
    return index
  } else if (p.form === "blank") {
    return -1
  } else if (p.form === "letter") {
    return -1
  } else if (p.form === "ranges") {
    return -1
  } else if (p.form === "edge") {
    return -1
  } else if (p.form === "chain") {
    return -1
  } else if (p.form === "choice") {
    return -1
  } else if (p.form === "loop") {
    return -1
  } else if (p.form === "atom") {
    return -1
  } else if (p.form === "look") {
    return -1
  } else {
    return -1
  }
}

export function groupBodyOf(p: Piece): Piece {
  if (p.form === "group") {
    const body = p.body
    return body
  } else if (p.form === "blank") {
    return p
  } else if (p.form === "letter") {
    return p
  } else if (p.form === "ranges") {
    return p
  } else if (p.form === "edge") {
    return p
  } else if (p.form === "chain") {
    return p
  } else if (p.form === "choice") {
    return p
  } else if (p.form === "loop") {
    return p
  } else if (p.form === "atom") {
    return p
  } else if (p.form === "look") {
    return p
  } else {
    return p
  }
}

export function fixedText(p: Piece): number[] {
  const none: number[] = ([] as number[])
  if (p.form === "letter") {
    const point = p.point
    const out: number[] = ([] as number[])
    out.push(point)
    return out
  } else if (p.form === "chain") {
    const parts = p.parts
    const out: number[] = ([] as number[])
    for (const part of parts) {
      if (part.form === "letter") {
        const point = part.point
        out.push(point)
      } else if (part.form === "blank") {} else if (part.form === "ranges") {
        return none
      } else if (part.form === "edge") {
        return none
      } else if (part.form === "chain") {
        return none
      } else if (part.form === "choice") {
        return none
      } else if (part.form === "loop") {
        return none
      } else if (part.form === "group") {
        return none
      } else if (part.form === "atom") {
        return none
      } else if (part.form === "look") {
        return none
      } else {
        return none
      }
    }
    return out
  } else if (p.form === "blank") {
    return none
  } else if (p.form === "ranges") {
    return none
  } else if (p.form === "edge") {
    return none
  } else if (p.form === "choice") {
    return none
  } else if (p.form === "loop") {
    return none
  } else if (p.form === "group") {
    return none
  } else if (p.form === "atom") {
    return none
  } else if (p.form === "look") {
    return none
  } else {
    return none
  }
}

export function expandRefer(p: Piece, knownIndex: number[], knownText: number[][]): Piece {
  if (p.form === "refer") {
    const index = p.index
    const fold = p.fold
    let k: number = 0
    for (const each of knownIndex) {
      if (each === index && k < knownText.length) {
        const codes: number[] = (k >= 0 && k < knownText.length ? knownText[k]! : __termReadPast(knownText, k))
        const parts: Piece[] = ([] as Piece[])
        for (const c of codes) {
          if (fold) {
            parts.push({ form: "ranges", set: closeUnderCase(rangeSet(c, c)) })
          } else {
            parts.push({ form: "letter", point: c })
          }
        }
        return { form: "chain", parts: parts }
      }
      const __n160 = k + 1; if (!(__n160 <= 9007199254740991 && __n160 >= -9007199254740991)) __termIntStop(__n160); k = __n160
    }
    return p
  } else if (p.form === "blank") {
    return p
  } else if (p.form === "letter") {
    return p
  } else if (p.form === "ranges") {
    return p
  } else if (p.form === "edge") {
    return p
  } else if (p.form === "chain") {
    return p
  } else if (p.form === "choice") {
    return p
  } else if (p.form === "loop") {
    return p
  } else if (p.form === "group") {
    return p
  } else if (p.form === "atom") {
    return p
  } else {
    return p
  }
}

export function possessiveOfSet(body: Piece, set: number[], least: number, most: number, backward: boolean): Piece {
  const stop: Piece = { form: "look", body: { form: "ranges", set: set }, behind: backward, negate: true }
  if (most < 0) {
    const unbounded: Piece = { form: "loop", body: body, least: least, most: -1, greedy: true, possessive: false }
    return stopped(backward, stop, unbounded)
  }
  if (least === most) {
    return { form: "loop", body: body, least: least, most: most, greedy: true, possessive: false }
  }
  const fewer: Piece = { form: "loop", body: body, least: least, most: __termInt(most - 1), greedy: true, possessive: false }
  return { form: "choice", parts: [{ form: "loop", body: body, least: most, most: most, greedy: true, possessive: false }, stopped(backward, stop, fewer)] }
}

function stopped(backward: boolean, stop: Piece, run: Piece): Piece {
  const parts: Piece[] = ([] as Piece[])
  if (backward) {
    parts.push(stop)
    parts.push(run)
  } else {
    parts.push(run)
    parts.push(stop)
  }
  return { form: "chain", parts: parts }
}

export function largestClass(p: Piece): number {
  if (p.form === "ranges") {
    const set = p.set
    return Math.trunc(set.length / 2)
  } else if (p.form === "letter") {
    return 1
  } else if (p.form === "chain") {
    const parts = p.parts
    let most: number = 0
    for (const part of parts) {
      const size: number = largestClass(part)
      if (size > most) {
        most = size
      }
    }
    return most
  } else if (p.form === "choice") {
    const parts = p.parts
    let most: number = 0
    for (const part of parts) {
      const size: number = largestClass(part)
      if (size > most) {
        most = size
      }
    }
    return most
  } else if (p.form === "loop") {
    const body = p.body
    return largestClass(body)
  } else if (p.form === "group") {
    const body = p.body
    return largestClass(body)
  } else if (p.form === "atom") {
    const body = p.body
    return largestClass(body)
  } else if (p.form === "look") {
    const body = p.body
    return largestClass(body)
  } else if (p.form === "blank") {
    return 0
  } else if (p.form === "edge") {
    return 0
  } else {
    return 0
  }
}

export function nativeFor(p: Piece, features: string[], widest: number, profile: EngineProfile, words: string, lines: string): string {
  const linear: boolean = profile.linear
  const written: string = capableText(p, features, widest, profile, words, lines)
  if (written === "") {
    return ""
  }
  if (!linear && !isSafeToBacktrack(p)) {
    return ""
  }
  return written
}

export function capableText(p: Piece, features: string[], widest: number, profile: EngineProfile, words: string, lines: string): string {
  if (widest > profile.classLimit) {
    return ""
  }
  if (!featuresCovered(features, profile.features)) {
    return ""
  }
  const written: string[] = nativeText(p, profile.end, profile.lineInline, profile.foldFlags, words, lines)
  if (written.length === 0) {
    return ""
  }
  return (0 < written.length ? written[0]! : __termReadPast(written, 0))
}

export function analyzePattern(root: Piece, profile: EngineProfile): Analysis {
  const rewritten: Piece = rewrite(root, false)
  const folds: boolean = hasFoldedRefer(rewritten)
  const features: string[] = pieceFeatures(rewritten)
  let tier: number = tierLinear
  if (needsBacktracking(rewritten)) {
    tier = tierBacktrack
  }
  let words: number[] = ([] as number[])
  let widest: number = largestClass(rewritten)
  const wordEdges: boolean = holdsName(features, "word-edge")
  if (wordEdges) {
    words = wordSet()
    const size: number = Math.trunc(words.length / 2)
    if (size > widest) {
      widest = size
    }
  }
  let wordText: string = ""
  if (wordEdges) {
    wordText = classText(words)
  }
  const lineText: string = classText(negateSet(rangeSet(10, 10)))
  let native: string = nativeFor(rewritten, features, widest, profile, wordText, lineText)
  if (native === "") {
    native = nativeFor(root, pieceFeatures(root), widest, profile, wordText, lineText)
  }
  const hasNative: boolean = native !== ""
  let capable: string = native
  const fallback: number = tier
  if (hasNative) {
    tier = tierNative
  } else {
    capable = capableText(rewritten, features, widest, profile, wordText, lineText)
    if (capable === "") {
      capable = capableText(root, pieceFeatures(root), widest, profile, wordText, lineText)
    }
  }
  return { root: rewritten, tier: tier, native: native, hasNative: hasNative, folds: folds, fallback: fallback, features: features, capable: capable }
}

export interface Pattern {
  text: string
}

export interface PreparedPattern {
  source: string
  groups: number
  names: string[]
  tier: number
  fallback: number
  native: string
  program: Program
  folds: boolean
  words: boolean
  dfas: DfaPair
}

export interface Session {
  input: string
  runes: number[]
  scene: Scene
  tables: number[][]
  hasTables: number[]
}

const patternStepLimit: number = 10000000

export function stepLimit(instructions: number, length: number): number {
  const __n161 = __termInt(instructions * 64) * __termInt(length + 1); if (!(__n161 <= 9007199254740991 && __n161 >= -9007199254740991)) __termIntStop(__n161); const scaled: number = __n161
  if (scaled > patternStepLimit) {
    return scaled
  }
  return patternStepLimit
}

const preparedMemo: PreparedPattern[] = ([] as PreparedPattern[])

const preparedKeep: number = 64

export function prepare(value: Pattern): PreparedPattern {
  for (const kept of preparedMemo) {
    if (kept.source === value.text) {
      return kept
    }
  }
  const ready: PreparedPattern = prepareAnew(value)
  if (preparedMemo.length >= preparedKeep) {
    listPop(preparedMemo)
  }
  preparedMemo.push(ready)
  return ready
}

export function prepareAnew(value: Pattern): PreparedPattern {
  const parsed: Parsed = parsePattern(value.text)
  const found: Analysis = analyzePattern(parsed.root, { name: "ECMAScript (V8)", features: engineFeatures(), linear: false, classLimit: 557056, end: "$", lineInline: false, foldFlags: "i" })
  let root: Piece = found.root
  if (found.tier === tierNative) {
    root = __termVariantBlank
  }
  const source: Parsed = { root: root, groups: parsed.groups, names: parsed.names }
  const program: Program = compilePattern(source)
  const dfas: DfaPair = dfasFor(found.tier, program, source)
  return { source: value.text, groups: parsed.groups, names: parsed.names, tier: found.tier, fallback: found.fallback, native: found.native, program: program, folds: found.folds, words: usesWordEdge(program), dfas: dfas }
}

export function withProgram(ready: PreparedPattern): PreparedPattern {
  if (ready.tier !== tierNative) {
    return ready
  }
  const parsed: Parsed = parsePattern(ready.source)
  const found: Analysis = analyzePattern(parsed.root, { name: "ECMAScript (V8)", features: engineFeatures(), linear: false, classLimit: 557056, end: "$", lineInline: false, foldFlags: "i" })
  const source: Parsed = { root: found.root, groups: parsed.groups, names: parsed.names }
  const program: Program = compilePattern(source)
  const dfas: DfaPair = dfasFor(ready.fallback, program, source)
  return { source: ready.source, groups: ready.groups, names: ready.names, tier: ready.tier, fallback: ready.fallback, native: ready.native, program: program, folds: ready.folds, words: usesWordEdge(program), dfas: dfas }
}

export function dfasFor(tier: number, program: Program, source: Parsed): DfaPair {
  if (tier === tierLinear) {
    return makeDfaPair(program, source)
  }
  return noDfaPair()
}

export function backtrackReason(value: Pattern): string {
  const parsed: Parsed = parsePattern(value.text)
  const found: Analysis = analyzePattern(parsed.root, { name: "ECMAScript (V8)", features: engineFeatures(), linear: false, classLimit: 557056, end: "$", lineInline: false, foldFlags: "i" })
  return backtrackCause(found.root)
}

export function openSession(ready: PreparedPattern, input: string): Session {
  const runes: number[] = Array.from(input, function (rune) { return rune.codePointAt(0) ?? 0 })
  const noTables: number[][] = ([] as number[][])
  const flag: number[] = ([] as number[])
  flag.push(0)
  return { input: input, runes: runes, scene: makeSceneFor(runes, ready.words, ready.folds), tables: noTables, hasTables: flag }
}

export function sessionTables(ready: PreparedPattern, open: Session): number[][] {
  if (numberAt(open.hasTables, 0, 0) === 1) {
    return open.tables
  }
  const made: number[][] = lookTables(ready.program, open.scene)
  const kept: number[][] = open.tables
  for (const table of made) {
    kept.push(table)
  }
  putNumber(open.hasTables, 0, 1)
  return kept
}

export function searchSlots(ready: PreparedPattern, open: Session, from: number): number[] {
  if (ready.tier === tierNative) {
    const slots: number[] = engineSearch(ready.native, open.input, from)
    if (slots.length === 1 && (0 < slots.length ? slots[0]! : __termReadPast(slots, 0)) === -2) {
      const full: PreparedPattern = withProgram(ready)
      return termSearch(full, openSession(full, open.input), from, full.fallback)
    }
    return slots
  }
  return termSearch(ready, open, from, ready.tier)
}

export function termSearch(ready: PreparedPattern, open: Session, from: number, tier: number): number[] {
  if (tier === tierLinear) {
    if (ready.dfas.fits) {
      const none: number[][] = ([] as number[][])
      const slots: number[] = dfaSearch(ready.dfas.forward, ready.dfas.backward, ready.program, open.scene, none, from)
      if (!(slots.length === 1 && (0 < slots.length ? slots[0]! : __termReadPast(slots, 0)) === -2)) {
        return slots
      }
    }
    return pikeSearchWith(ready.program, open.scene, sessionTables(ready, open), from)
  }
  const limit: number = stepLimit(ready.program.ops.length, open.runes.length)
  return backSearch(ready.program, open.scene, from, limit)
}

export function matchesPrepared(ready: PreparedPattern, input: string): boolean {
  const slots: number[] = searchSlots(ready, openSession(ready, input), 0)
  return slots.length > 0
}

export interface LiteralPattern {
  refused: boolean
  at: number
  reason: string
  backtracks: string
}

export function readLiteralPattern(source: string): LiteralPattern {
  const literal: Pattern = { text: source }
  try {
    parsePattern(source)
    return { refused: false, at: -1, reason: "", backtracks: backtrackReason(literal) }
  } catch (error: any) {
    if (error.form === "pattern-mismatch") {
      const at = error.link.at
      const reason = error.link.reason
      return { refused: true, at: at, reason: reason, backtracks: "" }
    } else if (error.form === "failure") {
      return { refused: true, at: -1, reason: "the reader stopped", backtracks: "" }
    } else {
      throw error
    }
    return { refused: true, at: -1, reason: "the reader stopped", backtracks: "" }
  }
}

export interface ExcessLink {
  thing: string
  limit?: number
  actual?: number
}

export interface MismatchLink {
  thing: string
  expected?: string
  actual?: string
}

export interface FailureLink {
  thing: string
}

export interface PatternMismatchLink {
  thing: string
  expected?: string
  actual?: string
  at: number
  reason: string
}

export interface PatternBudgetLink {
  thing: string
  limit?: number
  actual?: number
  at: number
}
