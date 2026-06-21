// `seed scan <file>`: type-check a file with its project's imports resolved, and report diagnostics. This is the
// agent's fast inner-loop verifier. `--back json` returns `{ ok, diagnostics }` with codes + spans so a loop or skill
// can decide "done" mechanically; the process exits non-zero on any error, so a plain shell check works too.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { compile } from '@cluesurf/make/code/compile/compile'
import type { Diagnostic } from '@cluesurf/make/code/parser/diagnostic'
import { editorResolver } from '@cluesurf/make/code/resolve'
import { logGood, logFail, fade } from '@cluesurf/make/code/tint'

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
      process.stdout.write(
        `${JSON.stringify({
          ok: false,
          error: 'not-found',
          file: input.file,
        })}\n`,
      )
    } else {
      logFail(`File not found: ${input.file}`)
    }

    process.exit(1)
  }

  const text = readFileSync(file, 'utf8')
  const result = compile({ file, text }, { resolve: editorResolver(file) })
  // errors when it failed; warnings (unused, termination, unchecked holds) when it compiled. `ok` is the gate.
  const diagnostics = result.ok ? result.warnings : result.diagnostics

  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: result.ok,
        diagnostics: diagnostics.map(d => toJson(input.root, d)),
      })}\n`,
    )

    if (!result.ok) {
      process.exit(1)
    }

    return
  }

  for (const d of diagnostics) {
    const where = `${path.relative(input.root, d.file)}:${
      d.span.start.line + 1
    }:${d.span.start.column + 1}`
    const line = `${where}  ${d.name}: ${d.message}${
      d.hint ? ` (${d.hint})` : ''
    }`

    if (d.severity === 'error') {
      logFail(line)
    } else {
      console.log(fade(`  ${line}`))
    }
  }

  if (!result.ok) {
    process.exit(1)
  }

  logGood(
    diagnostics.length
      ? `${input.file} ✓ (${diagnostics.length} warning${
          diagnostics.length === 1 ? '' : 's'
        })`
      : `${input.file} ✓`,
  )
}
