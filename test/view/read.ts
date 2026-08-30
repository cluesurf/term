// The `view` reader: a real document reads into the forms, and every bound the dialect claims is refused with a
// message that names it. See note/term/view/ and deck/mill/code/view/.

import { parse } from '@term/make/code/parser/tree'
import { readView, lowerView, viewManifest, checkView } from '@term/make/code/compile/view'
import { readDataText } from '@term/make/code/compile/host'

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

function read(text: string) {
  const parsed = parse({ file: 'page.tree', text })

  if (!parsed.ok) {
    return { ok: false as const, diagnostics: parsed.diagnostics }
  }

  return readView(parsed.tree, 'page.tree')
}

// a message names the thing it refuses
function refuses(what: string, text: string, word: string): void {
  const result = read(text)
  const said = result.diagnostics.map(d => d.message).join(' | ')

  ok(
    `refuses ${what}`,
    !result.ok && said.includes(word),
    said || '(no diagnostic)',
  )
}

// ---- a whole document reads ----

const DOCUMENT = `
load @view/text
  find heading
  find item

load @view/sound
  find phoneme-chart, name chart

host slug, like text
host title, text <How Quenya sounds>
host show-audio, true
host row-cap, 20

find language
  task <select:language>
  hold is-equal
    read self/slug
    read slug

find vowel
  task <filter:phoneme>
  meet and
    hold is-equal
      read self/kind
      text <vowel>
    meet not
      hold is-equal
        read self/status
        text <archived>
  sort fall, read self/frequency
  sort rise, read self/symbol
  size 50

view page
  take theme, like text
  view text/heading
    bind rank, 1
    bind text
      call titlecase
        read title
  view sound/phoneme-chart
    bind language, read language
  walk list, read vowel
    hook next
      take site, name sound
      view text/item
        bind term, read sound/symbol
  fork test
    hook test
      read show-audio
    hook hold
      text <has audio>
    hook miss
      text <no audio>
`

const result = read(DOCUMENT)

ok('a whole document reads', result.ok, result.diagnostics.map(d => d.message).join(' | '))

if (result.ok) {
  const file = result.file

  ok('both loads read', file.load.length === 2)
  ok('an aliased find reads', file.load[1]?.find[0]?.alias === 'chart')
  ok('four hosts read', file.host.length === 4)
  ok('a host parameter carries a type', file.host[0]?.like?.name === 'text')
  ok('a host constant carries a value', file.host[1]?.bond?.form === 'text')
  ok('a boolean host reads', file.host[2]?.bond?.form === 'wave')
  ok('a number host reads', file.host[3]?.bond?.form === 'mark')
  ok('two finds read', file.find.length === 2)
  ok('a query id reads as text', file.find[0]?.task === 'select:language')
  ok('a bare hold is its own field', file.find[0]?.hold.length === 1)
  ok('a hold takes positional arguments', file.find[0]?.hold[0]?.slot.length === 2)
  ok('a meet reads its mode', file.find[1]?.meet?.mode === 'and')
  ok('a meet nests', file.find[1]?.meet?.meet[0]?.mode === 'not')
  ok('two sorts read in order', file.find[1]?.sort.length === 2)
  ok('a sort reads its direction', file.find[1]?.sort[0]?.way === 'fall')
  ok('a sort reads its key', file.find[1]?.sort[0]?.road.step.join('/') === 'self/frequency')
  ok('a size reads', file.find[1]?.size === 50)
  ok('one view reads', file.view.length === 1)

  const body = file.view[0]?.node ?? []

  ok('a take reads with its type', file.view[0]?.take[0]?.like?.name === 'text')
  ok('a take is named apart from the file scope', file.view[0]?.take[0]?.name === 'theme')
  ok('a component use reads', body[0]?.form === 'view')
  ok(
    'a component name keeps its scope',
    body[0]?.form === 'view' && body[0].value.name === 'text/heading',
  )
  ok(
    'a call reads as a value',
    body[0]?.form === 'view' && body[0].value.bind[1]?.bond.form === 'call',
  )
  ok('a walk reads', body[2]?.form === 'walk')
  ok(
    'a walk binds its item',
    body[2]?.form === 'walk' && body[2].value.next[0]?.site === 'sound',
  )
  ok('a fork reads', body[3]?.form === 'fork')
  ok(
    'a fork reads three hooks',
    body[3]?.form === 'fork' && body[3].value.hook.length === 3,
  )
}

