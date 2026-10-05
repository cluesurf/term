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

export function makeWhole(value: number): number {
  if (value !== value) {
    return 0
  }
  const limit: number = 9007199254740991
  if (value > limit) {
    return limit
  }
  const __n7 = 0 - limit; if (!(__n7 <= 9007199254740991 && __n7 >= -9007199254740991)) __termIntStop(__n7); const least: number = __n7
  if (value < least) {
    return least
  }
  if (value >= 4503599627370496 || value <= -4503599627370496) {
    return value
  }
  if (value >= 0) {
    const __n8 = Math.trunc(__termInt(__termInt(value * 2) + 1) / 2); if (!(__n8 <= 9007199254740991 && __n8 >= -9007199254740991)) __termIntStop(__n8); return __n8
  }
  const __n9 = 0 - value; if (!(__n9 <= 9007199254740991 && __n9 >= -9007199254740991)) __termIntStop(__n9); const flipped: number = __n9
  const __n10 = 0 - __termInt(Math.trunc(__termInt(__termInt(flipped * 2) + 1) / 2)); if (!(__n10 <= 9007199254740991 && __n10 >= -9007199254740991)) __termIntStop(__n10); return __n10
}

export function groupNumber(value: number, standard: Standard): string {
  let whole: number = makeWhole(value)
  let sign: string = ""
  if (whole < 0) {
    sign = "-"
    const __n11 = 0 - whole; if (!(__n11 <= 9007199254740991 && __n11 >= -9007199254740991)) __termIntStop(__n11); whole = __n11
  }
  const digits: string = `${whole}`
  const runes: number[] = Array.from(digits, function (rune) { return rune.codePointAt(0) ?? 0 })
  const count: number = runes.length
  const every: number = standard.numbers.groupDigits
  const mark: string = standard.numbers.group
  let out: string = ""
  let at: number = 0
  for (const rune of runes) {
    const __n12 = count - at; if (!(__n12 <= 9007199254740991 && __n12 >= -9007199254740991)) __termIntStop(__n12); const left: number = __n12
    if (at > 0 && (every > 0 && __termInt(left % every) === 0)) {
      out = `${out}${mark}`
    }
    out = `${out}${String.fromCodePoint(rune)}`
    const __n13 = at + 1; if (!(__n13 <= 9007199254740991 && __n13 >= -9007199254740991)) __termIntStop(__n13); at = __n13
  }
  return `${sign}${out}`
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
      const __n14 = digits + 1; if (!(__n14 <= 9007199254740991 && __n14 >= -9007199254740991)) __termIntStop(__n14); digits = __n14
    }
    const __n15 = at + 1; if (!(__n15 <= 9007199254740991 && __n15 >= -9007199254740991)) __termIntStop(__n15); at = __n15
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
    const __n16 = at + 1; if (!(__n16 <= 9007199254740991 && __n16 >= -9007199254740991)) __termIntStop(__n16); at = __n16
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

export function measureSpans(spans: Span[]): number {
  let total: number = 0
  for (const one of spans) {
    const __n17 = total + measureText(one.value); if (!(__n17 <= 9007199254740991 && __n17 >= -9007199254740991)) __termIntStop(__n17); total = __n17
  }
  return total
}

export function cropSpans(spans: Span[], width: number, room: Room): Span[] {
  if (measureSpans(spans) <= width) {
    return spans
  }
  const more: string = findSymbol(room, "more")
  const __n18 = width - measureText(more); if (!(__n18 <= 9007199254740991 && __n18 >= -9007199254740991)) __termIntStop(__n18); const limit: number = __n18
  const out: Span[] = ([] as Span[])
  let used: number = 0
  let role: string = "text"
  for (const one of spans) {
    let kept: string = ""
    let full: boolean = true
    for (const grain of makeGrains(one.value)) {
      if (__termInt(used + grain.wide) <= limit) {
        kept = `${kept}${grain.value}`
        const __n19 = used + grain.wide; if (!(__n19 <= 9007199254740991 && __n19 >= -9007199254740991)) __termIntStop(__n19); used = __n19
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
    const __n20 = at + 1; if (!(__n20 <= 9007199254740991 && __n20 >= -9007199254740991)) __termIntStop(__n20); at = __n20
  }
  let kept: number = 0
  let used: number = 0
  at = 0
  for (const wide of widths) {
    let need: number = wide
    if (at > 0) {
      const __n21 = wide + gap; if (!(__n21 <= 9007199254740991 && __n21 >= -9007199254740991)) __termIntStop(__n21); need = __n21
    }
    if (at === 0 || __termInt(used + need) <= room.width) {
      if (kept === at) {
        const __n22 = used + need; if (!(__n22 <= 9007199254740991 && __n22 >= -9007199254740991)) __termIntStop(__n22); used = __n22
        const __n23 = kept + 1; if (!(__n23 <= 9007199254740991 && __n23 >= -9007199254740991)) __termIntStop(__n23); kept = __n23
      }
    }
    const __n24 = at + 1; if (!(__n24 <= 9007199254740991 && __n24 >= -9007199254740991)) __termIntStop(__n24); at = __n24
  }
  const __n25 = columns.length - kept; if (!(__n25 <= 9007199254740991 && __n25 >= -9007199254740991)) __termIntStop(__n25); const dropped: number = __n25
  let header: Span[] = ([] as Span[])
  at = 0
  for (const one of columns) {
    if (at < kept) {
      const title: Span[] = ([] as Span[])
      title.push(makeSpan(glueUnits(neutralize(one.title, room.standard, room.ascii), room.standard), "dim"))
      const last: boolean = at === kept - 1
      header = pushEntry(header, title, (at >= 0 && at < widths.length ? widths[at]! : __termReadPast(widths, at)), one.numeric, last, gap)
    }
    const __n26 = at + 1; if (!(__n26 <= 9007199254740991 && __n26 >= -9007199254740991)) __termIntStop(__n26); at = __n26
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
      const __n27 = at + 1; if (!(__n27 <= 9007199254740991 && __n27 >= -9007199254740991)) __termIntStop(__n27); at = __n27
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
  const __n28 = width - wide; if (!(__n28 <= 9007199254740991 && __n28 >= -9007199254740991)) __termIntStop(__n28); let pad: number = __n28
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
    const __n29 = at + 1; if (!(__n29 <= 9007199254740991 && __n29 >= -9007199254740991)) __termIntStop(__n29); at = __n29
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
    const __n30 = at + 1; if (!(__n30 <= 9007199254740991 && __n30 >= -9007199254740991)) __termIntStop(__n30); at = __n30
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
        const __n31 = __termInt(widest - measureText(label)) + gap; if (!(__n31 <= 9007199254740991 && __n31 >= -9007199254740991)) __termIntStop(__n31); const pad: number = __n31
        spans.push(makeSpan(`${label}${makeSpaces(pad)}`, "text"))
        spans.push({ value: detail, role: "dim", strong: false, href: "", focus: false })
      }
      out.push({ spans: cropSpans(spans, room.width, room) })
    }
    const __n32 = at + 1; if (!(__n32 <= 9007199254740991 && __n32 >= -9007199254740991)) __termIntStop(__n32); at = __n32
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

export function drawRule(room: Room): Line[] {
  const out: Line[] = ([] as Line[])
  const spans: Span[] = ([] as Span[])
  spans.push(makeSpan(repeatText(findSymbol(room, "rule"), room.width), "faint"))
  out.push({ spans: spans })
  return out
}
