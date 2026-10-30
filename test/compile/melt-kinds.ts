// Every kind melt and fill carry crosses the round trip, the same bytes on TypeScript and Rust (decision 076 of
// note/project/term/self-host/change/001-finish-self-host, item term-self-host-001-0400). One kind function,
// compile/backend-shapes.tree `form-kind-with`, answers what a type melts as: text, the number words, boolean, `data`,
// a list, a text-keyed hash, a `maybe` in or out of a `need false` field, a record or a union of the program (tagged
// as `mark tag` says), and a form met again under a list. Until item 0400 a hash, a maybe outside a field, a union and a
// recursive form were `any`: Rust refused the build and TypeScript melted a hash empty, a maybe as its box and a union
// as a plain object.
//
// Each case melts a value, encodes it with `to-code`, decodes it with `from-code`, fills it back and answers the code's
// hex, whether `inspect` reads the same before and after, and what it reads after. The answer must be `<hex> true
// <want>` on each backend, and the hex the same on both. MELT_KINDS_ONLY=rust (or typescript) runs one backend.
// Run: npx tsx test/compile/melt-kinds.ts (from deck/term/deck/term)

import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { runOn, type Backend, type Ran } from './shared/run-on'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

type Case = {
  name: string
  says: string
  // the form filled and melted
  form: string
  // the lines of `run` that save `given`
  build: string
  want: string
}

const LOADS = `load @term/host/code/base
  find data
  find to-code
  find from-code
  find read

load @term/base/maybe
  find maybe

load @term/base/list
  find list
  find get

load @term/base/hash
  find hash

load @term/base/bytes
  find to-hex

load @term/base/debug
  find inspect
`

const FORMS = `form point
  link x, like number
  link tag, like text

form figure
  case dot
  case box
    link side, like number
    link label, like text
  case wide-box
    link side-length, like number

form shape
  mark tag, name kind
  case circle
    link radius, like float
  case group
    link pieces, like list, like shape

form node
  link name, like text
  link kids, like list, like node

form table
  link counts, like hash, like text, like number
  link points, like hash, like text, like point
  link empty, like hash, like text, like number
  link spare
    like hash, like text, like number
    need false

form chances
  link bound, like maybe, like number
  link gone, like maybe, like number
  link labels, like list, like maybe, like text
  link spot, like maybe, like point

form holder
  link figure, like figure
  link figures, like list, like figure
  link shape, like shape

form sample
  link payload, like data
  link note
    like maybe, like text
    need false
  link rest
    like maybe, like text
    need false
  link weight, like float
`

const CASES: Case[] = [
  {
    name: 'hash',
    says: 'a text-keyed hash of numbers and of records, an empty one and a need-false one',
    form: 'table',
    build: `  save counts, make hash
  counts/set(<b>, 2)
  counts/set(<a>, 1)
  save points, make hash
  save p
    make point
      bind x, 7
      bind tag, <q>
  points/set(<p>, p)
  save spare, make hash
  spare/set(<z>, 0)
  save given
    make table
      bind counts, counts
      bind points, points
      bind empty, make hash
      bind spare, spare
`,
    want: 'table(counts hash(<b> 2, <a> 1), points hash(<p> point(x 7, tag <q>)), empty hash(), spare hash(<z> 0))',
  },
  {
    name: 'maybe',
    says: 'a maybe outside a need-false field, some and none, in a list and of a record',
    form: 'chances',
    build: `  save labels, make list
  push(labels, make(some, <x>))
  push(labels, make none)
  save p
    make point
      bind x, 3
      bind tag, <s>
  save given
    make chances
      bind bound, make(some, 4)
      bind gone, make none
      bind labels, labels
      bind spot, make(some, p)
`,
    want: 'chances(bound some(value 4), gone none, labels list(some(value <x>), none), spot some(value point(x 3, tag <s>)))',
  },
  {
    name: 'union-field',
    says: 'unions as fields and list items, the tag written as form and as a mark tag',
    form: 'holder',
    build: `  save figures, make list
  push(figures, make dot)
  save b
    make box
      bind side, 2
      bind label, <w>
  push(figures, b)
  save w
    make wide-box
      bind side-length, 4
  push(figures, w)
  save pieces, make list
  save c
    make circle
      bind radius, 1.5
  push(pieces, c)
  save inner
    make group
      bind pieces, make list
  push(pieces, inner)
  save outer
    make group
      bind pieces, pieces
  save first
    make box
      bind side, 9
      bind label, <v>
  save given
    make holder
      bind figure, first
      bind figures, figures
      bind shape, outer
`,
    want: 'holder(figure box(side 9, label <v>), figures list(dot, box(side 2, label <w>), wide-box(side-length 4)), shape group(pieces list(circle(radius 1.5), group(pieces list()))))',
  },
  {
    name: 'union-whole',
    says: 'a union filled and melted whole',
    form: 'figure',
    build: `  save given
    make box
      bind side, 5
      bind label, <z>
`,
    want: 'box(side 5, label <z>)',
  },
  {
    name: 'recursive',
    says: 'a record met again under a list of itself, three deep',
    form: 'node',
    build: `  save leaf
    make node
      bind name, <b>
      bind kids, make list
  save mid-kids, make list
  push(mid-kids, leaf)
  save mid
    make node
      bind name, <a>
      bind kids, mid-kids
  save other
    make node
      bind name, <c>
      bind kids, make list
  save kids, make list
  push(kids, mid)
  push(kids, other)
  save given
    make node
      bind name, <r>
      bind kids, kids
`,
    want: 'node(name <r>, kids list(node(name <a>, kids list(node(name <b>, kids list()))), node(name <c>, kids list())))',
  },
  {
    name: 'data-optional',
    says: 'data and a need-false maybe field, some and none, written alike on both backends',
    form: 'sample',
    build: `  save payload, call read(text <host a, 1\\nhost b, <x>\\n>)
  save given
    make sample
      bind payload, payload
      bind note, make(some, <eu>)
      bind rest, make none
      bind weight, 2.0
`,
    want: '',
  },
]

