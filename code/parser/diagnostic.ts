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

type CatalogEntry = { code: number; message: string; severity: Severity; fix: string }

// The catalog of diagnostic codes. Codes are permanent. `fix` is the default actionable hint, so every error
// tells you how to resolve it.
export const CATALOG = {
  'syntax-error': { code: 0x1, message: 'error in the structure of the tree', severity: 'error', fix: 'check the brackets, the two-space indentation, and the commas on this line' },
  'invalid-nesting': { code: 0x2, message: 'the tree has invalid nesting', severity: 'error', fix: 'a number is a value: it cannot have children or be the head of a line' },
  'invalid-indentation': { code: 0x3, message: 'the tree has invalid indentation', severity: 'error', fix: 'indent exactly one level (two spaces) deeper than the parent line' },
  'not-implemented': { code: 0x4, message: 'this feature is not implemented yet', severity: 'error', fix: 'this construct is recognized but not yet compiled' },
  'unknown-name': { code: 0x5, message: 'this name is not defined', severity: 'error', fix: 'define it, import it, or check the spelling' },
  'unexpected-node': { code: 0x6, message: 'this node is not valid here', severity: 'error', fix: 'this term is not allowed in this position' },
  'type-mismatch': { code: 0x7, message: 'the types do not match', severity: 'error', fix: 'make the value match the expected type, or adjust the annotation' },
  'unproven': { code: 0x8, message: 'this hold could not be proven', severity: 'error', fix: 'add the assumption it needs (e.g. a natural-number bound), or weaken the claim' },
  'incomplete-instance': { code: 0x9, message: 'this trait implementation is missing methods', severity: 'error', fix: 'implement every method the trait declares' },
  'unused-binding': { code: 0xa, message: 'this binding is never used', severity: 'warning', fix: 'remove it, or use it' },
  'non-exhaustive': { code: 0xb, message: 'this match does not cover every case', severity: 'error', fix: 'add the missing cases, or add an `else` branch' },
  'no-instance': { code: 0xc, message: 'no trait instance for this type', severity: 'error', fix: 'implement the trait for this type with `wear` or `suit`' },
  'non-positive': { code: 0xd, message: 'this type occurs in a non-positive position in its own definition', severity: 'error', fix: 'a type cannot appear to the left of an arrow within its own fields; restructure the definition' },
  'non-terminating': { code: 0xe, message: 'this recursion could not be shown to terminate', severity: 'warning', fix: 'make a recursive call decrease an argument (e.g. a structurally smaller value), or add a base case' },
  'unchecked-hold': { code: 0xf, message: 'this hold is outside the decidable linear fragment and was not proven', severity: 'warning', fix: 'rewrite it as a linear comparison (<, <=, >, >=, ==), or prove it in the dependent kernel' },
  'duplicate-instance': { code: 0x10, message: 'this trait is implemented more than once for the same type', severity: 'error', fix: 'remove the overlapping implementation; a type may implement a trait only once (coherence)' },
  'effect-error': { code: 0x11, message: 'an effect is used inconsistently', severity: 'error', fix: 'mark the task async, await the asynchronous call, or only await asynchronous tasks' },
  'invalid-proof': { code: 0x12, message: 'this proof does not establish the proposition', severity: 'error', fix: 'check the tactic and its argument; `melt` needs both sides to compute equal, `cite` needs a proven lemma of the same statement' },
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
    // a specific hint if given, otherwise the catalog's default fix, so every diagnostic suggests a remedy
    hint: input.hint ?? entry.fix,
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
    ? { red: chalk.red, yellow: chalk.yellow, dim: chalk.dim, bold: chalk.bold, bright: chalk.whiteBright }
    : { red: identity, yellow: identity, dim: identity, bold: identity, bright: identity }

  const accent = diagnostic.severity === 'warning' ? paint.yellow : paint.red
  const { span } = diagnostic
  const out: Array<string> = []

  // header shows the readable name and the stable code, e.g. `error[type-mismatch 0007]`
  const heading = `${diagnostic.severity}[${diagnostic.name} ${toHex(diagnostic.code)}]`
  out.push(`${paint.bold(accent(heading))}: ${paint.bold(diagnostic.message)}`)
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
      out.push(`${paint.dim(number)} ${paint.dim('|')} ${paint.bright(before)}${accent(middle)}${paint.bright(after)}`)
      const carets = `${' '.repeat(span.start.column)}${'^'.repeat(Math.max(1, stop - span.start.column))}`
      const label = diagnostic.markers[0]?.label ? ` ${diagnostic.markers[0].label}` : ''
      out.push(`${' '.repeat(width)} ${paint.dim('|')} ${accent(carets + label)}`)
    } else {
      out.push(`${paint.dim(number)} ${paint.dim('|')} ${paint.dim(text)}`)
    }
  }
  out.push(rail)

  // related (secondary) markers: point at other relevant places, e.g. where a type was first fixed
  for (let i = 1; i < diagnostic.markers.length; i++) {
    const marker = diagnostic.markers[i]!
    const where = `${diagnostic.file}:${marker.span.start.line + 1}:${marker.span.start.column + 1}`
    out.push(`  ${paint.dim('-->')} ${where}${marker.label ? `: ${paint.dim(marker.label)}` : ''}`)
  }

  if (diagnostic.hint) {
    out.push(` ${paint.bold('hint')}: ${diagnostic.hint}`)
  }

  return out.join('\n')
}

