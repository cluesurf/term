// What a parallel walk's turn may write, hold and do (decision 021 sections 3 to 5 of
// note/project/term/self-host/change/001-finish-self-host, amended by decisions 076 and 078): check/parallel.tree's five
// refusals, each by its code and naming its variable, and the walks it accepts. Item term-self-host-001-0232.
//   - parallel-write: an outer name, a list changed in place, a list handed to a task that writes it
//   - parallel-slot-read: a slot list read in the turn
//   - parallel-crossing: a task value, and until item 0400 widens `form-kind-of` (decision 076) a hash, a maybe outside
//     a field and a union; a raise whose props hold a hash (decision 078)
//   - parallel-await, parallel-escape
// Accepted: slot writes into two lists, captures of a record and a list, a list the turn makes and pushes, `turn next`,
// a nested unmarked walk, a call to a pure task, a raise of `failure` and of a declared exception with text and number
// props. Then decision 076 section 3's arbiter: one value of every kind the predicate accepts goes through melt,
// to-code, from-code and fill on TypeScript and Rust and reads back equal (PARALLEL_NATIVE=0 skips Rust).
// Run: npx tsx test/check/parallel-walk.ts (from deck/term/deck/term)

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'
import { runOn } from '../compile/shared/run-on'

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

type Said = { name: string; message: string }

const dir = mkdtempSync(join(tmpdir(), 'term-parallel-walk-'))
let made = 0

function check(text: string): { ok: boolean; said: Said[] } {
  made++
  const built = compile(
    { file: join(dir, `walk${made}.tree`), text },
    { resolve: projectResolver(process.cwd(), 'node'), env: 'node' } as never,
  ) as { ok: boolean; diagnostics?: { name: string; message: string; severity?: string }[] }

  return {
    ok: built.ok,
    said: (built.diagnostics ?? [])
      .filter(d => d.severity !== 'warning')
      .map(d => ({ name: String(d.name), message: String(d.message) })),
  }
}

const LIST = `load @term/base/list
  find list
`

// refused with `code`, by a message naming every one of `names`. PARALLEL_SAY=1 prints the messages
function refused(says: string, code: string, names: string | string[], text: string): void {
  const got = check(text)
  const wanted = typeof names === 'string' ? [names] : names
  if (process.env.PARALLEL_SAY === '1') {
    for (const d of got.said) console.log(`      ${d.name}: ${d.message}`)
  }
  ok(
    `${code}: ${says}`,
    !got.ok && got.said.some(d => d.name === code && wanted.every(name => d.message.includes(name))),
    JSON.stringify(got.said),
  )
}

function accepted(says: string, text: string): void {
  const got = check(text)
  ok(`accepted: ${says}`, got.ok && got.said.length === 0, JSON.stringify(got.said))
}

// ---- refused ----

refused(
  'an outer number written in the turn',
  'parallel-write',
  '`sum`',
  `${LIST}
task total
  take xs, like list, like number
  like number
  save sum, 0
  walk xs, mark parallel
    take x
    save sum, add(sum, x)
  back sum
`,
)

refused(
  'an outer list pushed in the turn',
  'parallel-write',
  '`seen`',
  `${LIST}
task gather
  take xs, like list, like number
  like list, like number
  save seen, make list
  walk xs, mark parallel
    take x
    seen/push(x)
  back seen
`,
)

refused(
  'an outer list handed to a task that pushes into it',
  'parallel-write',
  '`seen`',
  `${LIST}
task keep
  take into, like list, like number
  take x, like number
  into/push(x)

task gather
  take xs, like list, like number
  like list, like number
  save seen, make list
  walk xs, mark parallel
    take x
    keep(seen, x)
  back seen
`,
)

refused(
  'a slot list read in the turn',
  'parallel-slot-read',
  '`out`',
  `${LIST}
task doubled
  take xs, like list, like number
  like list, like number
  save out, make list
  walk xs, mark parallel
    take x
    take at
    save out/{at}, add(x, out/length)
  back out
`,
)

refused(
  'a captured task value',
  'parallel-crossing',
  '`f`',
  `${LIST}
task mapped
  take xs, like list, like number
  take f
    like task
      take x, like number
      like number
  like list, like number
  save out, make list
  walk xs, mark parallel
    take x
    take at
    save out/{at}, f(x)
  back out
`,
)

refused(
  'a captured hash, until item 0400 widens form-kind-of (decision 076)',
  'parallel-crossing',
  '`table`',
  `${LIST}
task looked
  take xs, like list, like text
  take table, like hash, like text, like number
  like list, like number
  save out, make list
  walk xs, mark parallel
    take x
    take at
    save out/{at}, table/get(x)
  back out
`,
)

refused(
  'a captured maybe outside a field, until item 0400 (decision 076)',
  'parallel-crossing',
  '`bound`',
  `${LIST}
load @term/base/maybe
  find maybe

task capped
  take xs, like list, like number
  take bound, like maybe, like number
  like list, like number
  save out, make list
  walk xs, mark parallel
    take x
    take at
    save top, x
    sift bound
      case some
        link given
        save top, given
      case none
        save top, x
    save out/{at}, top
  back out
`,
)

