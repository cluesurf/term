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

import { readDataText, toJsonValue } from '@term/make/code/compile/host'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'

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

// ---- deriving the per-field table from a database's own indexes ----
// A `hold` is refused unless the catalog says the field accepts that predicate, and it says so because an index
// answers it. By hand that is two hundred rows for ten forms and it goes stale the day an index changes.
//
// Pure, so it is testable without a database. That matters here: local development points at production, so a
// script that opens a connection is a script that can surprise someone. task/term/view-catalog-derive.ts is a
// thin command over this, and the query it needs is checked in beside it.

export type IndexRow = {
  // the table the index is on, which is the form
  form: string
  // the column, which is the field
  site: string
  // btree, hash, gin, gist, brin
  kind: string
  // whether the index can answer a range, which btree can and hash cannot
  sort: boolean
  // whether the column is a foreign key
  bond: boolean
  // whether the index supports text pattern matching (a *_pattern_ops or trigram index)
  like: boolean
}

export type SiteEntry = { site: string; hold: string[]; sort: boolean }

/**
 * The whole decision, as a pure function, so it is testable without a database.
 */
export function deriveSites(rows: IndexRow[]): Map<string, SiteEntry[]> {
  const byForm = new Map<string, Map<string, SiteEntry>>()

  for (const row of rows) {
    const form = byForm.get(row.form) ?? new Map<string, SiteEntry>()
    byForm.set(row.form, form)

    const held = form.get(row.site) ?? { site: row.site, hold: [], sort: false }
    const hold = new Set(held.hold)

    // an index answers equality, whatever kind it is
    hold.add('is-equal')
    hold.add('is-unequal')

    if (row.bond) {
      // a foreign key resolves to a key lookup. A range over opaque identifiers is never what an author means,
      // and offering it would invite one.
      form.set(row.site, { site: row.site, hold: [...hold].sort(), sort: false })
      continue
    }

    if (row.sort) {
      hold.add('is-above')
      hold.add('is-below')
    }

    if (row.like) {
      hold.add('is-within')
    }

    form.set(row.site, {
      site: row.site,
      hold: [...hold].sort(),
      sort: held.sort || row.sort,
    })
  }

  const out = new Map<string, SiteEntry[]>()

  for (const [form, sites] of byForm) {
    out.set(
      form,
      [...sites.values()].sort((a, b) => a.site.localeCompare(b.site)),
    )
  }

  return out
}

/**
 * The `list task` section of a catalog, in the host dialect: a `select:` and a `filter:` per form.
 */
export function writeCatalog(sites: Map<string, SiteEntry[]>, size = 500): string {
  const out: string[] = ['list task']

  for (const [form, fields] of [...sites].sort((a, b) => a[0].localeCompare(b[0]))) {
    for (const kind of ['select', 'filter'] as const) {
      out.push('  mesh')
      out.push(`    host name, <${kind}:${form}>`)
      out.push(`    host back, <${kind === 'select' ? 'one' : 'list'}>`)

      if (kind === 'filter') {
        out.push(`    host size, ${size}`)
      }

      out.push('    list site')

      for (const field of fields) {
        out.push('      mesh')
        out.push(`        host name, <${field.site}>`)
        out.push('        list hold')

        for (const one of field.hold) {
          out.push(`          <${one}>`)
        }

        out.push(`        host sort, ${field.sort ? 'true' : 'false'}`)
      }
    }
  }

  return out.join('\n') + '\n'
}

/**
 * Read the tab-separated rows the query emits. Six columns, in the order the .sql file selects them.
 */
export function readRows(text: string): IndexRow[] {
  const rows: IndexRow[] = []

  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue
    }

    const [form, site, kind, sort, bond, like] = line.split('\t')

    if (!form || !site) {
      continue
    }

    rows.push({
      form,
      site,
      kind: kind ?? 'btree',
      sort: sort === 't' || sort === 'true',
      bond: bond === 't' || bond === 'true',
      like: like === 't' || like === 'true',
    })
  }

  return rows
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
