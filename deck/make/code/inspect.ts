// The module inspector: compile a module (following its `load`/`bear` graph) and report the symbols it exposes —
// forms (with fields and variants) and tasks (with parameter and result types). Pure and browser-safe: it returns
// structured data; rendering to JSON / CSV / a table is separate. The CLI `term look` drives it. This is the easy way
// to see "what's on" a module — including transitively re-exported (`bear`'d) definitions.

import { collectModules } from '@term/make/code/compile/load'
import type { Resolver, Source } from '@term/make/code/compile/load'
import { parse } from '@term/make/code/parser/tree'
import { expandTemplates } from '@term/make/code/compile/template'
import { mill } from '@term/make/code/compile/mill'
import { showType } from '@term/make/code/compile/node'
import { deckFromPath } from '@term/make/code/compile/roll'

export type FormSymbol = {
  kind: 'form'
  name: string
  module: string
  // the deck the module belongs to (`@term/seed`), from its nearest deck.tree; the roll names hosts the same way
  deck: string
  fields: { name: string; type: string }[]
  variants: string[]
}
export type TaskSymbol = {
  kind: 'task'
  name: string
  module: string
  deck: string
  params: { name: string; type: string }[]
  result: string
}
export type Symbol = FormSymbol | TaskSymbol

export type Inspection = {
  symbols: Symbol[]
  modules: number
  loadDiagnostics: number
}

// short module label: the last two path segments without the .tree suffix
function moduleLabel(file: string): string {
  return file
    .replace(/\.tree$/, '')
    .split('/')
    .slice(-2)
    .join('/')
}

// inspect a module and everything it pulls in via load/bear
export function inspectModule(
  entry: Source,
  resolve: Resolver,
  // the file's deck, the way the CLI and the roll name it (`projectDeckOf`); without it the path's package segment
  deckOf?: (file: string) => { name: string; root: string } | undefined,
): Inspection {
  const { sources, diagnostics } = collectModules(entry, resolve)
  const symbols: Symbol[] = []

  for (const source of sources) {
    const parsed = parse(source)

    if (!parsed.ok) {
      continue
    }

    const milled = mill(expandTemplates(parsed.tree), source.file)

    if (!milled.ok) {
      continue
    }

    const module = moduleLabel(source.file)
    const deck = deckOf?.(source.file)?.name ?? deckFromPath(source.file)

    for (const statement of milled.program) {
      if (statement.form === 'record-type') {
        symbols.push({
          kind: 'form',
          name: statement.name,
          module,
          deck,
          fields: statement.fields.map(f => ({
            name: f.name,
            type: showType(f.type),
          })),
          variants: statement.variants.map(v => v.name),
        })
      } else if (statement.form === 'function') {
        symbols.push({
          kind: 'task',
          name: statement.name,
          module,
          deck,
          params: statement.params.map(p => ({
            name: p.name,
            type: p.type ? showType(p.type) : 'unknown',
          })),
          result: statement.result
            ? showType(statement.result)
            : 'unit',
        })
      }
    }
  }

  return {
    symbols,
    modules: sources.length,
    loadDiagnostics: diagnostics.length,
  }
}

// a one-line signature for a symbol
export function signature(symbol: Symbol): string {
  if (symbol.kind === 'form') {
    const fields = symbol.fields
      .map(f => `${f.name}: ${f.type}`)
      .join('; ')

    const variants = symbol.variants.length
      ? ` | ${symbol.variants.join(' | ')}`
      : ''

    return `{ ${fields} }${variants}`
  }

  return `(${symbol.params
    .map(p => `${p.name}: ${p.type}`)
    .join(', ')}) -> ${symbol.result}`
}

export function toJson(symbols: Symbol[]): string {
  return JSON.stringify(symbols, null, 2)
}

// a CSV with a quoted signature column (commas inside are safe)
export function toCsv(symbols: Symbol[]): string {
  const rows = ['kind,name,deck,module,signature']

  for (const symbol of symbols) {
    rows.push(
      [
        symbol.kind,
        symbol.name,
        symbol.deck,
        symbol.module,
        JSON.stringify(signature(symbol)),
      ].join(','),
    )
  }

  return rows.join('\n')
}

// a readable aligned table (the default terminal view)
export function toTable(symbols: Symbol[]): string {
  const width = (key: keyof Symbol) =>
    Math.max(0, ...symbols.map(s => String(s[key] ?? '').length))

  const nameWidth = width('name')
  const deckWidth = width('deck')
  const moduleWidth = width('module')

  return symbols
    .map(
      s =>
        `${s.kind === 'form' ? 'form' : 'task'}  ${s.name.padEnd(
          nameWidth,
        )}  ${s.deck.padEnd(deckWidth)}  ${s.module.padEnd(moduleWidth)}  ${signature(s)}`,
    )
    .join('\n')
}
