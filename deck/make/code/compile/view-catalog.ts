// The catalogs a document composes from, and the one place all three readers of them agree.
//
// A document names four kinds of thing it did not write: a component to place, an operator to apply, a query to
// run, and a package to load. Each is a closed list. A name outside one fails the compile, fails the save, and is
// underlined in the editor, and those three have to be the SAME list or they answer differently. A second copy of
// an allow-list is a second answer to "is this allowed", and the two disagree eventually. That is the argument the
// root CLAUDE.md makes about hand-rolled readers, applied to a permission boundary.
//
// The catalog is DATA, so it is a `host`-dialect file a project supplies. The compiler carries none of it: what a
// document may reach is the project's decision, and word.surf's answer is not the language's.
//
//   host deck, <quenya>
//   list view
//     <text/heading>
//     <sound/phoneme-chart>
//   list call
//     <titlecase>
//   list load
//     <@view/text>
//   list task
//     mesh
//       host name, <filter:phoneme>
//       host back, <list>
//       host size, 200
//       list site
//         mesh
//           host name, <kind>
//           list hold
//             <is-equal>
//             <is-unequal>
//           host sort, true
//
// A `task` entry says what the query returns (`back`), its own result cap (`size`), and per field which predicates
// it accepts and whether it sorts. That last part is not taste: a predicate the resolver cannot push down to an
// index is a full table read wearing the costume of a filter, and this repository has a measured 125,076 ms answer
// to what that costs. See note/term/view/03-find.md and 04-catalog.md.
//
// Deriving the per-field table from a database's own indexes (`deriveSites`, `writeCatalog`, `readRows`) is Term
// since 2026-10-04, compile/catalog-derive.tree. This file reads a catalog, through the data reader.

import { readDataText, toJsonValue } from '@term/make/code/compile/host'
import { writeCatalogSized } from '@term/make/code/compile/catalog-derive'
import type { SiteEntry } from '@term/make/code/compile/catalog-derive'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'

export { deriveSites, readRows } from '@term/make/code/compile/catalog-derive'
export type { IndexRow, SiteEntry } from '@term/make/code/compile/catalog-derive'

export type ViewField = {
  // the predicates this field accepts, because its index can answer them
  hold: Set<string>
  // whether a `sort` may name it
  sort: boolean
}

export type ViewQuery = {
  name: string
  // `one` for a `select:`, `list` for a `filter:`
  back: 'one' | 'list'
  // the largest `size` a document may ask for. A larger one is clamped and said so
  size?: number
  site: Map<string, ViewField>
}

export type ViewCatalog = {
  deck?: string
  view: Set<string>
  call: Set<string>
  load: Set<string>
  task: Map<string, ViewQuery>
}

export function emptyCatalog(): ViewCatalog {
  return { view: new Set(), call: new Set(), load: new Set(), task: new Map() }
}

export type CatalogResult =
  | { ok: true; catalog: ViewCatalog }
  | { ok: false; diagnostics: Diagnostic[] }

export function readCatalog(source: { file: string; text: string }): CatalogResult {
  const data = readDataText(source)

  if (!data.ok) {
    return { ok: false, diagnostics: data.diagnostics }
  }

  const value = toJsonValue(data.data.root, true) as Record<string, unknown>
  const catalog = emptyCatalog()

  if (typeof value.deck === 'string') {
    catalog.deck = value.deck
  }

  for (const name of ['view', 'call', 'load'] as const) {
    for (const one of asList(value[name])) {
      if (typeof one === 'string') {
        catalog[name].add(one)
      }
    }
  }

  for (const one of asList(value.task)) {
    const entry = one as Record<string, unknown>
    const name = typeof entry.name === 'string' ? entry.name : undefined

    if (!name) {
      continue
    }

    const site = new Map<string, ViewField>()

    for (const field of asList(entry.site)) {
      const shape = field as Record<string, unknown>
      const fieldName = typeof shape.name === 'string' ? shape.name : undefined

      if (!fieldName) {
        continue
      }

      site.set(fieldName, {
        hold: new Set(asList(shape.hold).filter((x): x is string => typeof x === 'string')),
        sort: shape.sort === true,
      })
    }

    catalog.task.set(name, {
      name,
      back: entry.back === 'one' ? 'one' : 'list',
      size: typeof entry.size === 'number' ? entry.size : undefined,
      site,
    })
  }

  return { ok: true, catalog }
}

// the `list task` section of a catalog, in the host dialect: a `select:` and a `filter:` per form. The default size
// lives here, where a TypeScript caller can leave it out
export function writeCatalog(sites: Map<string, SiteEntry[]>, size = 500): string {
  return writeCatalogSized(sites, size)
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
