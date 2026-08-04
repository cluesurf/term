import { readFileSync } from 'fs'
import path from 'path'
import {
  inspectModule,
  toJson,
  toCsv,
  toTable,
} from '@term/make/code/inspect'
import type { Source } from '@term/make/code/compile/load'
import { projectResolver } from '@term/call/code/make'
import { logFail, logStep, fade } from '@term/make/code/tint'

// `seed look <module>` -- inspect what a module exposes (forms + tasks with signatures), following its load/bear
// graph. The target is a package path (`@cluesurf/bind/code/browser/dom`) or a `.tree` file. Output: table (default),
// `--json`, or `--csv`.
export async function callLook(input: {
  root: string
  target?: string
  json?: boolean
  csv?: boolean
  kind?: string
}): Promise<void> {
  if (!input.target) {
    logFail(
      'Usage: seed look <module> [--json|--csv] [--kind form|task]',
    )
    process.exit(1)
  }

  const resolve = projectResolver(input.root)

  // a package path resolves through the project resolver; otherwise it is a file on disk
  let entry: Source | undefined

  if (input.target.startsWith('@')) {
    entry = resolve(input.target, input.root)

    if (!entry) {
      logFail(
        `Could not resolve ${input.target} (is the package linked? run \`seed link\`)`,
      )
      process.exit(1)
    }
  } else {
    const file = path.resolve(input.root, input.target)

    try {
      entry = { file, text: readFileSync(file, 'utf-8') }
    } catch {
      logFail(`File not found: ${input.target}`)
      process.exit(1)
    }
  }

  if (!input.json && !input.csv) {
    logStep(`Inspecting ${input.target}...`)
  }

  const { symbols, modules, loadDiagnostics } = inspectModule(
    entry,
    resolve,
  )

  const filtered = input.kind
    ? symbols.filter(s => s.kind === input.kind)
    : symbols

  if (input.json) {
    process.stdout.write(toJson(filtered) + '\n')
  } else if (input.csv) {
    process.stdout.write(toCsv(filtered) + '\n')
  } else {
    console.log('')
    console.log(toTable(filtered))

    const forms = symbols.filter(s => s.kind === 'form').length
    const tasks = symbols.filter(s => s.kind === 'task').length
    console.log('')
    console.log(
      fade(
        `  ${modules} module(s), ${forms} form(s), ${tasks} task(s)${
          loadDiagnostics
            ? `, ${loadDiagnostics} unresolved import(s)`
            : ''
        }`,
      ),
    )
  }
}
