// The `view` reader: a real document reads into the forms, and every bound the dialect claims is refused with a
// message that names it. See note/term/view/ and deck/mill/code/view/.

import { parse } from '@term/make/code/parser/tree'
import { readView, lowerView } from '@term/make/code/compile/view'

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
  ok('a component use reads', body[0]?.form === 'zone')
  ok(
    'a component name keeps its scope',
    body[0]?.form === 'zone' && body[0].value.name === 'text/heading',
  )
  ok(
    'a call reads as a value',
    body[0]?.form === 'zone' && body[0].value.bind[1]?.bond.form === 'call',
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
  ok('the zone keeps the view name', zone?.form === 'zone' && zone.name === 'page')

  // a `take`, then every name the host supplies: the typed `host` parameter and the two query results
  ok(
    'the zone takes its parameter and its resolved queries',
    zone?.form === 'zone' &&
      zone.params.map(p => p.name).join(',') === 'theme,slug,language,vowel',
    zone?.form === 'zone' ? zone.params.map(p => p.name).join(',') : '',
  )

  const body = zone?.form === 'zone' ? zone.body : []

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
  built.ok && built.program.length === 1 && built.program[0]?.form === 'zone',
)

// The SAME TEXT under the code role does not compile: `view page` is not a statement there, so the code mill
// reads it as a call to an undefined name. That difference is the whole point of the role deciding rather than
// the content, and it is why a document cannot define a component: its file is in the other role.
const asCode = compile(
  { file: '/app/code/quenya.tree', text: DOC },
  { roleOf, optimize: false },
)

ok('the same text under the code role does not compile', !asCode.ok)
ok(
  'and it fails because "view" is not a code statement',
  !asCode.ok && asCode.diagnostics.some(d => /the name "view" is not defined/.test(d.message)),
  asCode.ok ? '' : asCode.diagnostics.map(d => d.message).slice(0, 2).join(' | '),
)

console.log(`\nview-role: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
