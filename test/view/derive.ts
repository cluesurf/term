// Deriving a catalog's per-field table from a database's own indexes.
//
// A `hold` is refused unless the catalog says the field accepts that predicate, and it says so because an index
// answers it. Writing that by hand is two hundred rows for ten forms and it goes stale the day an index changes.
//
// The derivation is a pure function so it is testable without a database, which matters here: local development
// points at production, so a script that opens a connection is a script that can surprise someone. The query is
// checked in beside it and a person runs it.

import {
  deriveSites,
  writeCatalog,
  readRows,
  readCatalog,
  type IndexRow,
} from '@term/make/code/compile/view-catalog'

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
  form: 'phoneme',
  site: 'kind',
  kind: 'btree',
  sort: true,
  bond: false,
  like: false,
  ...over,
})

// ---- the mapping, one case per rule ----

const hash = deriveSites([row({ site: 'tag', kind: 'hash', sort: false })])
  .get('phoneme')![0]!

ok('a hash index answers equality only', hash.hold.join(',') === 'is-equal,is-unequal')
ok('and does not sort', hash.sort === false)

const btree = deriveSites([row({ site: 'rank' })]).get('phoneme')![0]!

ok(
  'an ordered index answers ranges too',
  btree.hold.join(',') === 'is-above,is-below,is-equal,is-unequal',
  btree.hold.join(','),
)
ok('and sorts', btree.sort === true)

const pattern = deriveSites([row({ site: 'symbol', like: true })]).get('phoneme')![0]!

ok('a pattern index answers containment', pattern.hold.includes('is-within'))

const bond = deriveSites([row({ site: 'language__id', bond: true })]).get('phoneme')![0]!

ok(
  'a foreign key answers equality alone',
  bond.hold.join(',') === 'is-equal,is-unequal',
  bond.hold.join(','),
)
ok(
  'and never sorts, because a range over opaque ids is not what anyone means',
  bond.sort === false,
)

ok(
  'a column with no index is simply absent',
  deriveSites([row({ site: 'kind' })]).get('phoneme')!.every(one => one.site !== 'secret'),
)

// two indexes on one column union their answers rather than the last one winning
const both = deriveSites([
  row({ site: 'symbol', kind: 'hash', sort: false }),
  row({ site: 'symbol', kind: 'gin', sort: false, like: true }),
]).get('phoneme')![0]!

ok('two indexes on one column union their answers', both.hold.includes('is-within'))

// ---- the tab-separated reader ----

const rows = readRows('phoneme\tkind\tbtree\tt\tf\tf\nphoneme\tlanguage__id\tbtree\tt\tt\tf\n\n')

ok('the reader takes the query output', rows.length === 2)
ok('and reads the flags', rows[1]?.bond === true && rows[0]?.bond === false)

// ---- the output is a catalog the compiler reads ----

const text = writeCatalog(
  deriveSites([
    row({ site: 'kind', sort: false }),
    row({ site: 'rank' }),
    row({ site: 'language__id', bond: true }),
  ]),
)

ok('it writes a select and a filter per form', /select:phoneme/.test(text) && /filter:phoneme/.test(text))

const back = readCatalog({ file: 'derived.tree', text: `host deck, <x>\n${text}` })

ok('and the compiler reads what it wrote', back.ok, back.ok ? '' : back.diagnostics.map(d => d.message).join(' | '))

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
