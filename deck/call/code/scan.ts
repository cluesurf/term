// `term scan <file>`: type-check one file with its project's imports resolved, its role and `mark lean` read from the
// project's role files and a test file rewritten, as `term make` reads it, and report diagnostics. This is the
// agent's fast inner-loop verifier. `--back json` returns `{ ok, diagnostics }` with codes + spans so a loop or skill
// can decide "done" mechanically; the process exits non-zero on any error, so a plain shell check works too.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { buildable, projectResolver } from '@term/call/code/make'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'
import { closeRun, count, field, openRun, printData, report, reportProblems } from '@term/call/code/output'

// the JSON shape an agent consumes: stable, workspace-relative, no machine paths or timestamps
function toJson(
  root: string,
  d: Diagnostic,
): {
  code: number
  name: string
  severity: string
  message: string
  hint?: string
  file: string
  span: { start: unknown; end: unknown }
} {
  return {
    code: d.code,
    name: d.name,
    severity: d.severity,
    message: d.message,
    hint: d.hint,
    file: path.relative(root, d.file),
    span: { start: d.span.start, end: d.span.end },
  }
}

export async function callScan(input: {
  root: string
  file: string
  back?: string
}): Promise<void> {
  const json = input.back === 'json'
  const file = path.resolve(input.root, input.file)

  if (!existsSync(file)) {
    if (json) {
      printData(
        `${JSON.stringify({
          ok: false,
          error: 'not-found',
          file: input.file,
        })}\n`,
      )
      process.exitCode = 1
    } else {
      openRun({ verb: 'scan', root: input.root, facts: [input.file] })
      // relative to the working folder, the way the file was named: it printed the whole absolute path
      report({ glyph: 'failed', kind: 'problem', subject: 'There is no such file', fields: [field('looked', path.relative(input.root, file) || file)] })
      closeRun({ verdict: 'Nothing scanned' })
    }

    return
  }

  // the file as `term make` compiles it. It was compiled as written with no role reader, so a file under a
  // `mark lean` role was read as longhand and reported names `term make` builds (guides: commands/scan, 2026-10-04)
  const source = readFileSync(file, 'utf8')
  const roleOf = projectRoleOf(input.root)
  const leanOf = projectLeanOf(input.root)
  const unit = buildable(file, source, roleOf(file))
  const text = 'text' in unit ? unit.text : source
  const result = compile(
    { file, text },
    // the build's own resolver, which follows a relative `load` too. `editorResolver` looked in linked packages and
    // the standard library only, so a name loaded from a sibling file read as undefined
    { resolve: projectResolver(input.root, 'node', input.root), roleOf, leanOf },
  )

  // errors when it failed; warnings (unused, termination, unchecked holds) when it compiled. `ok` is the gate.
  const diagnostics = result.ok ? result.warnings : result.diagnostics

  if (json) {
    // the answer the agent asked for: data on stdout, the exit code the gate
    printData(
      `${JSON.stringify({
        ok: result.ok,
        diagnostics: diagnostics.map(d => toJson(input.root, d)),
      })}\n`,
    )

    if (!result.ok) {
      process.exitCode = 1
    }

    return
  }

  // the working folder is the subject (section 3), the file a fact
  openRun({ verb: 'scan', root: input.root, facts: [input.file] })
  // each diagnostic a Problem item with its frame (section 12); the run fails on any error, as before
  reportProblems(diagnostics.map(diagnostic => ({ diagnostic, text: diagnostic.file === file ? text : undefined })), input.root)
  const errors = diagnostics.filter(d => d.severity === 'error').length
  const warnings = diagnostics.length - errors
  closeRun({
    verdict: result.ok ? `${input.file} checks` : `${input.file} does not check`,
    counts: [...(errors ? [count(errors, 'errors', 'error')] : []), ...(warnings ? [count(warnings, 'warnings', 'warning')] : [])],
  })
}
