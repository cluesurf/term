// The four closed vocabularies, and the messages a document gets when it steps outside one.
//
// A name outside a catalog fails the compile, fails the save, and is underlined in the editor, and the three read
// the SAME registry, so they cannot answer differently. See note/term/view/04-catalog.md.

import { parse } from '@term/make/code/parser/tree'
import { readView } from '@term/make/code/compile/view'
import { readCatalog, emptyCatalog } from '@term/make/code/compile/view-catalog'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const CATALOG = `
host deck, <quenya>
list view
  <text/heading>
  <text/item>
  <sound/phoneme-chart>
list call
  <titlecase>
  <weld>
list load
  <@view/text>
  <@view/sound>
list task
  mesh
    host name, <filter:phoneme>
    host back, <list>
    host size, 200
    list site
      mesh
        host name, <kind>
        list hold
          <is-equal>
          <is-unequal>
        host sort, false
      mesh
        host name, <rank>
        list hold
          <is-equal>
          <is-above>
          <is-below>
        host sort, true
  mesh
    host name, <select:language>
    host back, <one>
    list site
      mesh
        host name, <slug>
        list hold
          <is-equal>
        host sort, false
`

const read = readCatalog({ file: 'catalog.tree', text: CATALOG })

ok('the catalog reads', read.ok, read.ok ? '' : read.diagnostics.map(d => d.message).join(' | '))

if (!read.ok) {
  process.exit(1)
}

const catalog = read.catalog

ok('it names its deck', catalog.deck === 'quenya')
ok('it registers three components', catalog.view.size === 3)
ok('it registers two operators', catalog.call.size === 2)
ok('it registers two packages', catalog.load.size === 2)
ok('it registers two queries', catalog.task.size === 2)
ok('a filter returns a list', catalog.task.get('filter:phoneme')?.back === 'list')
ok('a select returns one', catalog.task.get('select:language')?.back === 'one')
ok('a query carries its own cap', catalog.task.get('filter:phoneme')?.size === 200)
ok(
  'a field says which predicates it accepts',
  catalog.task.get('filter:phoneme')?.site.get('rank')?.hold.has('is-above') === true,
)
ok(
  'a field says whether it sorts',
  catalog.task.get('filter:phoneme')?.site.get('rank')?.sort === true &&
    catalog.task.get('filter:phoneme')?.site.get('kind')?.sort === false,
)

function check(text: string) {
  const parsed = parse({ file: 'page.tree', text })

  if (!parsed.ok) {
    return { ok: false as const, said: parsed.diagnostics.map(d => d.message).join(' | ') }
  }

  const result = readView(parsed.tree, 'page.tree', catalog)

  return { ok: result.ok, said: result.diagnostics.map(d => d.message).join(' | ') }
}

function refuses(what: string, text: string, word: string): void {
  const result = check(text)

  ok(`refuses ${what}`, !result.ok && result.said.includes(word), result.said || '(no diagnostic)')
}

// ---- a document inside every catalog ----

const GOOD = `
load @view/sound
  find phoneme-chart

find vowel
  task <filter:phoneme>
  meet and
    hold is-equal
      read self/kind
      text <vowel>
    hold is-above
      read self/rank
      20
  sort fall, read self/rank
  size 50

view page
  view sound/phoneme-chart
    bind name
      call titlecase
        text <quenya>
`

const good = check(GOOD)

ok('a document inside every catalog reads', good.ok, good.said)

// ---- and outside each of them ----

refuses('a component that is not registered',
  'view page\n  view text/nowhere\n    bind a, text <x>\n', 'not a component this document may place')
refuses('an operator that is not registered',
  'view page\n  view text/item\n    bind a\n      call shout\n        text <x>\n', 'not a registered operator')
refuses('a package that is not registered',
  'load @view/secret\n  find thing\n', 'not a package this document may load')
refuses('a query that is not registered',
  'find v\n  task <filter:nowhere>\n', 'not a registered query')
