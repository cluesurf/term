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

export interface GlyphRule {
  name: string
  unicode: string
  ascii: string
  role: string
  rank: number
}

export interface RoleRule {
  name: string
  dark: string
  light: string
  ansi: string
}

export interface SymbolRule {
  name: string
  unicode: string
  ascii: string
}

export interface LayoutRule {
  verbColumn: number
  verbWidth: number
  bodyColumn: number
  hang: number
  leastWidth: number
  tagGap: number
  keyGap: number
  fieldGap: number
  alignKeys: boolean
  chainLinks: number
  tabStop: number
}

export interface DurationRule {
  figures: number
  millisecondUnit: string
  secondUnit: string
  minuteUnit: string
  hourUnit: string
  uptimeWord: string
}

export interface SizeRule {
  step: number
  units: string[]
  wholeFrom: number
  decimals: number
}

export interface NumberRule {
  group: string
  groupDigits: number
  part: string
}

export interface FactRule {
  order: string[]
  httpLabel: string
  exitLabel: string
  signalLabel: string
  clockFrom: number
  clockKinds: string[]
}

export interface WrapRule {
  tiers: string[]
  never: string
  locationTiers: string[]
}

export interface FieldRule {
  locationKey: string
  actionKeys: string[]
  standardKeys: string[]
  budgetKey: string
  passKey: string
  logKey: string
  nextKey: string
  sourcesKey: string
}

export interface FrameRule {
  context: number
  tabWidth: number
}

export interface QuoteRule {
  lines: number
  earlierWord: string
  framesWord: string
  frameStart: string
  foreign: string[]
  indent: number
}

export interface BarRule {
  width: number
}

export interface LiveRule {
  redrawMs: number
  quietProgressMs: number
}

export interface ServiceRule {
  tagWidth: number
  collapseMs: number
  dateVerb: string
  footerVerb: string
}

export interface CapRule {
  problems: number
  entries: number
  allFlag: string
  moreProblemsWord: string
  hiddenWord: string
  moreWord: string
  listsWord: string
  droppedWord: string
  dedupedWord: string
}

export interface ExitRule {
  value: number
  name: string
  glyph: string
}

export interface EnvironmentRule {
  noColor: string
  forceColor: string
  colorTerm: string
  truecolorValues: string[]
  forceOffValues: string[]
  terminal: string
  dumb: string
  ci: string
  localeNames: string[]
  utfMarkers: string[]
  forceHyperlink: string
  hyperlinkPrograms: string[]
  hyperlinkVariables: string[]
  programVariable: string
  backgroundVariable: string
  linkSchemes: string[]
  fileScheme: string
}

export interface KindRule {
  name: string
  verbs: string[]
  facts: string[]
  details: string[]
  order: string[]
}

export interface LevelRule {
  word: string
  glyph: string
  quiet: boolean
}

export interface ChildRule {
  levelKeys: string[]
  verbKeys: string[]
  messageKeys: string[]
  timeKeys: string[]
  durationKeys: string[]
  stackKeys: string[]
  defaultVerb: string
  levels: LevelRule[]
}

export interface KeyRule {
  glyph: string
  verb: string
  subject: string
  source: string
  time: string
  milliseconds: string
  status: string
  bytes: string
  counts: string
  facts: string
  message: string
  fields: string
  kind: string
}

export interface AskRule {
  verb: string
  confirmYes: string
  confirmNo: string
  manyHint: string
  oneHint: string
  yesFlag: string
  yesWord: string
  noWord: string
  noTerminal: string
}

export interface UnitWord {
  unit: string
  one: string
  many: string
}

export interface Standard {
  layout: LayoutRule
  glyphs: GlyphRule[]
  roles: RoleRule[]
  symbols: SymbolRule[]
  folds: SymbolRule[]
  durations: DurationRule
  sizes: SizeRule
  numbers: NumberRule
  facts: FactRule
  wraps: WrapRule
  fields: FieldRule
  frames: FrameRule
  quotes: QuoteRule
  bars: BarRule
  lives: LiveRule
  services: ServiceRule
  caps: CapRule
  exits: ExitRule[]
  environment: EnvironmentRule
  kinds: KindRule[]
  children: ChildRule
  keys: KeyRule
  asks: AskRule
  unitWords: UnitWord[]
}

export function split(value: string, delimiter: string): string[] {
  return __termText.split(value, delimiter)
}

export function startsWith(value: string, prefix: string): boolean {
  return __termText.startsWith(value, prefix)
}

export interface Span {
  value: string
  role: string
  strong: boolean
  href: string
  focus: boolean
}

export interface Line {
  spans: Span[]
}

export interface Room {
  width: number
  standard: Standard
  ascii: boolean
  offset: number
  utc: boolean
  root: string
}

export function narrowRoom(one: Room, by: number): Room {
  const less: Room = { ...one }
  const __n0 = one.width - by; if (!(__n0 <= 9007199254740991 && __n0 >= -9007199254740991)) __termIntStop(__n0); let cells: number = __n0
  if (cells < 1) {
    cells = 1
  }
  less.width = cells
  return less
}

export function makeSpan(value: string, role: string): Span {
  return { value: value, role: role, strong: false, href: "", focus: false }
}

export function restyleSpan(one: Span, value: string): Span {
  const copy: Span = { ...one }
  copy.value = value
  return copy
}