const programOf = (one: Case): string => `${LOADS}
${FORMS}
task run
  like text
${one.build}  save melted
    call melt
      read given
      like ${one.form}
  save coded, to-code(melted)
  save decoded, from-code(coded)
  save decoded-one, get(decoded, 0)
  save got
    call fill
      read decoded-one
      like ${one.form}
  save before, inspect(given)
  save after, inspect(got)
  back <{to-hex(coded)} {is-equal(before, after)} {after}>
`

const HERE =
  import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
const root = mkdtempSync(join(tmpdir(), 'term-melt-kinds-'))
mkdirSync(join(root, 'link/@term'), { recursive: true })
mkdirSync(join(root, 'code'), { recursive: true })
symlinkSync(join(TERM, 'deck/base'), join(root, 'link/@term/base'))
symlinkSync(join(TERM, 'deck/host'), join(root, 'link/@term/host'))
writeFileSync(
  join(root, 'deck.tree'),
  'deck @probe/melt-kinds\n  code <0.0.0>\n',
)

const dir = join(root, 'out')
mkdirSync(dir, { recursive: true })
const only = process.env.MELT_KINDS_ONLY ?? ''
const BACKS: Backend[] = ['typescript', 'rust']

for (const one of CASES) {
  const outputs = new Map<Backend, string>()

  for (const backend of BACKS.filter(b => !only || b === only)) {
    // an emitter that refuses the build throws (rust.ts `fail`), which is this case failing, not the run
    let ran: Ran
    try {
      ran = runOn({
        backend,
        program: programOf(one),
        resolve: env => projectResolver(root, env),
        dir,
        name: `kinds-${one.name}`,
      })
    } catch (error) {
      ran = {
        form: 'failed',
        stage: 'compile',
        reason: error instanceof Error ? error.message : String(error),
      }
    }

    if (ran.form === 'skipped') {
      console.log(`skip  ${backend}: ${ran.reason}`)
      continue
    }

    const parts =
      ran.form === 'ran'
        ? /^([0-9a-f]+) (true|false) (.*)$/s.exec(ran.output)
        : null
    // a case with no `want` is held by the round trip and the bytes alone
    const read =
      parts !== null &&
      parts[2] === 'true' &&
      (one.want === '' || parts[3] === one.want)
    ok(
      `${backend}: ${one.says} (${one.name})`,
      read,
      ran.form === 'ran'
        ? `got ${JSON.stringify(ran.output.slice(0, 1600))}`
        : `${ran.stage}: ${ran.reason.slice(0, 1600)}`,
    )

    if (parts !== null) {
      outputs.set(backend, parts[1]!)
    }
  }

  if (outputs.size === 2) {
    ok(
      `the same bytes on TypeScript and Rust (${one.name})`,
      outputs.get('typescript') === outputs.get('rust'),
      `typescript ${outputs.get('typescript')} rust ${outputs.get('rust')}`,
    )
  }
}

console.log(`\nmelt-kinds: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
