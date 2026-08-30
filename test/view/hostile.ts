// One document per bound, each trying to break it.
//
// Assume the author is hostile and skilled: they can craft any input the editor accepts, and any input the editor
// would never produce, by calling the API directly. Every row of the table in note/term/view/05-sandbox.md is a
// case here, and each asserts the MESSAGE and not only the refusal, because a bound that fires without saying
// which bound it was is a bug report nobody can act on.
//
// A bound with no test is a claim, not a guarantee. This is the file that turns the claims into guarantees.

import { parse } from '@term/make/code/parser/tree'
import { readView, checkView } from '@term/make/code/compile/view'
import { readCatalog } from '@term/make/code/compile/view-catalog'
import { compile } from '@term/make/code/compile/compile'
import { VIEW_CAPS } from '@term/make/code/compile/view-cap'
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

const HERE = dirname(fileURLToPath(import.meta.url))
const loaded = readCatalog({
  file: 'catalog.tree',
  text: readFileSync(join(HERE, 'catalog.tree'), 'utf8'),
})

if (!loaded.ok) {
  console.error('the reference catalog does not read')
  process.exit(1)
}

const catalog = loaded.catalog

// Every attack goes through the WHOLE path a save would: parse, cycle check, expand, read with the catalog and
// the caps. Testing a stage in isolation would prove less than a document actually being refused.
function attack(text: string): string {
  // `checkView` and nothing else. Restating its stages here would be a second copy of the gate, and the suite's
  // whole claim is that a save and this agree, which a copy cannot establish.
  const result = checkView({ file: 'page.tree', text }, { catalog, caps: VIEW_CAPS })

  return result.ok ? '' : result.diagnostics.map(d => d.message).join(' | ')
}

// `what` names the bound, `text` is the hostile document, `word` is what the message must say.
function bound(what: string, text: string, word: string): void {
  const said = attack(text)

  ok(what, said.includes(word), said || 'NOT REFUSED')
}

const GOOD = 'view page\n  view text/item\n    bind term, text <x>\n'

ok('a document inside every bound is not refused', attack(GOOD) === '', attack(GOOD))

// ---- the first bound: no head declares anything ----

bound('a task at the top level', 'task main\n  take a\n', 'cannot declare a function')
bound('a dock load', 'dock load\n  load <node:fs>\n', 'cannot reach a native module')
bound('a note unsafe', 'note unsafe\n', 'carries no metadata')
bound('a wait', 'wait true\n', 'nothing a document writes is asynchronous')
bound('a save', 'save x, code 1\n', 'cannot hold state')
bound('a form declaration', 'form x\n  link a, like text\n', 'cannot declare a type')

// ---- the second bound: four closed vocabularies ----

bound('a relative load reaching out of the project',
  'load ../../secrets\n  find key\n', 'file path')
bound('a load outside the catalog',
  'load @view/secret\n  find thing\n', 'not a package this document may load')
bound('an unregistered component',
  'view page\n  view text/nowhere\n    bind a, text <x>\n', 'not a component this document may place')
bound('an unregistered query', 'find v\n  task <filter:nowhere>\n', 'not a registered query')
bound('an unregistered operator',
  'view page\n  view text/item\n    bind a\n      call shout\n        text <x>\n', 'not a registered operator')

for (const [word, why] of [
  ['random', 'not deterministic'],
  ['uuid', 'not deterministic'],
  ['now', 'not deterministic'],
  ['resolve', 'performs input and output'],
  ['walk', 'iteration is the `walk` head'],
  ['branch', 'branching is the `fork` head'],
  ['attempt', 'nothing to catch'],
] as [string, string][]) {
  bound(
    `a call of "${word}", with the reason`,
    `view page\n  view text/item\n    bind a\n      call ${word}\n        text <x>\n`,
    why,
  )
}

// ---- the fourth bound: everything is bounded ----

const many = (n: number) => Array.from({ length: n }, () => '  view text/item\n    bind a, text <x>').join('\n')

bound('a document of far too many nodes', `view page\n${many(4200)}\n`, 'and the cap is 4000')
bound('a tree deeper than the cap',
  'view page\n' + Array.from({ length: 40 }, (_, i) => '  '.repeat(i + 1) + 'view hold/box').join('\n') + '\n',
  'and the cap is 32')
bound('a call nested past the depth cap',
  'view page\n  view text/item\n    bind a\n      call trim\n        call trim\n          call trim\n            call trim\n              call trim\n                text <x>\n',
  'and the cap is 4')