// ---- every bound is refused, and the message names it ----

refuses('a task at statement level', 'task main\n  take a\n', 'task')
refuses('a dock', 'dock load\n  load <node:fs>\n', 'dock')
refuses('a save', 'save total, code 1\n', 'save')
refuses('a form declaration', 'form thing\n  link a, like text\n', 'form')
refuses('a relative load', 'load ./secret\n  find thing\n', 'file path')
refuses('an unknown statement head', 'wibble page\n', 'not a statement of a document')
refuses('a walk test', 'view page\n  walk test\n    hook next\n      text <x>\n', 'no end of its own')
refuses('a fork case', 'view page\n  fork case, read x\n    case one\n', 'declares none')
refuses('an event handler', 'view page\n  view text/item\n    seed click, read go\n', 'event handler')
refuses('a find with no query', 'find vowel\n  size 10\n', 'names no query')
refuses('a meet not with two children',
  'find v\n  task <filter:phoneme>\n  meet not\n    hold is-equal\n      read self/a\n    hold is-equal\n      read self/b\n',
  'exactly one child')
refuses('a bad sort direction', 'find v\n  task <filter:phoneme>\n  sort sideways, read self/a\n', 'rise or fall')
refuses('a bad meet mode', 'find v\n  task <filter:phoneme>\n  meet perhaps\n    hold is-equal\n      read self/a\n', 'and, or, or not')
refuses('a duplicate name', 'host slug, text <a>\nhost slug, text <b>\n', 'already declared')
refuses('mixed positional and named arguments',
  'find v\n  task <filter:phoneme>\n  hold is-equal\n    read self/a\n    bind other, text <b>\n',
  'mixes positional and named')
refuses('a body head that is not a node', 'view page\n  wibble x\n', 'not part of a document body')
// every word a document cannot say gets its own sentence, because "unknown head" is correct and useless
refuses('a note', 'note async\n', 'carries no metadata')
refuses('a wait', 'wait true\n', 'nothing a document writes is asynchronous')
refuses('a roll', 'roll metric\n', 'declares nothing for the hive')
refuses('a tell', 'tell @deck/form\n', 'decides nothing about what a customer is told')
refuses('a rule', 'rule a-thing\n', 'declares no theorem')
refuses('a line', 'line thing\n', 'is not a command')
refuses('a mask', 'mask thing\n', 'cannot declare a trait')
refuses('a halt', 'halt <boom>\n', 'cannot raise')
refuses('a bear', 'bear ./x\n', 'cannot re-export')

refuses('a take that shadows a host', 'host slug, like text\nview page\n  take slug, like text\n', 'two answers')

// ---- every read resolves ----
refuses('a filter reading another query',
  'find a\n  task <select:language>\n  hold is-equal\n    read self/x\n    text <y>\nfind b\n  task <filter:phoneme>\n  hold is-equal\n    read self/k\n    read a\n',
  'is a join')
refuses('a filter reading an undeclared name',
  'find b\n  task <filter:phoneme>\n  hold is-equal\n    read self/k\n    read nowhere\n',
  'not in scope in a filter')
refuses('a sort on something other than self',
  'find b\n  task <filter:phoneme>\n  sort rise, read other/k\n',
  'a field of `self`')
refuses('a body reading an undeclared name',
  'view page\n  view text/item\n    bind text, read nowhere\n',
  'not in scope in "page"')
refuses('a body reading self',
  'view page\n  view text/item\n    bind text, read self/x\n',
  'names the record under test inside a filter')
refuses('a walk item read outside its walk',
  'host list-of, like text\nview page\n  walk list, read list-of\n    hook next\n      take site, name one\n      text <x>\n  view text/item\n    bind text, read one\n',
  'not in scope in "page"')

// ---- the lowering: a document becomes a zone Statement per view ----

