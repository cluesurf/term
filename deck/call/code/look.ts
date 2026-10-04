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
import { projectDeckOf } from '@term/call/code/deck-of'
import {
  dataKeys,
  expandData,
  isDataFile,
  readDataText,
  toJsonValue,
} from '@term/make/code/compile/host'
import { closeRun, count, field, openRun, printData, report, reportProblems } from '@term/call/code/output'

// `term look <module>` -- inspect what a module exposes (forms + tasks with signatures), following its load/bear
// graph. The target is a package path (`@cluesurf/bind/code/browser/dom`) or a `.tree` file. Output: table (default),
// `--json`, or `--csv`.
//
// THE ANSWER IS DATA. The table, the JSON and the CSV go to stdout as they always read, through `printData`, so a
// pipe gets them clean; the run around them (what was read, the counts, a failure) is items on stderr.
export async function callLook(input: {
  root: string
  target?: string
  json?: boolean
  csv?: boolean
  kind?: string
}): Promise<void> {
  openRun({ verb: 'look', root: input.root, facts: [...(input.target ? [input.target] : []), ...(input.kind ? [input.kind] : [])] })

  if (!input.target) {
    report({ glyph: 'failed', kind: 'problem', subject: 'Name a module to look at' })
    closeRun({ verdict: 'Nothing to look at', next: 'term look <module> [--json|--csv] [--kind form|task]', failure: 'usage' })

    return
  }

  const resolve = projectResolver(input.root)

  // a package path resolves through the project resolver; otherwise it is a file on disk
  let entry: Source | undefined

  if (input.target.startsWith('@')) {
    entry = resolve(input.target, input.root)

    if (!entry) {
      report({ glyph: 'failed', kind: 'problem', verb: 'resolve', subject: `${input.target} does not resolve`, fields: [field('why', 'the package may not be linked')] })
      closeRun({ verdict: 'Nothing to look at', next: 'term link' })

      return
    }
  } else {
    const file = path.resolve(input.root, input.target)

    try {
      entry = { file, text: readFileSync(file, 'utf-8') }
    } catch {
      report({ glyph: 'failed', kind: 'problem', verb: 'read', subject: `There is no file ${input.target}` })
      closeRun({ verdict: 'Nothing to look at' })

      return
    }
  }

  // a data file has no forms or tasks: list its keys instead, a path per row
  if (isDataFile(entry)) {
    lookData(entry, input, input.root)

    return
  }

  const { symbols, modules, loadDiagnostics } = inspectModule(
    entry,
    resolve,
    projectDeckOf(),
  )

  const filtered = input.kind
    ? symbols.filter(s => s.kind === input.kind)
    : symbols

  if (input.json) {
    printData(toJson(filtered) + '\n')
  } else if (input.csv) {
    printData(toCsv(filtered) + '\n')
  } else {
    printData(toTable(filtered) + '\n')
  }

  const forms = symbols.filter(s => s.kind === 'form').length
  const tasks = symbols.filter(s => s.kind === 'task').length

  if (loadDiagnostics) {
    report({ glyph: 'warning', verb: 'resolve', subject: 'Some imports did not resolve', counts: [count(loadDiagnostics, 'unresolved', 'unresolved')] })
  }

  closeRun({
    verdict: `${filtered.length} name${filtered.length === 1 ? '' : 's'} listed`,
    counts: [count(modules, 'modules', 'module'), count(forms, 'forms', 'form'), count(tasks, 'tasks', 'task')],
  })
}

// `term look` on a data file: every key as a path, its kind, and its value (or how much a map or a list holds).
// `--json` prints the value itself, keys in snake case, the way `term make` would export it.
function lookData(
  entry: Source,
  input: { target?: string; json?: boolean; csv?: boolean },
  root: string,
): void {
  const read = readDataText(entry)
  const expanded = read.ok ? expandData(read.data, entry.file) : read

  if (!expanded.ok) {
    // each defect a Problem item with its frame (section 12)
    reportProblems(expanded.diagnostics.map(diagnostic => ({ diagnostic, text: entry.text })), root)
    closeRun({ verdict: 'The data file does not read' })

    return
  }

  const keys = dataKeys(expanded.data)

  if (input.json) {
    printData(JSON.stringify(toJsonValue(expanded.data), null, 2) + '\n')
  } else if (input.csv) {
    const cell = (text: string): string => (/[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text)
    printData(['path,kind,value', ...keys.map(k => [k.path, k.kind, k.value].map(cell).join(','))].join('\n') + '\n')
  } else {
    const pathWidth = Math.max(4, ...keys.map(k => k.path.length))
    const kindWidth = Math.max(4, ...keys.map(k => k.kind.length))
    const lines = [`  ${'path'.padEnd(pathWidth)}  ${'kind'.padEnd(kindWidth)}  value`]

    for (const key of keys) {
      lines.push(`  ${key.path.padEnd(pathWidth)}  ${key.kind.padEnd(kindWidth)}  ${key.value}`)
    }

    printData(lines.join('\n') + '\n')
  }

  closeRun({ verdict: `${keys.length} key${keys.length === 1 ? '' : 's'} listed`, facts: ['data'] })
}
