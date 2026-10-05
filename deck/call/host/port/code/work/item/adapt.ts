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

const __termVariantJsonNull = Object.freeze({ kind: "json-null" as const })

const __termVariantJsonTrue = Object.freeze({ kind: "json-true" as const })

const __termVariantJsonFalse = Object.freeze({ kind: "json-false" as const })

export function split(value: string, delimiter: string): string[] {
  return __termText.split(value, delimiter)
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

export function restyleSpan(one: Span, value: string): Span {
  const copy: Span = { ...one }
  copy.value = value
  return copy
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

export function isInRanges(ranges: number[], rune: number): boolean {
  let at: number = 0
  const size: number = ranges.length
  while (__termInt(at + 1) < size) {
    const __n0 = at + 1; if (!(__n0 <= 9007199254740991 && __n0 >= -9007199254740991)) __termIntStop(__n0); const next: number = __n0
    const low: number = (at >= 0 && at < ranges.length ? ranges[at]! : __termReadPast(ranges, at))
    const high: number = (next >= 0 && next < ranges.length ? ranges[next]! : __termReadPast(ranges, next))
    if (rune < low) {
      return false
    }
    if (rune <= high) {
      return true
    }
    const __n1 = at + 2; if (!(__n1 <= 9007199254740991 && __n1 >= -9007199254740991)) __termIntStop(__n1); at = __n1
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
      const __n2 = total + measureRune(rune); if (!(__n2 <= 9007199254740991 && __n2 >= -9007199254740991)) __termIntStop(__n2); total = __n2
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
    const __n3 = total + one.wide; if (!(__n3 <= 9007199254740991 && __n3 >= -9007199254740991)) __termIntStop(__n3); total = __n3
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
    rest = Math.trunc(__termInt(rest - digit) / 16)
  }
  let have: number = Array.from(out).length
  while (have < 2) {
    out = `0${out}`
    have = have + 1
  }
  return out
}

export function measureSpans(spans: Span[]): number {
  let total: number = 0
  for (const one of spans) {
    const __n4 = total + measureText(one.value); if (!(__n4 <= 9007199254740991 && __n4 >= -9007199254740991)) __termIntStop(__n4); total = __n4
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
  const __n5 = count - 1; if (!(__n5 <= 9007199254740991 && __n5 >= -9007199254740991)) __termIntStop(__n5); const last: number = __n5
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
  const __n6 = width - measureText(more); if (!(__n6 <= 9007199254740991 && __n6 >= -9007199254740991)) __termIntStop(__n6); const limit: number = __n6
  const out: Span[] = ([] as Span[])
  let used: number = 0
  let role: string = "text"
  for (const one of spans) {
    let kept: string = ""
    let full: boolean = true
    for (const grain of makeGrains(one.value)) {
      if (__termInt(used + grain.wide) <= limit) {
        kept = `${kept}${grain.value}`
        const __n7 = used + grain.wide; if (!(__n7 <= 9007199254740991 && __n7 >= -9007199254740991)) __termIntStop(__n7); used = __n7
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

export function writeJsonText(value: string): string {
  let out: string = ""
  const quote: string = String.fromCodePoint(34)
  const slash: string = String.fromCodePoint(92)
  for (const rune of Array.from(value, function (rune) { return rune.codePointAt(0) ?? 0 })) {
    let piece: string = String.fromCodePoint(rune)
    if (rune === 34) {
      piece = `${slash}${quote}`
    }
    if (rune === 92) {
      piece = `${slash}${slash}`
    }
    if (rune === 10) {
      piece = `${slash}n`
    }
    if (rune === 13) {
      piece = `${slash}r`
    }
    if (rune === 9) {
      piece = `${slash}t`
    }
    if (rune < 32 && (rune !== 10 && (rune !== 13 && rune !== 9))) {
      const digits: string = padDigitsHex(rune)
      piece = `${slash}u${digits}`
    }
    if (rune === 127) {
      piece = `${slash}u007f`
    }
    out = `${out}${piece}`
  }
  return `${quote}${out}${quote}`
}

export function padDigitsHex(rune: number): string {
  let digits: string = writeHex(rune)
  let have: number = Array.from(digits).length
  while (have < 4) {
    digits = `0${digits}`
    have = have + 1
  }
  return digits
}

export function joinParts(parts: string[], open: string, close: string): string {
  let out: string = open
  let at: number = 0
  for (const one of parts) {
    if (at > 0) {
      out = `${out},`
    }
    out = `${out}${one}`
    const __n8 = at + 1; if (!(__n8 <= 9007199254740991 && __n8 >= -9007199254740991)) __termIntStop(__n8); at = __n8
  }
  return `${out}${close}`
}

export type JsonNode =
  | { kind: "json-object"; keys: string[]; values: JsonNode[] }
  | { kind: "json-array"; values: JsonNode[] }
  | { kind: "json-text"; value: string }
  | { kind: "json-number"; value: string }
  | { kind: "json-true" }
  | { kind: "json-false" }
  | { kind: "json-null" }

export interface JsonRead {
  node: JsonNode
  at: number
  failed: boolean
}

export function skipSpace(runes: number[], at: number): number {
  let here: number = at
  while (here < runes.length) {
    const rune: number = (here >= 0 && here < runes.length ? runes[here]! : __termReadPast(runes, here))
    if (rune === 32 || (rune === 9 || (rune === 10 || rune === 13))) {} else {
      return here
    }
    here = here + 1
  }
  return here
}

export function readJsonString(runes: number[], at: number): JsonRead {
  const __n9 = at + 1; if (!(__n9 <= 9007199254740991 && __n9 >= -9007199254740991)) __termIntStop(__n9); let here: number = __n9
  let out: string = ""
  while (here < runes.length) {
    const rune: number = (here >= 0 && here < runes.length ? runes[here]! : __termReadPast(runes, here))
    if (rune === 34) {
      return { node: { kind: "json-text", value: out }, at: __termInt(here + 1), failed: false }
    }
    if (rune === 92) {
      const __n10 = here + 1; if (!(__n10 <= 9007199254740991 && __n10 >= -9007199254740991)) __termIntStop(__n10); const next: number = __n10
      if (next >= runes.length) {
        return { node: __termVariantJsonNull, at: here, failed: true }
      }
      const escaped: number = (next >= 0 && next < runes.length ? runes[next]! : __termReadPast(runes, next))
      const __n11 = next + 1; if (!(__n11 <= 9007199254740991 && __n11 >= -9007199254740991)) __termIntStop(__n11); here = __n11
      if (escaped === 110) {
        out = `${out}
`
        continue
      }
      if (escaped === 116) {
        out = `${out}	`
        continue
      }
      if (escaped === 114) {
        out = `${out}\r`
        continue
      }
      if (escaped === 98 || escaped === 102) {
        continue
      }
      if (escaped === 117) {
        let code: number = 0
        let count: number = 0
        while (count < 4 && here < runes.length) {
          const digit: number = readDigitHex((here >= 0 && here < runes.length ? runes[here]! : __termReadPast(runes, here)))
          if (digit < 0) {
            return { node: __termVariantJsonNull, at: here, failed: true }
          }
          const __n12 = __termInt(code * 16) + digit; if (!(__n12 <= 9007199254740991 && __n12 >= -9007199254740991)) __termIntStop(__n12); code = __n12
          const __n13 = here + 1; if (!(__n13 <= 9007199254740991 && __n13 >= -9007199254740991)) __termIntStop(__n13); here = __n13
          count = count + 1
        }
        out = `${out}${String.fromCodePoint(code)}`
        continue
      }
      out = `${out}${String.fromCodePoint(escaped)}`
      continue
    }
    out = `${out}${String.fromCodePoint(rune)}`
    const __n14 = here + 1; if (!(__n14 <= 9007199254740991 && __n14 >= -9007199254740991)) __termIntStop(__n14); here = __n14
  }
  return { node: __termVariantJsonNull, at: here, failed: true }
}

export function readDigitHex(rune: number): number {
  if (rune >= 48 && rune <= 57) {
    return rune - 48
  }
  if (rune >= 65 && rune <= 70) {
    return rune - 55
  }
  if (rune >= 97 && rune <= 102) {
    return rune - 87
  }
  return -1
}

export function isWordAt(runes: number[], at: number, word: string): boolean {
  let here: number = at
  for (const rune of Array.from(word, function (rune) { return rune.codePointAt(0) ?? 0 })) {
    if (here >= runes.length) {
      return false
    }
    if ((here >= 0 && here < runes.length ? runes[here]! : __termReadPast(runes, here)) !== rune) {
      return false
    }
    const __n15 = here + 1; if (!(__n15 <= 9007199254740991 && __n15 >= -9007199254740991)) __termIntStop(__n15); here = __n15
  }
  return true
}

export function readJsonValue(runes: number[], at: number): JsonRead {
  const here: number = skipSpace(runes, at)
  if (here >= runes.length) {
    return { node: __termVariantJsonNull, at: here, failed: true }
  }
  const rune: number = (here >= 0 && here < runes.length ? runes[here]! : __termReadPast(runes, here))
  if (rune === 34) {
    return readJsonString(runes, here)
  }
  if (rune === 123) {
    return readJsonObject(runes, here)
  }
  if (rune === 91) {
    return readJsonArray(runes, here)
  }
  if (isWordAt(runes, here, "true")) {
    return { node: __termVariantJsonTrue, at: __termInt(here + 4), failed: false }
  }
  if (isWordAt(runes, here, "false")) {
    return { node: __termVariantJsonFalse, at: __termInt(here + 5), failed: false }
  }
  if (isWordAt(runes, here, "null")) {
    return { node: __termVariantJsonNull, at: __termInt(here + 4), failed: false }
  }
  let out: string = ""
  let end: number = here
  while (end < runes.length) {
    const next: number = (end >= 0 && end < runes.length ? runes[end]! : __termReadPast(runes, end))
    if (next >= 48 && next <= 57 || (next === 45 || (next === 43 || (next === 46 || (next === 101 || next === 69))))) {} else {
      break
    }
    out = `${out}${String.fromCodePoint(next)}`
    end = end + 1
  }
  if (end === here) {
    return { node: __termVariantJsonNull, at: here, failed: true }
  }
  return { node: { kind: "json-number", value: out }, at: end, failed: false }
}

export function readJsonObject(runes: number[], at: number): JsonRead {
  const keys: string[] = ([] as string[])
  const values: JsonNode[] = ([] as JsonNode[])
  let here: number = skipSpace(runes, __termInt(at + 1))
  if (here < runes.length && (here >= 0 && here < runes.length ? runes[here]! : __termReadPast(runes, here)) === 125) {
    return { node: { kind: "json-object", keys: keys, values: values }, at: __termInt(here + 1), failed: false }
  }
  while (here < runes.length) {
    here = skipSpace(runes, here)
    if (here >= runes.length || (here >= 0 && here < runes.length ? runes[here]! : __termReadPast(runes, here)) !== 34) {
      return { node: __termVariantJsonNull, at: here, failed: true }
    }
    const key: JsonRead = readJsonString(runes, here)
    if (key.failed) {
      return key
    }
    here = skipSpace(runes, key.at)
    if (here >= runes.length || (here >= 0 && here < runes.length ? runes[here]! : __termReadPast(runes, here)) !== 58) {
      return { node: __termVariantJsonNull, at: here, failed: true }
    }
    const value: JsonRead = readJsonValue(runes, __termInt(here + 1))
    if (value.failed) {
      return value
    }
    let jsonTextOf1: string = ""
    const node1: JsonNode = key.node
    if (node1.kind === "json-text") {
      const value1 = node1.value
      jsonTextOf1 = value1
    } else if (node1.kind === "json-number") {
      const value1 = node1.value
      jsonTextOf1 = value1
    } else if (node1.kind === "json-true") {
      jsonTextOf1 = "true"
    } else if (node1.kind === "json-false") {
      jsonTextOf1 = "false"
    } else if (node1.kind === "json-object") {
      jsonTextOf1 = ""
    } else if (node1.kind === "json-array") {
      jsonTextOf1 = ""
    } else {
      jsonTextOf1 = ""
    }
    keys.push(jsonTextOf1)
    values.push(value.node)
    here = skipSpace(runes, value.at)
    if (here >= runes.length) {
      return { node: __termVariantJsonNull, at: here, failed: true }
    }
    if ((here >= 0 && here < runes.length ? runes[here]! : __termReadPast(runes, here)) === 125) {
      return { node: { kind: "json-object", keys: keys, values: values }, at: __termInt(here + 1), failed: false }
    }
    if ((here >= 0 && here < runes.length ? runes[here]! : __termReadPast(runes, here)) !== 44) {
      return { node: __termVariantJsonNull, at: here, failed: true }
    }
    const __n16 = here + 1; if (!(__n16 <= 9007199254740991 && __n16 >= -9007199254740991)) __termIntStop(__n16); here = __n16
  }
  return { node: __termVariantJsonNull, at: here, failed: true }
}

export function readJsonArray(runes: number[], at: number): JsonRead {
  const values: JsonNode[] = ([] as JsonNode[])
  let here: number = skipSpace(runes, __termInt(at + 1))
  if (here < runes.length && (here >= 0 && here < runes.length ? runes[here]! : __termReadPast(runes, here)) === 93) {
    return { node: { kind: "json-array", values: values }, at: __termInt(here + 1), failed: false }
  }
  while (here < runes.length) {
    const value: JsonRead = readJsonValue(runes, here)
    if (value.failed) {
      return value
    }
    values.push(value.node)
    here = skipSpace(runes, value.at)
    if (here >= runes.length) {
      return { node: __termVariantJsonNull, at: here, failed: true }
    }
    if ((here >= 0 && here < runes.length ? runes[here]! : __termReadPast(runes, here)) === 93) {
      return { node: { kind: "json-array", values: values }, at: __termInt(here + 1), failed: false }
    }
    if ((here >= 0 && here < runes.length ? runes[here]! : __termReadPast(runes, here)) !== 44) {
      return { node: __termVariantJsonNull, at: here, failed: true }
    }
    const __n17 = here + 1; if (!(__n17 <= 9007199254740991 && __n17 >= -9007199254740991)) __termIntStop(__n17); here = __n17
  }
  return { node: __termVariantJsonNull, at: here, failed: true }
}

export function jsonTextOf(node: JsonNode): string {
  if (node.kind === "json-text") {
    const value = node.value
    return value
  } else if (node.kind === "json-number") {
    const value = node.value
    return value
  } else if (node.kind === "json-true") {
    return "true"
  } else if (node.kind === "json-false") {
    return "false"
  } else if (node.kind === "json-object") {
    return ""
  } else if (node.kind === "json-array") {
    return ""
  } else {
    return ""
  }
}

export function readJson(value: string): JsonRead {
  const runes: number[] = Array.from(value, function (rune) { return rune.codePointAt(0) ?? 0 })
  const got: JsonRead = readJsonValue(runes, 0)
  if (got.failed) {
    return got
  }
  const end: number = skipSpace(runes, got.at)
  if (end < runes.length) {
    return { node: __termVariantJsonNull, at: end, failed: true }
  }
  return got
}

export function writeJsonNode(node: JsonNode): string {
  if (node.kind === "json-object") {
    const keys = node.keys
    const values = node.values
    const parts: string[] = ([] as string[])
    let at: number = 0
    for (const key of keys) {
      const one: JsonNode = (at >= 0 && at < values.length ? values[at]! : __termReadPast(values, at))
      parts.push(`${writeJsonText(key)}:${writeJsonNode(one)}`)
      const __n18 = at + 1; if (!(__n18 <= 9007199254740991 && __n18 >= -9007199254740991)) __termIntStop(__n18); at = __n18
    }
    return joinParts(parts, "{", "}")
  } else if (node.kind === "json-array") {
    const values = node.values
    const parts: string[] = ([] as string[])
    for (const one of values) {
      parts.push(writeJsonNode(one))
    }
    return joinParts(parts, "[", "]")
  } else if (node.kind === "json-text") {
    const value = node.value
    return writeJsonText(value)
  } else if (node.kind === "json-number") {
    const value = node.value
    return value
  } else if (node.kind === "json-true") {
    return "true"
  } else if (node.kind === "json-false") {
    return "false"
  } else {
    return "null"
  }
}

export interface Adapted {
  kind: string
  event: Event
  line: string
}

export interface ChildPair {
  key: string
  value: string
  nested: boolean
}

export interface ChildPairs {
  pairs: ChildPair[]
  failed: boolean
}

export function countDays(year: number, month: number, day: number): number {
  let y: number = year
  if (month <= 2) {
    const __n19 = y - 1; if (!(__n19 <= 9007199254740991 && __n19 >= -9007199254740991)) __termIntStop(__n19); y = __n19
  }
  let era: number = Math.trunc(y / 400)
  if (y < 0) {
    era = Math.trunc(__termInt(y - 399) / 400)
  }
  const __n20 = y - __termInt(era * 400); if (!(__n20 <= 9007199254740991 && __n20 >= -9007199254740991)) __termIntStop(__n20); const yoe: number = __n20
  const __n21 = month + 9; if (!(__n21 <= 9007199254740991 && __n21 >= -9007199254740991)) __termIntStop(__n21); let shifted: number = __n21
  if (month > 2) {
    const __n22 = month - 3; if (!(__n22 <= 9007199254740991 && __n22 >= -9007199254740991)) __termIntStop(__n22); shifted = __n22
  }
  const __n23 = Math.trunc(__termInt(__termInt(153 * shifted) + 2) / 5) + __termInt(day - 1); if (!(__n23 <= 9007199254740991 && __n23 >= -9007199254740991)) __termIntStop(__n23); const doy: number = __n23
  const __n24 = __termInt(__termInt(__termInt(yoe * 365) + Math.trunc(yoe / 4)) - Math.trunc(yoe / 100)) + doy; if (!(__n24 <= 9007199254740991 && __n24 >= -9007199254740991)) __termIntStop(__n24); const doe: number = __n24
  const __n25 = __termInt(__termInt(era * 146097) + doe) - 719468; if (!(__n25 <= 9007199254740991 && __n25 >= -9007199254740991)) __termIntStop(__n25); return __n25
}

export interface DigitsRead {
  value: number
  count: number
}

export function readDigits(runes: number[], at: number, most: number): DigitsRead {
  let value: number = 0
  let count: number = 0
  let here: number = at
  while (here < runes.length && count < most) {
    const rune: number = (here >= 0 && here < runes.length ? runes[here]! : __termReadPast(runes, here))
    if (rune >= 48 && rune <= 57) {} else {
      break
    }
    const __n26 = __termInt(value * 10) + (rune - 48); if (!(__n26 <= 9007199254740991 && __n26 >= -9007199254740991)) __termIntStop(__n26); value = __n26
    const __n27 = count + 1; if (!(__n27 <= 9007199254740991 && __n27 >= -9007199254740991)) __termIntStop(__n27); count = __n27
    const __n28 = here + 1; if (!(__n28 <= 9007199254740991 && __n28 >= -9007199254740991)) __termIntStop(__n28); here = __n28
  }
  return { value: value, count: count }
}

export function readInstant(value: string, offset: number): number {
  const runes: number[] = Array.from(__termText.trim(value), function (rune) { return rune.codePointAt(0) ?? 0 })
  const year: DigitsRead = readDigits(runes, 0, 4)
  if (year.count !== 4 || runes.length < 16) {
    return -1
  }
  const month: DigitsRead = readDigits(runes, 5, 2)
  const day: DigitsRead = readDigits(runes, 8, 2)
  const hour: DigitsRead = readDigits(runes, 11, 2)
  const minute: DigitsRead = readDigits(runes, 14, 2)
  if (month.count !== 2 || (day.count !== 2 || (hour.count !== 2 || minute.count !== 2))) {
    return -1
  }
  let at: number = 16
  let second: number = 0
  let millis: number = 0
  if (at < runes.length && (at >= 0 && at < runes.length ? runes[at]! : __termReadPast(runes, at)) === 58) {
    const got: DigitsRead = readDigits(runes, at + 1, 2)
    second = got.value
    at = at + 3
  }
  if (at < runes.length && ((at >= 0 && at < runes.length ? runes[at]! : __termReadPast(runes, at)) === 46 || (at >= 0 && at < runes.length ? runes[at]! : __termReadPast(runes, at)) === 44)) {
    const got: DigitsRead = readDigits(runes, at + 1, 9)
    const __n29 = 3 - got.count; if (!(__n29 <= 9007199254740991 && __n29 >= -9007199254740991)) __termIntStop(__n29); let left: number = __n29
    let fraction: number = got.value
    while (left > 0) {
      const __n30 = fraction * 10; if (!(__n30 <= 9007199254740991 && __n30 >= -9007199254740991)) __termIntStop(__n30); fraction = __n30
      left = left - 1
    }
    while (left < 0) {
      fraction = Math.trunc(fraction / 10)
      left = left + 1
    }
    millis = fraction
    const __n31 = at + 1 + got.count; if (!(__n31 <= 9007199254740991 && __n31 >= -9007199254740991)) __termIntStop(__n31); at = __n31
  }
  let zone: number = offset
  if (at < runes.length) {
    const sign: number = (at >= 0 && at < runes.length ? runes[at]! : __termReadPast(runes, at))
    if (sign === 90 || sign === 122) {
      zone = 0
    }
    if (sign === 43 || sign === 45) {
      const zoneHours: DigitsRead = readDigits(runes, __termInt(at + 1), 2)
      const __n32 = at + 3; if (!(__n32 <= 9007199254740991 && __n32 >= -9007199254740991)) __termIntStop(__n32); let minutesAt: number = __n32
      if (minutesAt < runes.length && (minutesAt >= 0 && minutesAt < runes.length ? runes[minutesAt]! : __termReadPast(runes, minutesAt)) === 58) {
        const __n33 = minutesAt + 1; if (!(__n33 <= 9007199254740991 && __n33 >= -9007199254740991)) __termIntStop(__n33); minutesAt = __n33
      }
      const zoneMinutes: DigitsRead = readDigits(runes, minutesAt, 2)
      const __n34 = __termInt(zoneHours.value * 60) + zoneMinutes.value; if (!(__n34 <= 9007199254740991 && __n34 >= -9007199254740991)) __termIntStop(__n34); zone = __n34
      if (sign === 45) {
        const __n35 = 0 - zone; if (!(__n35 <= 9007199254740991 && __n35 >= -9007199254740991)) __termIntStop(__n35); zone = __n35
      }
    }
  }
  const days: number = countDays(year.value, month.value, day.value)
  const __n36 = __termInt(__termInt(days * 86400) + __termInt(hour.value * 3600)) + __termInt(__termInt(minute.value * 60) + second); if (!(__n36 <= 9007199254740991 && __n36 >= -9007199254740991)) __termIntStop(__n36); const seconds: number = __n36
  const __n37 = __termInt(__termInt(seconds * 1000) + millis) - __termInt(zone * 60000); if (!(__n37 <= 9007199254740991 && __n37 >= -9007199254740991)) __termIntStop(__n37); return __n37
}

export function readDecimal(value: string, scale: number): number {
  const runes: number[] = Array.from(__termText.trim(value), function (rune) { return rune.codePointAt(0) ?? 0 })
  const whole: DigitsRead = readDigits(runes, 0, 16)
  if (whole.count === 0) {
    return -1
  }
  const __n38 = whole.value * scale; if (!(__n38 <= 9007199254740991 && __n38 >= -9007199254740991)) __termIntStop(__n38); let total: number = __n38
  let at: number = whole.count
  if (at < runes.length && (at >= 0 && at < runes.length ? runes[at]! : __termReadPast(runes, at)) === 46) {
    const part: DigitsRead = readDigits(runes, __termInt(at + 1), 9)
    const digits: number = part.count
    let index: number = 0
    const fraction: number = part.value
    let divisor: number = 1
    while (index < digits) {
      const __n39 = divisor * 10; if (!(__n39 <= 9007199254740991 && __n39 >= -9007199254740991)) __termIntStop(__n39); divisor = __n39
      index = index + 1
    }
    const __n40 = total + Math.trunc(__termInt(fraction * scale) / divisor); if (!(__n40 <= 9007199254740991 && __n40 >= -9007199254740991)) __termIntStop(__n40); total = __n40
    const __n41 = __termInt(at + 1) + part.count; if (!(__n41 <= 9007199254740991 && __n41 >= -9007199254740991)) __termIntStop(__n41); at = __n41
  }
  if (at < runes.length) {
    return -1
  }
  return total
}

export function readChildClock(value: string, offset: number): number {
  const instant: number = readInstant(value, offset)
  if (instant >= 0) {
    return instant
  }
  const seconds: number = readDecimal(value, 1000)
  if (seconds < 0) {
    return -1
  }
  if (seconds > 100000000000000) {
    return Math.trunc(seconds / 1000)
  }
  return seconds
}

export function readChildDuration(value: string): number {
  const plain: number = readDecimal(value, 1)
  if (plain >= 0) {
    return plain
  }
  const runes: number[] = Array.from(__termText.trim(value), function (rune) { return rune.codePointAt(0) ?? 0 })
  let number: string = ""
  let unit: string = ""
  for (const rune of runes) {
    if (rune >= 48 && rune <= 57 || rune === 46) {
      if (unit === "") {
        number = `${number}${String.fromCodePoint(rune)}`
        continue
      }
      return -1
    }
    if (rune === 32) {
      continue
    }
    unit = `${unit}${String.fromCodePoint(rune)}`
  }
  if (unit === "ms") {
    return readDecimal(number, 1)
  }
  if (unit === "s") {
    return readDecimal(number, 1000)
  }
  if (unit === "m") {
    return readDecimal(number, 60000)
  }
  if (unit === "h") {
    return readDecimal(number, 3600000)
  }
  return -1
}

export function isUnitNumber(value: string): boolean {
  const runes: number[] = Array.from(__termText.trim(value), function (rune) { return rune.codePointAt(0) ?? 0 })
  if (runes.length < 2 || runes.length > 12) {
    return false
  }
  let digits: number = 0
  let letters: number = 0
  for (const rune of runes) {
    const digit: boolean = rune >= 48 && rune <= 57 || (rune === 46 || rune === 44)
    if (digit) {
      if (letters > 0) {
        return false
      }
      const __n42 = digits + 1; if (!(__n42 <= 9007199254740991 && __n42 >= -9007199254740991)) __termIntStop(__n42); digits = __n42
      continue
    }
    if (rune === 32 && letters === 0) {
      continue
    }
    if (rune === 37 || (rune >= 65 && rune <= 90 || rune >= 97 && rune <= 122)) {
      const __n43 = letters + 1; if (!(__n43 <= 9007199254740991 && __n43 >= -9007199254740991)) __termIntStop(__n43); letters = __n43
      continue
    }
    return false
  }
  return digits > 0 && (letters > 0 && letters <= 3)
}

export function readLogfmt(value: string): ChildPairs {
  const pairs: ChildPair[] = ([] as ChildPair[])
  const runes: number[] = Array.from(value, function (rune) { return rune.codePointAt(0) ?? 0 })
  let at: number = 0
  let equals: number = 0
  while (at < runes.length) {
    while (at < runes.length && (at >= 0 && at < runes.length ? runes[at]! : __termReadPast(runes, at)) === 32) {
      const __n44 = at + 1; if (!(__n44 <= 9007199254740991 && __n44 >= -9007199254740991)) __termIntStop(__n44); at = __n44
    }
    if (at >= runes.length) {
      break
    }
    let key: string = ""
    while (at < runes.length && ((at >= 0 && at < runes.length ? runes[at]! : __termReadPast(runes, at)) !== 61 && (at >= 0 && at < runes.length ? runes[at]! : __termReadPast(runes, at)) !== 32)) {
      const rune: number = (at >= 0 && at < runes.length ? runes[at]! : __termReadPast(runes, at))
      if (rune === 34) {
        return { pairs: pairs, failed: true }
      }
      key = `${key}${String.fromCodePoint(rune)}`
      const __n45 = at + 1; if (!(__n45 <= 9007199254740991 && __n45 >= -9007199254740991)) __termIntStop(__n45); at = __n45
    }
    if (key === "") {
      return { pairs: pairs, failed: true }
    }
    if (at >= runes.length || (at >= 0 && at < runes.length ? runes[at]! : __termReadPast(runes, at)) === 32) {
      pairs.push({ key: key, value: "true", nested: false })
      continue
    }
    const __n46 = at + 1; if (!(__n46 <= 9007199254740991 && __n46 >= -9007199254740991)) __termIntStop(__n46); at = __n46
    const __n47 = equals + 1; if (!(__n47 <= 9007199254740991 && __n47 >= -9007199254740991)) __termIntStop(__n47); equals = __n47
    let found: string = ""
    if (at < runes.length && (at >= 0 && at < runes.length ? runes[at]! : __termReadPast(runes, at)) === 34) {
      const __n48 = at + 1; if (!(__n48 <= 9007199254740991 && __n48 >= -9007199254740991)) __termIntStop(__n48); at = __n48
      let closed: boolean = false
      while (at < runes.length) {
        const rune: number = (at >= 0 && at < runes.length ? runes[at]! : __termReadPast(runes, at))
        if (rune === 92) {
          const __n49 = at + 1; if (!(__n49 <= 9007199254740991 && __n49 >= -9007199254740991)) __termIntStop(__n49); const next: number = __n49
          if (next < runes.length) {
            found = `${found}${String.fromCodePoint((next >= 0 && next < runes.length ? runes[next]! : __termReadPast(runes, next)))}`
          }
          const __n50 = at + 2; if (!(__n50 <= 9007199254740991 && __n50 >= -9007199254740991)) __termIntStop(__n50); at = __n50
          continue
        }
        if (rune === 34) {
          const __n51 = at + 1; if (!(__n51 <= 9007199254740991 && __n51 >= -9007199254740991)) __termIntStop(__n51); at = __n51
          closed = true
          break
        }
        found = `${found}${String.fromCodePoint(rune)}`
        const __n52 = at + 1; if (!(__n52 <= 9007199254740991 && __n52 >= -9007199254740991)) __termIntStop(__n52); at = __n52
      }
      if (closed) {} else {
        return { pairs: pairs, failed: true }
      }
    } else {
      while (at < runes.length && (at >= 0 && at < runes.length ? runes[at]! : __termReadPast(runes, at)) !== 32) {
        found = `${found}${String.fromCodePoint((at >= 0 && at < runes.length ? runes[at]! : __termReadPast(runes, at)))}`
        const __n53 = at + 1; if (!(__n53 <= 9007199254740991 && __n53 >= -9007199254740991)) __termIntStop(__n53); at = __n53
      }
    }
    pairs.push({ key: key, value: found, nested: false })
  }
  return { pairs: pairs, failed: equals < 2 }
}

export function readJsonPairs(value: string): ChildPairs {
  const pairs: ChildPair[] = ([] as ChildPair[])
  const got: JsonRead = readJson(value)
  if (got.failed) {
    return { pairs: pairs, failed: true }
  }
  const node: JsonNode = got.node
  if (node.kind === "json-object") {
    const keys = node.keys
    const values = node.values
    let at: number = 0
    for (const key of keys) {
      const one: JsonNode = (at >= 0 && at < values.length ? values[at]! : __termReadPast(values, at))
      const __n54 = at + 1; if (!(__n54 <= 9007199254740991 && __n54 >= -9007199254740991)) __termIntStop(__n54); at = __n54
      let nested: boolean = false
      let carried: boolean = false
      if (one.kind === "json-object") {
        const keys = one.keys
        const values = one.values
        nested = true
        let innerAt: number = 0
        for (const inner of keys) {
          const innerValue: JsonNode = (innerAt >= 0 && innerAt < values.length ? values[innerAt]! : __termReadPast(values, innerAt))
          const __n55 = innerAt + 1; if (!(__n55 <= 9007199254740991 && __n55 >= -9007199254740991)) __termIntStop(__n55); innerAt = __n55
          if (inner === "stack" || inner === "message") {
            pairs.push({ key: `${key}.${inner}`, value: jsonTextOf(innerValue), nested: false })
            if (inner === "stack") {
              carried = true
            }
          }
        }
      } else if (one.kind === "json-array") {
        nested = true
      } else if (one.kind === "json-text") {
        nested = false
      } else if (one.kind === "json-number") {
        nested = false
      } else if (one.kind === "json-true") {
        nested = false
      } else if (one.kind === "json-false") {
        nested = false
      } else {
        nested = false
      }
      if (carried) {} else {
        if (nested) {
          pairs.push({ key: key, value: writeJsonNode(one), nested: true })
        } else {
          pairs.push({ key: key, value: jsonTextOf(one), nested: false })
        }
      }
    }
    return { pairs: pairs, failed: false }
  } else if (node.kind === "json-array") {
    return { pairs: pairs, failed: true }
  } else if (node.kind === "json-text") {
    return { pairs: pairs, failed: true }
  } else if (node.kind === "json-number") {
    return { pairs: pairs, failed: true }
  } else if (node.kind === "json-true") {
    return { pairs: pairs, failed: true }
  } else if (node.kind === "json-false") {
    return { pairs: pairs, failed: true }
  } else {
    return { pairs: pairs, failed: true }
  }
}

export function findLevel(standard: Standard, word: string): string {
  const lower: string = __termText.toLowerCase(word)
  for (const one of standard.children.levels) {
    if (one.word === lower) {
      if (one.quiet) {
        return "debug"
      }
      return one.glyph
    }
  }
  return "info"
}

export function adaptPairs(pairs: ChildPair[], received: number, offset: number, standard: Standard, room: Room): Event {
  const rule: ChildRule = standard.children
  const one: Event = { glyph: "info", kind: "step", clock: received, verb: "", subject: ([] as Span[]), source: "", tool: ([] as string[]), zone: "", duration: -1, uptime: false, budget: -1, status: { kind: "", value: 0, name: "" }, bytes: -1, tallies: ([] as Tally[]), facts: ([] as string[]), message: ([] as string[]), fields: ([] as ItemField[]), frames: ([] as Frame[]), quote: ([] as string[]), quoteEarlier: 0, quoteLog: "", done: -1, total: -1, choices: ([] as Choice[]), asking: false, typed: "", secret: false, columns: ([] as Column[]), rows: ([] as TableRow[]), nodes: ([] as TreeNode[]), entries: ([] as ListEntry[]), entryTotal: -1, level: "", verdict: false, place: { path: "", line: 0, column: 0 }, id: "", cause: "", repeat: 0 }
  let verb: string = ""
  let subject: string = ""
  let stack: string = ""
  for (const pair of pairs) {
    const key: string = pair.key
    if (holdsText(rule.levelKeys, key)) {
      const level: string = findLevel(standard, pair.value)
      if (level === "debug") {
        one.level = "debug"
      } else {
        one.glyph = level
      }
      continue
    }
    if (holdsText(rule.verbKeys, key)) {
      if (verb === "") {
        verb = pair.value
      }
      continue
    }
    if (holdsText(rule.messageKeys, key)) {
      if (subject === "") {
        subject = pair.value
      }
      continue
    }
    if (holdsText(rule.timeKeys, key)) {
      const clock: number = readChildClock(pair.value, offset)
      if (clock >= 0) {
        one.clock = clock
      }
      continue
    }
    if (holdsText(rule.durationKeys, key)) {
      const took: number = readChildDuration(pair.value)
      if (took >= 0) {
        one.duration = took
        continue
      }
    }
    if (holdsText(rule.stackKeys, key)) {
      stack = pair.value
      continue
    }
    if (key === "err.message") {
      if (subject === "") {
        subject = pair.value
      }
      continue
    }
    if (!pair.nested && isUnitNumber(pair.value)) {
      one.facts.push(pair.value)
      continue
    }
    one.fields.push(plainField(key, pair.value))
  }
  if (verb === "") {
    verb = rule.defaultVerb
  }
  if (measureText(verb) > standard.layout.verbWidth) {
    verb = cropText(verb, standard.layout.verbWidth, room)
  }
  one.verb = verb
  one.subject = plainSubject(subject)
  if (stack !== "") {
    one.quote = splitLines(stack)
  }
  return one
}

export function adaptLine(value: string, received: number, offset: number, raw: boolean, room: Room): Adapted {
  const blank: Event = { glyph: "info", kind: "step", verb: "", subject: ([] as Span[]), source: "", clock: -1, tool: ([] as string[]), zone: "", duration: -1, uptime: false, budget: -1, status: { kind: "", value: 0, name: "" }, bytes: -1, tallies: ([] as Tally[]), facts: ([] as string[]), message: ([] as string[]), fields: ([] as ItemField[]), frames: ([] as Frame[]), quote: ([] as string[]), quoteEarlier: 0, quoteLog: "", done: -1, total: -1, choices: ([] as Choice[]), asking: false, typed: "", secret: false, columns: ([] as Column[]), rows: ([] as TableRow[]), nodes: ([] as TreeNode[]), entries: ([] as ListEntry[]), entryTotal: -1, level: "", verdict: false, place: { path: "", line: 0, column: 0 }, id: "", cause: "", repeat: 0 }
  if (raw) {
    return { kind: "raw", event: blank, line: value }
  }
  const trimmed: string = __termText.trim(value)
  if (__termText.startsWith(trimmed, "{")) {
    const got: ChildPairs = readJsonPairs(trimmed)
    if (got.failed) {} else {
      const one: Event = adaptPairs(got.pairs, received, offset, room.standard, room)
      return { kind: "item", event: one, line: value }
    }
  }
  const got: ChildPairs = readLogfmt(trimmed)
  if (got.failed) {} else {
    const one: Event = adaptPairs(got.pairs, received, offset, room.standard, room)
    return { kind: "item", event: one, line: value }
  }
  return { kind: "quote", event: blank, line: value }
}