if (result.ok) {
  const program = lowerView(result.file)
  const zone = program[0]

  ok('one zone statement per view', program.length === 1)
  ok('the zone keeps the view name', zone?.form === 'view' && zone.name === 'page')

  // a `take`, then every name the host supplies: the typed `host` parameter and the two query results
  ok(
    'the zone takes the mount host, its parameter, and its resolved queries',
    zone?.form === 'view' &&
      zone.params.map(p => p.name).join(',') === 'host,theme,slug,language,vowel',
    zone?.form === 'view' ? zone.params.map(p => p.name).join(',') : '',
  )

  const body = zone?.form === 'view' ? zone.body : []

  ok('a component use lowers to an element', body[0]?.form === 'element')
  ok(
    'an element never carries an attribute or an event',
    body.every(node => node.form !== 'element' || node.attributes.length === 0),
  )
  ok(
    'a bind lowers to a prop',
    body[0]?.form === 'element' && body[0].props[0]?.name === 'rank',
  )
  ok(
    'a host constant folds into its use site',
    body[0]?.form === 'element' &&
      body[0].props[1]?.value.form === 'call' &&
      body[0].props[1].value.args[0]?.form === 'string',
  )
  ok('a walk lowers with its item bound', body[2]?.form === 'walk' && body[2].item === 'sound')
  ok(
    'a fork lowers to one branch and an otherwise',
    body[3]?.form === 'fork' && body[3].branches.length === 1 && body[3].otherwise !== undefined,
  )
  ok(
    'the lowering emits no computed local',
    body.every(node => node.form !== 'save'),
  )
}

// ---- the query manifest ----
// Written in the `host` dialect, because a manifest is data. It carries what a RESOLVER needs and nothing a
// renderer could act on. See note/term/view/03-find.md.

if (result.ok) {
  const manifest = viewManifest(result.file, 'page/quenya')

  const holds = (what: string) => manifest.includes(what)

  ok('the manifest names its module', holds('host module, <page/quenya>'))
  ok('it lists the holes the host must fill', holds('list hole') && holds('host name, <slug>'))
  ok('it carries the hole type', holds('host like, <text>'))
  ok('it lists every query with its id', holds('host task, <filter:phoneme>') && holds('host task, <select:language>'))
  ok('it carries the result cap', holds('host size, 50'))
  ok('it carries the meet mode', holds('host mode, <and>'))
  ok('it carries a predicate and its operands', holds('host name, <is-equal>') && holds('host road, <self/kind>'))
  ok('it carries the sort order', holds('host way, <fall>') && holds('host road, <self/frequency>'))
  ok('it lists every component placed', holds('list view') && holds('<sound/phoneme-chart>'))
  ok('it lists every operator applied', holds('list call') && holds('<titlecase>'))
  ok('it lists every package loaded', holds('list load') && holds('<@view/sound>'))
  ok('it does not list the synthesized range', !/list call[\s\S]*<range>/.test(manifest))

  // The manifest IS the host dialect, so the host's own READER takes it back, not merely the tree parser. That
  // is the assertion that matters: it is written by `writeLong`, so a value holding a brace, a newline or a tab
  // escapes the way the reader expects. Building the text by hand escaped three characters of the eight and this
  // came back broken.
  const back = readDataText({ file: 'find.tree', text: manifest })

  ok(
    'the manifest reads back through the host reader',
    back.ok,
    back.ok ? '' : back.diagnostics.map(d => d.message).join(' | '),
  )

  const awkward = read(
    'host title, text <a \\{brace\\} a \\n newline and a \\t tab>\nview page\n  view text/item\n    bind t, read title\n',
  )

  ok('a document with an awkward value reads', awkward.ok)

  if (awkward.ok) {
    const rough = viewManifest(awkward.file, 'page/awkward')

    ok(
      'and its manifest still reads back',
      readDataText({ file: 'm.tree', text: rough }).ok,
      rough,
    )
  }
}

// a record reference is collected apart from a plain text, because a reference is what delete protection walks
const REFERENCED = read(`
view page
  view text/item
    bind term, code <quenya-a>
    bind note, text <not a mark>
`)

ok('a record reference reads', REFERENCED.ok, REFERENCED.ok ? '' : REFERENCED.diagnostics.map(d => d.message).join(' | '))

