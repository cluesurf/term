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
  const { sources, diagnostics, scope } = collectModules(entry, resolve)
  const symbols: Symbol[] = []
  const offered: Symbol[] = []

  // the entry and every module reached from it through `bear` alone
  const passedOn = new Set<string>([entry.file])
  const queue = [entry.file]

  while (queue.length > 0) {
    for (const next of scope.get(queue.pop()!)?.bears ?? []) {
      if (!passedOn.has(next)) {
        passedOn.add(next)
        queue.push(next)
      }
    }
  }

  for (const source of sources) {
    const parsed = parse(source)

    if (!parsed.ok) {
      continue
    }

    // the doc comment of each top-level `task` and `form`, by kind and name: the comment lines the parser keeps on the
    // definition's group (CST trivia), the `#` and one space taken off each
    const notes = new Map<string, string>()

    for (const group of parsed.tree.nodes) {
      const head = group.nodes[0]
      const named = group.nodes[1]
      const word = (node: typeof head): string =>
        node?.kind === 'name' ? node.parts.map(part => (part.kind === 'chunk' ? part.text : '')).join('') : ''
      const kind = word(head)
      const name = named?.kind === 'group' ? word(named.nodes[0]) : word(named)

      if ((kind === 'task' || kind === 'form') && name && group.comments?.length) {
        notes.set(
          `${kind} ${name}`,
          group.comments.map(comment => comment.text.replace(/^#\s?/, '').trim()).filter(Boolean).join(' '),
        )
      }
    }

    const milled = mill(expandTemplates(parsed.tree), source.file)

    if (!milled.ok) {
      continue
    }

    const module = moduleLabel(source.file)
    const deck = deckOf?.(source.file)?.name ?? deckFromPath(source.file)

    const offers = passedOn.has(source.file)

    for (const statement of milled.program) {
      const before = symbols.length

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
          note: notes.get(`form ${statement.name}`) ?? '',
        })
      } else if (statement.form === 'function') {
        const task: TaskSymbol = {
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
          inferred: false,
          // a method is written inside its form, not at the top level, so a top-level task of its name is not its note
          note: statement.method ? '' : (notes.get(`task ${statement.name}`) ?? ''),
        }

        if (!statement.result) {
          unwritten.add(task)
        }

        symbols.push(task)
      }

      const isPrivate = statement.form === 'function' && statement.private === true

      if (offers && symbols.length > before && !isPrivate) {
        offered.push(symbols[symbols.length - 1]!)
      }
    }
  }

  return {
    symbols,
    offered,
    modules: sources.length,
    offeredModules: sources.filter(source => passedOn.has(source.file)).length,
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
  const rows = ['kind,name,deck,module,signature,note']

  for (const symbol of symbols) {
    rows.push(
      [
        symbol.kind,
        symbol.name,
        symbol.deck,
        symbol.module,
        JSON.stringify(signature(symbol)),
        JSON.stringify(symbol.note),
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

  // a definition's doc comment on the line under it, at the name's column
  return symbols
    .map(
      s =>
        `${s.kind === 'form' ? 'form' : 'task'}  ${s.name.padEnd(
          nameWidth,
        )}  ${s.deck.padEnd(deckWidth)}  ${s.module.padEnd(moduleWidth)}  ${signature(s)}${s.note ? `\n      ${s.note}` : ''}`,
    )
    .join('\n')
}