bound('three nested walks over unbounded lists',
  'host l, like text\nview page\n  walk list, read l\n    hook next\n      take site, name a\n      walk list, read a\n        hook next\n          take site, name b\n          walk list, read b\n            hook next\n              take site, name c\n              text <x>\n',
  'and the cap is',
)
bound('nested counted walks whose product is too large',
  'view page\n  walk size\n    bind base, 0\n    bind head, 1000\n    hook next\n      take site, name a\n      walk size\n        bind base, 0\n        bind head, 1000\n        hook next\n          take site, name b\n          text <x>\n',
  'build up to 1000000 nodes')

// a macro whose EXPANSION exceeds the cap. Small before, over after, which is the whole point of counting after.
const bomb =
  'tree a\n  hook fuse\n' +
  Array.from({ length: 70 }, () => '    view text/item\n      bind t, text <x>').join('\n') +
  '\n\nview page\n' +
  Array.from({ length: 70 }, () => '  fuse a').join('\n') +
  '\n'

const bombParsed = parse({ file: 'page.tree', text: bomb })

if (bombParsed.ok) {
  const { expandTemplates, collectTemplates } = await import('@term/make/code/compile/template')
  const result = readView(
    expandTemplates(bombParsed.tree, collectTemplates(bombParsed.tree)),
    'page.tree',
    catalog,
    VIEW_CAPS,
  )

  ok(
    'a macro whose expansion exceeds the node cap',
    !result.ok && result.diagnostics.some(d => /builds \d+ nodes and the cap is 4000/.test(d.message)),
    result.ok ? 'NOT REFUSED' : result.diagnostics.map(d => d.message).join(' | '),
  )
  ok(
    'and the document is far smaller than its expansion',
    bomb.split('\n').filter(l => /fuse a/.test(l)).length === 70,
  )
}

// ---- recursion ----

bound('a macro that fuses itself', 'tree a\n  hook fuse\n    fuse a\nview page\n  fuse a\n', 'a fuses a')
bound('two macros that fuse each other',
  'tree a\n  hook fuse\n    fuse b\ntree b\n  hook fuse\n    fuse a\nview page\n  fuse a\n', 'fuses')
bound('a view that places itself', 'view page\n  view page\n    bind a, text <x>\n', 'page places page')

// a fuse of a macro nothing declares. It expanded to NOTHING and compiled: the document said "put a row here"
// and rendered an empty page, with no diagnostic. Found by testing the cross-module macro path.
bound('a fuse of a macro nothing declares',
  'view page\n  fuse nowhere\n    bind a, <x>\n', 'is not a macro this document can reach')
bound('a fuse misspelling a macro that exists',
  'tree sound-row\n  hook fuse\n    text <x>\nview page\n  fuse sound-rw\n', 'Did you mean "sound-row"?')

// ---- the fifth bound: validation is a gate ----

bound('a read of a name nothing declares',
  'view page\n  view text/item\n    bind a, read nowhere\n', 'not in scope in "page"')
bound('a size over the query cap',
  'find v\n  task <filter:phoneme>\n  size 99999\n', 'caps at 500')
bound('a hold on a field the catalog does not index',
  'find v\n  task <filter:phoneme>\n  hold is-equal\n    read self/secret\n    text <x>\n',
  'has no filterable field')
bound('a predicate no index answers',
  'find v\n  task <filter:phoneme>\n  hold is-above\n    read self/kind\n    text <x>\n',
  'does not accept "is-above"')
bound('a hold whose operand reads another find',
  'find a\n  task <select:language>\n  hold is-equal\n    read self/slug\n    text <x>\nfind b\n  task <filter:phoneme>\n  hold is-equal\n    read self/kind\n    read a\n',
  'is a join')
bound('a meet not with two children',
  'find v\n  task <filter:phoneme>\n  meet not\n    hold is-equal\n      read self/kind\n      text <a>\n    hold is-equal\n      read self/kind\n      text <b>\n',
  'exactly one child')
bound('a walk test', 'view page\n  walk test\n    hook next\n      text <x>\n', 'no end of its own')
bound('a fork case', 'view page\n  fork case, read x\n    case one\n', 'declares none')
bound('an event handler',
  'view page\n  view text/item\n    seed click, read go\n', 'event handler')

// ---- the compile path refuses, not just the reader ----

const built = compile(
  { file: '/app/page/attack.tree', text: 'task main\n  take a\n' },
  { roleOf: () => 'view', optimize: false },
)

ok('the compile path refuses a hostile document', !built.ok)
ok(
  'and every diagnostic carries a span',
  !built.ok && built.diagnostics.every(d => d.span !== undefined),
)

