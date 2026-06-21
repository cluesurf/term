/**
 * Emit a structured gap from the live checker. Phase A of the
 * synthesis design (note/methodology/verification/synthesis.md): turn
 * each checker diagnostic into a `CheckerGap` - the single, machine-
 * and AI-readable description of a verification hole that every
 * proposer (mechanical fix, CEGIS, AI) consumes.
 *
 * The checker already produces rich diagnostics (a kind, a message, a
 * span, an optional hint, a severity). This adds the one missing
 * piece: a self-contained, actionable report including the offending
 * source line with a caret, so a fixer - human or model - has exactly
 * what it needs and nothing it does not.
 */

/** A position in the source. */
export type Spot = { line: number; column: number }

/** A checker diagnostic, as `compile().diagnostics` produces it. */
export type Diagnostic = {
  name: string
  message: string
  file?: string
  span?: { start: Spot; end: Spot }
  hint?: string
  severity?: string
}

/** A structured, actionable verification hole. */
export type CheckerGap = {
  /** `file:line:column` of the hole. */
  location: string
  /** The diagnostic kind (e.g. `type-mismatch`, `non-exhaustive`). */
  kind: string
  /** The obligation that failed, in plain language. */
  message: string
  /** A suggested direction, when the checker offers one. */
  hint?: string
  /** `error` | `warning` | ... */
  severity: string
  /** The offending source line with a caret under the span. */
  excerpt: string
}

/** Render the offending line(s) with a caret under the failing span. */
function excerptFor(source: string, span?: { start: Spot; end: Spot }): string {
  if (!span) return ''

  const lines = source.split('\n')
  const lineNo = span.start.line
  const line = lines[lineNo - 1] ?? ''
  const width = Math.max(
    1,
    (span.end.line === span.start.line ? span.end.column : line.length) -
      span.start.column,
  )
  const caret = ' '.repeat(Math.max(0, span.start.column)) + '^'.repeat(width)

  return `${lineNo} | ${line}\n${' '.repeat(String(lineNo).length)} | ${caret}`
}

/** Turn one diagnostic into a CheckerGap. */
export function gapFromDiagnostic(
  source: string,
  diagnostic: Diagnostic,
): CheckerGap {
  const start = diagnostic.span?.start
  const location = `${diagnostic.file ?? '<source>'}:${start?.line ?? 0}:${start?.column ?? 0}`

  return {
    location,
    kind: diagnostic.name,
    message: diagnostic.message,
    hint: diagnostic.hint,
    severity: diagnostic.severity ?? 'error',
    excerpt: excerptFor(source, diagnostic.span),
  }
}

/** Turn a compile's diagnostics into the gap reports the loop consumes. */
export function gapsFromDiagnostics(
  source: string,
  diagnostics: Diagnostic[] | undefined,
): CheckerGap[] {
  return (diagnostics ?? []).map(d => gapFromDiagnostic(source, d))
}

/** Render a gap as a compact, AI-readable block. */
export function showGap(gap: CheckerGap): string {
  const lines = [
    `gap [${gap.severity}] ${gap.kind} at ${gap.location}`,
    `  ${gap.message}`,
  ]
  if (gap.excerpt) lines.push(...gap.excerpt.split('\n').map(l => '  ' + l))
  if (gap.hint) lines.push(`  hint: ${gap.hint}`)
  return lines.join('\n')
}
