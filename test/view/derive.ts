// Deriving a catalog's per-field table from a database's own indexes: the catalog it writes, read back by the
// compiler's catalog reader.
//
// The derivation itself is Term since 2026-10-04 (deck/make/code/compile/catalog-derive.tree) and so are its checks,
// deck/make/test/catalog-derive.tree. What stays here reads the written catalog back through `readCatalog`, which goes
// through the data reader (compile/host.ts) and is TypeScript.

import { deriveSites, writeCatalog, readCatalog, type IndexRow } from '@term/make/code/compile/view-catalog'

let pass = 0
let fail = 0

function ok(what: string, held: boolean, note = ''): void {
  if (held) {
    pass++
    console.log(`ok    ${what}`)
  } else {
    fail++
    console.log(`FAIL  ${what}  ${note}`)
  }
}

const row = (over: Partial<IndexRow>): IndexRow => ({
  table: 'phoneme',
  site: 'kind',
  kind: 'btree',
  sort: true,
  bond: false,
  pattern: false,
  ...over,
})

const text = writeCatalog(
  deriveSites([
    row({ site: 'kind', sort: false }),
    row({ site: 'rank' }),
    row({ site: 'language__id', bond: true }),
  ]),
)

const back = readCatalog({ file: 'derived.tree', text: `host deck, <x>\n${text}` })

ok('the compiler reads what it wrote', back.ok, back.ok ? '' : back.diagnostics.map(d => d.message).join(' | '))

if (back.ok) {
  const filter = back.catalog.task.get('filter:phoneme')

  ok('the filter returns a list', filter?.back === 'list')
  ok('an ordered field sorts', filter?.site.get('rank')?.sort === true)
  ok('an unordered field does not', filter?.site.get('kind')?.sort === false)
  ok(
    'a foreign key takes equality alone',
    filter?.site.get('language__id')?.hold.has('is-above') === false,
  )
}

console.log(`\nview-derive: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