// ---- one gate, three callers ----
// The compiler, `term view` and a save path all call `checkView`. If they did not, a document refused by one
// could be accepted by another, and the strictest of the three would be the only real bound.

const HOSTILE = 'task main\n  take a\n'

const byGate = checkView({ file: 'page.tree', text: HOSTILE }, { catalog, caps: VIEW_CAPS })
const byCompile = compile(
  { file: '/app/page/x.tree', text: HOSTILE },
  { roleOf: () => 'view', optimize: false },
)

ok('the gate refuses it', !byGate.ok)
ok('the compiler refuses it', !byCompile.ok)
ok(
  'and both say the same thing',
  !byGate.ok && !byCompile.ok &&
    byGate.diagnostics[0]?.message === byCompile.diagnostics[0]?.message,
  !byGate.ok && !byCompile.ok
    ? `${byGate.diagnostics[0]?.message} :: ${byCompile.diagnostics[0]?.message}`
    : '',
)

// the gate is the whole path: a macro cycle is caught by it too, not only by a separate call
const ringed = checkView(
  { file: 'page.tree', text: 'tree a\n  hook fuse\n    fuse a\nview page\n  fuse a\n' },
  { catalog, caps: VIEW_CAPS },
)

ok(
  'the gate catches a macro cycle before expansion',
  !ringed.ok && ringed.diagnostics.some(d => /cannot fuse itself/.test(d.message)),
  ringed.ok ? 'NOT REFUSED' : ringed.diagnostics.map(d => d.message).join(' | '),
)

// and it refuses the WHOLE document: one diagnostic does not mean the rest was accepted
const several = checkView(
  {
    file: 'page.tree',
    text: 'load @view/secret\n  find a\nfind v\n  task <filter:nowhere>\nview page\n  view text/nowhere\n    bind a, text <x>\n',
  },
  { catalog, caps: VIEW_CAPS },
)

ok(
  'a document with three faults reports all three, and saves none of them',
  !several.ok && several.diagnostics.length >= 3,
  several.ok ? 'NOT REFUSED' : `${several.diagnostics.length} diagnostics`,
)

// ---- what no catalog may widen ----
// Determinism and purity are properties of the RENDERING MODEL, not a project's taste, so these are refused
// whether a catalog registers them or not. A project may narrow what it registers and may not widen past this.

const permissive = {
  ...catalog,
  call: new Set([...catalog.call, 'random', 'uuid', 'now', 'resolve', 'walk', 'branch', 'range']),
}

function withCatalog(text: string, use = permissive): string {
  const parsed = parse({ file: 'page.tree', text })

  if (!parsed.ok) {
    return parsed.diagnostics.map(d => d.message).join(' | ')
  }

  const result = readView(parsed.tree, 'page.tree', use, VIEW_CAPS)

  return result.ok ? '' : result.diagnostics.map(d => d.message).join(' | ')
}

for (const [word, why] of [
  ['random', 'not deterministic'],
  ['uuid', 'not deterministic'],
  ['now', 'not deterministic'],
  ['resolve', 'performs input and output'],
] as [string, string][]) {
  const said = withCatalog(`view page\n  view text/item\n    bind a\n      call ${word}\n        text <x>\n`)

  ok(`a catalog cannot widen to "${word}"`, said.includes(why), said || 'NOT REFUSED')
}

// and they are refused with NO catalog at all, because the rule is the language's
const bare = (() => {
  const parsed = parse({ file: 'page.tree', text: 'view page\n  view any/thing\n    bind a\n      call random\n        text <x>\n' })

  if (!parsed.ok) {
    return ''
  }

  const result = readView(parsed.tree, 'page.tree')

  return result.ok ? '' : result.diagnostics.map(d => d.message).join(' | ')
})()

ok('and refused with no catalog at all', bare.includes('not deterministic'), bare || 'NOT REFUSED')

// `range` is synthesized for a counted walk. An author writing it by hand does NOT get the synthesized one's pass,
// which a name-matched exemption would have handed them.
const written = withCatalog('view page\n  view text/item\n    bind a\n      call range\n        0\n        9\n', catalog)

ok(
  'an author writing `call range` does not skip the catalog',
  written.includes('not a registered operator'),
  written || 'NOT REFUSED',
)

const counted = withCatalog(
  'view page\n  walk size\n    bind base, 0\n    bind head, 9\n    hook next\n      take site, name i\n      view text/item\n        bind a, read i\n',
  catalog,
)

ok('while the synthesized one passes', counted === '', counted)

console.log(`\nview-hostile: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