refused(
  'a captured union, until item 0400 (decision 076)',
  'parallel-crossing',
  '`shape`',
  `${LIST}
form figure
  case dot
  case box
    link side, like number

task scaled
  take xs, like list, like number
  take shape, like figure
  like list, like number
  save out, make list
  walk xs, mark parallel
    take x
    take at
    save size, x
    sift shape
      case box
        save size, add(x, side)
      case dot
        save size, x
    save out/{at}, size
  back out
`,
)

refused(
  'a raise whose props hold a hash names the form and the field (decision 078)',
  'parallel-crossing',
  ['`lookup-miss`', '`table`'],
  `${LIST}
load @term/base/exception
  find exception

form lookup-miss
  like exception
    bind note, <Not in the table>
    link table, like hash, like text, like number

task looked
  take xs, like list, like number
  like list, like number
  save out, make list
  walk xs, mark parallel
    take x
    take at
    fork test, is-above(x, 3)
      hold
        halt lookup-miss
          bind table, make hash
    save out/{at}, x
  back out
`,
)

refused(
  'an awaited call in the turn',
  'parallel-await',
  '`later`',
  `${LIST}
task later
  take x, like number
  like number
  mark async
  back x

task total
  take xs, like list, like number
  like list, like number
  save out, make list
  walk xs, mark parallel
    take x
    take at
    save out/{at}, later(x)
  back out
`,
)

refused(
  'a `back` in the turn',
  'parallel-escape',
  '`back`',
  `${LIST}
task first-big
  take xs, like list, like number
  like number
  walk xs, mark parallel
    take x
    fork test, is-above(x, 3)
      hold
        back x
  back 0
`,
)

refused(
  'a bare `halt` of the walk itself',
  'parallel-escape',
  'bare `halt`',
  `${LIST}
task until-big
  take xs, like list, like number
  like list, like number
  save out, make list
  walk xs, mark parallel
    take x
    take at
    fork test, is-above(x, 3)
      hold
        halt
    save out/{at}, x
  back out
`,
)

// ---- accepted ----

accepted(
  'slot writes into two outer lists',
  `${LIST}
form split
  link low, like list, like number
  link high, like list, like number

task halves
  take xs, like list, like number
  like split
  save low, make list
  save high, make list
  walk xs, mark parallel
    take x
    take at
    save low/{at}, subtract(x, 1)
    save high/{at}, add(x, 1)
  back
    make split
      bind low, low
      bind high, high
`,
)

accepted(
  'captures of a record and a list read in the turn',
  `${LIST}
form pair
  link a, like number
  link b, like text

task shifted
  take xs, like list, like number
  take p, like pair
  take weights, like list, like number
  like list, like number
  save out, make list
  walk xs, mark parallel
    take x
    take at
    save out/{at}, add(add(x, p/a), weights/length)
  back out
`,
)

accepted(
  'a list the turn makes and pushes',
  `${LIST}
task sizes
  take xs, like list, like number
  like list, like number
  save out, make list
  walk xs, mark parallel
    take x
    take at
    save mine, make list
    mine/push(x)
    mine/push(add(x, 1))
    save out/{at}, mine/length
  back out
`,
)

accepted(
  '`turn next` ends the turn',
  `${LIST}
task kept
  take xs, like list, like number
  like list, like number
  save out, make list
  walk xs, mark parallel
    take x
    take at
    save out/{at}, 0
    fork test, is-above(x, 3)
      hold
        turn next
    save out/{at}, x
  back out
`,
)

accepted(
  'a nested unmarked walk with its own halt',
  `${LIST}
task sums
  take rows, like list, like list, like number
  like list, like number
  save out, make list
  walk rows, mark parallel
    take row
    take at
    save total, 0
    walk row
      take cell
      fork test, is-above(cell, 100)
        hold
          halt
      save total, add(total, cell)
    save out/{at}, total
  back out
`,
)

accepted(
  'a call to a pure task',
  `${LIST}
task square
  take x, like number
  like number
  back multiply(x, x)

task squares
  take xs, like list, like number
  like list, like number
  save out, make list
  walk xs, mark parallel
    take x
    take at
    save out/{at}, square(x)
  back out
`,
)

accepted(
  'a turn that raises `failure` by `halt <text>` (decision 078 section 5)',
  `${LIST}
task checked
  take xs, like list, like number
  like list, like number
  save out, make list
  walk xs, mark parallel
    take x
    take at
    fork test, is-above(x, 3)
      hold
        halt <too big>
    save out/{at}, x
  back out
`,
)

accepted(
  'a turn that raises a declared exception with text and number props (decision 078 section 5)',
  `${LIST}
load @term/base/exception
  find exception

form upload-excess
  like exception
    bind note, <Upload too large>
    link policy, like text
    link size, like number

task checked
  take xs, like list, like number
  like list, like number
  save out, make list
  walk xs, mark parallel
    take x
    take at
    fork test, is-above(x, 3)
      hold
        halt upload-excess
          bind policy, <small>
          bind size, x
    save out/{at}, x
  back out
`,
)

