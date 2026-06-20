import fs from 'fs/promises'
import path from 'path'
import { analyze } from '../analyze'
import { render } from '../parser/diagnostic'
import type { Diagnostic } from '../parser/diagnostic'
import type { Finding, TextEdit } from '../lint/rule'
import { collectTreeFiles } from './files'
import { logGood, logFail, logStep, fade } from '../tint'

// turn a lint finding into the compiler's Diagnostic shape so it renders identically. The stable rule code (`L003`)
// becomes the numeric diagnostic code and the rule name is the heading.
function toDiagnostic(finding: Finding, file: string): Diagnostic {
  return {
    code: parseInt(finding.code.replace(/\D/g, ''), 10),
    name: finding.rule,
    message: finding.message,
    file,
    span: finding.span,
    markers: [{ span: finding.span }],
    hint: finding.fix ? 'fixable: run `seed lint --fix`' : undefined,
    severity: finding.severity,
  }
}

// apply text edits to source. Edits are applied right-to-left so earlier offsets stay valid; overlapping edits are
// dropped (the first one in source order wins).
function applyEdits(text: string, edits: Array<TextEdit>): string {
  const lineStarts = [0]
  for (let i = 0; i < text.length; i++)
    if (text[i] === '\n') lineStarts.push(i + 1)
  const offset = (pos: { line: number; column: number }) =>
    (lineStarts[pos.line] ?? text.length) + pos.column

  const ranges = edits
    .map(e => ({
      start: offset(e.span.start),
      end: offset(e.span.end),
      text: e.text,
    }))
    .sort((a, b) => b.start - a.start)

  let result = text
  let lastStart = Infinity
  for (const range of ranges) {
    if (range.end > lastStart) continue // overlaps an already-applied edit; skip
    result =
      result.slice(0, range.start) +
      range.text +
      result.slice(range.end)
    lastStart = range.start
  }
  return result
}

// `seed lint` -- lint `.tree` files. `--fix` applies autofixes in place; otherwise findings are reported. Exits
// non-zero when any error-severity finding remains (so it gates CI).
export async function callLint(input: {
  root: string
  paths: Array<string>
  fix?: boolean
}): Promise<void> {
  const files = await collectTreeFiles(input.paths, input.root)
  if (files.length === 0) {
    logFail('No .tree files found')
    process.exit(1)
  }

  logStep(input.fix ? 'Linting and fixing...' : 'Linting...')

  let totalFindings = 0
  let totalErrors = 0
  let totalFixed = 0

  for (const file of files) {
    const text = await fs.readFile(file, 'utf-8')
    const relative = path.relative(input.root, file)
    const findings = analyze({ file: relative, text }).lint()
    if (findings.length === 0) continue

    if (input.fix) {
      const fixes = findings
        .map(f => f.fix)
        .filter((f): f is TextEdit => Boolean(f))
      const fixedText =
        fixes.length > 0 ? applyEdits(text, fixes) : text
      if (fixes.length > 0) {
        await fs.writeFile(file, fixedText, 'utf-8')
        totalFixed += fixes.length
      }
      // re-lint to report what the fixes did not resolve
      const remaining = analyze({
        file: relative,
        text: fixedText,
      }).lint()
      const lines = fixedText.split('\n')
      for (const finding of remaining) {
        if (finding.severity === 'error') totalErrors++
        totalFindings++
        console.error(render(toDiagnostic(finding, relative), lines))
      }
    } else {
      const lines = text.split('\n')
      for (const finding of findings) {
        if (finding.severity === 'error') totalErrors++
        totalFindings++
        console.error(render(toDiagnostic(finding, relative), lines))
      }
    }
  }

  if (totalFixed > 0)
    console.log(
      fade(
        `  applied ${totalFixed} fix${totalFixed === 1 ? '' : 'es'}`,
      ),
    )
  if (totalFindings === 0) logGood('No lint findings')
  else logWarnSummary(totalFindings, totalErrors)
  if (totalErrors > 0) process.exit(1)
}

function logWarnSummary(findings: number, errors: number): void {
  const warnings = findings - errors
  const parts: Array<string> = []
  if (errors > 0)
    parts.push(`${errors} error${errors === 1 ? '' : 's'}`)
  if (warnings > 0)
    parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`)
  if (errors > 0) logFail(parts.join(', '))
  else console.log(fade(`  ${parts.join(', ')}`))
}
