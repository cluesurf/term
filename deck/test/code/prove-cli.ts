/**
 * `seed prove` - the terminal verification workflow, built (not just
 * designed). Checks a Seed file end to end and gates CI:
 *   - compiles it and reports every verification gap (the checker's
 *     diagnostics as structured, actionable CheckerGaps)
 *   - runs the cross-backend differential (all four backends must agree
 *     the program is well-formed)
 *   - exits non-zero if anything is open or diverges
 *
 * This is Part 7 of theorem-proving-lsp.md, runnable. Usage:
 *   npx tsx deck/test/code/prove-cli.ts <file.tree> [--cross] [--json]
 *
 * Run from the seed install root so @cluesurf/base imports resolve.
 */

import { readFileSync } from 'node:fs'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { compile } from '@cluesurf/make/code/compile/compile'
import { projectResolver } from '@cluesurf/call/code/make'
import { gapsFromDiagnostics, showGap } from './checker-gap'
import { crossEmit } from './cross'

type Report = {
  file: string
  compiles: boolean
  gaps: ReturnType<typeof gapsFromDiagnostics>
  backends: Record<string, boolean>
  ok: boolean
}

/** Check one file: compile, collect gaps, run the cross-backend differential. */
export function proveFile(file: string, root: string, cross: boolean): Report {
  const source = readFileSync(file, 'utf8')
  const resolve = projectResolver(root, 'node', root)

  const compiled = compile({ file, text: source }, { resolve })
  const gaps = gapsFromDiagnostics(source, compiled.diagnostics)

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
function render(report: Report): string {
  const lines: string[] = []
  lines.push(`=== seed prove: ${report.file} ===`)

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

export async function main(): Promise<void> {
  const argv = await yargs(hideBin(process.argv))
    .scriptName('seed-prove')
    .command('$0 <file>', 'verify a Seed file', y =>
      y
        .positional('file', { type: 'string', describe: 'the .tree file to verify' })
        .option('cross', { type: 'boolean', default: true, describe: 'run the cross-backend differential' })
        .option('json', { type: 'boolean', default: false, describe: 'machine-readable output' }),
    )
    .strict()
    .help()
    .parse()

  const file = String(argv.file)
  const report = proveFile(file, process.cwd(), Boolean(argv.cross))

  if (argv.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(render(report))
  }

  process.exit(report.ok ? 0 : 1)
}

// run when invoked directly
const invokedDirectly = process.argv[1]?.endsWith('prove-cli.ts')
if (invokedDirectly) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(2)
  })
}
