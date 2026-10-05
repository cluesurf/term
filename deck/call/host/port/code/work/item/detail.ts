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

export function split(value: string, delimiter: string): string[] {
  return __termText.split(value, delimiter)
}

export function startsWith(value: string, prefix: string): boolean {
  return __termText.startsWith(value, prefix)
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

export interface Column {
  title: string
  numeric: boolean
}

export interface Location {
  path: string
  line: number
  column: number
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
    const __n4 = Math.trunc(__termInt(rest - digit) / 16); if (!(__n4 <= 9007199254740991 && __n4 >= -9007199254740991)) __termIntStop(__n4); rest = __n4
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
      const __n5 = stop - __termInt(column % stop); if (!(__n5 <= 9007199254740991 && __n5 >= -9007199254740991)) __termIntStop(__n5); const gap: number = __n5
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
    const __n6 = column + measureText(piece); if (!(__n6 <= 9007199254740991 && __n6 >= -9007199254740991)) __termIntStop(__n6); column = __n6
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
  const __n7 = 0 - value; if (!(__n7 <= 9007199254740991 && __n7 >= -9007199254740991)) __termIntStop(__n7); const flipped: number = __n7
  const __n8 = 0 - __termInt(Math.trunc(__termInt(__termInt(flipped * 2) + 1) / 2)); if (!(__n8 <= 9007199254740991 && __n8 >= -9007199254740991)) __termIntStop(__n8); return __n8
}

export function divideWhole(top: number, bottom: number): number {
  if (bottom <= 0) {
    return 0
  }
  const __n9 = Math.trunc(top / bottom); if (!(__n9 <= 9007199254740991 && __n9 >= -9007199254740991)) __termIntStop(__n9); return __n9
}

export function groupNumber(value: number, standard: Standard): string {
  let whole: number = makeWhole(value)
  let sign: string = ""
  if (whole < 0) {
    sign = "-"
    const __n10 = 0 - whole; if (!(__n10 <= 9007199254740991 && __n10 >= -9007199254740991)) __termIntStop(__n10); whole = __n10
  }
  const digits: string = `${whole}`
  const runes: number[] = Array.from(digits, function (rune) { return rune.codePointAt(0) ?? 0 })
  const count: number = runes.length
  const every: number = standard.numbers.groupDigits
  const mark: string = standard.numbers.group
  let out: string = ""
  let at: number = 0
  for (const rune of runes) {
    const __n11 = count - at; if (!(__n11 <= 9007199254740991 && __n11 >= -9007199254740991)) __termIntStop(__n11); const left: number = __n11
    if (at > 0 && (every > 0 && __termInt(left % every) === 0)) {
      out = `${out}${mark}`
    }
    out = `${out}${String.fromCodePoint(rune)}`
    const __n12 = at + 1; if (!(__n12 <= 9007199254740991 && __n12 >= -9007199254740991)) __termIntStop(__n12); at = __n12
  }
  return `${sign}${out}`
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
      const __n13 = digits + 1; if (!(__n13 <= 9007199254740991 && __n13 >= -9007199254740991)) __termIntStop(__n13); digits = __n13
    }
    const __n14 = at + 1; if (!(__n14 <= 9007199254740991 && __n14 >= -9007199254740991)) __termIntStop(__n14); at = __n14
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
    const __n15 = at + 1; if (!(__n15 <= 9007199254740991 && __n15 >= -9007199254740991)) __termIntStop(__n15); at = __n15
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
    const __n16 = keep - 1; if (!(__n16 <= 9007199254740991 && __n16 >= -9007199254740991)) __termIntStop(__n16); const lastAt: number = __n16
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
    const __n17 = at + 1; if (!(__n17 <= 9007199254740991 && __n17 >= -9007199254740991)) __termIntStop(__n17); at = __n17
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
    const __n18 = total + measureText(one.value); if (!(__n18 <= 9007199254740991 && __n18 >= -9007199254740991)) __termIntStop(__n18); total = __n18
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
  const __n19 = count - 1; if (!(__n19 <= 9007199254740991 && __n19 >= -9007199254740991)) __termIntStop(__n19); const last: number = __n19
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
  const __n20 = width - measureText(more); if (!(__n20 <= 9007199254740991 && __n20 >= -9007199254740991)) __termIntStop(__n20); const limit: number = __n20
  const out: Span[] = ([] as Span[])
  let used: number = 0
  let role: string = "text"
  for (const one of spans) {
    let kept: string = ""
    let full: boolean = true
    for (const grain of makeGrains(one.value)) {
      if (__termInt(used + grain.wide) <= limit) {
        kept = `${kept}${grain.value}`
        const __n21 = used + grain.wide; if (!(__n21 <= 9007199254740991 && __n21 >= -9007199254740991)) __termIntStop(__n21); used = __n21
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
    const __n22 = owner + 1; if (!(__n22 <= 9007199254740991 && __n22 >= -9007199254740991)) __termIntStop(__n22); owner = __n22
  }
  return out
}

export function measurePieces(pieces: Piece[], start: number, end: number): number {
  let total: number = 0
  let at: number = start
  if (at >= 0 && end - 1 < pieces.length) {
    while (at < end) {
      const one: Piece = pieces[at]!
      const __n23 = total + one.wide; if (!(__n23 <= 9007199254740991 && __n23 >= -9007199254740991)) __termIntStop(__n23); total = __n23
      at = at + 1
    }
  } else {
    while (at < end) {
      const one: Piece = (at >= 0 && at < pieces.length ? pieces[at]! : __termReadPast(pieces, at))
      const __n24 = total + one.wide; if (!(__n24 <= 9007199254740991 && __n24 >= -9007199254740991)) __termIntStop(__n24); total = __n24
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
      const __n25 = at + 1; if (!(__n25 <= 9007199254740991 && __n25 >= -9007199254740991)) __termIntStop(__n25); at = __n25
    }
    const gapEnd: number = at
    const start: number = at
    while (at < count && pieceValue(pieces, at) !== " ") {
      const __n26 = at + 1; if (!(__n26 <= 9007199254740991 && __n26 >= -9007199254740991)) __termIntStop(__n26); at = __n26
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
  const __n27 = __termInt(at - size) + 2; if (!(__n27 <= 9007199254740991 && __n27 >= -9007199254740991)) __termIntStop(__n27); let from: number = __n27
  if (from < start) {
    from = start
  }
  while (from <= at) {
    const __n28 = from + size; if (!(__n28 <= 9007199254740991 && __n28 >= -9007199254740991)) __termIntStop(__n28); const stop: number = __n28
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
    const __n29 = from + 1; if (!(__n29 <= 9007199254740991 && __n29 >= -9007199254740991)) __termIntStop(__n29); from = __n29
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
  const __n30 = one.tier + 1; if (!(__n30 <= 9007199254740991 && __n30 >= -9007199254740991)) __termIntStop(__n30); const nextTier: number = __n30
  let from: number = one.start
  let at: number = one.start
  const __n31 = one.end - 1; if (!(__n31 <= 9007199254740991 && __n31 >= -9007199254740991)) __termIntStop(__n31); const last: number = __n31
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
  const __n32 = words.length - 1; if (!(__n32 <= 9007199254740991 && __n32 >= -9007199254740991)) __termIntStop(__n32); let at: number = __n32
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
        const __n33 = __termInt(used + gapWide) + wide; if (!(__n33 <= 9007199254740991 && __n33 >= -9007199254740991)) __termIntStop(__n33); used = __n33
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
          const __n34 = used + wide; if (!(__n34 <= 9007199254740991 && __n34 >= -9007199254740991)) __termIntStop(__n34); used = __n34
        }
      } else {
        const __n35 = parts.length - 1; if (!(__n35 <= 9007199254740991 && __n35 >= -9007199254740991)) __termIntStop(__n35); at = __n35
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
    const __n36 = row + 1; if (!(__n36 <= 9007199254740991 && __n36 >= -9007199254740991)) __termIntStop(__n36); row = __n36
  }
  return out
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
  const __n37 = __termInt(width + layout.fieldGap) + measureSpans(value); if (!(__n37 <= 9007199254740991 && __n37 >= -9007199254740991)) __termIntStop(__n37); const beside: number = __n37
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
  const __n38 = room.width - hang; if (!(__n38 <= 9007199254740991 && __n38 >= -9007199254740991)) __termIntStop(__n38); const cells: number = __n38
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
      const __n39 = stop - column % stop; if (!(__n39 <= 9007199254740991 && __n39 >= -9007199254740991)) __termIntStop(__n39); const gap: number = __n39
      out = `${out}${makeSpaces(gap)}`
      const __n40 = column + gap; if (!(__n40 <= 9007199254740991 && __n40 >= -9007199254740991)) __termIntStop(__n40); column = __n40
    } else {
      out = `${out}${grain.value}`
      const __n41 = column + grain.wide; if (!(__n41 <= 9007199254740991 && __n41 >= -9007199254740991)) __termIntStop(__n41); column = __n41
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
    const __n42 = at + 1; if (!(__n42 <= 9007199254740991 && __n42 >= -9007199254740991)) __termIntStop(__n42); at = __n42
  }
  const start: number = measureText(expandTabs(before, tabWidth))
  const whole: number = measureText(expandTabs(`${before}${inside}`, tabWidth))
  const __n43 = whole - start; if (!(__n43 <= 9007199254740991 && __n43 >= -9007199254740991)) __termIntStop(__n43); let wide: number = __n43
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
  const __n44 = digits + 2; if (!(__n44 <= 9007199254740991 && __n44 >= -9007199254740991)) __termIntStop(__n44); const gutterWide: number = __n44
  const __n45 = room.width - __termInt(gutterWide + 1); if (!(__n45 <= 9007199254740991 && __n45 >= -9007199254740991)) __termIntStop(__n45); const cells: number = __n45
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

export function isStackFrame(value: string, room: Room): boolean {
  return startsWith(__termText.trim(value), room.standard.quotes.frameStart)
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
      const __n46 = frames + 1; if (!(__n46 <= 9007199254740991 && __n46 >= -9007199254740991)) __termIntStop(__n46); frames = __n46
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
          const __n47 = more + 1; if (!(__n47 <= 9007199254740991 && __n47 >= -9007199254740991)) __termIntStop(__n47); more = __n47
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
    const __n48 = kept.length - limit; if (!(__n48 <= 9007199254740991 && __n48 >= -9007199254740991)) __termIntStop(__n48); const cut: number = __n48
    const __n49 = before + cut; if (!(__n49 <= 9007199254740991 && __n49 >= -9007199254740991)) __termIntStop(__n49); before = __n49
    const last: string[] = ([] as string[])
    let at: number = 0
    for (const one of kept) {
      if (at >= cut) {
        last.push(one)
      }
      const __n50 = at + 1; if (!(__n50 <= 9007199254740991 && __n50 >= -9007199254740991)) __termIntStop(__n50); at = __n50
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
  const __n51 = room.width - indent; if (!(__n51 <= 9007199254740991 && __n51 >= -9007199254740991)) __termIntStop(__n51); const cells: number = __n51
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
  const __n52 = indent - measureText(elbow); if (!(__n52 <= 9007199254740991 && __n52 >= -9007199254740991)) __termIntStop(__n52); let rest: number = __n52
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
  const __n53 = cells - filled; if (!(__n53 <= 9007199254740991 && __n53 >= -9007199254740991)) __termIntStop(__n53); const empty: number = __n53
  if (empty > 0) {
    spans.push(makeSpan(repeatText(findSymbol(room, "bar-empty"), empty), "faint"))
  }
  out.push({ spans: spans })
  return out
}
