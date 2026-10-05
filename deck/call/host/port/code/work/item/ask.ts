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

export interface Question {
  kind: string
  label: string
  flag: string
  default: string
  choices: Choice[]
  focus: number
  typed: string
  answered: boolean
  answer: string
}

export function pickedValues(one: Question): string {
  let out: string = ""
  for (const each of one.choices) {
    if (each.picked) {
      let value: string = each.value
      if (value === "") {
        value = each.label
      }
      if (out === "") {
        out = value
      } else {
        out = `${out},${value}`
      }
    }
  }
  return out
}

export function shownAnswer(one: Question, standard: Standard): string {
  if (one.kind === "pick" || one.kind === "pick-many") {
    let out: string = ""
    for (const each of one.choices) {
      if (each.picked) {
        if (out === "") {
          out = each.label
        } else {
          out = `${out}, ${each.label}`
        }
      }
    }
    return out
  }
  return one.answer
}

export function pressKey(one: Question, key: string, standard: Standard): Question {
  const next: Question = { ...one }
  if (one.answered) {
    return next
  }
  const count: number = one.choices.length
  const picking: boolean = one.kind === "pick" || one.kind === "pick-many"
  if (picking && key === "up") {
    if (one.focus > 0) {
      next.focus = __termInt(one.focus - 1)
    }
    return focusChoices(next)
  }
  if (picking && key === "down") {
    if (one.focus < __termInt(count - 1)) {
      next.focus = __termInt(one.focus + 1)
    }
    return focusChoices(next)
  }
  if (one.kind === "pick-many" && key === "space") {
    const toggled: Choice[] = ([] as Choice[])
    let at: number = 0
    for (const each of one.choices) {
      const copy: Choice = { ...each }
      if (at === one.focus) {
        copy.picked = !each.picked
      }
      toggled.push(copy)
      const __n0 = at + 1; if (!(__n0 <= 9007199254740991 && __n0 >= -9007199254740991)) __termIntStop(__n0); at = __n0
    }
    next.choices = toggled
    return next
  }
  if (key === "enter") {
    next.answered = true
    if (one.kind === "pick") {
      const chosen: Choice[] = ([] as Choice[])
      let at: number = 0
      for (const each of one.choices) {
        const copy: Choice = { ...each }
        copy.picked = at === one.focus
        chosen.push(copy)
        const __n1 = at + 1; if (!(__n1 <= 9007199254740991 && __n1 >= -9007199254740991)) __termIntStop(__n1); at = __n1
      }
      next.choices = chosen
      next.answer = pickedValues(next)
      return next
    }
    if (one.kind === "pick-many") {
      next.answer = pickedValues(next)
      return next
    }
    if (one.kind === "confirm") {
      next.answer = readConfirm(one.typed, one.default, standard)
      return next
    }
    next.answer = one.typed
    if (one.typed === "") {
      next.answer = one.default
    }
    return next
  }
  if (key === "backspace") {
    const runes: number[] = Array.from(one.typed, function (rune) { return rune.codePointAt(0) ?? 0 })
    let kept: string = ""
    let at: number = 0
    const __n2 = runes.length - 1; if (!(__n2 <= 9007199254740991 && __n2 >= -9007199254740991)) __termIntStop(__n2); const last: number = __n2
    for (const rune of runes) {
      if (at < last) {
        kept = `${kept}${String.fromCodePoint(rune)}`
      }
      const __n3 = at + 1; if (!(__n3 <= 9007199254740991 && __n3 >= -9007199254740991)) __termIntStop(__n3); at = __n3
    }
    next.typed = kept
    return next
  }
  if (key === "up" || (key === "down" || key === "space")) {
    if (picking) {
      return next
    }
  }
  if (picking) {
    return next
  }
  next.typed = `${one.typed}${key}`
  return next
}

export function focusChoices(one: Question): Question {
  const next: Question = { ...one }
  const moved: Choice[] = ([] as Choice[])
  let at: number = 0
  for (const each of one.choices) {
    const copy: Choice = { ...each }
    copy.focused = at === one.focus
    moved.push(copy)
    const __n4 = at + 1; if (!(__n4 <= 9007199254740991 && __n4 >= -9007199254740991)) __termIntStop(__n4); at = __n4
  }
  next.choices = moved
  return next
}

export function readConfirm(typed: string, default_: string, standard: Standard): string {
  const rule: AskRule = standard.asks
  if (typed === "y" || (typed === "Y" || typed === rule.yesWord)) {
    return rule.yesWord
  }
  if (typed === "n" || (typed === "N" || typed === rule.noWord)) {
    return rule.noWord
  }
  if (default_ === "") {
    return rule.noWord
  }
  return default_
}

