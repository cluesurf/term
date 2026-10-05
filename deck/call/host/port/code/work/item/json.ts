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
  const __n0 = 0 - Math.trunc(__termInt(__termInt(flipped * 2) + 1) / 2); if (!(__n0 <= 9007199254740991 && __n0 >= -9007199254740991)) __termIntStop(__n0); return __n0
}

export function divideWhole(top: number, bottom: number): number {
  if (bottom <= 0) {
    return 0
  }
  return Math.trunc(top / bottom)
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

export function spansText(spans: Span[]): string {
  let out: string = ""
  for (const one of spans) {
    out = `${out}${one.value}`
  }
  return out
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
  const __n1 = instant + minutes * 60000; if (!(__n1 <= 9007199254740991 && __n1 >= -9007199254740991)) __termIntStop(__n1); return __n1
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

export interface CivilDate {
  year: number
  month: number
  day: number
}

export function makeCivilDate(days: number): CivilDate {
  const __n2 = days + 719468; if (!(__n2 <= 9007199254740991 && __n2 >= -9007199254740991)) __termIntStop(__n2); const z: number = __n2
  let era: number = divideWhole(z, 146097)
  if (z < 0) {
    era = divideWhole(__termInt(z - 146096), 146097)
  }
  const __n3 = z - __termInt(era * 146097); if (!(__n3 <= 9007199254740991 && __n3 >= -9007199254740991)) __termIntStop(__n3); const doe: number = __n3
  const yoe: number = divideWhole(__termInt(__termInt(__termInt(doe + divideWhole(doe, 36524)) - divideWhole(doe, 1460)) - divideWhole(doe, 146096)), 365)
  const __n4 = yoe + __termInt(era * 400); if (!(__n4 <= 9007199254740991 && __n4 >= -9007199254740991)) __termIntStop(__n4); let y: number = __n4
  const __n5 = doe - __termInt(__termInt(__termInt(365 * yoe) + divideWhole(yoe, 4)) - divideWhole(yoe, 100)); if (!(__n5 <= 9007199254740991 && __n5 >= -9007199254740991)) __termIntStop(__n5); const doy: number = __n5
  const mp: number = divideWhole(__termInt(__termInt(5 * doy) + 2), 153)
  const __n6 = __termInt(doy - divideWhole(__termInt(__termInt(153 * mp) + 2), 5)) + 1; if (!(__n6 <= 9007199254740991 && __n6 >= -9007199254740991)) __termIntStop(__n6); const d: number = __n6
  const __n7 = mp + 3; if (!(__n7 <= 9007199254740991 && __n7 >= -9007199254740991)) __termIntStop(__n7); let m: number = __n7
  if (m > 12) {
    const __n8 = m - 12; if (!(__n8 <= 9007199254740991 && __n8 >= -9007199254740991)) __termIntStop(__n8); m = __n8
  }
  if (m <= 2) {
    const __n9 = y + 1; if (!(__n9 <= 9007199254740991 && __n9 >= -9007199254740991)) __termIntStop(__n9); y = __n9
  }
  return { year: y, month: m, day: d }
}

export function formatDate(epoch: number, offset: number): string {
  const local: number = shiftClock(epoch, offset)
  const days: number = divideWhole(__termInt(local - moduloFloor(local, 86400000)), 86400000)
  const one: CivilDate = makeCivilDate(days)
  const y: string = padDigits(one.year, 4)
  const m: string = padDigits(one.month, 2)
  const d: string = padDigits(one.day, 2)
  return `${y}-${m}-${d}`
}

export function formatOffset(offset: number, utc: boolean): string {
  if (utc) {
    return "Z"
  }
  let sign: string = "+"
  let size: number = makeWhole(offset)
  if (size < 0) {
    sign = "-"
    const __n10 = 0 - size; if (!(__n10 <= 9007199254740991 && __n10 >= -9007199254740991)) __termIntStop(__n10); size = __n10
  }
  const h: string = padDigits(divideWhole(size, 60), 2)
  const m: string = padDigits(size % 60, 2)
  return `${sign}${h}:${m}`
}

export function formatInstant(epoch: number, offset: number, utc: boolean): string {
  let shift: number = offset
  if (utc) {
    shift = 0
  }
  const date: string = formatDate(epoch, shift)
  const clock: string = formatClock(epoch, shift)
  const zone: string = formatOffset(shift, utc)
  return `${date}T${clock}${zone}`
}

export interface Piece {
  value: string
  wide: number
  owner: number
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

export function noteEvent(one: Session, event: Event, standard: Standard): Session {
  const next: Session = { ...one }
  const rank: number = rankGlyph(standard, event.glyph)
  if (rank > one.worst) {
    next.worst = rank
    next.worstGlyph = event.glyph
  }
  return next
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

export function makeJsonKey(noun: string): string {
  let out: string = ""
  for (const rune of Array.from(noun, function (rune) { return rune.codePointAt(0) ?? 0 })) {
    if (rune === 32 || rune === 45) {
      out = `${out}_`
    } else {
      out = `${out}${String.fromCodePoint(rune)}`
    }
  }
  return out
}

export function pushPair(parts: string[], key: string, value: string): string[] {
  parts.push(`${writeJsonText(key)}:${value}`)
  return parts
}

export function joinParts(parts: string[], open: string, close: string): string {
  let out: string = open
  let at: number = 0
  for (const one of parts) {
    if (at > 0) {
      out = `${out},`
    }
    out = `${out}${one}`
    const __n11 = at + 1; if (!(__n11 <= 9007199254740991 && __n11 >= -9007199254740991)) __termIntStop(__n11); at = __n11
  }
  return `${out}${close}`
}

export function writeJsonStatus(one: Status, standard: Standard): string {
  if (one.kind === "http") {
    return `${makeWhole(one.value)}`
  }
  if (one.kind === "exit") {
    const label: string = standard.facts.exitLabel
    return writeJsonText(`${label} ${makeWhole(one.value)}`)
  }
  const label: string = standard.facts.signalLabel
  return writeJsonText(`${label} ${one.name}`)
}

export function writeJsonEvent(one: Event, offset: number, utc: boolean, standard: Standard): string {
  const keys: KeyRule = standard.keys
  let parts: string[] = ([] as string[])
  parts = pushPair(parts, keys.glyph, writeJsonText(one.glyph))
  parts = pushPair(parts, keys.verb, writeJsonText(one.verb))
  parts = pushPair(parts, keys.subject, writeJsonText(spansText(one.subject)))
  if (one.source !== "") {
    parts = pushPair(parts, keys.source, writeJsonText(one.source))
  }
  if (one.clock >= 0) {
    const time: string = writeJsonText(formatInstant(one.clock, offset, utc))
    parts = pushPair(parts, keys.time, time)
  }
  if (one.duration >= 0) {
    parts = pushPair(parts, keys.milliseconds, `${makeWhole(one.duration)}`)
  }
  if (one.status.kind !== "") {
    parts = pushPair(parts, keys.status, writeJsonStatus(one.status, standard))
  }
  if (one.bytes >= 0) {
    parts = pushPair(parts, keys.bytes, `${makeWhole(one.bytes)}`)
  }
  if (one.tallies.length > 0) {
    let counts: string[] = ([] as string[])
    for (const each of one.tallies) {
      const key: string = makeJsonKey(each.noun)
      counts = pushPair(counts, key, `${makeWhole(each.amount)}`)
      if (each.total >= 0) {
        counts = pushPair(counts, `${key}_total`, `${makeWhole(each.total)}`)
      }
    }
    parts = pushPair(parts, keys.counts, joinParts(counts, "{", "}"))
  }
  const rest: string[] = ([] as string[])
  for (const each of one.tool) {
    rest.push(writeJsonText(each))
  }
  if (one.zone !== "") {
    rest.push(writeJsonText(one.zone))
  }
  for (const each of one.facts) {
    rest.push(writeJsonText(each))
  }
  if (one.repeat > 1) {
    rest.push(writeJsonText(`×${makeWhole(one.repeat)}`))
  }
  if (rest.length > 0) {
    parts = pushPair(parts, keys.facts, joinParts(rest, "[", "]"))
  }
  if (one.message.length > 0) {
    let joined: string = ""
    let at: number = 0
    for (const each of one.message) {
      if (at > 0) {
        joined = `${joined}
`
      }
      joined = `${joined}${each}`
      const __n12 = at + 1; if (!(__n12 <= 9007199254740991 && __n12 >= -9007199254740991)) __termIntStop(__n12); at = __n12
    }
    parts = pushPair(parts, keys.message, writeJsonText(joined))
  }
  let fields: string[] = ([] as string[])
  for (const each of one.fields) {
    fields = pushPair(fields, each.key, writeJsonText(spansText(each.value)))
  }
  if (one.budget >= 0 && (one.duration >= 0 && one.duration > one.budget)) {
    fields = pushPair(fields, standard.fields.budgetKey, `${makeWhole(one.budget)}`)
  }
  if (one.quoteLog !== "") {
    fields = pushPair(fields, standard.fields.logKey, writeJsonText(one.quoteLog))
  }
  if (fields.length > 0) {
    parts = pushPair(parts, keys.fields, joinParts(fields, "{", "}"))
  }
  parts = pushPair(parts, keys.kind, writeJsonText(one.kind))
  return joinParts(parts, "{", "}")
}

export function writeJsonRun(opening: Event, events: Event[], closing: Event, options: RunOptions, standard: Standard, offset: number): string[] {
  const out: string[] = ([] as string[])
  let one: Session = { options: options, verb: opening.verb, opened: false, owed: false, printed: 0, worst: 0, worstGlyph: "info", failure: "" }
  out.push(writeJsonEvent(opening, offset, options.utc, standard))
  for (const event of events) {
    one = noteEvent(one, event, standard)
    out.push(writeJsonEvent(event, offset, options.utc, standard))
  }
  out.push(writeJsonEvent(closeEvent(one, closing, standard), offset, options.utc, standard))
  return out
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

export function failJson(at: number): JsonRead {
  return { node: __termVariantJsonNull, at: at, failed: true }
}

export function readJsonString(runes: number[], at: number): JsonRead {
  const __n13 = at + 1; if (!(__n13 <= 9007199254740991 && __n13 >= -9007199254740991)) __termIntStop(__n13); let here: number = __n13
  let out: string = ""
  while (here < runes.length) {
    const rune: number = (here >= 0 && here < runes.length ? runes[here]! : __termReadPast(runes, here))
    if (rune === 34) {
      return { node: { kind: "json-text", value: out }, at: __termInt(here + 1), failed: false }
    }
    if (rune === 92) {
      const __n14 = here + 1; if (!(__n14 <= 9007199254740991 && __n14 >= -9007199254740991)) __termIntStop(__n14); const next: number = __n14
      if (next >= runes.length) {
        return { node: __termVariantJsonNull, at: here, failed: true }
      }
      const escaped: number = (next >= 0 && next < runes.length ? runes[next]! : __termReadPast(runes, next))
      const __n15 = next + 1; if (!(__n15 <= 9007199254740991 && __n15 >= -9007199254740991)) __termIntStop(__n15); here = __n15
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
          const __n16 = __termInt(code * 16) + digit; if (!(__n16 <= 9007199254740991 && __n16 >= -9007199254740991)) __termIntStop(__n16); code = __n16
          const __n17 = here + 1; if (!(__n17 <= 9007199254740991 && __n17 >= -9007199254740991)) __termIntStop(__n17); here = __n17
          count = count + 1
        }
        out = `${out}${String.fromCodePoint(code)}`
        continue
      }
      out = `${out}${String.fromCodePoint(escaped)}`
      continue
    }
    out = `${out}${String.fromCodePoint(rune)}`
    const __n18 = here + 1; if (!(__n18 <= 9007199254740991 && __n18 >= -9007199254740991)) __termIntStop(__n18); here = __n18
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
    const __n19 = here + 1; if (!(__n19 <= 9007199254740991 && __n19 >= -9007199254740991)) __termIntStop(__n19); here = __n19
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
    const __n20 = here + 1; if (!(__n20 <= 9007199254740991 && __n20 >= -9007199254740991)) __termIntStop(__n20); here = __n20
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
    const __n21 = here + 1; if (!(__n21 <= 9007199254740991 && __n21 >= -9007199254740991)) __termIntStop(__n21); here = __n21
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
      const __n22 = at + 1; if (!(__n22 <= 9007199254740991 && __n22 >= -9007199254740991)) __termIntStop(__n22); at = __n22
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
