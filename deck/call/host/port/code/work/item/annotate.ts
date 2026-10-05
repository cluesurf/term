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

export function spansText(spans: Span[]): string {
  let out: string = ""
  for (const one of spans) {
    out = `${out}${one.value}`
  }
  return out
}

export function escapeAnnotation(value: string, property: boolean): string {
  let out: string = ""
  for (const rune of Array.from(value, function (rune) { return rune.codePointAt(0) ?? 0 })) {
    let piece: string = String.fromCodePoint(rune)
    if (rune === 37) {
      piece = "%25"
    }
    if (rune === 13) {
      piece = "%0D"
    }
    if (rune === 10) {
      piece = "%0A"
    }
    if (property && rune === 58) {
      piece = "%3A"
    }
    if (property && rune === 44) {
      piece = "%2C"
    }
    out = `${out}${piece}`
  }
  return out
}

export function annotateEvent(event: Event): string {
  let level: string = ""
  if (event.glyph === "failed") {
    level = "error"
  }
  if (event.glyph === "warning") {
    level = "warning"
  }
  if (level === "") {
    return ""
  }
  let message: string = spansText(event.subject)
  for (const one of event.message) {
    message = `${message}
${one}`
  }
  let where: string = ""
  const place: Location = event.place
  if (place.path !== "") {
    const path: string = escapeAnnotation(place.path, true)
    where = ` file=${path}`
    if (place.line > 0) {
      where = `${where},line=${place.line}`
    }
    if (place.column > 0) {
      where = `${where},col=${place.column}`
    }
  }
  const title: string = escapeAnnotation(event.verb, true)
  const said: string = escapeAnnotation(message, false)
  if (where === "") {
    return `::${level} title=${title}::${said}`
  }
  return `::${level}${where},title=${title}::${said}`
}
