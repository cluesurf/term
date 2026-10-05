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

export function split(value: string, delimiter: string): string[] {
  return __termText.split(value, delimiter)
}

export interface DiagnosticIn {
  name: string
  message: string
  file: string
  hasSpan: boolean
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
  hint: string
  severity: string
}

export interface CheckerGap {
  location: string
  kind: string
  message: string
  hint: string
  severity: string
  excerpt: string
}

export function repeatText(piece: string, count: number): string {
  let out: string = ""
  let at: number = 0
  while (at < count) {
    out = `${out}${piece}`
    at = at + 1
  }
  return out
}

export function excerptFor(source: string, found: DiagnosticIn): string {
  if (found.hasSpan) {} else {
    return ""
  }
  const lines: string[] = split(source, "\n")
  const __n0 = found.startLine + 1; if (!(__n0 <= 9007199254740991 && __n0 >= -9007199254740991)) __termIntStop(__n0); const lineNumber: number = __n0
  let line: string = ""
  if (found.startLine >= 0 && found.startLine < lines.length) {
    line = listGet(lines, found.startLine)
  }
  let end: number = Array.from(line).length
  if (found.endLine === found.startLine) {
    end = found.endColumn
  }
  const __n1 = end - found.startColumn; if (!(__n1 <= 9007199254740991 && __n1 >= -9007199254740991)) __termIntStop(__n1); let width: number = __n1
  if (width < 1) {
    width = 1
  }
  let lead: number = found.startColumn
  if (lead < 0) {
    lead = 0
  }
  const caret: string = `${repeatText(" ", lead)}${repeatText("^", width)}`
  const gutter: string = repeatText(" ", `${lineNumber}`.length)
  return `${lineNumber} | ${line}
${gutter} | ${caret}`
}

export function gapFromDiagnostic(source: string, found: DiagnosticIn): CheckerGap {
  let line: number = 1
  let column: number = 1
  if (found.hasSpan) {
    const __n2 = found.startLine + 1; if (!(__n2 <= 9007199254740991 && __n2 >= -9007199254740991)) __termIntStop(__n2); line = __n2
    const __n3 = found.startColumn + 1; if (!(__n3 <= 9007199254740991 && __n3 >= -9007199254740991)) __termIntStop(__n3); column = __n3
  }
  return { location: `${found.file}:${line}:${column}`, kind: found.name, message: found.message, hint: found.hint, severity: found.severity, excerpt: excerptFor(source, found) }
}

export function showGap(gap: CheckerGap): string {
  const lines: string[] = ([] as string[])
  lines.push(`gap [${gap.severity}] ${gap.kind} at ${gap.location}`)
  lines.push(`  ${gap.message}`)
  if (gap.excerpt !== "") {
    for (const each of split(gap.excerpt, "\n")) {
      lines.push(`  ${each}`)
    }
  }
  if (gap.hint !== "") {
    lines.push(`  hint: ${gap.hint}`)
  }
  return lines.join("\n")
}
