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
// since 2026-10-04, compile/catalog-derive.tree, and reading a catalog since 2026-10-06, compile/catalog-read.tree.
// This file is the face: it turns the port's lists into the `Set`s callers hold.

import { readCatalogText } from '@term/make/code/compile/catalog-read'
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
  const read = readCatalogText(source)

  if (!read.ok) {
    return { ok: false, diagnostics: read.diagnostics }
  }

  // a `void` or a `fuse` where a query or a field belongs was `null` to the JSON the original read, and it threw here
  if (read.nullRead) {
    throw new TypeError("Cannot read properties of null (reading 'name')")
  }

  const catalog = emptyCatalog()

  if (read.deck.form === 'some') {
    catalog.deck = read.deck.value
  }

  catalog.view = new Set(read.view)
  catalog.call = new Set(read.call)
  catalog.load = new Set(read.load)

  for (const [name, query] of read.task) {
    const site = new Map<string, ViewField>()

    for (const [fieldName, field] of query.site) {
      site.set(fieldName, { hold: new Set(field.hold), sort: field.sort })
    }

    catalog.task.set(name, {
      name: query.name,
      back: query.back === 'one' ? 'one' : 'list',
      size: query.size.form === 'some' ? query.size.value : undefined,
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