export function questionHint(one: Question, standard: Standard): string {
  const rule: AskRule = standard.asks
  if (one.kind === "confirm") {
    if (one.default === rule.yesWord) {
      return rule.confirmYes
    }
    return rule.confirmNo
  }
  if (one.kind === "pick-many") {
    return rule.manyHint
  }
  if (one.kind === "pick") {
    return rule.oneHint
  }
  return one.default
}

export function questionEvent(one: Question, clock: number, standard: Standard): Event {
  const rule: AskRule = standard.asks
  const item: Event = { kind: "question", verb: rule.verb, subject: plainSubject(one.label), clock: clock, glyph: "info", source: "", tool: ([] as string[]), zone: "", duration: -1, uptime: false, budget: -1, status: { kind: "", value: 0, name: "" }, bytes: -1, tallies: ([] as Tally[]), facts: ([] as string[]), message: ([] as string[]), fields: ([] as ItemField[]), frames: ([] as Frame[]), quote: ([] as string[]), quoteEarlier: 0, quoteLog: "", done: -1, total: -1, choices: ([] as Choice[]), asking: false, typed: "", secret: false, columns: ([] as Column[]), rows: ([] as TableRow[]), nodes: ([] as TreeNode[]), entries: ([] as ListEntry[]), entryTotal: -1, level: "", verdict: false, place: { path: "", line: 0, column: 0 }, id: "", cause: "", repeat: 0 }
  if (one.answered) {
    item.glyph = "done"
    let shown: string = shownAnswer(one, standard)
    if (one.kind === "secret") {
      shown = ""
    }
    if (shown !== "") {
      item.facts.push(shown)
    }
    return item
  }
  item.glyph = "asking"
  const hint: string = questionHint(one, standard)
  if (hint !== "") {
    item.facts.push(hint)
  }
  if (one.kind === "pick" || one.kind === "pick-many") {
    const focused: Question = focusChoices(one)
    item.choices = focused.choices
    return item
  }
  item.asking = true
  item.typed = one.typed
  item.secret = one.kind === "secret"
  return item
}

export function answerAll(questions: Question[], standard: Standard): Question[] {
  const out: Question[] = ([] as Question[])
  for (const one of questions) {
    const next: Question = { ...one }
    if (one.answered) {} else {
      next.answered = true
      next.answer = one.default
      if (one.kind === "pick" || one.kind === "pick-many") {
        next.answer = pickedValues(one)
      }
      if (one.kind === "confirm" && one.default === "") {
        next.answer = standard.asks.noWord
      }
    }
    out.push(next)
  }
  return out
}

export function passCommand(command: string, questions: Question[], standard: Standard): string {
  let out: string = command
  let yes: boolean = false
  for (const one of questions) {
    if (one.flag === "") {
      yes = true
      continue
    }
    let value: string = one.answer
    if (!one.answered) {
      value = one.default
      if (one.kind === "pick" || one.kind === "pick-many") {
        value = pickedValues(one)
      }
    }
    if (value === "") {
      value = `<${one.label}>`
    }
    out = `${out} ${one.flag} ${value}`
  }
  if (yes) {
    out = `${out} ${standard.asks.yesFlag}`
  }
  return out
}

export function failWithoutTerminal(verb: string, command: string, questions: Question[], clock: number, standard: Standard): Event {
  const words: string = standard.asks.noTerminal
  const item: Event = { glyph: "failed", kind: "question", verb: verb, clock: clock, subject: ([] as Span[]), source: "", tool: ([] as string[]), zone: "", duration: -1, uptime: false, budget: -1, status: { kind: "", value: 0, name: "" }, bytes: -1, tallies: ([] as Tally[]), facts: ([] as string[]), message: ([] as string[]), fields: ([] as ItemField[]), frames: ([] as Frame[]), quote: ([] as string[]), quoteEarlier: 0, quoteLog: "", done: -1, total: -1, choices: ([] as Choice[]), asking: false, typed: "", secret: false, columns: ([] as Column[]), rows: ([] as TableRow[]), nodes: ([] as TreeNode[]), entries: ([] as ListEntry[]), entryTotal: -1, level: "", verdict: false, place: { path: "", line: 0, column: 0 }, id: "", cause: "", repeat: 0 }
  item.subject = plainSubject(`${command} ${words}`)
  item.fields.push(plainField(standard.fields.passKey, passCommand(command, questions, standard)))
  return item
}