if (REFERENCED.ok) {
  const manifest = viewManifest(REFERENCED.file, 'page/ref')

  ok('a record mark is listed', /list mark\n  <quenya-a>/.test(manifest))
  ok('a plain text is not a mark', !manifest.includes('<not a mark>'))
}

// ---- the role routes a file to this reader, end to end ----
// A project's `role.tree` decides which mill reads a file. Content cannot decide, because a document and a
// program share the words `load` and `host`. See note/term/view/06-mill.md.

import { parseRoleFile, matchRole } from '@cluesurf/deck.tree'
import { compile } from '@term/make/code/compile/compile'

const ROLE = `
role view
  take @/page/**/*.tree
  take @/view/**/*.tree

role code
  take @/code/**/*.tree
`

const config = parseRoleFile({ text: ROLE, root: '/app' })
const roleOf = (path: string) => matchRole({ filePath: path, config })

ok('a role file routes a page to view', roleOf('/app/page/quenya.tree') === 'view')
ok('a role file routes a fragment to view', roleOf('/app/view/row.tree') === 'view')
ok('a role file routes code to code', roleOf('/app/code/tool.tree') === 'code')

const DOC = `
host title, text <Vowels>

view page
  view text/heading
    bind text, read title
`

const built = compile(
  { file: '/app/page/quenya.tree', text: DOC },
  { roleOf, optimize: false },
)

ok(
  'a view-role file compiles through the reader',
  built.ok,
  built.ok ? '' : built.diagnostics.map(d => d.message).join(' | '),
)

ok(
  'it compiles to exactly one zone statement',
  built.ok && built.program.length === 1 && built.program[0]?.form === 'view',
)

// Both roles read `view`, because a component is one concept. What differs is AUTHORITY: a component may hold
// state, a document may not, and the role of the FILE is what decides. That is the security model, and it is why
// a document cannot define a component even though it uses the same word.
const STATEFUL = `
view counter
  take host
  save count, code 0
  view div
    text <hello>
`

const asDocument = compile(
  { file: '/app/page/counter.tree', text: STATEFUL },
  { roleOf, optimize: false },
)

ok('a document may not hold state', !asDocument.ok)
ok(
  'and is told why, by name',
  !asDocument.ok && asDocument.diagnostics.some(d => /cannot hold state/.test(d.message)),
  asDocument.ok ? '' : asDocument.diagnostics.map(d => d.message).slice(0, 2).join(' | '),
)

ok(
  'the same word in the code role is not refused for holding state',
  (() => {
    const asComponent = compile(
      { file: '/app/code/counter.tree', text: STATEFUL },
      { roleOf, optimize: false },
    )

    return (
      asComponent.ok ||
      !asComponent.diagnostics.some(d => /cannot hold state/.test(d.message))
    )
  })(),
)

// ---- a counted walk ----
// `walk size` normalises into a `walk list` over `range(base, head)`, because `view-walk` carries only a list walk
// and adding a counted one would touch every pass that reads a walk. `range` is a render-runtime task.

const COUNTED = `
host total, like text

view page
  walk size
    bind base, 0
    bind head, 100
    hook next
      take site, name step
      view text/item
        bind rank, read step
  walk size, read total
    hook next
      take site, name n
      view text/item
        bind rank, read n
`

// Read and lowered directly rather than through `compile`, because `range` is a render-runtime task and a bare
// compile has no resolver to load it. A real build auto-loads that runtime for any module holding a zone.
const countedRead = read(COUNTED)

ok(
  'a counted walk reads',
  countedRead.ok,
  countedRead.ok ? '' : countedRead.diagnostics.map(d => d.message).join(' | '),
)

