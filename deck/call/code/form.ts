import fs from 'fs/promises'
import path from 'path'
import { analyze } from '@term/make/code/analyze'
import { render } from '@term/make/code/parser/diagnostic'
import { collectTreeFiles } from '@term/call/code/files'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'
import {
  logGood,
  logFail,
  logStep,
  fade,
} from '@term/make/code/tint'

// `term form` -- format `.tree` files into canonical layout. By default it rewrites them in place; `--check` only
// reports which files would change (for CI); `--list` prints the formatted source to stdout without writing. Files
// with parse errors are reported and left untouched, so a broken file is never overwritten.
export async function callForm(input: {
  root: string
  paths: string[]
  check?: boolean
  list?: boolean
}): Promise<void> {
  const files = await collectTreeFiles(input.paths, input.root)

  if (files.length === 0) {
    logFail('No .tree files found')
    process.exit(1)
  }

  logStep(input.check ? 'Checking formatting...' : 'Formatting...')

  let changed = 0
  let broken = 0

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
      logFail(
        analysis.kind === 'data'
          ? `${relative} is data that could not be read`
          : `${relative} could not be parsed`,
      )

      for (const error of errors) {
        console.error(render(error, text.split('\n')))
      }

      continue
    }

    const formatted = analysis.format()

    if (formatted === text) {
      continue
    }

    changed++

    if (input.list) {
      process.stdout.write(formatted)
    } else if (input.check) {
      console.log(fade(`  would reformat ${relative}`))
    } else {
      await fs.writeFile(file, formatted, 'utf-8')
      console.log(fade(`  formatted ${relative}`))
    }
  }

  if (broken > 0) {
    process.exit(1)
  }

  if (input.check && changed > 0) {
    logFail(
      `${changed} file${changed === 1 ? ' needs' : 's need'} formatting`,
    )
    process.exit(1)
  }

  if (changed === 0) {
    logGood('All files already formatted')
  } else {
    logGood(`Formatted ${changed} file${changed === 1 ? '' : 's'}`)
  }
}
