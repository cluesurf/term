// The diagnostic system. Self-contained, fast, and readable. Every phase of the compiler reports through this.
// See the plan at note/research/vibe/computation/plans/02-diagnostics.md.

import chalk from 'chalk'

// A position in the source: zero-based line and column.
export type Position = { line: number; column: number }

// A range from a start to an end position.
export type Span = { start: Position; end: Position }

export type Severity = 'error' | 'warning' | 'info'

// One labeled range inside a diagnostic. A diagnostic can point at several places at once.
export type Marker = { span: Span; label?: string }

export type Diagnostic = {
  code: number
  name: string
  message: string
  file: string
  span: Span
  markers: Array<Marker>
  hint?: string
  severity: Severity
}

type CatalogEntry = { code: number; message: string; severity: Severity }

// The catalog of diagnostic codes. Codes are permanent and shown in hex.
export const CATALOG = {
  'syntax-error': { code: 0x1, message: 'error in the structure of the tree', severity: 'error' },
  'invalid-nesting': { code: 0x2, message: 'the tree has invalid nesting', severity: 'error' },
  'invalid-indentation': { code: 0x3, message: 'the tree has invalid indentation', severity: 'error' },
  'not-implemented': { code: 0x4, message: 'this feature is not implemented yet', severity: 'error' },
  'unknown-name': { code: 0x5, message: 'this name is not defined', severity: 'error' },
  'unexpected-node': { code: 0x6, message: 'this node is not valid here', severity: 'error' },
  'type-mismatch': { code: 0x7, message: 'the types do not match', severity: 'error' },
} satisfies Record<string, CatalogEntry>

export type DiagnosticName = keyof typeof CATALOG

export type DiagnosticInput = {
  file: string
  span: Span
  hint?: string
  message?: string
  markers?: Array<Marker>
}

// Build a diagnostic from a catalog name. Cheap: just a record, rendered lazily.
export function diagnose(name: DiagnosticName, input: DiagnosticInput): Diagnostic {
  const entry = CATALOG[name]
  return {
    code: entry.code,
    name,
    message: input.message ?? entry.message,
    file: input.file,
    span: input.span,
    markers: input.markers ?? [{ span: input.span }],
    hint: input.hint,
    severity: entry.severity,
  }
}

// A thrown diagnostic, for the strict (non-tolerant) path.
export class DiagnosticError extends Error {
  constructor(public diagnostic: Diagnostic) {
    super(diagnostic.message)
  }
}

function toHex(n: number): string {
  return n.toString(16).padStart(4, '0')
}

// Render a diagnostic against the source lines: a gutter, the offending line, a red range, a caret underline, a
// few context lines, and an optional hint.
export function render(diagnostic: Diagnostic, lines: Array<string>, color = chalk.level > 0): string {
  const paint = color
    ? { red: chalk.red, dim: chalk.dim, bold: chalk.bold, bright: chalk.whiteBright }
    : { red: identity, dim: identity, bold: identity, bright: identity }

  const { span } = diagnostic
  const out: Array<string> = []

  const heading = `${diagnostic.severity}[${toHex(diagnostic.code)}]`
  out.push(`${paint.bold(paint.red(heading))}: ${paint.bold(diagnostic.message)}`)
  out.push(`  ${paint.dim('-->')} ${diagnostic.file}:${span.start.line + 1}:${span.start.column + 1}`)

  const first = Math.max(0, span.start.line - 2)
  const last = Math.min(lines.length - 1, span.end.line + 2)
  const width = String(last + 1).length
  const rail = `${' '.repeat(width)} ${paint.dim('|')}`

  out.push(rail)
  for (let i = first; i <= last; i++) {
    const text = lines[i] ?? ''
    const number = String(i + 1).padStart(width, ' ')
    if (i === span.start.line) {
      const stop = span.end.line === span.start.line ? span.end.column : text.length
      const before = text.slice(0, span.start.column)
      const middle = text.slice(span.start.column, stop)
      const after = text.slice(stop)
      out.push(`${paint.dim(number)} ${paint.dim('|')} ${paint.bright(before)}${paint.red(middle)}${paint.bright(after)}`)
      const carets = `${' '.repeat(span.start.column)}${'^'.repeat(Math.max(1, stop - span.start.column))}`
      const label = diagnostic.markers[0]?.label ? ` ${diagnostic.markers[0].label}` : ''
      out.push(`${' '.repeat(width)} ${paint.dim('|')} ${paint.red(carets + label)}`)
    } else {
      out.push(`${paint.dim(number)} ${paint.dim('|')} ${paint.dim(text)}`)
    }
  }
  out.push(rail)

  if (diagnostic.hint) {
    out.push(` ${paint.bold('hint')}: ${diagnostic.hint}`)
  }

  return out.join('\n')
}

// Machine-readable form for the language server and CI.
export function toJson(diagnostic: Diagnostic): string {
  return JSON.stringify({
    code: toHex(diagnostic.code),
    name: diagnostic.name,
    message: diagnostic.message,
    file: diagnostic.file,
    span: diagnostic.span,
    hint: diagnostic.hint,
    severity: diagnostic.severity,
  })
}

function identity(s: string): string {
  return s
}

// did-you-mean: nearest known name by edit distance, within a small threshold.
export function nearest(name: string, known: Array<string>): string | undefined {
  let best: string | undefined
  let bestDistance = Infinity
  for (const candidate of known) {
    const d = editDistance(name, candidate)
    if (d < bestDistance) {
      bestDistance = d
      best = candidate
    }
  }
  const threshold = Math.max(2, Math.floor(name.length / 3))
  return best !== undefined && bestDistance <= threshold ? best : undefined
}

function editDistance(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  const grid = new Array<number>(rows * cols)
  for (let i = 0; i < rows; i++) grid[i * cols] = i
  for (let j = 0; j < cols; j++) grid[j] = j
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      grid[i * cols + j] = Math.min(
        grid[(i - 1) * cols + j]! + 1,
        grid[i * cols + (j - 1)]! + 1,
        grid[(i - 1) * cols + (j - 1)]! + cost,
      )
    }
  }
  return grid[rows * cols - 1]!
}
