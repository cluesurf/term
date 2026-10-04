import fs from 'fs/promises'
import path from 'path'
import { analyze } from '@term/make/code/analyze'
import { collectTreeFiles } from '@term/call/code/files'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'
import { closeRun, count, openRun, printData, report, reportProblems } from '@term/call/code/output'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'

// `term form` -- format `.tree` files into canonical layout. By default it rewrites them in place; `--check` only
// reports which files would change (for CI); `--list` prints the formatted source to stdout without writing. Files
// with parse errors are reported and left untouched, so a broken file is never overwritten.
//
// Through the terminal output library: a `change` item per file rewritten, a ✗ `check` item per file `--check`
// finds unformatted, each parse error a Problem item with its frame. `--list`'s formatted source is data, on stdout.
export async function callForm(input: {
  root: string
  paths: string[]
  check?: boolean
  list?: boolean
}): Promise<void> {
  const files = await collectTreeFiles(input.paths, input.root)
  const mode = input.check ? '--check' : input.list ? '--list' : ''

  openRun({ verb: 'form', root: input.root, counts: [count(files.length, 'files', 'file')], facts: mode ? [mode] : [] })

  if (files.length === 0) {
    report({ glyph: 'failed', kind: 'problem', subject: 'There is no .tree file to format' })
    closeRun({ verdict: 'Nothing to format' })

    return
  }

  let changed = 0
  let broken = 0
  const problems: { diagnostic: Diagnostic; text: string }[] = []

  // each file's role and `mark lean`, as the build reads them: a lean file's layout is checked against the program
  // the build compiles, and a `mill` or `view` file gets no call parentheses (format-rules.md, rule 3)
  const roleOf = projectRoleOf(input.root)
  const leanOf = projectLeanOf(input.root)

  for (const file of files) {
    const text = await fs.readFile(file, 'utf-8')
    const relative = path.relative(input.root, file)
    const absolute = path.resolve(input.root, file)
    const analysis = analyze({ file: relative, text }, { role: roleOf(absolute), lean: leanOf(absolute) })

    const errors = analysis.diagnostics.filter(
      d => d.severity === 'error',
    )

    if (errors.length > 0) {
      broken++
      report({
        glyph: 'failed',
        verb: 'form',
        subject: relative,
        facts: [analysis.kind === 'data' ? 'data that could not be read' : 'could not be parsed'],
      })
      problems.push(...errors.map(diagnostic => ({ diagnostic, text })))

      continue
    }

    const formatted = analysis.format()

    if (formatted === text) {
      continue
    }

    changed++

    if (input.list) {
      printData(formatted)
    } else if (input.check) {
      report({ glyph: 'failed', kind: 'problem', verb: 'check', subject: `${relative} is not formatted` })
    } else {
      await fs.writeFile(file, formatted, 'utf-8')
      report({ glyph: 'changed', kind: 'change', verb: 'change', subject: relative })
    }
  }

  reportProblems(problems, input.root)

  const counted = [count(changed, input.check ? 'unformatted' : input.list ? 'printed' : 'changed'), ...(broken ? [count(broken, 'unreadable')] : [])]

  if (broken > 0) {
    closeRun({ verdict: 'Some files could not be read', counts: counted })

    return
  }

  if (input.check && changed > 0) {
    closeRun({ verdict: `${changed} file${changed === 1 ? ' needs' : 's need'} formatting`, counts: counted, next: 'term form' })

    return
  }

  // `--list` writes nothing, so it must not say it formatted anything (guides: commands/form, 2026-10-04)
  closeRun({
    verdict:
      changed === 0
        ? 'All files already formatted'
        : input.list
          ? 'Printed as they would be formatted, nothing written'
          : `Formatted ${changed} file${changed === 1 ? '' : 's'}`,
    counts: counted,
  })
}