refuses('a field the query cannot filter',
  'find v\n  task <filter:phoneme>\n  hold is-equal\n    read self/nowhere\n    text <x>\n',
  'has no filterable field')
refuses('a predicate no index answers',
  'find v\n  task <filter:phoneme>\n  hold is-above\n    read self/kind\n    text <x>\n',
  'does not accept "is-above"')
refuses('a sort on a field with no ordered index',
  'find v\n  task <filter:phoneme>\n  sort rise, read self/kind\n',
  'does not sort on "kind"')
refuses('a size over the query cap',
  'find v\n  task <filter:phoneme>\n  size 5000\n', 'caps at 200')

// ---- the message names what was probably meant ----

const typo = check('view page\n  view text/headng\n    bind a, text <x>\n')

ok('a near miss says what was meant', typo.said.includes('Did you mean "text/heading"?'), typo.said)

const far = check('view page\n  view zzz/qqq\n    bind a, text <x>\n')

ok('a far miss says how many there are', far.said.includes('registers 3'), far.said)

// ---- no catalog means no checking, which is what the other suites want ----

const bare = (() => {
  const parsed = parse({ file: 'page.tree', text: 'view page\n  view any/thing\n    bind a, text <x>\n' })

  return parsed.ok ? readView(parsed.tree, 'page.tree') : { ok: false }
})()

ok('without a catalog no name is checked', bare.ok)

const empty = (() => {
  const parsed = parse({ file: 'page.tree', text: 'view page\n  view any/thing\n    bind a, text <x>\n' })

  return parsed.ok ? readView(parsed.tree, 'page.tree', emptyCatalog()) : { ok: true }
})()

ok('an empty catalog registers nothing, so everything is refused', !empty.ok)

// ---- the reference catalog, checked in beside this test ----
// The scope decision written as data rather than as prose, so a review sees the reachable surface change. Three
// operator scopes are absent on purpose and this asserts each one stays absent.

const HERE = dirname(fileURLToPath(import.meta.url))
const reference = readCatalog({
  file: 'catalog.tree',
  text: readFileSync(join(HERE, 'catalog.tree'), 'utf8'),
})

ok('the reference catalog reads', reference.ok, reference.ok ? '' : reference.diagnostics.map(d => d.message).join(' | '))

if (reference.ok) {
  const it = reference.catalog

  ok('it registers the six view packages', it.load.size === 6)
  ok('it registers the linguistic components', it.view.has('sound/phoneme-chart') && it.view.has('sound/paradigm-table'))
  ok('it registers the string scope', it.call.has('titlecase') && it.call.has('weld'))
  ok('it registers the math scope', it.call.has('clamp') && it.call.has('sum'))
  ok('it registers the boolean scope', it.call.has('negate') && it.call.has('gte'))
  ok('it registers the list scope', it.call.has('count') && it.call.has('slice'))

  // the seven list operators that take a callback are cut, because a document has no way to write one and
  // giving `tree` a calling convention would be a second spelling of `walk` and `fork`
  for (const word of ['keep', 'morph', 'find', 'locate', 'group', 'sort', 'dedupe']) {
    ok(`a callback-taking list operator stays out: no "${word}"`, !it.call.has(word))
  }

  // the three refused scopes, each asserted absent
  for (const word of ['walk', 'loop', 'branch', 'switch', 'match', 'pick', 'attempt']) {
    ok(`the control scope stays out: no "${word}"`, !it.call.has(word))
  }

  for (const word of ['random', 'uuid']) {
    ok(`the random scope stays out: no "${word}"`, !it.call.has(word))
  }

  ok('the resource scope stays out: no "resolve"', !it.call.has('resolve'))
  ok('`now` is cut from the date scope', !it.call.has('now') && it.call.has('shift'))
  ok('`parse-json` is cut from the type scope', !it.call.has('parse-json') && it.call.has('cast'))

  ok('a query declares what it returns', it.task.get('select:language')?.back === 'one')
  ok('and its per-field predicates', it.task.get('filter:phoneme')?.site.get('symbol')?.hold.has('is-within') === true)
}

console.log(`\nview-catalog: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
