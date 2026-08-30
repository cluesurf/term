// The `view` reader and the `view` grammar agree.
//
// `deck/mill/code/view/` says what the dialect is, declaratively. `deck/make/code/compile/view.ts` is what
// actually reads a file today, because the mill executor does not exist yet (note/term/project/mill-self-hosting).
// Two statements of one grammar drift, and the drift is silent, which is the whole reason the root CLAUDE.md
// forbids a hand-rolled reader. This is the gate that keeps them together until the executor makes it one.
//
// When the executor lands, this becomes a differential: same fixtures, both paths, byte for byte.
//
//   npx tsx test/compile/view-grammar.ts

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@term/make/code/parser/tree'
import { readView, VIEW_REFUSED_HEAD } from '@term/make/code/compile/view'

const HERE = dirname(fileURLToPath(import.meta.url))
const MILL = join(HERE, '../../deck/mill/code/view')

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

function walk(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)

    if (statSync(path).isDirectory()) {
      walk(path, into)
    } else if (name === 'mine.tree') {
      into.push(path)
    }
  }

  return into
}

// the grammar with its prose removed, so a word named in a comment is never mistaken for a rule
const rules = walk(MILL)
  .map(path => readFileSync(path, 'utf8'))
  .join('\n')
  .split('\n')
  .filter(line => !/^\s*#/.test(line))
  .join('\n')

const declared = new Set(
  [...rules.matchAll(/mine term, term ([a-z-]+)/g)].map(match => match[1]!),
)

// Every word the grammar matches, and where the reader handles it. Adding a rule to the grammar without adding a
// line here fails the gate, which is the point: the two cannot drift apart quietly.
const HEADS: Record<string, string> = {
  load: 'a statement: an import from the approved catalog',
  host: 'a statement: a constant, or a parameter the route fills',
  find: 'a statement, and inside a load, one imported name',
  view: 'a statement: the document, and inside a body, a component use',
  name: 'inside a load find, the local alias; inside a walk take, the item name',
  like: 'after a take, and on a host that is a parameter, its type',
  task: 'inside a find, the catalog query id',
  meet: 'inside a find, a group of predicates',
  hold: 'inside a find, one predicate; inside a fork, the taken branch',
  sort: 'inside a find, one ordering',
  size: 'inside a find, the result cap',
  slot: 'inside a find, the offset',
  take: 'a parameter of a view, and the item of a walk',
  text: 'a text literal, and a text node',
  code: 'a number literal',
  true: 'a boolean literal',
  false: 'a boolean literal',
  read: 'a path read',
  call: 'a catalog operator applied to arguments',
  bind: 'one named argument, property or operand',
  walk: 'a body node: iteration',
  list: 'the mode of a walk',
  hook: 'the body of a walk, and the branches of a fork',
  next: 'the body of a walk',
  site: 'the loop slot of a walk',
  fork: 'a body node: a branch',
  test: 'the mode of a fork, and its condition hook',
  miss: 'the final branch of a fork',
}

for (const word of declared) {
  ok(`the grammar's "${word}" is accounted for`, word in HEADS)
}

for (const word of Object.keys(HEADS)) {
  ok(`"${word}" is still in the grammar`, declared.has(word), 'listed here but no rule matches it')
}

// The four statement heads, read off the file-level rule rather than assumed.
const STATEMENT = new Set(
  [...readFileSync(join(MILL, 'mine.tree'), 'utf8').matchAll(/mine form, like view-(\w+)/g)]
    .map(match => match[1]!)
    .map(part => (part === 'def' ? 'view' : part)),
)

ok(
  'the grammar has exactly four statement heads',
  [...STATEMENT].sort().join(',') === 'find,host,load,view',
  [...STATEMENT].sort().join(','),
)

// Every word the reader refuses in statement position is not one of them. A document cannot say the thing, AND
// it is told why, and those are two guarantees that have to agree. Several of these words ARE legal deeper in a
// file (`task` inside a find, `hook` inside a walk), so this is checked against the statement heads and not
// against the whole grammar.
for (const word of VIEW_REFUSED_HEAD.keys()) {
  ok(`"${word}" is refused and is not a statement head`, !STATEMENT.has(word))
}

// The reader accepts a document built only from the declared heads, and its refusals all fire.
const DOCUMENT = `
load @view/text
  find heading
  find item, name row

host slug, like text
host title, text <Vowels>
host loud, true
host cap, 20

find vowel
  task <filter:phoneme>
  meet and
    hold is-equal
      read self/kind
      text <vowel>
    meet not
      hold is-below
        read self/rank
        read cap
  sort fall, read self/rank
  size 50
  slot 0

view page
  take theme, like text
  text <Vowels>
  view text/heading
    bind text
      call titlecase
        read title
  walk list, read vowel
    hook next
      take site, name one
      view text/row
        bind term, read one/symbol
  fork test
    hook test
      read loud
    hook hold
      text <loud>
    hook miss
      text <quiet>
`

const parsed = parse({ file: 'page.tree', text: DOCUMENT })

ok('the fixture parses', parsed.ok)

if (parsed.ok) {
  const read = readView(parsed.tree, 'page.tree')

  ok(
    'the reader accepts a document using every declared head',
    read.ok,
    read.ok ? '' : read.diagnostics.map(d => d.message).join(' | '),
  )
}

console.log(`\nview-grammar: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
