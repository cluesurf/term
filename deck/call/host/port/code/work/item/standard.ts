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

export function makeStandard(): Standard {
  return { layout: { verbColumn: 2, verbWidth: 7, bodyColumn: 11, hang: 2, leastWidth: 40, tagGap: 2, keyGap: 2, fieldGap: 1, alignKeys: false, chainLinks: 4, tabStop: 8 }, glyphs: [{ name: "done", unicode: "✓", ascii: "v", role: "done", rank: 4 }, { name: "failed", unicode: "✗", ascii: "x", role: "failed", rank: 7 }, { name: "warning", unicode: "▲", ascii: "!", role: "warning", rank: 6 }, { name: "info", unicode: "·", ascii: "-", role: "dim", rank: 2 }, { name: "skipped", unicode: "○", ascii: "o", role: "dim", rank: 3 }, { name: "running", unicode: "◐", ascii: "*", role: "active", rank: 5 }, { name: "asking", unicode: "?", ascii: "?", role: "active", rank: 5 }, { name: "added", unicode: "+", ascii: "+", role: "done", rank: 0 }, { name: "removed", unicode: "−", ascii: "-", role: "failed", rank: 0 }, { name: "changed", unicode: "~", ascii: "~", role: "warning", rank: 0 }], roles: [{ name: "text", dark: "#E6E6E1", light: "#1C1E20", ansi: "" }, { name: "dim", dark: "#8A8F95", light: "#6B6F75", ansi: "90" }, { name: "faint", dark: "#3A3F44", light: "#CFD1D4", ansi: "2;90" }, { name: "done", dark: "#8FCB9B", light: "#2E7D45", ansi: "32" }, { name: "failed", dark: "#F08C8C", light: "#B93A3A", ansi: "31" }, { name: "warning", dark: "#E8C77A", light: "#8A5A00", ansi: "33" }, { name: "active", dark: "#8FB8E8", light: "#2F5FA8", ansi: "34" }, { name: "source", dark: "#8FB3D9", light: "#3D6797", ansi: "36" }, { name: "focus", dark: "#1D2630", light: "#DCE6F1", ansi: "7" }], symbols: [{ name: "separator", unicode: "·", ascii: "." }, { name: "chain", unicode: "›", ascii: ">" }, { name: "arrow", unicode: "→", ascii: "->" }, { name: "more", unicode: "…", ascii: "..." }, { name: "gutter", unicode: "│", ascii: "|" }, { name: "elbow", unicode: "⎿", ascii: "\\_" }, { name: "primary", unicode: "━", ascii: "~" }, { name: "secondary", unicode: "─", ascii: "-" }, { name: "skip", unicode: "⋮", ascii: ":" }, { name: "rule", unicode: "─", ascii: "-" }, { name: "bar-full", unicode: "━", ascii: "-" }, { name: "bar-empty", unicode: "─", ascii: " " }, { name: "picked", unicode: "◉", ascii: "(*)" }, { name: "unpicked", unicode: "◯", ascii: "( )" }, { name: "secret", unicode: "•", ascii: "*" }, { name: "prompt", unicode: "❯", ascii: "$" }, { name: "times", unicode: "×", ascii: "x" }, { name: "minus", unicode: "−", ascii: "-" }, { name: "branch", unicode: "├─", ascii: "|-" }, { name: "last", unicode: "└─", ascii: "`-" }, { name: "stem", unicode: "│ ", ascii: "| " }, { name: "spin-1", unicode: "◐", ascii: "*" }, { name: "spin-2", unicode: "◓", ascii: "*" }, { name: "spin-3", unicode: "◑", ascii: "*" }, { name: "spin-4", unicode: "◒", ascii: "*" }], folds: [{ name: "arrow", unicode: "→", ascii: "->" }, { name: "chain", unicode: "›", ascii: ">" }, { name: "more", unicode: "…", ascii: "..." }, { name: "separator", unicode: "·", ascii: "." }, { name: "minus", unicode: "−", ascii: "-" }, { name: "en-dash", unicode: "–", ascii: "-" }, { name: "em-dash", unicode: "—", ascii: "--" }, { name: "left-quote", unicode: "‘", ascii: "'" }, { name: "right-quote", unicode: "’", ascii: "'" }, { name: "left-double", unicode: "“", ascii: "\"" }, { name: "right-double", unicode: "”", ascii: "\"" }, { name: "times", unicode: "×", ascii: "x" }, { name: "bullet", unicode: "•", ascii: "*" }, { name: "done", unicode: "✓", ascii: "v" }, { name: "failed", unicode: "✗", ascii: "x" }, { name: "warning", unicode: "▲", ascii: "!" }, { name: "skipped", unicode: "○", ascii: "o" }, { name: "running", unicode: "◐", ascii: "*" }, { name: "gutter", unicode: "│", ascii: "|" }, { name: "elbow", unicode: "⎿", ascii: "\\_" }], durations: { figures: 3, millisecondUnit: "ms", secondUnit: "s", minuteUnit: "m", hourUnit: "h", uptimeWord: "up" }, sizes: { step: 1000, units: ["B", "kB", "MB", "GB", "TB", "PB"], wholeFrom: 100, decimals: 1 }, numbers: { group: ",", groupDigits: 3, part: "/" }, facts: { order: ["clock", "tool", "zone", "duration", "status", "size", "counts", "rest"], httpLabel: "HTTP", exitLabel: "exit", signalLabel: "signal", clockFrom: 1000, clockKinds: ["lifecycle", "request", "job", "query", "health", "date"] }, wraps: { tiers: ["/?&", ":.=-"], never: "://", locationTiers: ["/", ":"] }, fields: { locationKey: "at", actionKeys: ["fix", "next", "pass"], standardKeys: ["at", "why", "want", "seen", "gave", "fix", "next", "reason", "via", "wait", "budget", "log", "pass"], budgetKey: "budget", passKey: "pass", logKey: "log", nextKey: "next", sourcesKey: "sources" }, frames: { context: 2, tabWidth: 8 }, quotes: { lines: 20, earlierWord: "earlier lines", framesWord: "more frames", frameStart: "at ", foreign: ["node_modules/", "node:", "internal/", "<anonymous>"], indent: 3 }, bars: { width: 24 }, lives: { redrawMs: 100, quietProgressMs: 10000 }, services: { tagWidth: 12, collapseMs: 10000, dateVerb: "date", footerVerb: "up" }, caps: { problems: 20, entries: 10, allFlag: "--all", moreProblemsWord: "more problems", hiddenWord: "hidden", moreWord: "more", listsWord: "lists them", droppedWord: "more columns", dedupedWord: "deduped" }, exits: [{ value: 0, name: "success", glyph: "done" }, { value: 1, name: "input", glyph: "failed" }, { value: 2, name: "usage", glyph: "failed" }, { value: 3, name: "environment", glyph: "failed" }, { value: 70, name: "bug", glyph: "failed" }, { value: 130, name: "interrupted", glyph: "skipped" }], environment: { noColor: "NO_COLOR", forceColor: "FORCE_COLOR", colorTerm: "COLORTERM", truecolorValues: ["truecolor", "24bit"], forceOffValues: ["0", "false"], terminal: "TERM", dumb: "dumb", ci: "CI", localeNames: ["LC_ALL", "LC_CTYPE", "LANG"], utfMarkers: ["utf-8", "utf8"], forceHyperlink: "FORCE_HYPERLINK", hyperlinkPrograms: ["iTerm.app", "WezTerm", "vscode", "ghostty", "Hyper", "Tabby"], hyperlinkVariables: ["WT_SESSION", "KITTY_WINDOW_ID", "KONSOLE_VERSION", "DOMTERM"], programVariable: "TERM_PROGRAM", backgroundVariable: "COLORFGBG", linkSchemes: ["https://", "http://", "file://"], fileScheme: "file://" }, kinds: [{ name: "open", verbs: ["*"], facts: ["tool", "zone", "counts", "rest"], details: ["fields", "data"], order: ([] as string[]) }, { name: "close", verbs: ["*"], facts: ["duration", "counts", "rest"], details: ["message", "fields"], order: ([] as string[]) }, { name: "lifecycle", verbs: ["start", "reload", "stop", "exit", "restart", "rotate", "watch", "up"], facts: ["duration", "status", "counts", "size", "rest"], details: ["message", "fields"], order: ["clock", "duration", "status", "counts", "size", "rest"] }, { name: "request", verbs: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"], facts: ["duration", "status", "size", "rest"], details: ["message", "fields"], order: ([] as string[]) }, { name: "job", verbs: ["job"], facts: ["duration", "rest", "counts"], details: ["message", "fields", "quote"], order: ["clock", "duration", "rest", "counts", "status", "size"] }, { name: "query", verbs: ["query"], facts: ["duration", "counts"], details: ["quote"], order: ([] as string[]) }, { name: "health", verbs: ["health"], facts: ["duration", "size", "counts", "rest"], details: ["fields"], order: ([] as string[]) }, { name: "step", verbs: ["*"], facts: ["duration", "status", "size", "counts", "rest"], details: ["message", "fields", "frame", "quote", "data"], order: ([] as string[]) }, { name: "progress", verbs: ["*"], facts: ["duration", "counts", "rest"], details: ["bar", "fields"], order: ([] as string[]) }, { name: "change", verbs: ["add", "remove", "update", "change"], facts: ["rest"], details: ["fields"], order: ([] as string[]) }, { name: "problem", verbs: ["*"], facts: ["duration", "status", "counts", "rest"], details: ["message", "fields", "frame", "quote"], order: ([] as string[]) }, { name: "question", verbs: ["ask"], facts: ["rest"], details: ["choices", "input", "fields"], order: ([] as string[]) }, { name: "date", verbs: ["date"], facts: ["none"], details: ["none"], order: ([] as string[]) }], children: { levelKeys: ["level", "severity"], verbKeys: ["logger", "module", "name"], messageKeys: ["msg", "message"], timeKeys: ["time", "ts"], durationKeys: ["duration", "ms"], stackKeys: ["stack", "err.stack"], defaultVerb: "log", levels: [{ word: "fatal", glyph: "failed", quiet: false }, { word: "panic", glyph: "failed", quiet: false }, { word: "critical", glyph: "failed", quiet: false }, { word: "error", glyph: "failed", quiet: false }, { word: "err", glyph: "failed", quiet: false }, { word: "warn", glyph: "warning", quiet: false }, { word: "warning", glyph: "warning", quiet: false }, { word: "info", glyph: "info", quiet: false }, { word: "notice", glyph: "info", quiet: false }, { word: "debug", glyph: "info", quiet: true }, { word: "trace", glyph: "info", quiet: true }, { word: "60", glyph: "failed", quiet: false }, { word: "50", glyph: "failed", quiet: false }, { word: "40", glyph: "warning", quiet: false }, { word: "30", glyph: "info", quiet: false }, { word: "20", glyph: "info", quiet: true }, { word: "10", glyph: "info", quiet: true }] }, keys: { glyph: "glyph", verb: "verb", subject: "subject", source: "source", time: "time", milliseconds: "ms", status: "status", bytes: "bytes", counts: "counts", facts: "facts", message: "message", fields: "fields", kind: "kind" }, asks: { verb: "ask", confirmYes: "Y/n", confirmNo: "y/N", manyHint: "space picks, enter confirms", oneHint: "enter picks", yesFlag: "--yes", yesWord: "yes", noWord: "no", noTerminal: "needs answers, and this is not a terminal" }, unitWords: [{ unit: "B", one: "byte", many: "bytes" }, { unit: "kB", one: "kilobyte", many: "kilobytes" }, { unit: "MB", one: "megabyte", many: "megabytes" }, { unit: "GB", one: "gigabyte", many: "gigabytes" }, { unit: "TB", one: "terabyte", many: "terabytes" }, { unit: "PB", one: "petabyte", many: "petabytes" }, { unit: "ms", one: "millisecond", many: "milliseconds" }, { unit: "s", one: "second", many: "seconds" }] }
}