accepted(
  'the same walk with no mark writes what it likes',
  `${LIST}
task total
  take xs, like list, like number
  like number
  save sum, 0
  walk xs
    take x
    save sum, add(sum, x)
  back sum
`,
)

// ---- decision 076 section 3: every kind the predicate accepts round-trips on TypeScript and Rust ----

const HOST_LOADS = `load @term/host/code/base
  find data
  find read
  find write
  find to-code
  find from-code

load @term/base/maybe
  find maybe

load @term/base/list
  find list
  find get

form inner
  link tag, like text
  link weight, like float
`

type Kind = { kind: string; field: string; value: string; shown: string; want: string; extra?: string }

const REGION_OF = `
task region-of
  take one, like sample
  like text
  fork case, read one/value
    case some
      link written
      send back, text <some:{read written}>
    case none
      send back, text <none>
`

const KINDS: Kind[] = [
  { kind: 'text', field: 'like text', value: 'text <ada é>', shown: '{got/value}', want: 'ada é' },
  { kind: 'number', field: 'like number', value: 'code -41', shown: '{got/value}', want: '-41' },
  { kind: 'decimal', field: 'like float', value: 'code 2.5', shown: '{got/value}', want: '2.5' },
  { kind: 'flag', field: 'like boolean', value: 'false', shown: '{got/value}', want: 'false' },
  {
    kind: 'data',
    field: 'like data',
    value: 'call read(text <host a, 1\\nhost b, <x>\\n>)',
    shown: '{write(got/value)}',
    want: 'host a, 1\nhost b, <x>\n',
  },
  {
    kind: 'list',
    field: 'like list, like number',
    value: 'make list\n        code 3\n        code 5',
    shown: '{got/value/length}:{get(got/value, 1)}',
    want: '2:5',
  },
  {
    kind: 'form',
    field: 'like inner',
    value: 'make inner\n        bind tag, text <t>\n        bind weight, code 1.5',
    shown: '{got/value/tag}:{got/value/weight}',
    want: 't:1.5',
  },
  {
    kind: 'list of forms',
    field: 'like list, like inner',
    value: 'make list\n        make inner\n          bind tag, text <u>\n          bind weight, code 0.5',
    shown: '{got/value/length}:{got/value/0/tag}',
    want: '1:u',
  },
  {
    kind: 'need false maybe field, some',
    field: 'like maybe, like text\n    need false',
    value: 'make some, text <eu>',
    shown: '{region-of(got)}',
    want: 'some:eu',
    extra: REGION_OF,
  },
  {
    kind: 'need false maybe field, none',
    field: 'like maybe, like text\n    need false',
    value: 'make none',
    shown: '{region-of(got)}',
    want: 'none',
    extra: REGION_OF,
  },
]

const programOf = (one: Kind): string => `${HOST_LOADS}
form sample
  link value
    ${one.field.replace('\n', '\n  ')}
${one.extra ?? ''}
task run
  like text
  save given
    make sample
      bind value
        ${one.value.replace(/\n {8}/g, '\n          ')}
  save melted
    call melt
      read given
      like sample
  save coded, call to-code(read melted)
  save decoded, call from-code(read coded)
  save first
    call get
      read decoded
      code 0
  save got
    call fill
      read first
      like sample
  send back, text <${one.shown}>
`

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
const root = mkdtempSync(join(tmpdir(), 'term-parallel-cross-'))
mkdirSync(join(root, 'link/@term'), { recursive: true })
mkdirSync(join(root, 'code'), { recursive: true })
symlinkSync(join(TERM, 'deck/base'), join(root, 'link/@term/base'))
symlinkSync(join(TERM, 'deck/host'), join(root, 'link/@term/host'))
writeFileSync(join(root, 'deck.tree'), 'deck @probe/parallel-cross\n  code <0.0.0>\n')
const out = join(root, 'out')
mkdirSync(out, { recursive: true })
const backends = process.env.PARALLEL_NATIVE === '0' ? (['typescript'] as const) : (['typescript', 'rust'] as const)

for (const one of KINDS) {
  for (const backend of backends) {
    const ran = runOn({
      backend,
      program: programOf(one),
      resolve: env => projectResolver(root, env),
      dir: out,
      name: `cross-${one.kind.replace(/[^a-z]+/g, '-')}`,
    })

    if (ran.form === 'skipped') {
      console.log(`skip  ${backend} ${one.kind}: ${ran.reason}`)
      continue
    }

    ok(
      `${backend}: a ${one.kind} crosses melt, to-code, from-code and fill unchanged`,
      ran.form === 'ran' && ran.output === one.want,
      ran.form === 'ran' ? `got ${JSON.stringify(ran.output)}` : `${ran.stage}: ${ran.reason.slice(0, 600)}`,
    )
  }
}

console.log(`\nparallel-walk: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
