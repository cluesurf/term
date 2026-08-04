/**
 * The core of `seed hold`, with the module resolver injected (not
 * built here). Keeping `proveFile` resolver-agnostic is what lets BOTH
 * the standalone `prove-cli.ts` AND the real `seed hold` CLI verb
 * (`@term/call/code/hold`) call it without the verification
 * package depending on `@cluesurf/call` - which would be a cycle, since
 * `call` is what owns `projectResolver`.
 *
 * Check one file end to end:
 *   - compile it and collect every verification gap (the checker's
 *     diagnostics as structured, actionable CheckerGaps)
 *   - run the cross-backend differential (all backends must agree the
 *     program is well-formed)
 *
 * Pure: the caller supplies the resolver and decides what to do with
 * the Report (render, JSON, exit code). This is Part 7 of
 * theorem-proving-lsp.md.
 */

import { readFileSync } from 'node:fs'
import { compile } from '@term/make/code/compile/compile'
import type { Resolver } from '@term/make/code/compile/load'
import { gapsFromDiagnostics, showGap } from './checker-gap'
import { crossEmit } from './cross'

/** A module resolver, as compile()/crossEmit() expect. */
export type Resolve = Resolver

export type Report = {
  file: string
  compiles: boolean
  gaps: ReturnType<typeof gapsFromDiagnostics>
  backends: Record<string, boolean>
  ok: boolean
}

/** Check one file: compile, collect gaps, run the cross-backend differential. */
export function proveFile(input: { file: string; resolve: Resolve; cross: boolean }): Report {
  const { file, resolve, cross } = input
  const source = readFileSync(file, 'utf8')

  const compiled = compile({ file, text: source }, { resolve })
  // diagnostics live on the failure branch; warnings on success. Both surface as gaps.
  const diagnostics = compiled.ok ? compiled.warnings : compiled.diagnostics
  const gaps = gapsFromDiagnostics(source, diagnostics)

  const backends: Record<string, boolean> = {}
  if (cross && compiled.ok) {
    const result = crossEmit(source, resolve)
    for (const [name, emit] of Object.entries(result.emits)) {
      backends[name] = emit.ok
    }
  }

  const backendsOk = Object.values(backends).every(Boolean)
  const ok = compiled.ok && gaps.length === 0 && backendsOk

  return { file, compiles: compiled.ok, gaps, backends, ok }
}

/** Render a report the way the terminal prints it. */
export function renderReport(report: Report): string {
  const lines: string[] = []
  lines.push(`=== seed hold: ${report.file} ===`)

  if (report.gaps.length === 0 && report.compiles) {
    lines.push('  PROVED - compiles with no open obligations')
  } else {
    for (const gap of report.gaps) {
      lines.push(showGap(gap).split('\n').map(l => '  ' + l).join('\n'))
    }
    if (!report.compiles && report.gaps.length === 0) {
      lines.push('  OPEN - did not compile')
    }
  }

  const backends = Object.entries(report.backends)
  if (backends.length) {
    const summary = backends.map(([b, ok]) => `${b}${ok ? '' : ':DIVERGED'}`).join(' ')
    lines.push(`  backends: [${summary}]`)
  }

  lines.push(`  => ${report.ok ? 'OK' : 'FAILED'}`)
  return lines.join('\n')
}
