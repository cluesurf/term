/**
 * Derive the per-field half of a view catalog from a database's own indexes.
 *
 * A `hold` in a document is refused unless the catalog says the field accepts that predicate, and the catalog
 * says so because an index answers it. Writing that table by hand is two hundred rows for ten forms and it goes
 * stale the day an index changes. Deriving it is free and always true.
 *
 * The input is index rows, not a connection. This script does not open one: local development points at the
 * production database, so a script that connects is a script that can surprise someone. Run the query yourself
 * and pipe the result in.
 *
 *   psql "$DATABASE_URL" -At -F$'\t' -f task/term/view-catalog-derive.sql > /tmp/index.tsv
 *   pnpm view:derive /tmp/index.tsv
 *   pnpm view:derive /tmp/index.tsv --commit catalog.tree
 *
 * Paths are resolved from `the Term root`, because the alias this imports only resolves there, which is
 * why the alias in package.json does the `cd` the way `term:unknown-types` does. Give it an absolute path.
 *
 * Reports by default and writes only on `--commit`, like everything else here.
 *
 * The mapping, and the reason for each row:
 *
 *   any index on a column      is-equal, is-unequal    an index answers equality
 *   an ORDERED index (btree)   plus is-above, is-below a range scan answers it, and the field may sort
 *   a text pattern index       plus is-within          a prefix or trigram index answers containment
 *   no index                   nothing                 a filter on it is a full table read wearing a costume
 *
 * A foreign key gets `is-equal` alone even when its index is ordered, because a range over opaque identifiers is
 * never what an author means and answering it would invite one.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import {
  deriveSites,
  writeCatalog,
  readRows,
} from '@term/make/code/compile/view-catalog'

function main(): void {
  const args = process.argv.slice(2)
  const commit = args.indexOf('--commit')
  const into = commit === -1 ? undefined : args[commit + 1]
  const from = args.find(one => !one.startsWith('--') && one !== into)

  if (!from || !existsSync(from)) {
    console.error('usage: pnpm view:derive <index.tsv> [--commit <catalog.tree>]')
    console.error('       run task/term/view-catalog-derive.sql against the database to make index.tsv')
    process.exit(2)
  }

  const rows = readRows(readFileSync(from, 'utf8'))
  const sites = deriveSites(rows)
  const text = writeCatalog(sites)

  console.log(`${rows.length} index rows over ${sites.size} forms`)

  for (const [form, fields] of [...sites].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sorted = fields.filter(one => one.sort).length

    console.log(`  ${form.padEnd(24)} ${String(fields.length).padStart(3)} filterable, ${sorted} sortable`)
  }

  if (!into) {
    console.log('\nreporting only. Pass --commit <file> to write the catalog section')

    return
  }

  writeFileSync(into, text)
  console.log(`\nwrote ${into}`)
}

if (process.argv[1]?.endsWith('view-catalog-derive.ts')) {
  main()
}
