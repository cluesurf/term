// The module inspector: compile a module (following its `load`/`bear` graph) and report the symbols it exposes —
// forms (with fields and variants) and tasks (with parameter and result types). Pure and browser-safe: it returns
// structured data; rendering to JSON / CSV / a table is separate. The CLI `term look` drives it. This is the easy way
// to see "what's on" a module — including transitively re-exported (`bear`'d) definitions.
//
// The symbols, the doc comments, the `bear` closure and the three renderings are Term, inspection.tree (self-hosting,
// 2026-10-06). This face walks the load closure with the build's own loader, mills each module (the mill is
// compile/mint-bridge.ts), names a file's deck the way the roll does, and keeps the tasks whose result was not written
// in a WeakSet, which is identity Term does not have.

import { collectModules } from '@term/make/code/compile/load'
import type { Resolver, Source } from '@term/make/code/compile/load'
import type { RootNode } from '@term/make/code/parser/narrow'
import { mill } from '@term/make/code/compile/mill'
import { deckFromPath } from '@term/make/code/compile/roll'
import * as inspection from '@term/make/code/inspection'

export type FormSymbol = {
  kind: 'form'
  name: string
  module: string
  // the deck the module belongs to (`@term/base`), from its nearest deck.tree; the roll names hosts the same way
  deck: string
  fields: { name: string; type: string }[]
  variants: string[]
  // the `#` lines written directly above the definition, joined into one text, empty when there are none
  note: string
}
export type TaskSymbol = {
  kind: 'task'
  name: string
  module: string
  deck: string
  params: { name: string; type: string }[]
  result: string
  // the result was not written (no `like` for it) and was read off the checked program instead (`fillInferred`)
  inferred: boolean
  note: string
}

// the tasks whose source writes no result type: their `unit` is a placeholder, not a claim
const unwritten = new WeakSet<TaskSymbol>()

// fill each unwritten result from a checked program's own: `task twice / take n / back multiply(n, 2)` printed
// `-> unit` because only the source was read (guides: commands/look, 2026-10-04). `results` is task name to type,
// from a compile of the module. A task the compile does not name keeps its placeholder
export function fillInferred(symbols: Symbol[], results: Map<string, string>): void {
  for (const symbol of symbols) {
    if (symbol.kind === 'task' && unwritten.has(symbol) && results.has(symbol.name)) {
      symbol.result = results.get(symbol.name)!
      symbol.inferred = true
    }
  }
}
export type Symbol = FormSymbol | TaskSymbol

export type Inspection = {
  // every definition in the module's load closure
  symbols: Symbol[]
  // what the module OFFERS: its own definitions that are not `mark private`, and those of every module it passes on
  // with `bear`, transitively. `term look` printed the closure, so a file that loaded @term/base/exception listed
  // 23 forms and 154 tasks with its own five at the bottom (guides: commands/look, 2026-10-04)
  offered: Symbol[]
  modules: number
  // how many modules `offered` is drawn from: the entry and its `bear` chain
  offeredModules: number
  loadDiagnostics: number
}

// inspect a module and everything it pulls in via load/bear
export function inspectModule(
  entry: Source,
  resolve: Resolver,
  // the file's deck, the way the CLI and the roll name it (`projectDeckOf`); without it the path's package segment
  deckOf?: (file: string) => { name: string; root: string } | undefined,
): Inspection {
  const { sources, diagnostics, scope } = collectModules(entry, resolve)
  const found = inspection.inspectSources(
    entry.file,
    sources,
    file => scope.get(file)?.bears ?? [],
    (tree, file) => {
      const milled = mill(tree as RootNode, file)

      return milled.ok ? { form: 'some', value: milled.program } : { form: 'none' }
    },
    file => deckOf?.(file)?.name ?? deckFromPath(file),
  )

  for (const task of found.unwritten) {
    unwritten.add(task as TaskSymbol)
  }

  return {
    symbols: found.symbols as Symbol[],
    offered: found.offered as Symbol[],
    modules: sources.length,
    offeredModules: found.offeredModules,
    loadDiagnostics: diagnostics.length,
  }
}

// a one-line signature for a symbol
export function signature(symbol: Symbol): string {
  return inspection.signature(symbol)
}

export function toJson(symbols: Symbol[]): string {
  return inspection.toJson(symbols)
}

// a CSV with a quoted signature column (commas inside are safe)
export function toCsv(symbols: Symbol[]): string {
  return inspection.toCsv(symbols)
}

// a readable aligned table (the default terminal view)
export function toTable(symbols: Symbol[]): string {
  return inspection.toTable(symbols)
}
