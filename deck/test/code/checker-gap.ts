/**
 * Emit a structured gap from the live checker. Phase A of the
 * synthesis design (note/methodology/verification/synthesis.md): turn
 * each checker diagnostic into a `CheckerGap` - the single, machine-
 * and AI-readable description of a verification hole that every
 * proposer (mechanical fix, CEGIS, AI) consumes.
 *
 * The report is Term since 2026-10-04, deck/test/code/checker-report.tree.
 * This is the face that fills what a compiler diagnostic leaves out
 * (`file`, `span`, `hint`, `severity`), which Term cannot test for.
 */

import { gapFromDiagnostic as gapFromComplete, showGap } from '@term/test/code/checker-report'
import type { CheckerGap } from '@term/test/code/checker-report'

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

export type { CheckerGap }
export { showGap }

/** Turn one diagnostic into a CheckerGap. */
export function gapFromDiagnostic(source: string, diagnostic: Diagnostic): CheckerGap {
  const span = diagnostic.span

  return gapFromComplete(source, {
    name: diagnostic.name,
    message: diagnostic.message,
    file: diagnostic.file ?? '<source>',
    hasSpan: span !== undefined,
    startLine: span?.start.line ?? 0,
    startColumn: span?.start.column ?? 0,
    endLine: span?.end.line ?? 0,
    endColumn: span?.end.column ?? 0,
    hint: diagnostic.hint ?? '',
    severity: diagnostic.severity ?? 'error',
  })
}

/** Turn a compile's diagnostics into the gap reports the loop consumes. */
export function gapsFromDiagnostics(source: string, diagnostics: Diagnostic[] | undefined): CheckerGap[] {
  return (diagnostics ?? []).map(d => gapFromDiagnostic(source, d))
}