// the inline source snippet for a span: a gutter, the offending line, and a caret underline, optionally indented
function sourceSnippet(lines: Array<string>, span: Span, accent: (s: string) => string, dim: (s: string) => string, bright: (s: string) => string, indent: string): Array<string> {
  const out: Array<string> = []
  const first = Math.max(0, span.start.line - 1)
  const last = Math.min(lines.length - 1, span.end.line + 1)
  const width = String(last + 1).length
  for (let i = first; i <= last; i++) {
    const text = lines[i] ?? ''
    const number = String(i + 1).padStart(width, ' ')
    if (i === span.start.line) {
      const stop = span.end.line === span.start.line ? span.end.column : text.length
      out.push(`${indent}${dim(`${number} |`)} ${bright(text.slice(0, span.start.column))}${accent(text.slice(span.start.column, stop))}${bright(text.slice(stop))}`)
      const carets = `${' '.repeat(span.start.column)}${'^'.repeat(Math.max(1, stop - span.start.column))}`
      out.push(`${indent}${dim(`${' '.repeat(width)} |`)} ${accent(carets)}`)
    } else {
      out.push(`${indent}${dim(`${number} |`)} ${dim(text)}`)
    }
  }
  return out
}

// The beautiful structured renderer, in the kink style: a titled error with code and host, then site/call frames,
// each followed by its inline source snippet. Keywords are bare words, values sit in <...> (no colon separators;
// colons appear only inside file:line:col). The richest, most debuggable form.
export function renderKink(diagnostic: Diagnostic, lines: Array<string>, color = chalk.level > 0): string {
  const paint = color
    ? { red: chalk.red, cyan: chalk.cyan, dim: chalk.dim, bold: chalk.bold, white: chalk.white, bright: chalk.whiteBright, yellow: chalk.yellow }
    : { red: identity, cyan: identity, dim: identity, bold: identity, white: identity, bright: identity, yellow: identity }
  const accent = diagnostic.severity === 'warning' ? paint.yellow : paint.red
  const wrap = (open: string, value: string, close = '>') => `${paint.dim(open)}${value}${paint.dim(close)}`
  const out: Array<string> = []

  const word = diagnostic.severity === 'warning' ? 'warn' : 'kink'
  // title: the keyword, then the message in <...>
  out.push(`${accent(word)} ${wrap('<', accent(paint.bold(diagnostic.message)))}`)
  out.push(`  ${paint.dim('code')} ${wrap('<', paint.cyan(toHex(diagnostic.code)))}`)
  out.push(`  ${paint.dim('name')} ${wrap('<', paint.dim(diagnostic.name))}`)
  out.push(`  ${paint.dim('host')} ${paint.dim('seed')}`) // host has no brackets, by design

  diagnostic.markers.forEach((marker, i) => {
    const here = marker.span
    const location = `${diagnostic.file}:${here.start.line + 1}:${here.start.column + 1}`
    out.push(`  ${paint.dim('site')} ${wrap('<', paint.bright(location))}`)
    if (marker.label) out.push(`    ${paint.dim('call')} ${wrap('<', paint.white(marker.label))}`)
    else if (i > 0) out.push(`    ${paint.dim('call')} ${wrap('<', paint.white('related'))}`)
    out.push(...sourceSnippet(lines, here, accent, paint.dim, paint.bright, '    '))
  })

  if (diagnostic.hint) out.push(`  ${paint.dim('note')} ${wrap('<', paint.dim(diagnostic.hint))}`)
  return out.join('\n')
}

// Render a whole batch of diagnostics with a summary count. The single thing to call to show problems to a user.
export function report(diagnostics: Array<Diagnostic>, lines: Array<string>, color = chalk.level > 0): string {
  if (diagnostics.length === 0) return 'no problems found'
  const errors = diagnostics.filter((d) => d.severity === 'error').length
  const warnings = diagnostics.filter((d) => d.severity === 'warning').length
  const parts: Array<string> = []
  if (errors) parts.push(`${errors} error${errors === 1 ? '' : 's'}`)
  if (warnings) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`)
  const body = diagnostics.map((d) => renderKink(d, lines, color)).join('\n\n')
  return `${body}\n\n${parts.join(', ')}`
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