if (countedRead.ok) {
  const zone = lowerView(countedRead.file)[0]
  const body = zone?.form === 'view' ? zone.body : []

  ok('both counted walks lower to a walk', body.length === 2 && body.every(node => node.form === 'walk'))
  ok(
    'a counted walk iterates a range call',
    body[0]?.form === 'walk' &&
      body[0].iterable.form === 'call' &&
      body[0].iterable.callee.form === 'variable' &&
      body[0].iterable.callee.name === 'range',
  )
  ok(
    'its bounds are the base and the head',
    body[0]?.form === 'walk' &&
      body[0].iterable.form === 'call' &&
      body[0].iterable.args[0]?.form === 'integer' &&
      body[0].iterable.args[0].value === 0 &&
      body[0].iterable.args[1]?.form === 'integer' &&
      body[0].iterable.args[1].value === 100,
  )
  ok(
    'the short form counts from zero',
    body[1]?.form === 'walk' &&
      body[1].iterable.form === 'call' &&
      body[1].iterable.args[0]?.form === 'integer' &&
      body[1].iterable.args[0].value === 0,
  )
  ok('a counted walk binds its item', body[0]?.form === 'walk' && body[0].item === 'step')
}

refuses('a counted walk with no bound', 'view page\n  walk size\n    hook next\n      text <x>\n', 'names how far it counts')

// ---- a macro from another module ----
// A repository publishes macros and a document fuses them. `checkView` merges the module graph's templates with
// the file's own, so a `fuse` of an imported macro expands. Without that the fuse expanded to NOTHING and the
// document silently rendered less than it said, which is the worst shape a bug can take here.

{
  const { collectTemplates } = await import('@term/make/code/compile/template')
  const elsewhere = parse({
    file: 'view/row.tree',
    text: 'tree shared-row\n  take n, like text\n  hook fuse\n    view text/item\n      bind t, text <{n}>\n',
  })

  const here = 'view page\n  fuse shared-row\n    bind n, <a>\n'

  if (elsewhere.ok) {
    const graph = collectTemplates(elsewhere.tree)

    const without = checkView({ file: '/app/page/p.tree', text: here })
    const with_ = checkView({ file: '/app/page/p.tree', text: here }, { templates: graph })

    ok(
      'without the graph the imported macro is REFUSED, not silently dropped',
      !without.ok &&
        without.diagnostics.some(d => /is not a macro this document can reach/.test(d.message)),
      without.ok ? 'compiled with an empty body' : without.diagnostics.map(d => d.message).join(' | '),
    )
    ok(
      'with it the macro body stands where the fuse was',
      with_.ok && with_.file.view[0]?.node.length === 1,
      with_.ok ? String(with_.file.view[0]?.node.length) : 'refused',
    )
  }
}

// ---- macros expand before the reader ever sees them ----
// `tree` and `fuse` are surface syntax. `compile/template.ts` expands them on the parse tree, so by the time the
// reader runs the macros are gone and their bodies stand where each `fuse` was. The dialect gets this for free
// by going through the same expand phase the code role does. See note/term/view/02-macro.md.

// A parameter substitutes as `{name}`, never as `read name`. The wrong spelling does not fail: it expands to a
// read of the bound group's head, which is a variable that does not exist. Measured, see note/term/view/02-macro.md.
const MACRO = `
tree sound-row
  take symbol, like text
  hook fuse
    view text/item
      bind term, text <{symbol}>

view page
  fuse sound-row
    bind symbol, <a>
  fuse sound-row
    bind symbol, <e>
`

const expanded = compile(
  { file: '/app/page/macro.tree', text: MACRO },
  { roleOf, optimize: false },
)

ok(
  'a document with a macro compiles',
  expanded.ok,
  expanded.ok ? '' : expanded.diagnostics.map(d => d.message).join(' | '),
)

if (expanded.ok) {
  const zone = expanded.program[0]
  const body = zone?.form === 'view' ? zone.body : []

  ok('two fuses expand to two nodes', body.length === 2)
  ok('an expanded node is the macro body', body[0]?.form === 'element')
  ok(
    'a macro parameter is substituted',
    body[0]?.form === 'element' &&
      body[0].props[0]?.value.form === 'string' &&
      body[0].props[0].value.value === 'a',
  )
  ok(
    'each fuse gets its own argument',
    body[1]?.form === 'element' &&
      body[1].props[0]?.value.form === 'string' &&
      body[1].props[0].value.value === 'e',
  )
  ok(
    'the reader never sees a tree or a fuse',
    body.every(node => node.form === 'element'),
  )
}

console.log(`\nview-role: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