export function makeSpaces(count: number): string {
  let out: string = ""
  let at: number = 0
  while (at < count) {
    out = `${out} `
    at = at + 1
  }
  return out
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

export function indentLines(lines: Line[], column: number): Line[] {
  const out: Line[] = ([] as Line[])
  const pad: string = makeSpaces(column)
  for (const one of lines) {
    if (one.spans.length === 0) {
      out.push(one)
    } else {
      const spans: Span[] = ([] as Span[])
      spans.push({ value: pad, role: "text", strong: false, href: "", focus: false })
      for (const piece of one.spans) {
        spans.push(piece)
      }
      out.push({ spans: spans })
    }
  }
  return out
}

export function findSymbol(room: Room, name: string): string {
  for (const one of room.standard.symbols) {
    if (one.name === name) {
      if (room.ascii) {
        return one.ascii
      }
      return one.unicode
    }
  }
  return ""
}

export function findGlyph(standard: Standard, name: string): GlyphRule {
  for (const one of standard.glyphs) {
    if (one.name === name) {
      return one
    }
  }
  for (const one of standard.glyphs) {
    if (one.name === "info") {
      return one
    }
  }
  return { name: name, unicode: "·", ascii: "-", role: "dim", rank: 0 }
}

export function drawGlyph(room: Room, name: string): string {
  const rule: GlyphRule = findGlyph(room.standard, name)
  if (room.ascii) {
    return rule.ascii
  }
  return rule.unicode
}

export function glyphRole(standard: Standard, name: string): string {
  const rule: GlyphRule = findGlyph(standard, name)
  return rule.role
}

export function holdsText(values: string[], wanted: string): boolean {
  for (const one of values) {
    if (one === wanted) {
      return true
    }
  }
  return false
}

export interface Status {
  kind: string
  value: number
  name: string
}

export interface Tally {
  amount: number
  noun: string
  one: string
  total: number
}

export interface ItemField {
  key: string
  value: Span[]
  location: boolean
}

export interface FrameLine {
  number: number
  value: string
}

export interface FrameMark {
  line: number
  column: number
  length: number
  label: string
  primary: boolean
}

export interface Frame {
  lines: FrameLine[]
  marks: FrameMark[]
  tabWidth: number
}

export interface Choice {
  label: string
  hint: string
  picked: boolean
  focused: boolean
  value: string
}

export interface Column {
  title: string
  numeric: boolean
}

export interface TableRow {
  entries: Span[]
}

export interface TreeNode {
  label: string
  detail: string
  deduped: boolean
  children: TreeNode[]
}

export interface ListEntry {
  label: string
  detail: string
}

export interface Location {
  path: string
  line: number
  column: number
}

export interface Event {
  glyph: string
  kind: string
  verb: string
  subject: Span[]
  source: string
  clock: number
  tool: string[]
  zone: string
  duration: number
  uptime: boolean
  budget: number
  status: Status
  bytes: number
  tallies: Tally[]
  facts: string[]
  message: string[]
  fields: ItemField[]
  frames: Frame[]
  quote: string[]
  quoteEarlier: number
  quoteLog: string
  done: number
  total: number
  choices: Choice[]
  asking: boolean
  typed: string
  secret: boolean
  columns: Column[]
  rows: TableRow[]
  nodes: TreeNode[]
  entries: ListEntry[]
  entryTotal: number
  level: string
  verdict: boolean
  place: Location
  id: string
  cause: string
  repeat: number
}

export function plainSubject(value: string): Span[] {
  const spans: Span[] = ([] as Span[])
  spans.push({ value: value, role: "text", strong: false, href: "", focus: false })
  return spans
}

export function plainField(key: string, value: string): ItemField {
  const spans: Span[] = ([] as Span[])
  spans.push({ value: value, role: "text", strong: false, href: "", focus: false })
  return { key: key, value: spans, location: false }
}

export interface Grain {
  value: string
  wide: number
}

export function listZeroRanges(): number[] {
  const ranges: number[] = [768, 879, 1155, 1161, 1425, 1469, 1471, 1471, 1473, 1474, 1476, 1477, 1479, 1479, 1552, 1562, 1611, 1631, 1648, 1648, 1750, 1756, 1759, 1764, 1767, 1768, 1770, 1773, 1809, 1809, 1840, 1866, 1958, 1968, 2027, 2035, 2045, 2045, 2070, 2073, 2075, 2083, 2085, 2087, 2089, 2093, 2137, 2139, 2200, 2207, 2250, 2273, 2275, 2306, 2362, 2362, 2364, 2364, 2369, 2376, 2381, 2381, 2385, 2391, 2402, 2403, 2433, 2433, 2492, 2492, 2497, 2500, 2509, 2509, 2530, 2531, 2558, 2558, 2561, 2562, 2620, 2620, 2625, 2626, 2631, 2632, 2635, 2637, 2641, 2641, 2672, 2673, 2677, 2677, 2689, 2690, 2748, 2748, 2753, 2757, 2759, 2760, 2765, 2765, 2786, 2787, 2810, 2815, 2817, 2817, 2876, 2876, 2879, 2879, 2881, 2884, 2893, 2893, 2901, 2902, 2914, 2915, 2946, 2946, 3008, 3008, 3021, 3021, 3072, 3072, 3076, 3076, 3132, 3132, 3134, 3136, 3142, 3144, 3146, 3149, 3157, 3158, 3170, 3171, 3201, 3201, 3260, 3260, 3263, 3263, 3270, 3270, 3276, 3277, 3298, 3299, 3328, 3329, 3387, 3388, 3393, 3396, 3405, 3405, 3426, 3427, 3457, 3457, 3530, 3530, 3538, 3540, 3542, 3542, 3633, 3633, 3636, 3642, 3655, 3662, 3761, 3761, 3764, 3772, 3784, 3790, 3864, 3865, 3893, 3893, 3895, 3895, 3897, 3897, 3953, 3966, 3968, 3972, 3974, 3975, 3981, 3991, 3993, 4028, 4038, 4038, 4141, 4144, 4146, 4151, 4153, 4154, 4157, 4158, 4184, 4185, 4190, 4192, 4209, 4212, 4226, 4226, 4229, 4230, 4237, 4237, 4253, 4253, 4448, 4607, 4957, 4959, 5906, 5908, 5938, 5939, 5970, 5971, 6002, 6003, 6068, 6069, 6071, 6077, 6086, 6086, 6089, 6099, 6109, 6109, 6155, 6159, 6277, 6278, 6313, 6313, 6432, 6434, 6439, 6440, 6450, 6450, 6457, 6459, 6679, 6680, 6683, 6683, 6742, 6742, 6744, 6750, 6752, 6752, 6754, 6754, 6757, 6764, 6771, 6780, 6783, 6783, 6832, 6862, 6912, 6915, 6964, 6964, 6966, 6970, 6972, 6972, 6978, 6978, 7019, 7027, 7040, 7041, 7074, 7077, 7080, 7081, 7083, 7085, 7142, 7142, 7144, 7145, 7149, 7149, 7151, 7153, 7212, 7219, 7222, 7223, 7376, 7378, 7380, 7392, 7394, 7400, 7405, 7405, 7412, 7412, 7416, 7417, 7616, 7679, 8203, 8205, 8288, 8292, 8298, 8303, 8400, 8432, 11503, 11505, 11647, 11647, 11744, 11775, 12330, 12333, 12441, 12442, 42607, 42610, 42612, 42621, 42654, 42655, 42736, 42737, 43010, 43010, 43014, 43014, 43019, 43019, 43045, 43046, 43052, 43052, 43204, 43205, 43232, 43249, 43263, 43263, 43302, 43309, 43335, 43345, 43392, 43394, 43443, 43443, 43446, 43449, 43452, 43453, 43493, 43493, 43561, 43566, 43569, 43570, 43573, 43574, 43587, 43587, 43596, 43596, 43644, 43644, 43696, 43696, 43698, 43700, 43703, 43704, 43710, 43711, 43713, 43713, 43756, 43757, 43766, 43766, 44005, 44005, 44008, 44008, 44013, 44013, 55216, 55295, 64286, 64286, 65024, 65039, 65056, 65071, 65279, 65279, 65529, 65531, 66045, 66045, 66272, 66272, 66422, 66426, 68097, 68111, 68152, 68159, 68325, 68326, 68900, 68903, 69291, 69292, 69446, 69456, 69633, 69633, 69688, 69702, 69759, 69761, 69811, 69814, 69817, 69818, 69888, 69890, 69927, 69931, 69933, 69940, 94095, 94098, 113821, 113822, 119143, 119145, 119163, 119170, 119173, 119179, 119210, 119213, 122880, 122922, 125136, 125142, 125252, 125258, 127995, 127999, 917505, 917505, 917536, 917631, 917760, 917999]
  return ranges
}

export function listSpacingRanges(): number[] {
  const ranges: number[] = [2307, 2307, 2363, 2363, 2366, 2368, 2377, 2380, 2382, 2383, 2434, 2435, 2494, 2496, 2503, 2504, 2507, 2508, 2519, 2519, 2563, 2563, 2622, 2624, 2691, 2691, 2750, 2752, 2761, 2761, 2763, 2764, 2818, 2819, 2878, 2878, 2880, 2880, 2887, 2888, 2891, 2892, 2903, 2903, 3006, 3007, 3009, 3010, 3014, 3016, 3018, 3020, 3031, 3031, 3073, 3075, 3137, 3140, 3202, 3203, 3262, 3262, 3264, 3268, 3271, 3272, 3274, 3275, 3285, 3286, 3330, 3331, 3390, 3392, 3398, 3400, 3402, 3404, 3415, 3415, 3458, 3459, 3535, 3537, 3544, 3551, 3570, 3571, 3902, 3903, 3967, 3967, 4139, 4140, 4145, 4145, 4152, 4152, 4155, 4156, 4182, 4183, 4194, 4196, 4199, 4205, 4227, 4228, 4231, 4236, 4239, 4239, 4250, 4252, 6070, 6070, 6078, 6085, 6087, 6088, 6435, 6438, 6441, 6443, 6448, 6449, 6451, 6456, 6681, 6682, 6741, 6741, 6743, 6743, 6753, 6753, 6755, 6756, 6765, 6770, 6916, 6916, 6965, 6965, 6971, 6971, 6973, 6977, 6979, 6980, 7042, 7042, 7073, 7073, 7078, 7079, 7082, 7082, 7143, 7143, 7146, 7148, 7150, 7150, 7154, 7155, 7204, 7211, 7220, 7221, 7393, 7393, 7415, 7415, 43043, 43044, 43047, 43047, 43136, 43137, 43188, 43203, 43346, 43347, 43395, 43395, 43444, 43445, 43450, 43451, 43454, 43456, 43567, 43568, 43571, 43572, 43597, 43597, 43643, 43643, 43645, 43645, 43755, 43755, 43758, 43759, 43765, 43765, 44003, 44004, 44006, 44007, 44009, 44010, 44012, 44012]
  return ranges
}

export function listWideRanges(): number[] {
  const ranges: number[] = [4352, 4447, 8986, 8987, 9001, 9002, 9193, 9196, 9200, 9200, 9203, 9203, 9725, 9726, 9748, 9749, 9800, 9811, 9855, 9855, 9875, 9875, 9889, 9889, 9898, 9899, 9917, 9918, 9924, 9925, 9934, 9934, 9940, 9940, 9962, 9962, 9970, 9971, 9973, 9973, 9978, 9978, 9981, 9981, 9989, 9989, 9994, 9995, 10024, 10024, 10060, 10060, 10062, 10062, 10067, 10069, 10071, 10071, 10133, 10135, 10160, 10160, 10175, 10175, 11035, 11036, 11088, 11088, 11093, 11093, 11904, 11929, 11931, 12019, 12032, 12245, 12272, 12287, 12288, 12350, 12353, 12438, 12441, 12543, 12549, 12591, 12593, 12686, 12688, 12771, 12783, 12830, 12832, 12871, 12880, 19903, 19968, 42124, 42128, 42182, 43360, 43388, 44032, 55203, 63744, 64255, 65040, 65049, 65072, 65106, 65108, 65126, 65128, 65131, 65281, 65376, 65504, 65510, 94176, 94180, 94192, 94193, 94208, 100343, 100352, 101589, 101632, 101640, 110576, 110590, 110592, 110882, 110898, 110898, 110928, 110930, 110933, 110933, 110948, 110951, 110960, 111355, 126980, 126980, 127183, 127183, 127374, 127374, 127377, 127386, 127488, 127490, 127504, 127547, 127552, 127560, 127568, 127569, 127584, 127589, 127744, 127776, 127789, 127797, 127799, 127868, 127870, 127891, 127904, 127946, 127951, 127955, 127968, 127984, 127988, 127988, 127992, 128062, 128064, 128064, 128066, 128252, 128255, 128317, 128331, 128334, 128336, 128359, 128378, 128378, 128405, 128406, 128420, 128420, 128507, 128591, 128640, 128709, 128716, 128716, 128720, 128722, 128725, 128727, 128732, 128735, 128747, 128748, 128756, 128764, 128992, 129003, 129008, 129008, 129292, 129338, 129340, 129349, 129351, 129535, 129648, 129660, 129664, 129672, 129680, 129725, 129727, 129733, 129742, 129755, 129760, 129768, 129776, 129784, 131072, 196605, 196608, 262141]
  return ranges
}

export function listBidiRanges(): number[] {
  const ranges: number[] = [1564, 1564, 8206, 8207, 8234, 8238, 8294, 8297]
  return ranges
}

export function isInRanges(ranges: number[], rune: number): boolean {
  let at: number = 0
  const size: number = ranges.length
  while (__termInt(at + 1) < size) {
    const __n1 = at + 1; if (!(__n1 <= 9007199254740991 && __n1 >= -9007199254740991)) __termIntStop(__n1); const next: number = __n1
    const low: number = (at >= 0 && at < ranges.length ? ranges[at]! : __termReadPast(ranges, at))
    const high: number = (next >= 0 && next < ranges.length ? ranges[next]! : __termReadPast(ranges, next))
    if (rune < low) {
      return false
    }
    if (rune <= high) {
      return true
    }
    const __n2 = at + 2; if (!(__n2 <= 9007199254740991 && __n2 >= -9007199254740991)) __termIntStop(__n2); at = __n2
  }
  return false
}

export function isControl(rune: number): boolean {
  if (rune < 32) {
    return true
  }
  if (rune >= 127 && rune < 160) {
    return true
  }
  return false
}

export function isRegional(rune: number): boolean {
  return rune >= 127462 && rune <= 127487
}

export function measureRune(rune: number): number {
  if (isControl(rune)) {
    return 0
  }
  if (rune < 768) {
    return 1
  }
  if (isInRanges(listZeroRanges(), rune)) {
    return 0
  }
  if (isInRanges(listWideRanges(), rune)) {
    return 2
  }
  return 1
}

export function isExtender(rune: number): boolean {
  if (rune < 768) {
    return false
  }
  if (isInRanges(listZeroRanges(), rune)) {
    return true
  }
  return isInRanges(listSpacingRanges(), rune)
}

export function measureCluster(runes: number[]): number {
  const count: number = runes.length
  if (count === 0) {
    return 0
  }
  const first: number = (0 < runes.length ? runes[0]! : __termReadPast(runes, 0))
  if (count === 1) {
    return measureRune(first)
  }
  let emoji: boolean = false
  for (const rune of runes) {
    if (rune === 65039 || (rune === 8419 || rune === 8205)) {
      emoji = true
    }
  }
  if (first >= 127462 && first <= 127487 && count === 2) {
    return 2
  }
  if (emoji) {
    if (runeWidthOrTwo(first) === 2) {
      return 2
    }
    if (containsRune(runes, 65039)) {
      return 2
    }
  }
  let total: number = 0
  let joined: boolean = false
  for (const rune of runes) {
    if (joined) {} else {
      const __n3 = total + measureRune(rune); if (!(__n3 <= 9007199254740991 && __n3 >= -9007199254740991)) __termIntStop(__n3); total = __n3
    }
    joined = rune === 8205
  }
  return total
}

export function runeWidthOrTwo(rune: number): number {
  if (rune >= 126976) {
    return 2
  }
  return measureRune(rune)
}

export function containsRune(runes: number[], wanted: number): boolean {
  for (const rune of runes) {
    if (rune === wanted) {
      return true
    }
  }
  return false
}

export function makeGrains(value: string): Grain[] {
  const out: Grain[] = ([] as Grain[])
  let current: number[] = ([] as number[])
  let afterJoiner: boolean = false
  for (const rune of Array.from(value, function (rune) { return rune.codePointAt(0) ?? 0 })) {
    let join: boolean = false
    if (current.length > 0) {
      if (afterJoiner || isExtender(rune)) {
        join = true
      }
      if (rune >= 127462 && rune <= 127487 && (current.length === 1 && isRegional((0 < current.length ? current[0]! : __termReadPast(current, 0))))) {
        join = true
      }
    }
    if (join) {
      current.push(rune)
    } else {
      if (current.length > 0) {
        out.push(makeGrain(current))
      }
      current = ([] as number[])
      current.push(rune)
    }
    afterJoiner = rune === 8205
  }
  if (current.length > 0) {
    out.push(makeGrain(current))
  }
  return out
}

export function makeGrain(runes: number[]): Grain {
  let value: string = ""
  for (const rune of runes) {
    value = `${value}${String.fromCodePoint(rune)}`
  }
  return { value: value, wide: measureCluster(runes) }
}

export function measureText(value: string): number {
  let total: number = 0
  for (const one of makeGrains(value)) {
    const __n4 = total + one.wide; if (!(__n4 <= 9007199254740991 && __n4 >= -9007199254740991)) __termIntStop(__n4); total = __n4
  }
  return total
}

export function writeHex(value: number): string {
  const runes: number[] = Array.from("0123456789abcdef", function (rune) { return rune.codePointAt(0) ?? 0 })
  let out: string = ""
  let rest: number = value
  while (rest > 0) {
    const digit: number = rest % 16
    const shown: string = String.fromCodePoint((digit >= 0 && digit < runes.length ? runes[digit]! : __termReadPast(runes, digit)))
    out = `${shown}${out}`
    const __n5 = Math.trunc(__termInt(rest - digit) / 16); if (!(__n5 <= 9007199254740991 && __n5 >= -9007199254740991)) __termIntStop(__n5); rest = __n5
  }
  let have: number = Array.from(out).length
  while (have < 2) {
    out = `0${out}`
    have = have + 1
  }
  return out
}

export function showControl(rune: number, ascii: boolean): string {
  if (rune === 127) {
    if (ascii) {
      return "^?"
    }
    return String.fromCodePoint(9249)
  }
  if (rune < 32) {
    if (ascii) {
      const letter: string = String.fromCodePoint(__termInt(rune + 64))
      return `^${letter}`
    }
    return String.fromCodePoint(__termInt(9216 + rune))
  }
  const digits: string = writeHex(rune)
  return `\\x${digits}`
}

export function showBidi(rune: number): string {
  let digits: string = writeHex(rune)
  let have: number = Array.from(digits).length
  while (have < 4) {
    digits = `0${digits}`
    have = have + 1
  }
  return `\\u${digits}`
}

export function neutralize(value: string, standard: Standard, ascii: boolean): string {
  let out: string = ""
  let column: number = 0
  let stop: number = standard.layout.tabStop
  if (stop < 1) {
    stop = 8
  }
  for (const rune of Array.from(value, function (rune) { return rune.codePointAt(0) ?? 0 })) {
    let piece: string = String.fromCodePoint(rune)
    if (rune === 9) {
      const __n6 = stop - __termInt(column % stop); if (!(__n6 <= 9007199254740991 && __n6 >= -9007199254740991)) __termIntStop(__n6); const gap: number = __n6
      piece = ""
      let at: number = 0
      while (at < gap) {
        piece = `${piece} `
        at = at + 1
      }
    } else {
      if (isControl(rune)) {
        piece = showControl(rune, ascii)
      } else {
        if (isInRanges(listBidiRanges(), rune)) {
          piece = showBidi(rune)
        } else {
          if (ascii && rune > 126) {
            piece = foldRune(standard, piece)
          }
        }
      }
    }
    out = `${out}${piece}`
    const __n7 = column + measureText(piece); if (!(__n7 <= 9007199254740991 && __n7 >= -9007199254740991)) __termIntStop(__n7); column = __n7
  }
  return out
}

export function foldRune(standard: Standard, piece: string): string {
  for (const one of standard.folds) {
    if (one.unicode === piece) {
      return one.ascii
    }
  }
  return piece
}

export function stripEscapes(value: string): string {
  let out: string = ""
  let state: number = 0
  for (const rune of Array.from(value, function (rune) { return rune.codePointAt(0) ?? 0 })) {
    if (state === 0) {
      if (rune === 27) {
        state = 1
      } else {
        out = `${out}${String.fromCodePoint(rune)}`
      }
      continue
    }
    if (state === 1) {
      if (rune === 91) {
        state = 2
      } else {
        if (rune === 93) {
          state = 3
        } else {
          state = 0
        }
      }
      continue
    }
    if (state === 2) {
      if (rune >= 64 && rune <= 126) {
        state = 0
      }
      continue
    }
    if (state === 3) {
      if (rune === 7) {
        state = 0
      } else {
        if (rune === 27) {
          state = 4
        }
      }
      continue
    }
    if (rune === 92) {
      state = 0
    } else {
      state = 3
    }
  }
  return out
}

export function makeWhole(value: number): number {
  if (value !== value) {
    return 0
  }
  const limit: number = 9007199254740991
  if (value > limit) {
    return limit
  }
  const least: number = 0 - limit
  if (value < least) {
    return least
  }
  if (value >= 4503599627370496 || value <= -4503599627370496) {
    return value
  }
  if (value >= 0) {
    return Math.trunc((value * 2 + 1) / 2)
  }
  const flipped: number = 0 - value
  const __n8 = 0 - Math.trunc(__termInt(__termInt(flipped * 2) + 1) / 2); if (!(__n8 <= 9007199254740991 && __n8 >= -9007199254740991)) __termIntStop(__n8); return __n8
}

export function divideRound(top: number, bottom: number): number {
  if (bottom <= 0) {
    return 0
  }
  const whole: number = Math.trunc(top / bottom)
  const __n9 = top - __termInt(whole * bottom); if (!(__n9 <= 9007199254740991 && __n9 >= -9007199254740991)) __termIntStop(__n9); const rest: number = __n9
  if (rest >= __termInt(bottom - rest)) {
    const __n10 = whole + 1; if (!(__n10 <= 9007199254740991 && __n10 >= -9007199254740991)) __termIntStop(__n10); return __n10
  }
  return whole
}

export function divideWhole(top: number, bottom: number): number {
  if (bottom <= 0) {
    return 0
  }
  return Math.trunc(top / bottom)
}

export function powerOfTen(places: number): number {
  let out: number = 1
  let at: number = 0
  while (at < places) {
    const __n11 = out * 10; if (!(__n11 <= 9007199254740991 && __n11 >= -9007199254740991)) __termIntStop(__n11); out = __n11
    at = at + 1
  }
  return out
}

export function padDigits(value: number, places: number): string {
  let out: string = `${value}`
  let have: number = out.length
  while (have < places) {
    out = `0${out}`
    have = have + 1
  }
  return out
}

export function groupNumber(value: number, standard: Standard): string {
  let whole: number = makeWhole(value)
  let sign: string = ""
  if (whole < 0) {
    sign = "-"
    const __n12 = 0 - whole; if (!(__n12 <= 9007199254740991 && __n12 >= -9007199254740991)) __termIntStop(__n12); whole = __n12
  }
  const digits: string = `${whole}`
  const runes: number[] = Array.from(digits, function (rune) { return rune.codePointAt(0) ?? 0 })
  const count: number = runes.length
  const every: number = standard.numbers.groupDigits
  const mark: string = standard.numbers.group
  let out: string = ""
  let at: number = 0
  for (const rune of runes) {
    const __n13 = count - at; if (!(__n13 <= 9007199254740991 && __n13 >= -9007199254740991)) __termIntStop(__n13); const left: number = __n13
    if (at > 0 && (every > 0 && __termInt(left % every) === 0)) {
      out = `${out}${mark}`
    }
    out = `${out}${String.fromCodePoint(rune)}`
    const __n14 = at + 1; if (!(__n14 <= 9007199254740991 && __n14 >= -9007199254740991)) __termIntStop(__n14); at = __n14
  }
  return `${sign}${out}`
}

export function spansText(spans: Span[]): string {
  let out: string = ""
  for (const one of spans) {
    out = `${out}${one.value}`
  }
  return out
}

export function pushFigure(spans: Span[], number: string, unit: string, numberRole: string, unitRole: string): Span[] {
  spans.push({ value: number, role: numberRole, strong: false, href: "", focus: false })
  spans.push(makeSpan(String.fromCodePoint(160), unitRole))
  spans.push({ value: unit, role: unitRole, strong: false, href: "", focus: false })
  return spans
}

export function formatDuration(milliseconds: number, standard: Standard, numberRole: string): Span[] {
  const rule: DurationRule = standard.durations
  let unitRole: string = "dim"
  if (numberRole !== "text") {
    unitRole = numberRole
  }
  const spans: Span[] = ([] as Span[])
  let ms: number = makeWhole(milliseconds)
  if (ms < 0) {
    ms = 0
  }
  if (ms < 1000) {
    return pushFigure(spans, `${ms}`, rule.millisecondUnit, numberRole, unitRole)
  }
  const hundredths: number = divideRound(ms, 10)
  if (hundredths < 1000) {
    const whole: number = divideWhole(hundredths, 100)
    const part: string = padDigits(hundredths % 100, 2)
    return pushFigure(spans, `${whole}.${part}`, rule.secondUnit, numberRole, unitRole)
  }
  const tenths: number = divideRound(ms, 100)
  if (tenths < 600) {
    const whole: number = divideWhole(tenths, 10)
    const part: number = tenths % 10
    return pushFigure(spans, `${whole}.${part}`, rule.secondUnit, numberRole, unitRole)
  }
  const seconds: number = divideRound(ms, 1000)
  if (seconds < 3600) {
    const minutes: number = divideWhole(seconds, 60)
    const rest: string = padDigits(seconds % 60, 2)
    spans.push(makeSpan(`${minutes}`, numberRole))
    spans.push({ value: rule.minuteUnit, role: unitRole, strong: false, href: "", focus: false })
    spans.push(makeSpan(String.fromCodePoint(160), unitRole))
    spans.push({ value: rest, role: numberRole, strong: false, href: "", focus: false })
    spans.push({ value: rule.secondUnit, role: unitRole, strong: false, href: "", focus: false })
    return spans
  }
  const minutes: number = divideRound(ms, 60000)
  const hours: number = divideWhole(minutes, 60)
  const rest: string = padDigits(minutes % 60, 2)
  spans.push(makeSpan(groupNumber(hours, standard), numberRole))
  spans.push({ value: rule.hourUnit, role: unitRole, strong: false, href: "", focus: false })
  spans.push(makeSpan(String.fromCodePoint(160), unitRole))
  spans.push({ value: rest, role: numberRole, strong: false, href: "", focus: false })
  spans.push({ value: rule.minuteUnit, role: unitRole, strong: false, href: "", focus: false })
  return spans
}

export function formatSize(bytes: number, standard: Standard): Span[] {
  const rule: SizeRule = standard.sizes
  const spans: Span[] = ([] as Span[])
  let value: number = makeWhole(bytes)
  if (value < 0) {
    value = 0
  }
  const units: string[] = rule.units
  let step: number = rule.step
  if (step < 2) {
    step = 1000
  }
  const scale: number = powerOfTen(rule.decimals)
  if (value < step || units.length < 2) {
    const first: string = (0 < units.length ? units[0]! : __termReadPast(units, 0))
    return pushFigure(spans, groupNumber(value, standard), first, "text", "dim")
  }
  let index: number = 1
  let divisor: number = step
  while (index < units.length) {
    const unit: string = (index >= 0 && index < units.length ? units[index]! : __termReadPast(units, index))
    let fraction: number = divideRound(value, __termInt(Math.trunc(divisor / scale)))
    if (__termInt(divisor % scale) > 0) {
      fraction = divideRound(__termInt(value * scale), divisor)
    }
    if (fraction < __termInt(rule.wholeFrom * scale)) {
      const whole: number = divideWhole(fraction, scale)
      const part: string = padDigits(__termInt(fraction % scale), rule.decimals)
      if (rule.decimals > 0) {
        return pushFigure(spans, `${whole}.${part}`, unit, "text", "dim")
      }
      return pushFigure(spans, `${whole}`, unit, "text", "dim")
    }
    const whole: number = divideRound(value, divisor)
    const last: boolean = index + 1 === units.length
    if (whole < step || last) {
      return pushFigure(spans, groupNumber(whole, standard), unit, "text", "dim")
    }
    index = index + 1
    const __n15 = divisor * step; if (!(__n15 <= 9007199254740991 && __n15 >= -9007199254740991)) __termIntStop(__n15); divisor = __n15
  }
  const first: string = (0 < units.length ? units[0]! : __termReadPast(units, 0))
  return pushFigure(spans, groupNumber(value, standard), first, "text", "dim")
}

export function formatTally(amount: number, noun: string, one: string, total: number, standard: Standard): Span[] {
  const spans: Span[] = ([] as Span[])
  let number: string = groupNumber(amount, standard)
  let word: string = noun
  if (total >= 0) {
    const part: string = standard.numbers.part
    number = `${number}${part}${groupNumber(total, standard)}`
  } else {
    if (makeWhole(amount) === 1 && one !== "") {
      word = one
    }
  }
  if (word === "") {
    spans.push({ value: number, role: "text", strong: false, href: "", focus: false })
    return spans
  }
  return pushFigure(spans, number, word, "text", "dim")
}

export function statusRole(kind: string, value: number): string {
  if (kind === "http") {
    if (value < 400) {
      return "done"
    }
    if (value < 500) {
      return "warning"
    }
    return "failed"
  }
  if (kind === "exit" && value === 0) {
    return "done"
  }
  return "failed"
}

export function formatStatus(kind: string, value: number, name: string, standard: Standard): Span[] {
  const spans: Span[] = ([] as Span[])
  const rule: FactRule = standard.facts
  const role: string = statusRole(kind, value)
  if (kind === "http") {
    return pushFigure(spans, rule.httpLabel, `${makeWhole(value)}`, "dim", role)
  }
  if (kind === "exit") {
    return pushFigure(spans, rule.exitLabel, `${makeWhole(value)}`, "dim", role)
  }
  if (kind === "signal") {
    return pushFigure(spans, rule.signalLabel, name, "dim", role)
  }
  return spans
}

export function moduloFloor(value: number, base: number): number {
  const rest: number = value % base
  if (rest < 0) {
    return rest + base
  }
  return rest
}

export function shiftClock(epoch: number, offset: number): number {
  let instant: number = makeWhole(epoch)
  if (instant > 8640000000000000) {
    instant = 8640000000000000
  }
  if (instant < -8640000000000000) {
    instant = -8640000000000000
  }
  let minutes: number = makeWhole(offset)
  if (minutes > 1440) {
    minutes = 1440
  }
  if (minutes < -1440) {
    minutes = -1440
  }
  const __n16 = instant + minutes * 60000; if (!(__n16 <= 9007199254740991 && __n16 >= -9007199254740991)) __termIntStop(__n16); return __n16
}

export function formatClock(epoch: number, offset: number): string {
  const local: number = shiftClock(epoch, offset)
  const day: number = moduloFloor(local, 86400000)
  const hours: number = divideWhole(day, 3600000)
  const minutes: number = divideWhole(day % 3600000, 60000)
  const seconds: number = divideWhole(day % 60000, 1000)
  const millis: number = day % 1000
  const a: string = padDigits(hours, 2)
  const b: string = padDigits(minutes, 2)
  const c: string = padDigits(seconds, 2)
  const d: string = padDigits(millis, 3)
  return `${a}:${b}:${c}.${d}`
}

export function truncateMiddle(value: string, width: number, room: Room): string {
  const grains: Grain[] = makeGrains(value)
  let total: number = 0
  for (const one of grains) {
    const __n17 = total + one.wide; if (!(__n17 <= 9007199254740991 && __n17 >= -9007199254740991)) __termIntStop(__n17); total = __n17
  }
  if (total <= width) {
    return value
  }
  const more: string = findSymbol(room, "more")
  const __n18 = width - measureText(more); if (!(__n18 <= 9007199254740991 && __n18 >= -9007199254740991)) __termIntStop(__n18); const roomLeft: number = __n18
  if (roomLeft < 1) {
    return more
  }
  const headRoom: number = divideRound(roomLeft, 2)
  const __n19 = roomLeft - headRoom; if (!(__n19 <= 9007199254740991 && __n19 >= -9007199254740991)) __termIntStop(__n19); const tailRoom: number = __n19
  let head: string = ""
  let used: number = 0
  for (const one of grains) {
    if (__termInt(used + one.wide) <= headRoom) {
      head = `${head}${one.value}`
      const __n20 = used + one.wide; if (!(__n20 <= 9007199254740991 && __n20 >= -9007199254740991)) __termIntStop(__n20); used = __n20
    } else {
      break
    }
  }
  let tail: string = ""
  used = 0
  const __n21 = grains.length - 1; if (!(__n21 <= 9007199254740991 && __n21 >= -9007199254740991)) __termIntStop(__n21); let at: number = __n21
  while (at >= 0) {
    const one: Grain = (at >= 0 && at < grains.length ? grains[at]! : __termReadPast(grains, at))
    if (__termInt(used + one.wide) > tailRoom) {
      break
    }
    tail = `${one.value}${tail}`
    const __n22 = used + one.wide; if (!(__n22 <= 9007199254740991 && __n22 >= -9007199254740991)) __termIntStop(__n22); used = __n22
    at = at - 1
  }
  return `${head}${more}${tail}`
}

export function cleanText(value: string, room: Room): string {
  return glueUnits(neutralize(value, room.standard, room.ascii), room.standard)
}

export function listUnitWords(standard: Standard): string[] {
  const out: string[] = ([] as string[])
  const rule: DurationRule = standard.durations
  out.push(rule.millisecondUnit)
  out.push(rule.secondUnit)
  out.push(rule.minuteUnit)
  out.push(rule.hourUnit)
  for (const one of standard.sizes.units) {
    out.push(one)
  }
  return out
}

export function isNumberWord(value: string): boolean {
  let digits: number = 0
  let at: number = 0
  for (const rune of Array.from(value, function (rune) { return rune.codePointAt(0) ?? 0 })) {
    const digit: boolean = rune >= 48 && rune <= 57
    const mark: boolean = rune === 46 || rune === 44
    const sign: boolean = at === 0 && (rune === 45 || rune === 43)
    if (digit || (mark || sign)) {} else {
      return false
    }
    if (digit) {
      const __n23 = digits + 1; if (!(__n23 <= 9007199254740991 && __n23 >= -9007199254740991)) __termIntStop(__n23); digits = __n23
    }
    const __n24 = at + 1; if (!(__n24 <= 9007199254740991 && __n24 >= -9007199254740991)) __termIntStop(__n24); at = __n24
  }
  return digits > 0
}

export function glueUnits(value: string, standard: Standard): string {
  const words: string[] = split(value, " ")
  if (words.length < 2) {
    return value
  }
  const units: string[] = listUnitWords(standard)
  const glue: string = String.fromCodePoint(160)
  let out: string = ""
  let at: number = 0
  let previous: string = ""
  for (const word of words) {
    if (at > 0) {
      if (isNumberWord(previous) && holdsText(units, word)) {
        out = `${out}${glue}`
      } else {
        out = `${out} `
      }
    }
    out = `${out}${word}`
    previous = word
    const __n25 = at + 1; if (!(__n25 <= 9007199254740991 && __n25 >= -9007199254740991)) __termIntStop(__n25); at = __n25
  }
  return out
}

export function cleanSpans(spans: Span[], room: Room): Span[] {
  const out: Span[] = ([] as Span[])
  for (const one of spans) {
    out.push(restyleSpan(one, glueUnits(neutralize(one.value, room.standard, room.ascii), room.standard)))
  }
  return out
}

export function linkSpans(spans: Span[], location: boolean, room: Room): Span[] {
  const out: Span[] = ([] as Span[])
  for (const one of spans) {
    const copy: Span = { ...one }
    if (one.href === "") {
      copy.href = findLink(one.value, location, room)
    }
    out.push(copy)
  }
  return out
}

export function findLink(value: string, location: boolean, room: Room): string {
  const rule: EnvironmentRule = room.standard.environment
  if (value === "" || __termText.includes(value, " ")) {
    return ""
  }
  for (const scheme of rule.linkSchemes) {
    if (__termText.startsWith(value, scheme)) {
      return value
    }
  }
  if (location && room.root !== "") {} else {
    return ""
  }
  const path: string = stripPlace(value)
  if (__termText.startsWith(path, "/")) {
    return `${rule.fileScheme}${path}`
  }
  return `${rule.fileScheme}${room.root}/${path}`
}

export function stripPlace(value: string): string {
  const parts: string[] = split(value, ":")
  let keep: number = parts.length
  let dropped: number = 0
  while (keep > 1 && dropped < 2) {
    const __n26 = keep - 1; if (!(__n26 <= 9007199254740991 && __n26 >= -9007199254740991)) __termIntStop(__n26); const lastAt: number = __n26
    if (isDigits((lastAt >= 0 && lastAt < parts.length ? parts[lastAt]! : __termReadPast(parts, lastAt)))) {} else {
      break
    }
    keep = lastAt
    dropped = dropped + 1
  }
  let out: string = ""
  let at: number = 0
  for (const part of parts) {
    if (at < keep) {
      if (at > 0) {
        out = `${out}:`
      }
      out = `${out}${part}`
    }
    const __n27 = at + 1; if (!(__n27 <= 9007199254740991 && __n27 >= -9007199254740991)) __termIntStop(__n27); at = __n27
  }
  return out
}

export function isDigits(value: string): boolean {
  if (value === "") {
    return false
  }
  for (const rune of Array.from(value, function (rune) { return rune.codePointAt(0) ?? 0 })) {
    if (rune >= 48 && rune <= 57) {} else {
      return false
    }
  }
  return true
}

export function tintSpans(spans: Span[], role: string): Span[] {
  const out: Span[] = ([] as Span[])
  for (const one of spans) {
    const copy: Span = { ...one }
    copy.role = role
    out.push(copy)
  }
  return out
}

export function measureSpans(spans: Span[]): number {
  let total: number = 0
  for (const one of spans) {
    const __n28 = total + measureText(one.value); if (!(__n28 <= 9007199254740991 && __n28 >= -9007199254740991)) __termIntStop(__n28); total = __n28
  }
  return total
}

export function splitLines(value: string): string[] {
  const out: string[] = ([] as string[])
  for (const one of split(value, "\n")) {
    out.push(trimReturn(one))
  }
  return out
}

export function trimReturn(value: string): string {
  const grains: Grain[] = makeGrains(value)
  const count: number = grains.length
  if (count === 0) {
    return value
  }
  const __n29 = count - 1; if (!(__n29 <= 9007199254740991 && __n29 >= -9007199254740991)) __termIntStop(__n29); const last: number = __n29
  const tail: Grain = (last >= 0 && last < grains.length ? grains[last]! : __termReadPast(grains, last))
  if (tail.value === "\r") {} else {
    return value
  }
  let out: string = ""
  let at: number = 0
  if (at >= 0 && last - 1 < grains.length) {
    while (at < last) {
      const one: Grain = grains[at]!
      out = `${out}${one.value}`
      at = at + 1
    }
  } else {
    while (at < last) {
      const one: Grain = (at >= 0 && at < grains.length ? grains[at]! : __termReadPast(grains, at))
      out = `${out}${one.value}`
      at = at + 1
    }
  }
  return out
}

export function cropSpans(spans: Span[], width: number, room: Room): Span[] {
  if (measureSpans(spans) <= width) {
    return spans
  }
  const more: string = findSymbol(room, "more")
  const __n30 = width - measureText(more); if (!(__n30 <= 9007199254740991 && __n30 >= -9007199254740991)) __termIntStop(__n30); const limit: number = __n30
  const out: Span[] = ([] as Span[])
  let used: number = 0
  let role: string = "text"
  for (const one of spans) {
    let kept: string = ""
    let full: boolean = true
    for (const grain of makeGrains(one.value)) {
      if (__termInt(used + grain.wide) <= limit) {
        kept = `${kept}${grain.value}`
        const __n31 = used + grain.wide; if (!(__n31 <= 9007199254740991 && __n31 >= -9007199254740991)) __termIntStop(__n31); used = __n31
      } else {
        full = false
        break
      }
    }
    if (kept !== "") {
      out.push(restyleSpan(one, kept))
    }
    role = one.role
    if (full) {} else {
      break
    }
  }
  out.push({ value: more, role: "dim", strong: false, href: "", focus: false })
  return out
}

export function trimLines(lines: Line[]): Line[] {
  const out: Line[] = ([] as Line[])
  for (const one of lines) {
    out.push(trimLine(one))
  }
  return out
}

export function trimLine(one: Line): Line {
  const spans: Span[] = ([] as Span[])
  for (const piece of one.spans) {
    spans.push(piece)
  }
  while (spans.length > 0) {
    const __n32 = spans.length - 1; if (!(__n32 <= 9007199254740991 && __n32 >= -9007199254740991)) __termIntStop(__n32); const lastAt: number = __n32
    const last: Span = (lastAt >= 0 && lastAt < spans.length ? spans[lastAt]! : __termReadPast(spans, lastAt))
    if (last.focus) {
      break
    }
    const trimmed: string = __termText.trimEnd(last.value)
    if (trimmed === last.value) {
      break
    }
    __termPop(spans)
    if (trimmed !== "") {
      spans.push(restyleSpan(last, trimmed))
      break
    }
  }
  return { spans: spans }
}

export function cropText(value: string, width: number, room: Room): string {
  const spans: Span[] = ([] as Span[])
  spans.push({ value: value, role: "text", strong: false, href: "", focus: false })
  const cut: Span[] = cropSpans(spans, width, room)
  let out: string = ""
  for (const one of cut) {
    out = `${out}${one.value}`
  }
  return out
}

export interface Piece {
  value: string
  wide: number
  owner: number
}

export interface Stretch {
  start: number
  end: number
  gapStart: number
  gapEnd: number
  tier: number
}

export interface Wrapped {
  indices: number[]
}

export interface Breaks {
  tiers: string[]
  never: string
}

export function textBreaks(standard: Standard): Breaks {
  return { tiers: standard.wraps.tiers, never: standard.wraps.never }
}

export function placeBreaks(standard: Standard): Breaks {
  return { tiers: standard.wraps.locationTiers, never: standard.wraps.never }
}

export function makePieces(spans: Span[], keepLeading: boolean): Piece[] {
  const out: Piece[] = ([] as Piece[])
  const glue: string = String.fromCodePoint(160)
  let owner: number = 0
  let leading: boolean = keepLeading
  for (const one of spans) {
    for (const grain of makeGrains(one.value)) {
      let value: string = grain.value
      if (leading) {
        if (value === " ") {
          value = glue
        } else {
          leading = false
        }
      }
      out.push({ value: value, wide: grain.wide, owner: owner })
    }
    const __n33 = owner + 1; if (!(__n33 <= 9007199254740991 && __n33 >= -9007199254740991)) __termIntStop(__n33); owner = __n33
  }
  return out
}

export function measurePieces(pieces: Piece[], start: number, end: number): number {
  let total: number = 0
  let at: number = start
  if (at >= 0 && end - 1 < pieces.length) {
    while (at < end) {
      const one: Piece = pieces[at]!
      const __n34 = total + one.wide; if (!(__n34 <= 9007199254740991 && __n34 >= -9007199254740991)) __termIntStop(__n34); total = __n34
      at = at + 1
    }
  } else {
    while (at < end) {
      const one: Piece = (at >= 0 && at < pieces.length ? pieces[at]! : __termReadPast(pieces, at))
      const __n35 = total + one.wide; if (!(__n35 <= 9007199254740991 && __n35 >= -9007199254740991)) __termIntStop(__n35); total = __n35
      at = at + 1
    }
  }
  return total
}

export function makeStretches(pieces: Piece[]): Stretch[] {
  const out: Stretch[] = ([] as Stretch[])
  const count: number = pieces.length
  let at: number = 0
  while (at < count) {
    const gapStart: number = at
    while (at < count && pieceValue(pieces, at) === " ") {
      const __n36 = at + 1; if (!(__n36 <= 9007199254740991 && __n36 >= -9007199254740991)) __termIntStop(__n36); at = __n36
    }
    const gapEnd: number = at
    const start: number = at
    while (at < count && pieceValue(pieces, at) !== " ") {
      const __n37 = at + 1; if (!(__n37 <= 9007199254740991 && __n37 >= -9007199254740991)) __termIntStop(__n37); at = __n37
    }
    if (at > start) {
      out.push({ start: start, end: at, gapStart: gapStart, gapEnd: gapEnd, tier: 0 })
    }
  }
  return out
}

export function pieceValue(pieces: Piece[], at: number): string {
  const one: Piece = (at >= 0 && at < pieces.length ? pieces[at]! : __termReadPast(pieces, at))
  return one.value
}

export function isCutForbidden(pieces: Piece[], at: number, start: number, end: number, never: string): boolean {
  const size: number = Array.from(never).length
  if (size < 2) {
    return false
  }
  const __n38 = __termInt(at - size) + 2; if (!(__n38 <= 9007199254740991 && __n38 >= -9007199254740991)) __termIntStop(__n38); let from: number = __n38
  if (from < start) {
    from = start
  }
  while (from <= at) {
    const __n39 = from + size; if (!(__n39 <= 9007199254740991 && __n39 >= -9007199254740991)) __termIntStop(__n39); const stop: number = __n39
    if (stop <= end) {
      let joined: string = ""
      let k: number = from
      while (k < stop) {
        joined = `${joined}${pieceValue(pieces, k)}`
        k = k + 1
      }
      if (joined === never) {
        return true
      }
    }
    const __n40 = from + 1; if (!(__n40 <= 9007199254740991 && __n40 >= -9007199254740991)) __termIntStop(__n40); from = __n40
  }
  return false
}

export function isBreakAfter(tier: string, value: string): boolean {
  for (const rune of Array.from(tier, function (rune) { return rune.codePointAt(0) ?? 0 })) {
    if (String.fromCodePoint(rune) === value) {
      return true
    }
  }
  return false
}

export function splitStretch(pieces: Piece[], one: Stretch, rules: Breaks): Stretch[] {
  const out: Stretch[] = ([] as Stretch[])
  const edge: boolean = one.tier >= rules.tiers.length
  let tierText: string = ""
  const tier: number = one.tier
  if (edge) {} else {
    tierText = (tier >= 0 && tier < rules.tiers.length ? rules.tiers[tier]! : __termReadPast(rules.tiers, tier))
  }
  const __n41 = one.tier + 1; if (!(__n41 <= 9007199254740991 && __n41 >= -9007199254740991)) __termIntStop(__n41); const nextTier: number = __n41
  let from: number = one.start
  let at: number = one.start
  const __n42 = one.end - 1; if (!(__n42 <= 9007199254740991 && __n42 >= -9007199254740991)) __termIntStop(__n42); const last: number = __n42
  while (at < last) {
    let cut: boolean = edge
    if (edge) {} else {
      cut = isBreakAfter(tierText, pieceValue(pieces, at))
    }
    if (cut) {
      if (isCutForbidden(pieces, at, one.start, one.end, rules.never)) {
        cut = false
      }
    }
    if (cut) {
      const stop: number = at + 1
      out.push({ start: from, end: stop, gapStart: from, gapEnd: from, tier: nextTier })
      from = stop
    }
    at = at + 1
  }
  out.push({ start: from, end: one.end, gapStart: from, gapEnd: from, tier: nextTier })
  return out
}

export function wrapSpans(spans: Span[], first: number, rest: number, hang: number, rules: Breaks, keepLeading: boolean): Line[] {
  const pieces: Piece[] = makePieces(spans, keepLeading)
  let firstRoom: number = first
  if (firstRoom < 1) {
    firstRoom = 1
  }
  let restRoom: number = rest
  if (restRoom < 1) {
    restRoom = 1
  }
  const words: Stretch[] = makeStretches(pieces)
  const stack: Stretch[] = ([] as Stretch[])
  const __n43 = words.length - 1; if (!(__n43 <= 9007199254740991 && __n43 >= -9007199254740991)) __termIntStop(__n43); let at: number = __n43
  while (at >= 0) {
    stack.push((at >= 0 && at < words.length ? words[at]! : __termReadPast(words, at)))
    at = at - 1
  }
  const done: Wrapped[] = ([] as Wrapped[])
  let current: number[] = ([] as number[])
  let used: number = 0
  while (stack.length > 0) {
    const one: Stretch = __termPop(stack)
    const wide: number = measurePieces(pieces, one.start, one.end)
    const gapWide: number = measurePieces(pieces, one.gapStart, one.gapEnd)
    let roomNow: number = firstRoom
    if (done.length > 0) {
      roomNow = restRoom
    }
    let placed: boolean = false
    if (current.length === 0) {
      if (wide <= roomNow) {
        at = one.start
        while (at < one.end) {
          current.push(at)
          at = at + 1
        }
        used = wide
        placed = true
      }
    } else {
      if (__termInt(__termInt(used + gapWide) + wide) <= roomNow) {
        at = one.gapStart
        while (at < one.end) {
          current.push(at)
          at = at + 1
        }
        const __n44 = __termInt(used + gapWide) + wide; if (!(__n44 <= 9007199254740991 && __n44 >= -9007199254740991)) __termIntStop(__n44); used = __n44
        placed = true
      } else {
        done.push({ indices: current })
        current = ([] as number[])
        used = 0
        if (wide <= restRoom) {
          at = one.start
          while (at < one.end) {
            current.push(at)
            at = at + 1
          }
          used = wide
          placed = true
        }
      }
    }
    if (placed) {} else {
      const parts: Stretch[] = splitStretch(pieces, one, rules)
      if (parts.length === 1) {
        const only: Stretch = (0 < parts.length ? parts[0]! : __termReadPast(parts, 0))
        if (one.tier <= rules.tiers.length) {
          stack.push(only)
        } else {
          at = one.start
          while (at < one.end) {
            current.push(at)
            at = at + 1
          }
          const __n45 = used + wide; if (!(__n45 <= 9007199254740991 && __n45 >= -9007199254740991)) __termIntStop(__n45); used = __n45
        }
      } else {
        const __n46 = parts.length - 1; if (!(__n46 <= 9007199254740991 && __n46 >= -9007199254740991)) __termIntStop(__n46); at = __n46
        while (at >= 0) {
          stack.push((at >= 0 && at < parts.length ? parts[at]! : __termReadPast(parts, at)))
          at = at - 1
        }
      }
    }
  }
  if (current.length > 0 || done.length === 0) {
    done.push({ indices: current })
  }
  return drawWrapped(done, pieces, spans, hang)
}

export function drawWrapped(done: Wrapped[], pieces: Piece[], spans: Span[], hang: number): Line[] {
  const out: Line[] = ([] as Line[])
  const glue: string = String.fromCodePoint(160)
  const pad: string = makeSpaces(hang)
  let row: number = 0
  for (const placed of done) {
    const built: Span[] = ([] as Span[])
    if (row > 0 && hang > 0) {
      built.push({ value: pad, role: "text", strong: false, href: "", focus: false })
    }
    let owner: number = -1
    let value: string = ""
    for (const index of placed.indices) {
      const one: Piece = (index >= 0 && index < pieces.length ? pieces[index]! : __termReadPast(pieces, index))
      let shown: string = one.value
      if (shown === glue) {
        shown = " "
      }
      if (one.owner === owner) {
        value = `${value}${shown}`
      } else {
        if (owner >= 0) {
          built.push(restyleSpan((owner >= 0 && owner < spans.length ? spans[owner]! : __termReadPast(spans, owner)), value))
        }
        owner = one.owner
        value = shown
      }
    }
    if (owner >= 0) {
      built.push(restyleSpan((owner >= 0 && owner < spans.length ? spans[owner]! : __termReadPast(spans, owner)), value))
    }
    out.push({ spans: built })
    const __n47 = row + 1; if (!(__n47 <= 9007199254740991 && __n47 >= -9007199254740991)) __termIntStop(__n47); row = __n47
  }
  return out
}

export function drawLead(event: Event, room: Room): Span[] {
  const layout: LayoutRule = room.standard.layout
  const spans: Span[] = ([] as Span[])
  const glyph: string = drawGlyph(room, event.glyph)
  let role: string = glyphRole(room.standard, event.glyph)
  const debug: boolean = event.level !== ""
  if (debug) {
    role = "dim"
  }
  spans.push({ value: glyph, role: role, strong: false, href: "", focus: false })
  const __n48 = layout.verbColumn - measureText(glyph); if (!(__n48 <= 9007199254740991 && __n48 >= -9007199254740991)) __termIntStop(__n48); let gap: number = __n48
  if (gap < 1) {
    gap = 1
  }
  spans.push(makeSpan(makeSpaces(gap), "text"))
  let verb: string = glueUnits(neutralize(event.verb, room.standard, room.ascii), room.standard)
  if (measureText(verb) > layout.verbWidth) {
    verb = cropText(verb, layout.verbWidth, room)
  }
  let verbRole: string = "text"
  if (debug) {
    verbRole = "dim"
  }
  spans.push({ value: verb, role: verbRole, strong: false, href: "", focus: false })
  const __n49 = __termInt(measureText(glyph) + gap) + measureText(verb); if (!(__n49 <= 9007199254740991 && __n49 >= -9007199254740991)) __termIntStop(__n49); const used: number = __n49
  const __n50 = layout.bodyColumn - used; if (!(__n50 <= 9007199254740991 && __n50 >= -9007199254740991)) __termIntStop(__n50); let rest: number = __n50
  if (rest < 1) {
    rest = 1
  }
  spans.push(makeSpan(makeSpaces(rest), "text"))
  return spans
}

export function drawSubject(event: Event, room: Room, tagged: boolean): Span[] {
  let spans: Span[] = linkSpans(cleanSpans(event.subject, room), false, room)
  if (event.verdict) {
    const bold: Span[] = ([] as Span[])
    for (const one of spans) {
      const copy: Span = { ...one }
      copy.strong = true
      bold.push(copy)
    }
    spans = bold
  }
  if (event.level !== "") {
    spans = tintSpans(spans, "dim")
  }
  if (tagged) {} else {
    return spans
  }
  const source: string = glueUnits(neutralize(event.source, room.standard, room.ascii), room.standard)
  if (source === "" || source === spansText(spans)) {
    return spans
  }
  const out: Span[] = ([] as Span[])
  for (const one of spans) {
    out.push(one)
  }
  const gap: number = room.standard.layout.tagGap
  out.push(makeSpan(makeSpaces(gap), "text"))
  const shown: string = truncateMiddle(source, room.standard.services.tagWidth, room)
  out.push({ value: shown, role: "source", strong: false, href: "", focus: false })
  return out
}

export function drawTitleLine(event: Event, room: Room, tagged: boolean): Line[] {
  const lead: Span[] = drawLead(event, room)
  const subject: Span[] = drawSubject(event, room, tagged)
  const body: number = room.standard.layout.bodyColumn
  const hang: number = room.standard.layout.hang
  if (measureSpans(subject) === 0) {
    const bare: Span[] = ([] as Span[])
    let at: number = 0
    const __n51 = lead.length - 1; if (!(__n51 <= 9007199254740991 && __n51 >= -9007199254740991)) __termIntStop(__n51); const last: number = __n51
    for (const one of lead) {
      if (at < last) {
        bare.push(one)
      }
      const __n52 = at + 1; if (!(__n52 <= 9007199254740991 && __n52 >= -9007199254740991)) __termIntStop(__n52); at = __n52
    }
    const lines: Line[] = ([] as Line[])
    lines.push({ spans: bare })
    return lines
  }
  const __n53 = room.width - body; if (!(__n53 <= 9007199254740991 && __n53 >= -9007199254740991)) __termIntStop(__n53); const cells: number = __n53
  const wrapped: Line[] = wrapSpans(subject, cells, __termInt(cells - hang), hang, textBreaks(room.standard), false)
  const out: Line[] = ([] as Line[])
  let at: number = 0
  for (const one of wrapped) {
    if (at === 0) {
      const spans: Span[] = ([] as Span[])
      for (const piece of lead) {
        spans.push(piece)
      }
      for (const piece of one.spans) {
        spans.push(piece)
      }
      out.push({ spans: spans })
    } else {
      const moved: Line[] = ([] as Line[])
      moved.push(one)
      for (const piece of indentLines(moved, body)) {
        out.push(piece)
      }
    }
    const __n54 = at + 1; if (!(__n54 <= 9007199254740991 && __n54 >= -9007199254740991)) __termIntStop(__n54); at = __n54
  }
  return out
}

export interface FactSpans {
  spans: Span[]
}

export function showsClock(event: Event, standard: Standard): boolean {
  const rule: FactRule = standard.facts
  let shown: boolean = false
  if (rule.clockFrom < 0) {
    shown = true
  }
  if (event.duration >= rule.clockFrom) {
    shown = true
  }
  if (event.source !== "" || event.zone !== "") {
    shown = true
  }
  for (const one of rule.clockKinds) {
    if (one === event.kind) {
      shown = true
    }
  }
  return shown
}

export function drawClock(event: Event, room: Room): Span[] {
  const spans: Span[] = ([] as Span[])
  if (event.clock >= 0 && showsClock(event, room.standard)) {
    let shift: number = room.offset
    if (room.utc) {
      shift = 0
    }
    spans.push(makeSpan(formatClock(event.clock, shift), "dim"))
  }
  return spans
}

export function drawDuration(event: Event, room: Room): Span[] {
  const spans: Span[] = ([] as Span[])
  if (event.duration >= 0) {} else {
    return spans
  }
  let role: string = "text"
  if (event.budget >= 0 && event.duration > event.budget) {
    role = "warning"
  }
  if (event.uptime) {
    spans.push({ value: room.standard.durations.uptimeWord, role: "dim", strong: false, href: "", focus: false })
    spans.push(makeSpan(String.fromCodePoint(160), "dim"))
  }
  for (const one of formatDuration(event.duration, room.standard, role)) {
    spans.push(one)
  }
  return spans
}

export function drawStatus(event: Event, room: Room): Span[] {
  const one: Status = event.status
  if (one.kind === "") {
    return ([] as Span[])
  }
  return formatStatus(one.kind, one.value, glueUnits(neutralize(one.name, room.standard, room.ascii), room.standard), room.standard)
}

export function drawSize(event: Event, room: Room): Span[] {
  if (event.bytes >= 0) {} else {
    return ([] as Span[])
  }
  return formatSize(event.bytes, room.standard)
}

export function drawTally(one: Tally, room: Room): Span[] {
  return formatTally(one.amount, glueUnits(neutralize(one.noun, room.standard, room.ascii), room.standard), glueUnits(neutralize(one.one, room.standard, room.ascii), room.standard), one.total, room.standard)
}

export function drawRest(value: string, room: Room): Span[] {
  const spans: Span[] = ([] as Span[])
  spans.push(makeSpan(glueUnits(neutralize(value, room.standard, room.ascii), room.standard), "dim"))
  return spans
}

export function factOrder(event: Event, standard: Standard): string[] {
  const general: string[] = standard.facts.order
  for (const one of standard.kinds) {
    if (one.name === event.kind && one.order.length > 0) {
      const out: string[] = ([] as string[])
      for (const name of one.order) {
        out.push(name)
      }
      for (const name of general) {
        if (holdsText(out, name)) {} else {
          out.push(name)
        }
      }
      return out
    }
  }
  return general
}

export function listFacts(event: Event, room: Room): FactSpans[] {
  let out: FactSpans[] = ([] as FactSpans[])
  for (const name of factOrder(event, room.standard)) {
    if (name === "clock") {
      out = pushFact(out, drawClock(event, room))
    }
    if (name === "tool") {
      for (const one of event.tool) {
        out = pushFact(out, drawRest(one, room))
      }
    }
    if (name === "zone" && event.zone !== "") {
      out = pushFact(out, drawRest(event.zone, room))
    }
    if (name === "duration") {
      out = pushFact(out, drawDuration(event, room))
    }
    if (name === "status") {
      out = pushFact(out, drawStatus(event, room))
    }
    if (name === "size") {
      out = pushFact(out, drawSize(event, room))
    }
    if (name === "counts") {
      for (const one of event.tallies) {
        out = pushFact(out, drawTally(one, room))
      }
    }
    if (name === "rest") {
      for (const one of event.facts) {
        out = pushFact(out, drawRest(one, room))
      }
      if (event.repeat > 1) {
        const times: string = findSymbol(room, "times")
        const count: string = groupNumber(event.repeat, room.standard)
        out = pushFact(out, drawRest(`${times}${count}`, room))
      }
    }
  }
  return out
}

export function pushFact(out: FactSpans[], spans: Span[]): FactSpans[] {
  if (spans.length > 0) {
    out.push({ spans: spans })
  }
  return out
}

export function measureFact(one: FactSpans): number {
  let total: number = 0
  for (const piece of one.spans) {
    const __n55 = total + measureText(piece.value); if (!(__n55 <= 9007199254740991 && __n55 >= -9007199254740991)) __termIntStop(__n55); total = __n55
  }
  return total
}

export function drawFactsLine(event: Event, room: Room): Line[] {
  const facts: FactSpans[] = listFacts(event, room)
  if (facts.length === 0) {
    return ([] as Line[])
  }
  const mark: string = findSymbol(room, "separator")
  const glue: string = String.fromCodePoint(160)
  const body: number = room.standard.layout.bodyColumn
  const __n56 = room.width - body; if (!(__n56 <= 9007199254740991 && __n56 >= -9007199254740991)) __termIntStop(__n56); const cells: number = __n56
  const hang: number = room.standard.layout.hang
  const __n57 = measureText(mark) + 2; if (!(__n57 <= 9007199254740991 && __n57 >= -9007199254740991)) __termIntStop(__n57); const between: number = __n57
  let lines: Line[] = ([] as Line[])
  let current: Span[] = ([] as Span[])
  let used: number = 0
  for (const one of facts) {
    const wide: number = measureFact(one)
    let joined: boolean = false
    if (current.length > 0) {
      if (__termInt(__termInt(used + between) + wide) <= cells) {
        current.push(makeSpan(`${glue}${mark}`, "dim"))
        current.push({ value: " ", role: "text", strong: false, href: "", focus: false })
        for (const piece of one.spans) {
          current.push(piece)
        }
        const __n58 = __termInt(used + between) + wide; if (!(__n58 <= 9007199254740991 && __n58 >= -9007199254740991)) __termIntStop(__n58); used = __n58
        joined = true
      } else {
        lines.push({ spans: current })
        current = ([] as Span[])
        used = 0
      }
    }
    if (!joined) {
      if (wide <= cells) {
        for (const piece of one.spans) {
          current.push(piece)
        }
        used = wide
      } else {
        for (const part of wrapSpans(one.spans, cells, __termInt(cells - hang), hang, textBreaks(room.standard), false)) {
          lines.push(part)
        }
      }
    }
  }
  if (current.length > 0) {
    lines.push({ spans: current })
  }
  if (event.level !== "") {
    const dimmed: Line[] = ([] as Line[])
    for (const part of lines) {
      dimmed.push({ spans: tintSpans(part.spans, "dim") })
    }
    lines = dimmed
  }
  return indentLines(lines, body)
}

export function drawMessage(lines: string[], room: Room, role: string): Line[] {
  const out: Line[] = ([] as Line[])
  const hang: number = room.standard.layout.hang
  for (const written of lines) {
    for (const one of splitLines(written)) {
      const spans: Span[] = ([] as Span[])
      spans.push(makeSpan(glueUnits(neutralize(one, room.standard, room.ascii), room.standard), role))
      for (const each of wrapSpans(spans, room.width, __termInt(room.width - hang), hang, textBreaks(room.standard), false)) {
        out.push(each)
      }
    }
  }
  return out
}

export function measureKeys(fields: ItemField[], room: Room): number {
  let widest: number = 0
  if (!room.standard.layout.alignKeys) {
    return 0
  }
  for (const one of fields) {
    const wide: number = measureText(glueUnits(neutralize(one.key, room.standard, room.ascii), room.standard))
    if (wide > widest) {
      widest = wide
    }
  }
  return widest
}

export function drawField(field: ItemField, keyWidth: number, room: Room, role: string): Line[] {
  const layout: LayoutRule = room.standard.layout
  const key: string = glueUnits(neutralize(field.key, room.standard, room.ascii), room.standard)
  let value: Span[] = linkSpans(cleanSpans(field.value, room), field.location, room)
  if (role !== "text") {
    value = tintSpans(value, role)
  }
  let rules: Breaks = textBreaks(room.standard)
  if (field.location) {
    rules = placeBreaks(room.standard)
  }
  let width: number = measureText(key)
  if (keyWidth > width) {
    width = keyWidth
  }
  const padded: string = `${key}${makeSpaces(__termInt(width - measureText(key)))}`
  const __n59 = __termInt(width + layout.fieldGap) + measureSpans(value); if (!(__n59 <= 9007199254740991 && __n59 >= -9007199254740991)) __termIntStop(__n59); const beside: number = __n59
  if (beside <= room.width) {
    const spans: Span[] = ([] as Span[])
    spans.push({ value: padded, role: "dim", strong: false, href: "", focus: false })
    spans.push(makeSpan(makeSpaces(layout.fieldGap), "text"))
    for (const piece of value) {
      spans.push(piece)
    }
    const lines: Line[] = ([] as Line[])
    lines.push({ spans: spans })
    return lines
  }
  const out: Line[] = ([] as Line[])
  const head: Span[] = ([] as Span[])
  head.push({ value: key, role: "dim", strong: false, href: "", focus: false })
  out.push({ spans: head })
  const hang: number = layout.hang
  const __n60 = room.width - hang; if (!(__n60 <= 9007199254740991 && __n60 >= -9007199254740991)) __termIntStop(__n60); const cells: number = __n60
  const under: Line[] = wrapSpans(value, cells, __termInt(cells - hang), hang, rules, false)
  for (const one of indentLines(under, hang)) {
    out.push(one)
  }
  return out
}

export function drawFields(fields: ItemField[], keyWidth: number, room: Room, role: string): Line[] {
  const out: Line[] = ([] as Line[])
  for (const one of fields) {
    for (const each of drawField(one, keyWidth, room, role)) {
      out.push(each)
    }
  }
  return out
}

export function expandTabs(value: string, width: number): string {
  let out: string = ""
  let column: number = 0
  let stop: number = width
  if (stop < 1) {
    stop = 8
  }
  for (const grain of makeGrains(value)) {
    if (grain.value === "\t") {
      const __n61 = stop - __termInt(column % stop); if (!(__n61 <= 9007199254740991 && __n61 >= -9007199254740991)) __termIntStop(__n61); const gap: number = __n61
      out = `${out}${makeSpaces(gap)}`
      const __n62 = column + gap; if (!(__n62 <= 9007199254740991 && __n62 >= -9007199254740991)) __termIntStop(__n62); column = __n62
    } else {
      out = `${out}${grain.value}`
      const __n63 = column + grain.wide; if (!(__n63 <= 9007199254740991 && __n63 >= -9007199254740991)) __termIntStop(__n63); column = __n63
    }
  }
  return out
}

export interface FrameCells {
  start: number
  wide: number
}

export function locateMark(source: string, column: number, length: number, tabWidth: number): FrameCells {
  const runes: number[] = Array.from(source, function (rune) { return rune.codePointAt(0) ?? 0 })
  let before: string = ""
  let inside: string = ""
  let at: number = 1
  for (const rune of runes) {
    if (at < column) {
      before = `${before}${String.fromCodePoint(rune)}`
    } else {
      if (at < __termInt(column + length)) {
        inside = `${inside}${String.fromCodePoint(rune)}`
      }
    }
    const __n64 = at + 1; if (!(__n64 <= 9007199254740991 && __n64 >= -9007199254740991)) __termIntStop(__n64); at = __n64
  }
  const start: number = measureText(expandTabs(before, tabWidth))
  const whole: number = measureText(expandTabs(`${before}${inside}`, tabWidth))
  const __n65 = whole - start; if (!(__n65 <= 9007199254740991 && __n65 >= -9007199254740991)) __termIntStop(__n65); let wide: number = __n65
  if (wide < 1) {
    wide = 1
  }
  return { start: start, wide: wide }
}

export function isShownLine(one: FrameLine, marks: FrameMark[], context: number): boolean {
  for (const mark of marks) {
    if (one.number <= mark.line && one.number >= __termInt(mark.line - context)) {
      return true
    }
  }
  return false
}

export function drawFrame(one: Frame, room: Room, role: string): Line[] {
  const out: Line[] = ([] as Line[])
  const rule: FrameRule = room.standard.frames
  const bar: string = findSymbol(room, "gutter")
  const skip: string = findSymbol(room, "skip")
  const shown: FrameLine[] = ([] as FrameLine[])
  for (const each of one.lines) {
    if (one.marks.length === 0 || isShownLine(each, one.marks, rule.context)) {
      shown.push(each)
    }
  }
  let digits: number = 1
  for (const each of shown) {
    const wide: number = measureText(`${each.number}`)
    if (wide > digits) {
      digits = wide
    }
  }
  const __n66 = digits + 2; if (!(__n66 <= 9007199254740991 && __n66 >= -9007199254740991)) __termIntStop(__n66); const gutterWide: number = __n66
  const __n67 = room.width - __termInt(gutterWide + 1); if (!(__n67 <= 9007199254740991 && __n67 >= -9007199254740991)) __termIntStop(__n67); const cells: number = __n67
  let previous: number = -1
  for (const each of shown) {
    if (previous >= 0 && each.number > __termInt(previous + 1)) {
      const gap: Span[] = ([] as Span[])
      const lead: string = makeSpaces(__termInt(digits + 1))
      gap.push(makeSpan(`${lead}${skip}`, "dim"))
      out.push({ spans: gap })
    }
    previous = each.number
    const number: string = padNumber(each.number, digits)
    const source: string = cleanText(expandTabs(each.value, one.tabWidth), room)
    const spans: Span[] = ([] as Span[])
    spans.push(makeSpan(`${number} ${bar}`, "dim"))
    const body: Span[] = ([] as Span[])
    body.push(makeSpan(` ${source}`, "text"))
    for (const piece of cropSpans(body, __termInt(cells + 1), room)) {
      spans.push(piece)
    }
    out.push({ spans: spans })
    for (const mark of one.marks) {
      if (mark.line === each.number) {
        out.push(drawMark(mark, each, one, digits, cells, role, room))
      }
    }
  }
  return out
}

export function padNumber(value: number, digits: number): string {
  const shown: string = `${value}`
  return `${makeSpaces(__termInt(digits - measureText(shown)))}${shown}`
}

export function drawMark(mark: FrameMark, source: FrameLine, one: Frame, digits: number, cells: number, role: string, room: Room): Line {
  const bar: string = findSymbol(room, "gutter")
  const place: FrameCells = locateMark(source.value, mark.column, mark.length, one.tabWidth)
  let glyph: string = findSymbol(room, "secondary")
  let markRole: string = "dim"
  if (mark.primary) {
    glyph = findSymbol(room, "primary")
    markRole = role
  }
  const spans: Span[] = ([] as Span[])
  spans.push(makeSpan(`${makeSpaces(digits)} ${bar}`, "dim"))
  const under: Span[] = ([] as Span[])
  under.push(makeSpan(makeSpaces(__termInt(place.start + 1)), "text"))
  under.push(makeSpan(repeatText(glyph, place.wide), markRole))
  const label: string = glueUnits(neutralize(mark.label, room.standard, room.ascii), room.standard)
  if (label !== "") {
    under.push(makeSpan(` ${label}`, markRole))
  }
  for (const piece of cropSpans(under, __termInt(cells + 1), room)) {
    spans.push(piece)
  }
  return { spans: spans }
}

export function isForeignFrame(value: string, room: Room): boolean {
  for (const marker of room.standard.quotes.foreign) {
    if (__termText.includes(value, marker)) {
      return true
    }
  }
  return false
}

export interface QuoteLines {
  lines: string[]
  moreFrames: number
  earlier: number
}

export function trimQuote(written: string[], earlier: number, room: Room): QuoteLines {
  const plain: string[] = ([] as string[])
  for (const each of written) {
    for (const one of splitLines(each)) {
      plain.push(stripEscapes(one))
    }
  }
  let frames: number = 0
  for (const one of plain) {
    if (startsWith(__termText.trim(one), room.standard.quotes.frameStart)) {
      const __n68 = frames + 1; if (!(__n68 <= 9007199254740991 && __n68 >= -9007199254740991)) __termIntStop(__n68); frames = __n68
    }
  }
  let kept: string[] = ([] as string[])
  let more: number = 0
  if (frames > 1) {
    let topSeen: boolean = false
    let userSeen: boolean = false
    for (const one of plain) {
      if (startsWith(__termText.trim(one), room.standard.quotes.frameStart)) {
        let keep: boolean = false
        const foreign: boolean = isForeignFrame(one, room)
        if (topSeen) {
          if (!userSeen && !foreign) {
            keep = true
            userSeen = true
          }
        } else {
          keep = true
          topSeen = true
          if (foreign) {} else {
            userSeen = true
          }
        }
        if (keep) {
          kept.push(__termText.trim(one))
        } else {
          const __n69 = more + 1; if (!(__n69 <= 9007199254740991 && __n69 >= -9007199254740991)) __termIntStop(__n69); more = __n69
        }
      } else {
        kept.push(one)
      }
    }
  } else {
    kept = plain
  }
  const limit: number = room.standard.quotes.lines
  let before: number = earlier
  if (before < 0) {
    before = 0
  }
  if (limit > 0 && kept.length > limit) {
    const __n70 = kept.length - limit; if (!(__n70 <= 9007199254740991 && __n70 >= -9007199254740991)) __termIntStop(__n70); const cut: number = __n70
    const __n71 = before + cut; if (!(__n71 <= 9007199254740991 && __n71 >= -9007199254740991)) __termIntStop(__n71); before = __n71
    const last: string[] = ([] as string[])
    let at: number = 0
    for (const one of kept) {
      if (at >= cut) {
        last.push(one)
      }
      const __n72 = at + 1; if (!(__n72 <= 9007199254740991 && __n72 >= -9007199254740991)) __termIntStop(__n72); at = __n72
    }
    kept = last
  }
  return { lines: kept, moreFrames: more, earlier: before }
}

export function drawQuote(written: string[], earlier: number, room: Room): Line[] {
  let out: Line[] = ([] as Line[])
  const trimmed: QuoteLines = trimQuote(written, earlier, room)
  const elbow: string = findSymbol(room, "elbow")
  const indent: number = room.standard.quotes.indent
  const more: string = findSymbol(room, "more")
  const hang: number = room.standard.layout.hang
  const __n73 = room.width - indent; if (!(__n73 <= 9007199254740991 && __n73 >= -9007199254740991)) __termIntStop(__n73); const cells: number = __n73
  if (trimmed.earlier > 0) {
    const count: string = groupNumber(trimmed.earlier, room.standard)
    const word: string = room.standard.quotes.earlierWord
    out = pushQuoteLine(out, elbow, indent, makeSpan(`${more} ${count} ${word}`, "dim"))
  }
  for (const one of trimmed.lines) {
    const spans: Span[] = ([] as Span[])
    spans.push(makeSpan(glueUnits(neutralize(one, room.standard, room.ascii), room.standard), "text"))
    for (const each of wrapSpans(spans, cells, __termInt(cells - hang), hang, textBreaks(room.standard), true)) {
      out = pushQuoteSpans(out, elbow, indent, each.spans)
    }
  }
  if (trimmed.moreFrames > 0) {
    const count: string = groupNumber(trimmed.moreFrames, room.standard)
    const word: string = room.standard.quotes.framesWord
    out = pushQuoteLine(out, elbow, indent, makeSpan(`${more} ${count} ${word}`, "dim"))
  }
  return out
}

export function quoteLead(first: boolean, elbow: string, indent: number): Span {
  if (first) {} else {
    return makeSpan(makeSpaces(indent), "text")
  }
  const __n74 = indent - measureText(elbow); if (!(__n74 <= 9007199254740991 && __n74 >= -9007199254740991)) __termIntStop(__n74); let rest: number = __n74
  if (rest < 1) {
    rest = 1
  }
  return makeSpan(`${elbow}${makeSpaces(rest)}`, "dim")
}

export function pushQuoteSpans(out: Line[], elbow: string, indent: number, pieces: Span[]): Line[] {
  const spans: Span[] = ([] as Span[])
  spans.push(quoteLead(out.length === 0, elbow, indent))
  for (const piece of pieces) {
    spans.push(piece)
  }
  out.push({ spans: spans })
  return out
}

export function pushQuoteLine(out: Line[], elbow: string, indent: number, piece: Span): Line[] {
  const pieces: Span[] = ([] as Span[])
  pieces.push(piece)
  return pushQuoteSpans(out, elbow, indent, pieces)
}

export function drawBar(done: number, total: number, room: Room): Line[] {
  const out: Line[] = ([] as Line[])
  if (total > 0) {} else {
    return out
  }
  let cells: number = room.standard.bars.width
  if (cells > room.width) {
    cells = room.width
  }
  let count: number = done
  if (count < 0) {
    count = 0
  }
  if (count > total) {
    count = total
  }
  const filled: number = divideWhole(__termInt(count * cells), total)
  const spans: Span[] = ([] as Span[])
  if (filled > 0) {
    spans.push(makeSpan(repeatText(findSymbol(room, "bar-full"), filled), "active"))
  }
  const __n75 = cells - filled; if (!(__n75 <= 9007199254740991 && __n75 >= -9007199254740991)) __termIntStop(__n75); const empty: number = __n75
  if (empty > 0) {
    spans.push(makeSpan(repeatText(findSymbol(room, "bar-empty"), empty), "faint"))
  }
  out.push({ spans: spans })
  return out
}

export function drawTable(columns: Column[], rows: TableRow[], room: Room): Line[] {
  const out: Line[] = ([] as Line[])
  const gap: number = room.standard.layout.keyGap
  const widths: number[] = ([] as number[])
  let at: number = 0
  for (const one of columns) {
    let wide: number = measureText(glueUnits(neutralize(one.title, room.standard, room.ascii), room.standard))
    for (const row of rows) {
      if (at < row.entries.length) {
        let entry: Span = (at >= 0 && at < row.entries.length ? row.entries[at]! : __termReadPast(row.entries, at))
        const size: number = measureText(glueUnits(neutralize(entry.value, room.standard, room.ascii), room.standard))
        if (size > wide) {
          wide = size
        }
      }
    }
    widths.push(wide)
    const __n76 = at + 1; if (!(__n76 <= 9007199254740991 && __n76 >= -9007199254740991)) __termIntStop(__n76); at = __n76
  }
  let kept: number = 0
  let used: number = 0
  at = 0
  for (const wide of widths) {
    let need: number = wide
    if (at > 0) {
      const __n77 = wide + gap; if (!(__n77 <= 9007199254740991 && __n77 >= -9007199254740991)) __termIntStop(__n77); need = __n77
    }
    if (at === 0 || __termInt(used + need) <= room.width) {
      if (kept === at) {
        const __n78 = used + need; if (!(__n78 <= 9007199254740991 && __n78 >= -9007199254740991)) __termIntStop(__n78); used = __n78
        const __n79 = kept + 1; if (!(__n79 <= 9007199254740991 && __n79 >= -9007199254740991)) __termIntStop(__n79); kept = __n79
      }
    }
    const __n80 = at + 1; if (!(__n80 <= 9007199254740991 && __n80 >= -9007199254740991)) __termIntStop(__n80); at = __n80
  }
  const __n81 = columns.length - kept; if (!(__n81 <= 9007199254740991 && __n81 >= -9007199254740991)) __termIntStop(__n81); const dropped: number = __n81
  let header: Span[] = ([] as Span[])
  at = 0
  for (const one of columns) {
    if (at < kept) {
      const title: Span[] = ([] as Span[])
      title.push(makeSpan(glueUnits(neutralize(one.title, room.standard, room.ascii), room.standard), "dim"))
      const last: boolean = at === kept - 1
      header = pushEntry(header, title, (at >= 0 && at < widths.length ? widths[at]! : __termReadPast(widths, at)), one.numeric, last, gap)
    }
    const __n82 = at + 1; if (!(__n82 <= 9007199254740991 && __n82 >= -9007199254740991)) __termIntStop(__n82); at = __n82
  }
  out.push({ spans: cropSpans(header, room.width, room) })
  for (const row of rows) {
    let spans: Span[] = ([] as Span[])
    at = 0
    for (const one of columns) {
      if (at < kept) {
        let entry: Span[] = ([] as Span[])
        if (at < row.entries.length) {
          const given: Span = (at >= 0 && at < row.entries.length ? row.entries[at]! : __termReadPast(row.entries, at))
          const shown: Span[] = cleanSpans(makeEntry(given), room)
          entry = shown
        }
        const last: boolean = at === kept - 1
        spans = pushEntry(spans, entry, (at >= 0 && at < widths.length ? widths[at]! : __termReadPast(widths, at)), one.numeric, last, gap)
      }
      const __n83 = at + 1; if (!(__n83 <= 9007199254740991 && __n83 >= -9007199254740991)) __termIntStop(__n83); at = __n83
    }
    out.push({ spans: cropSpans(spans, room.width, room) })
  }
  if (dropped > 0) {
    const more: string = findSymbol(room, "more")
    const word: string = room.standard.caps.droppedWord
    const note: Span[] = ([] as Span[])
    note.push(makeSpan(`${more} ${dropped} ${word}`, "dim"))
    out.push({ spans: note })
  }
  return out
}

export function makeEntry(one: Span): Span[] {
  const spans: Span[] = ([] as Span[])
  spans.push(one)
  return spans
}

export function pushEntry(spans: Span[], entry: Span[], width: number, numeric: boolean, last: boolean, gap: number): Span[] {
  const wide: number = measureSpans(entry)
  const __n84 = width - wide; if (!(__n84 <= 9007199254740991 && __n84 >= -9007199254740991)) __termIntStop(__n84); let pad: number = __n84
  if (pad < 0) {
    pad = 0
  }
  if (spans.length > 0) {
    spans.push(makeSpan(makeSpaces(gap), "text"))
  }
  if (numeric && pad > 0) {
    spans.push(makeSpan(makeSpaces(pad), "text"))
  }
  for (const piece of entry) {
    spans.push(piece)
  }
  if (!numeric && (!last && pad > 0)) {
    spans.push(makeSpan(makeSpaces(pad), "text"))
  }
  return spans
}

export function drawTree(nodes: TreeNode[], room: Room): Line[] {
  return drawBranch(nodes, "", room)
}

export function drawBranch(nodes: TreeNode[], prefix: string, room: Room): Line[] {
  const out: Line[] = ([] as Line[])
  const branch: string = findSymbol(room, "branch")
  const lastMark: string = findSymbol(room, "last")
  const stem: string = findSymbol(room, "stem")
  const count: number = nodes.length
  let at: number = 0
  for (const one of nodes) {
    const last: boolean = at === __termInt(count - 1)
    let mark: string = branch
    if (last) {
      mark = lastMark
    }
    const spans: Span[] = ([] as Span[])
    spans.push(makeSpan(`${prefix}${mark}`, "dim"))
    spans.push(makeSpan(` ${glueUnits(neutralize(one.label, room.standard, room.ascii), room.standard)}`, "text"))
    let detail: string = glueUnits(neutralize(one.detail, room.standard, room.ascii), room.standard)
    if (one.deduped) {
      const word: string = room.standard.caps.dedupedWord
      if (detail === "") {
        detail = word
      } else {
        detail = `${detail}, ${word}`
      }
    }
    if (detail !== "") {
      spans.push(makeSpan(`  ${detail}`, "dim"))
    }
    out.push({ spans: cropSpans(spans, room.width, room) })
    let below: string = `${prefix}${stem} `
    if (last) {
      const blank: string = makeSpaces(measureText(stem))
      below = `${prefix}${blank} `
    }
    for (const each of drawBranch(one.children, below, room)) {
      out.push(each)
    }
    const __n85 = at + 1; if (!(__n85 <= 9007199254740991 && __n85 >= -9007199254740991)) __termIntStop(__n85); at = __n85
  }
  return out
}

export function drawList(entries: ListEntry[], total: number, room: Room): Line[] {
  const out: Line[] = ([] as Line[])
  const cap: number = room.standard.caps.entries
  let all: number = entries.length
  if (total >= 0) {
    all = total
  }
  let widest: number = 0
  let at: number = 0
  for (const one of entries) {
    if (at < cap) {
      const wide: number = measureText(glueUnits(neutralize(one.label, room.standard, room.ascii), room.standard))
      if (wide > widest) {
        widest = wide
      }
    }
    const __n86 = at + 1; if (!(__n86 <= 9007199254740991 && __n86 >= -9007199254740991)) __termIntStop(__n86); at = __n86
  }
  const gap: number = room.standard.layout.keyGap
  at = 0
  for (const one of entries) {
    if (at < cap) {
      const spans: Span[] = ([] as Span[])
      const label: string = glueUnits(neutralize(one.label, room.standard, room.ascii), room.standard)
      const detail: string = glueUnits(neutralize(one.detail, room.standard, room.ascii), room.standard)
      if (detail === "") {
        spans.push({ value: label, role: "text", strong: false, href: "", focus: false })
      } else {
        const __n87 = __termInt(widest - measureText(label)) + gap; if (!(__n87 <= 9007199254740991 && __n87 >= -9007199254740991)) __termIntStop(__n87); const pad: number = __n87
        spans.push(makeSpan(`${label}${makeSpaces(pad)}`, "text"))
        spans.push({ value: detail, role: "dim", strong: false, href: "", focus: false })
      }
      out.push({ spans: cropSpans(spans, room.width, room) })
    }
    const __n88 = at + 1; if (!(__n88 <= 9007199254740991 && __n88 >= -9007199254740991)) __termIntStop(__n88); at = __n88
  }
  let shown: number = at
  if (shown > cap) {
    shown = cap
  }
  if (all > shown) {
    const more: string = findSymbol(room, "more")
    const rest: string = groupNumber(__termInt(all - shown), room.standard)
    const word: string = room.standard.caps.moreWord
    const flag: string = room.standard.caps.allFlag
    const lists: string = room.standard.caps.listsWord
    const note: Span[] = ([] as Span[])
    note.push(makeSpan(`${more} ${rest} ${word}, ${flag} ${lists}`, "dim"))
    out.push({ spans: cropSpans(note, room.width, room) })
  }
  return out
}

export function drawChoices(choices: Choice[], room: Room): Line[] {
  const out: Line[] = ([] as Line[])
  const picked: string = findSymbol(room, "picked")
  const unpicked: string = findSymbol(room, "unpicked")
  for (const one of choices) {
    const spans: Span[] = ([] as Span[])
    let mark: string = unpicked
    let markRole: string = "text"
    if (one.picked) {
      mark = picked
      markRole = "active"
    }
    const label: string = glueUnits(neutralize(one.label, room.standard, room.ascii), room.standard)
    const hint: string = glueUnits(neutralize(one.hint, room.standard, room.ascii), room.standard)
    if (one.focused) {
      let written: string = `${mark} ${label}`
      if (hint !== "") {
        written = `${written}  ${hint}`
      }
      const lit: Span = makeSpan(`${written} `, "text")
      lit.focus = true
      spans.push(lit)
    } else {
      spans.push({ value: mark, role: markRole, strong: false, href: "", focus: false })
      spans.push(makeSpan(` ${label}`, "text"))
      if (hint !== "") {
        spans.push(makeSpan(`  ${hint}`, "dim"))
      }
    }
    out.push({ spans: cropSpans(spans, room.width, room) })
  }
  return out
}

export function drawInput(typed: string, secret: boolean, room: Room): Line[] {
  const out: Line[] = ([] as Line[])
  let shown: string = glueUnits(neutralize(typed, room.standard, room.ascii), room.standard)
  if (secret) {
    const dot: string = findSymbol(room, "secret")
    shown = repeatText(dot, measureText(typed))
  }
  const spans: Span[] = ([] as Span[])
  if (shown !== "") {
    spans.push({ value: shown, role: "text", strong: false, href: "", focus: false })
  }
  out.push({ spans: cropSpans(spans, room.width, room) })
  return out
}

export function listFields(event: Event, room: Room): ItemField[] {
  const out: ItemField[] = ([] as ItemField[])
  for (const one of event.fields) {
    out.push(one)
  }
  const rule: FieldRule = room.standard.fields
  if (event.budget >= 0 && (event.duration >= 0 && event.duration > event.budget)) {
    const budget: string = spansText(formatDuration(event.budget, room.standard, "text"))
    out.push(plainField(rule.budgetKey, budget))
  }
  if (event.quoteLog !== "") {
    const logField: ItemField = plainField(rule.logKey, event.quoteLog)
    logField.location = true
    out.push(logField)
  }
  return out
}

export function pickFields(fields: ItemField[], place: string, room: Room): ItemField[] {
  const rule: FieldRule = room.standard.fields
  const out: ItemField[] = ([] as ItemField[])
  for (const one of fields) {
    let where: string = "other"
    if (one.key === rule.locationKey) {
      where = "location"
    }
    if (holdsText(rule.actionKeys, one.key)) {
      where = "action"
    }
    if (where === place) {
      out.push(one)
    }
  }
  return out
}

export function drawDetails(event: Event, room: Room): Line[] {
  let out: Line[] = ([] as Line[])
  const detailRoom: Room = narrowRoom(room, room.standard.layout.bodyColumn)
  const debug: boolean = event.level !== ""
  let textRole: string = "text"
  if (debug) {
    textRole = "dim"
  }
  const fields: ItemField[] = listFields(event, room)
  const keyWidth: number = measureKeys(fields, room)
  out = pushLines(out, drawMessage(event.message, detailRoom, textRole))
  out = pushLines(out, drawFields(pickFields(fields, "location", room), keyWidth, detailRoom, textRole))
  const role: string = glyphRole(room.standard, event.glyph)
  for (const one of event.frames) {
    out = pushLines(out, drawFrame(one, detailRoom, role))
  }
  out = pushLines(out, drawFields(pickFields(fields, "other", room), keyWidth, detailRoom, textRole))
  if (event.quote.length > 0) {
    out = pushLines(out, drawQuote(event.quote, event.quoteEarlier, detailRoom))
  }
  if (event.columns.length > 0) {
    out = pushLines(out, drawTable(event.columns, event.rows, detailRoom))
  }
  if (event.nodes.length > 0) {
    out = pushLines(out, drawTree(event.nodes, detailRoom))
  }
  if (event.entries.length > 0) {
    out = pushLines(out, drawList(event.entries, event.entryTotal, detailRoom))
  }
  if (event.choices.length > 0) {
    out = pushLines(out, drawChoices(event.choices, detailRoom))
  }
  if (event.asking) {
    out = pushLines(out, drawInput(event.typed, event.secret, detailRoom))
  }
  out = pushLines(out, drawFields(pickFields(fields, "action", room), keyWidth, detailRoom, textRole))
  out = pushLines(out, drawBar(event.done, event.total, detailRoom))
  return indentLines(out, room.standard.layout.bodyColumn)
}

export function pushLines(out: Line[], lines: Line[]): Line[] {
  for (const one of lines) {
    out.push(one)
  }
  return out
}

export function drawItem(event: Event, room: Room, tagged: boolean): Line[] {
  let out: Line[] = ([] as Line[])
  out = pushLines(out, drawTitleLine(event, room, tagged))
  const dated: boolean = event.kind === "date" || event.verb === room.standard.services.dateVerb
  if (dated) {} else {
    out = pushLines(out, drawFactsLine(event, room))
  }
  out = pushLines(out, drawDetails(event, room))
  return trimLines(out)
}

export interface RunOptions {
  quiet: boolean
  verbose: boolean
  trace: boolean
  strict: boolean
  utc: boolean
  plain: boolean
  json: boolean
  motion: boolean
  yes: boolean
  raw: boolean
  source: string
  color: string
  depth: number
}

export interface Session {
  options: RunOptions
  verb: string
  opened: boolean
  owed: boolean
  printed: number
  worst: number
  worstGlyph: string
  failure: string
}

export interface Stepped {
  session: Session
  lines: Line[]
  exit: number
}

export function makeOptions(): RunOptions {
  return { quiet: false, verbose: false, trace: false, strict: false, utc: false, plain: false, json: false, motion: true, yes: false, raw: false, source: "", color: "auto", depth: 0 }
}

export function rankGlyph(standard: Standard, name: string): number {
  const rule: GlyphRule = findGlyph(standard, name)
  return rule.rank
}

export function worstGlyph(events: Event[], standard: Standard): string {
  let best: number = 0
  let name: string = "info"
  for (const one of events) {
    const rank: number = rankGlyph(standard, one.glyph)
    if (rank > best) {
      best = rank
      name = one.glyph
    }
  }
  return name
}

export function isShown(event: Event, options: RunOptions): boolean {
  if (options.quiet) {
    return event.glyph === "failed"
  }
  if (event.level === "debug") {
    return options.verbose || options.trace
  }
  if (event.level === "trace") {
    return options.trace
  }
  return true
}

export function makeOpening(verb: string, subject: string, clock: number, tool: string): Event {
  const one: Event = { glyph: "info", kind: "open", verb: verb, subject: plainSubject(subject), clock: clock, source: "", tool: ([] as string[]), zone: "", duration: -1, uptime: false, budget: -1, status: { kind: "", value: 0, name: "" }, bytes: -1, tallies: ([] as Tally[]), facts: ([] as string[]), message: ([] as string[]), fields: ([] as ItemField[]), frames: ([] as Frame[]), quote: ([] as string[]), quoteEarlier: 0, quoteLog: "", done: -1, total: -1, choices: ([] as Choice[]), asking: false, typed: "", secret: false, columns: ([] as Column[]), rows: ([] as TableRow[]), nodes: ([] as TreeNode[]), entries: ([] as ListEntry[]), entryTotal: -1, level: "", verdict: false, place: { path: "", line: 0, column: 0 }, id: "", cause: "", repeat: 0 }
  if (tool !== "") {
    one.tool.push(tool)
  }
  return one
}

export function openSession(verb: string, options: RunOptions): Session {
  return { options: options, verb: verb, opened: false, owed: false, printed: 0, worst: 0, worstGlyph: "info", failure: "" }
}

export function drawOpening(one: Session, opening: Event, room: Room): Stepped {
  const next: Session = { ...one }
  let lines: Line[] = ([] as Line[])
  if (one.options.quiet) {} else {
    lines = drawItem(opening, room, true)
    next.opened = true
    next.owed = true
  }
  return { session: next, lines: lines, exit: 0 }
}

export function noteEvent(one: Session, event: Event, standard: Standard): Session {
  const next: Session = { ...one }
  const rank: number = rankGlyph(standard, event.glyph)
  if (rank > one.worst) {
    next.worst = rank
    next.worstGlyph = event.glyph
  }
  return next
}

export function stepSession(one: Session, event: Event, room: Room, tagged: boolean): Stepped {
  const next: Session = noteEvent(one, event, room.standard)
  const lines: Line[] = ([] as Line[])
  if (isShown(event, one.options)) {
    if (next.owed) {
      lines.push({ spans: ([] as Span[]) })
      next.owed = false
    }
    for (const each of drawItem(event, room, tagged)) {
      lines.push(each)
    }
    next.printed = __termInt(next.printed + 1)
  }
  return { session: next, lines: lines, exit: 0 }
}

export function failSession(one: Session, failure: string): Session {
  const next: Session = { ...one }
  next.failure = failure
  return next
}

export function exitValue(standard: Standard, name: string): number {
  for (const one of standard.exits) {
    if (one.name === name) {
      return one.value
    }
  }
  return 1
}

export function closingGlyph(one: Session, standard: Standard): string {
  if (one.failure === "interrupted") {
    return "skipped"
  }
  if (one.failure !== "") {
    return "failed"
  }
  if (one.options.strict && one.worstGlyph === "warning") {
    return "failed"
  }
  if (one.worstGlyph === "skipped") {
    return "done"
  }
  return one.worstGlyph
}

export function exitCode(one: Session, standard: Standard): number {
  if (one.failure !== "") {
    return exitValue(standard, one.failure)
  }
  if (one.worstGlyph === "failed") {
    return exitValue(standard, "input")
  }
  if (one.options.strict && one.worstGlyph === "warning") {
    return exitValue(standard, "input")
  }
  return exitValue(standard, "success")
}

export function closeEvent(one: Session, closing: Event, standard: Standard): Event {
  const shown: Event = { ...closing }
  shown.kind = "close"
  shown.verdict = true
  if (shown.verb === "") {
    shown.verb = one.verb
  }
  shown.glyph = closingGlyph(one, standard)
  return shown
}

export function closeSession(one: Session, closing: Event, room: Room): Stepped {
  const next: Session = { ...one }
  const shown: Event = closeEvent(one, closing, room.standard)
  const lines: Line[] = ([] as Line[])
  lines.push({ spans: ([] as Span[]) })
  for (const each of drawItem(shown, room, true)) {
    lines.push(each)
  }
  next.owed = false
  return { session: next, lines: lines, exit: exitCode(one, room.standard) }
}

export function drawRun(opening: Event, events: Event[], closing: Event, room: Room, options: RunOptions, tagged: boolean): Line[] {
  const out: Line[] = ([] as Line[])
  let one: Session = { options: options, verb: opening.verb, opened: false, owed: false, printed: 0, worst: 0, worstGlyph: "info", failure: "" }
  let step: Stepped = drawOpening(one, opening, room)
  one = step.session
  for (const each of step.lines) {
    out.push(each)
  }
  for (const event of events) {
    step = stepSession(one, event, room, tagged)
    one = step.session
    for (const each of step.lines) {
      out.push(each)
    }
  }
  if (closing.verb === "" && closing.subject.length === 0) {
    return out
  }
  step = closeSession(one, closing, room)
  for (const each of step.lines) {
    out.push(each)
  }
  return out
}

export function drawCommand(command: string, room: Room): Line {
  const spans: Span[] = ([] as Span[])
  spans.push(makeSpan(findSymbol(room, "prompt"), "active"))
  spans.push({ value: " ", role: "text", strong: false, href: "", focus: false })
  const shown: Span = makeSpan(glueUnits(neutralize(command, room.standard, room.ascii), room.standard), "text")
  shown.strong = true
  spans.push(shown)
  return { spans: spans }
}

export function compareText(a: string, b: string): number {
  const left: number[] = Array.from(a, function (rune) { return rune.codePointAt(0) ?? 0 })
  const right: number[] = Array.from(b, function (rune) { return rune.codePointAt(0) ?? 0 })
  let at: number = 0
  while (at < left.length && at < right.length) {
    const x: number = (at >= 0 && at < left.length ? left[at]! : __termReadPast(left, at))
    const y: number = (at >= 0 && at < right.length ? right[at]! : __termReadPast(right, at))
    if (x < y) {
      return -1
    }
    if (x > y) {
      return 1
    }
    const __n89 = at + 1; if (!(__n89 <= 9007199254740991 && __n89 >= -9007199254740991)) __termIntStop(__n89); at = __n89
  }
  if (left.length < right.length) {
    return -1
  }
  if (left.length > right.length) {
    return 1
  }
  return 0
}

export function problemRank(glyph: string): number {
  if (glyph === "failed") {
    return 0
  }
  if (glyph === "warning") {
    return 1
  }
  return 2
}

export function isProblemBefore(a: Event, b: Event): boolean {
  const rankA: number = problemRank(a.glyph)
  const rankB: number = problemRank(b.glyph)
  if (rankA !== rankB) {
    return rankA < rankB
  }
  const order: number = compareText(a.place.path, b.place.path)
  if (order !== 0) {
    return order < 0
  }
  if (a.place.line !== b.place.line) {
    return a.place.line < b.place.line
  }
  return a.place.column < b.place.column
}

export function arrangeProblems(problems: Event[], standard: Standard, room: Room): Event[] {
  const kept: Event[] = ([] as Event[])
  for (const one of problems) {
    let hidden: boolean = false
    if (one.cause !== "") {
      for (const other of problems) {
        if (other.id === one.cause && other.id !== "") {
          hidden = true
        }
      }
    }
    if (hidden) {} else {
      let count: number = 0
      if (one.id !== "") {
        for (const other of problems) {
          if (other.cause === one.id) {
            const __n90 = count + 1; if (!(__n90 <= 9007199254740991 && __n90 >= -9007199254740991)) __termIntStop(__n90); count = __n90
          }
        }
      }
      const copy: Event = { ...one }
      if (count > 0) {
        const word: string = standard.caps.hiddenWord
        const tallies: Tally[] = ([] as Tally[])
        for (const each of one.tallies) {
          tallies.push(each)
        }
        tallies.push({ amount: count, noun: word, one: "", total: -1 })
        copy.tallies = tallies
      }
      kept.push(copy)
    }
  }
  let sorted: Event[] = ([] as Event[])
  for (const one of kept) {
    const placed: Event[] = ([] as Event[])
    let inserted: boolean = false
    for (const other of sorted) {
      if (!inserted && isProblemBefore(one, other)) {
        placed.push(one)
        inserted = true
      }
      placed.push(other)
    }
    if (inserted) {} else {
      placed.push(one)
    }
    sorted = placed
  }
  const cap: number = standard.caps.problems
  if (sorted.length <= cap || cap < 1) {
    return sorted
  }
  const out: Event[] = ([] as Event[])
  let at: number = 0
  for (const one of sorted) {
    if (at < cap) {
      out.push(one)
    }
    const __n91 = at + 1; if (!(__n91 <= 9007199254740991 && __n91 >= -9007199254740991)) __termIntStop(__n91); at = __n91
  }
  const __n92 = cap - 1; if (!(__n92 <= 9007199254740991 && __n92 >= -9007199254740991)) __termIntStop(__n92); const lastAt: number = __n92
  const last: Event = (lastAt >= 0 && lastAt < sorted.length ? sorted[lastAt]! : __termReadPast(sorted, lastAt))
  const more: string = findSymbol(room, "more")
  const rest: string = groupNumber(__termInt(sorted.length - cap), standard)
  const word: string = standard.caps.moreProblemsWord
  const summary: Event = { glyph: "info", kind: "problem", verb: last.verb, clock: last.clock, subject: ([] as Span[]), source: "", tool: ([] as string[]), zone: "", duration: -1, uptime: false, budget: -1, status: { kind: "", value: 0, name: "" }, bytes: -1, tallies: ([] as Tally[]), facts: ([] as string[]), message: ([] as string[]), fields: ([] as ItemField[]), frames: ([] as Frame[]), quote: ([] as string[]), quoteEarlier: 0, quoteLog: "", done: -1, total: -1, choices: ([] as Choice[]), asking: false, typed: "", secret: false, columns: ([] as Column[]), rows: ([] as TableRow[]), nodes: ([] as TreeNode[]), entries: ([] as ListEntry[]), entryTotal: -1, level: "", verdict: false, place: { path: "", line: 0, column: 0 }, id: "", cause: "", repeat: 0 }
  summary.subject = plainSubject(`${more} ${rest} ${word}`)
  summary.facts.push(standard.caps.allFlag)
  out.push(summary)
  return out
}

export function makeCrash(verb: string, subject: string, where: string, log: string, clock: number, standard: Standard): Event {
  const one: Event = { glyph: "failed", kind: "problem", verb: verb, subject: plainSubject(subject), clock: clock, source: "", tool: ([] as string[]), zone: "", duration: -1, uptime: false, budget: -1, status: { kind: "", value: 0, name: "" }, bytes: -1, tallies: ([] as Tally[]), facts: ([] as string[]), message: ([] as string[]), fields: ([] as ItemField[]), frames: ([] as Frame[]), quote: ([] as string[]), quoteEarlier: 0, quoteLog: "", done: -1, total: -1, choices: ([] as Choice[]), asking: false, typed: "", secret: false, columns: ([] as Column[]), rows: ([] as TableRow[]), nodes: ([] as TreeNode[]), entries: ([] as ListEntry[]), entryTotal: -1, level: "", verdict: false, place: { path: "", line: 0, column: 0 }, id: "", cause: "", repeat: 0 }
  one.status = { ...one.status, kind: "exit" }
  one.status = { ...one.status, value: exitValue(standard, "bug") }
  if (where !== "") {
    one.fields.push(plainField("in", where))
  }
  if (log !== "") {
    const logField: ItemField = plainField(standard.fields.logKey, log)
    logField.location = true
    one.fields.push(logField)
  }
  return one
}
