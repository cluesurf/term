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

export function blankEvent(): Event {
  return { glyph: "info", kind: "step", verb: "", subject: ([] as Span[]), source: "", clock: -1, tool: ([] as string[]), zone: "", duration: -1, uptime: false, budget: -1, status: { kind: "", value: 0, name: "" }, bytes: -1, tallies: ([] as Tally[]), facts: ([] as string[]), message: ([] as string[]), fields: ([] as ItemField[]), frames: ([] as Frame[]), quote: ([] as string[]), quoteEarlier: 0, quoteLog: "", done: -1, total: -1, choices: ([] as Choice[]), asking: false, typed: "", secret: false, columns: ([] as Column[]), rows: ([] as TableRow[]), nodes: ([] as TreeNode[]), entries: ([] as ListEntry[]), entryTotal: -1, level: "", verdict: false, place: { path: "", line: 0, column: 0 }, id: "", cause: "", repeat: 0 }
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
