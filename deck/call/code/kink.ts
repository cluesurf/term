// `term show kink [name]`: what a diagnostic means and what resolves it, looked up by the name or code a run printed.
// Every compiler diagnostic (make/code/parser/diagnostic.tree, the catalog) and every lint finding (the driver's
// `lintCatalog` and the manifest findings in call/code/lint.ts) has one entry, so any code `term make`, `term scan` or
// `term lint` prints can be looked up. Without a name it lists them all, which is the catalog an agent reads once.
//
// A compiler code is printed in hexadecimal and padded (`0036`) and is a number in JSON (`54`), so a lookup reads four
// digits as the printed form, `0x` as hexadecimal, and any other run of digits as the JSON number.

import { diagnosticNames, entryOf, nearest } from '@term/make/code/parser/diagnostic'
import { FIXABLE } from '@term/make/code/fix'
import { lintCatalog } from '@term/make/code/lint/lint'
import { MANIFEST_CATALOG } from '@term/call/code/lint'
import { closeRun, field, openRun, printData, report } from '@term/call/code/output'
import * as port from '@term/call/code/kink-find'

export type Kink = {
  // `compiler` for a diagnostic the build reports, `lint` for a finding `term lint` reports
  kind: 'compiler' | 'lint'
  name: string
  // the compiler's number (`54`), or a lint rule's code (`L019`)
  code: number | string
  // the code as a run prints it: `0036`, `L019`
  label: string
  severity: string
  // what it means
  says: string
  // how to resolve it, where the catalog says. A lint rule's own text says both at once
  remedy?: string
  // whether a tool offers the change: `term scan` and an editor's quick fix for the compiler's, `term lint --fix` for a
  // lint rule's
  fixable: boolean
  // for a compiler diagnostic that is fixable: `sure` when `term scan --fix` writes the fix, `guess` when it is offered
  // and the author picks
  fixes?: 'sure' | 'guess'
}

// every entry, the compiler's in catalog order and then the lint findings by code
export function kinkCatalog(): Kink[] {
  const compiler = diagnosticNames().map((name): Kink => {
    const entry = entryOf(name)

    return {
      kind: 'compiler',
      name,
      code: entry.code,
      label: entry.code.toString(16).padStart(4, '0'),
      severity: entry.severity,
      says: entry.message,
      remedy: entry.fix,
      fixable: FIXABLE.has(name),
      ...(FIXABLE.has(name) ? { fixes: FIXABLE.get(name) } : {}),
    }
  })

  const lint = [...lintCatalog(), ...MANIFEST_CATALOG]
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((rule): Kink => ({
      kind: 'lint',
      name: rule.name,
      code: rule.code,
      label: rule.code,
      severity: rule.severity,
      says: rule.docs,
      fixable: rule.fixable,
    }))

  return [...compiler, ...lint]
}

// an entry as the port reads it: a lint rule's code is its label, and an absent remedy or fix kind the empty text
function portKink(kink: Kink): port.Kink {
  return {
    kind: kink.kind,
    name: kink.name,
    number: typeof kink.code === 'number' ? kink.code : -1,
    label: kink.label,
    severity: kink.severity,
    says: kink.says,
    remedy: kink.remedy ?? '',
    fixable: kink.fixable,
    fixes: kink.fixes ?? '',
  }
}

// the entry a query names: a name, a lint code, or a compiler code in any of the three spellings a run uses. The
// reading of the query is Term, call/code/kink-find.tree, and the entry it names is handed back as the catalog had it
export function findKink(query: string): Kink | undefined {
  const all = kinkCatalog()
  const asked = all.map(portKink)
  const found = port.findKink(query, asked)

  return found.form === 'some' ? all[asked.indexOf(found.value)] : undefined
}

function asJson(kink: Kink): Record<string, unknown> {
  return {
    kind: kink.kind,
    name: kink.name,
    code: kink.code,
    label: kink.label,
    severity: kink.severity,
    says: kink.says,
    ...(kink.remedy ? { remedy: kink.remedy } : {}),
    fixable: kink.fixable,
    ...(kink.fixes ? { fixes: kink.fixes } : {}),
  }
}

export function showKink(input: { root: string; query?: string; json: boolean }): void {
  if (input.query === undefined) {
    const all = kinkCatalog()

    printData(
      input.json
        ? `${JSON.stringify(all.map(asJson))}\n`
        : all.map(kink => port.listed(portKink(kink))).join(''),
    )

    return
  }

  const kink = findKink(input.query)

  if (!kink) {
    const near = nearest(input.query.toLowerCase(), kinkCatalog().map(one => one.name))

    if (input.json) {
      printData(`${JSON.stringify({ error: 'not-found', query: input.query, ...(near ? { nearest: near } : {}) })}\n`)
      process.exitCode = 1

      return
    }

    openRun({ verb: 'show', root: input.root })
    report({ glyph: 'failed', kind: 'problem', subject: `There is no diagnostic named ${input.query}`, ...(near ? { fields: [field('near', near)] } : {}) })
    closeRun({ verdict: 'Nothing shown', next: 'term show kink, which lists every name and code' })

    return
  }

  if (input.json) {
    printData(`${JSON.stringify(asJson(kink))}\n`)

    return
  }

  printData(port.shown(portKink(kink)))
}
