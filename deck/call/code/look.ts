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
import {
  dataKeys,
  expandData,
  isDataFile,
  readDataText,
  toJsonValue,
} from '@term/make/code/compile/host'
import { renderDiagnostic } from '@term/call/code/report'
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

  // a data file has no forms or tasks: list its keys instead, a path per row
  if (isDataFile(entry)) {
    lookData(entry, input)

    return
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

// `term look` on a data file: every key as a path, its kind, and its value (or how much a map or a list holds).
// `--json` prints the value itself, keys in snake case, the way `term make` would export it.
function lookData(
  entry: Source,
  input: { target?: string; json?: boolean; csv?: boolean },
): void {
  const read = readDataText(entry)
  const expanded = read.ok ? expandData(read.data, entry.file) : read

  if (!expanded.ok) {
    for (const diagnostic of expanded.diagnostics) {
      console.error(renderDiagnostic(diagnostic, entry.text))
    }

    process.exit(1)
  }

  const keys = dataKeys(expanded.data)

  if (input.json) {
    process.stdout.write(JSON.stringify(toJsonValue(expanded.data), null, 2) + '\n')

    return
  }

  if (input.csv) {
    const cell = (text: string): string => (/[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text)
    process.stdout.write(
      ['path,kind,value', ...keys.map(k => [k.path, k.kind, k.value].map(cell).join(','))].join('\n') + '\n',
    )

    return
  }

  logStep(`Inspecting ${input.target}...`)
  console.log('')

  const pathWidth = Math.max(4, ...keys.map(k => k.path.length))
  const kindWidth = Math.max(4, ...keys.map(k => k.kind.length))
  console.log(`  ${'path'.padEnd(pathWidth)}  ${'kind'.padEnd(kindWidth)}  value`)

  for (const key of keys) {
    console.log(`  ${key.path.padEnd(pathWidth)}  ${key.kind.padEnd(kindWidth)}  ${key.value}`)
  }

  console.log('')
  console.log(fade(`  ${keys.length} key${keys.length === 1 ? '' : 's'}`))
}
