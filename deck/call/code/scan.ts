// `term scan <file>`: type-check one file with its project's imports resolved, its role and `mark lean` read from the
// project's role files and a test file rewritten, as `term make` reads it, and report diagnostics. This is the
// agent's fast inner-loop verifier. `--back json` returns `{ ok, diagnostics }` with codes + spans so a loop or skill
// can decide "done" mechanically; the process exits non-zero on any error, so a plain shell check works too.
//
// Each diagnostic carries its `fixes`, the edits that resolve it (make/code/fix.ts), so an agent applies the
// compiler's answer rather than guessing one. `--fix` writes the SURE ones into the file (an old spelling, which has
// one current spelling) and scans again; a guess (a near spelling, a name that fits a hole) is offered, never written.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import type { CompileResult } from '@term/make/code/compile/compile'
import type { Diagnostic, Fix } from '@term/make/code/parser/diagnostic'
import { applyFixes, fixesOf } from '@term/make/code/fix'
import { findModulesExporting } from '@term/make/code/resolve'
import { buildable, projectResolver } from '@term/call/code/make'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'
import { closeRun, count, field, openRun, printData, report, reportProblems } from '@term/call/code/output'

type JsonFix = { title: string; sure: boolean; edits: { span: { start: unknown; end: unknown }; text: string; was: string }[] }

// the JSON shape an agent consumes: stable, workspace-relative, no machine paths or timestamps
function toJson(
  root: string,
  d: Diagnostic,
  fixes: Fix[],
): {
  code: number
  name: string
  severity: string
  message: string
  hint?: string
  file: string
  span: { start: unknown; end: unknown }
  fixes: JsonFix[]
} {
  return {
    code: d.code,
    name: d.name,
    severity: d.severity,
    message: d.message,
    hint: d.hint,
    file: path.relative(root, d.file),
    span: { start: d.span.start, end: d.span.end },
    fixes: fixes.map(fix => ({
      title: fix.title,
      sure: fix.sure,
      edits: fix.edits.map(edit => ({ span: { start: edit.span.start, end: edit.span.end }, text: edit.text, was: edit.was })),
    })),
  }
}

// one file compiled the way `term make` reads it: its role, its lean flag, and a test file rewritten
function scanOnce(root: string, file: string): { result: CompileResult; source: string; text: string } {
  // the file as `term make` compiles it. It was compiled as written with no role reader, so a file under a
  // `mark lean` role was read as longhand and reported names `term make` builds (guides: commands/scan, 2026-10-04)
  const source = readFileSync(file, 'utf8')
  const roleOf = projectRoleOf(root)
  const leanOf = projectLeanOf(root)
  const unit = buildable(file, source, roleOf(file))
  const text = 'text' in unit ? unit.text : source
  const result = compile(
    { file, text },
    // the build's own resolver, which follows a relative `load` too. `editorResolver` looked in linked packages and
    // the standard library only, so a name loaded from a sibling file read as undefined
    { resolve: projectResolver(root, 'node', root), roleOf, leanOf },
  )

  return { result, source, text }
}

// the fixes of a diagnostic in the scanned file. A test file is compiled rewritten, and a span into the rewrite does
// not point into the file on disk, so its fixes are read against the rewrite and offered only when the two are one
// text. A diagnostic in an imported module is that module's to fix
function fixesFor(root: string, file: string, d: Diagnostic, scanned: { source: string; text: string }): Fix[] {
  if (d.file !== file || scanned.text !== scanned.source) {
    return []
  }

  return fixesOf(d, scanned.source, { findExport: name => exporting(root, name) })
}

// which modules export a name, asked once a run per name: it reads every module the project can reach
const exported = new Map<string, { importPath: string }[]>()

function exporting(root: string, name: string): { importPath: string }[] {
  const key = `${root}\0${name}`

  if (!exported.has(key)) {
    exported.set(key, findModulesExporting(root, name))
  }

  return exported.get(key)!
}

export async function callScan(input: {
  root: string
  file: string
  back?: string
  fix?: boolean
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

  let scanned = scanOnce(input.root, file)
  // errors when it failed; warnings (unused, termination, unchecked holds) when it compiled. `ok` is the gate.
  let diagnostics = scanned.result.ok ? scanned.result.warnings : scanned.result.diagnostics
  const applied: Fix[] = []
  const refused: { fix: Fix; reason: string }[] = []

  // --fix: write every sure fix, then scan again, so the answer is about the file as it now stands. A fix that
  // resolves one diagnostic can uncover another, and a second round of sure fixes is the same rule applied again, so
  // it repeats while a round writes something, at most a handful of times
  for (let round = 0; input.fix && round < 4; round++) {
    const sure = diagnostics.flatMap(d => fixesFor(input.root, file, d, scanned)).filter(fix => fix.sure)

    if (!sure.length) {
      break
    }

    const done = applyFixes(scanned.source, sure)

    refused.push(...done.refused)

    if (!done.applied.length) {
      break
    }

    applied.push(...done.applied)
    writeFileSync(file, done.text)
    scanned = scanOnce(input.root, file)
    diagnostics = scanned.result.ok ? scanned.result.warnings : scanned.result.diagnostics
  }

  const result = scanned.result

  if (json) {
    // the answer the agent asked for: data on stdout, the exit code the gate
    printData(
      `${JSON.stringify({
        ok: result.ok,
        diagnostics: diagnostics.map(d => toJson(input.root, d, fixesFor(input.root, file, d, scanned))),
        ...(input.fix
          ? {
              applied: applied.map(fix => fix.title),
              refused: refused.map(one => ({ title: one.fix.title, reason: one.reason })),
            }
          : {}),
      })}\n`,
    )

    if (!result.ok) {
      process.exitCode = 1
    }

    return
  }

  // the working folder is the subject (section 3), the file a fact
  openRun({ verb: 'scan', root: input.root, facts: [input.file] })

  for (const fix of applied) {
    report({ glyph: 'changed', kind: 'change', verb: 'fix', subject: fix.title })
  }

  for (const one of refused) {
    report({ glyph: 'warning', kind: 'problem', verb: 'fix', subject: `Not applied: ${one.fix.title}`, fields: [field('why', one.reason)] })
  }

  // each diagnostic a Problem item with its frame (section 12); the run fails on any error, as before
  reportProblems(diagnostics.map(diagnostic => ({ diagnostic, text: diagnostic.file === file ? scanned.text : undefined })), input.root)
  const errors = diagnostics.filter(d => d.severity === 'error').length
  const warnings = diagnostics.length - errors
  const sure = input.fix ? 0 : diagnostics.flatMap(d => fixesFor(input.root, file, d, scanned)).filter(fix => fix.sure).length
  closeRun({
    verdict: result.ok ? `${input.file} checks` : `${input.file} does not check`,
    counts: [
      ...(applied.length ? [count(applied.length, 'fixes applied', 'fix applied')] : []),
      ...(errors ? [count(errors, 'errors', 'error')] : []),
      ...(warnings ? [count(warnings, 'warnings', 'warning')] : []),
    ],
    ...(sure ? { next: `term scan ${input.file} --fix, which applies ${sure === 1 ? 'the one sure fix' : `the ${sure} sure fixes`}` } : {}),
  })
}
