// Presence is a type (term/stdlib-parity decision 001), on every backend alike, through `fill` and `melt`:
//   - a plain `need false` field has no absent state: `region <>` and no `region` fill the same value, `size 0` and no
//     `size` too, and melt leaves each out (until 2026-10-22 TypeScript wrote `region <>` back and the natives `size 0`
//     where none was given)
//   - a `need false` field typed `maybe text` carries presence: `region <>` fills some of the empty text and melts back
//     as `region <>`, no `region` fills none and melts to nothing
//   - a value is still there after its melt (Rust lent it: until 2026-10-22 `melt(got)` moved `got`)
// Gaps 59 and 157 of the guides. Run: npx tsx test/compile/presence-native.ts   (PRESENCE_ONLY=rust ... runs one)

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { BACKENDS, runOn } from './shared/run-on'

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

type Case = { name: string; says: string; want: string; program: string }

const LOADS = `load @term/host/code/base
  find data
  find read
  find write

load @term/base/maybe
  find maybe
`

const CASES: Case[] = [
  {
    name: 'plain',
    says: 'a plain need false field: empty and absent are one value, and melt leaves both out',
    want: '[|0|false] host name, <a>\n / [|0|false] host name, <b>\n',
    program: `${LOADS}
form place
  link name, like text
  link region, like text
    need false
  link size, like number
    need false
  link open, like boolean
    need false

task trip
  take input, like text
  like text
  save got
    call fill
      call read(read input)
      like place
  save back-out
    call write
      call melt
        read got
        like place
  send back, text <[{got/region}|{got/size}|{got/open}] {back-out}>

task run
  like text
  save a, trip(text <host name, <a>\\nhost region, <>\\nhost size, 0\\nhost open, false\\n>)
  save b, trip(text <host name, <b>\\n>)
  send back, text <{a} / {b}>
`,
  },
  {
    name: 'maybe',
    says: 'a need false maybe field: some of the empty text and none round-trip exactly',
    want: '[some:] host name, <a>\nhost region, <>\n / [none] host name, <b>\n / [some:eu] host name, <c>\nhost region, <eu>\n',
    program: `${LOADS}
form place
  link name, like text
  link region
    like maybe, like text
    need false

task region-of
  take value, like place
  like text
  sift value/region
    case some
      link written
      send back, text <some:{written}>
    case none
      send back, text <none>

task trip
  take input, like text
  like text
  save got
    call fill
      call read(read input)
      like place
  save back-out
    call write
      call melt
        read got
        like place
  send back, text <[{region-of(read got)}] {back-out}>

task run
  like text
  save a, trip(text <host name, <a>\\nhost region, <>\\n>)
  save b, trip(text <host name, <b>\\n>)
  save c, trip(text <host name, <c>\\nhost region, <eu>\\n>)
  send back, text <{a} / {b} / {c}>
`,
  },
]

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
const root = mkdtempSync(join(tmpdir(), 'term-presence-'))
mkdirSync(join(root, 'link/@term'), { recursive: true })
mkdirSync(join(root, 'code'), { recursive: true })
symlinkSync(join(TERM, 'deck/base'), join(root, 'link/@term/base'))
symlinkSync(join(TERM, 'deck/host'), join(root, 'link/@term/host'))
writeFileSync(join(root, 'deck.tree'), 'deck @probe/presence\n  code <0.0.0>\n')

const dir = join(root, 'out')
mkdirSync(dir, { recursive: true })
const only = process.env.PRESENCE_ONLY ?? ''

for (const one of CASES) {
  for (const backend of BACKENDS.filter(b => !only || b === only)) {
    const ran = runOn({ backend, program: one.program, resolve: env => projectResolver(root, env), dir, name: one.name })

    if (ran.form === 'skipped') {
      console.log(`skip  ${backend}: ${ran.reason}`)
      continue
    }

    ok(
      `${backend}: ${one.says} (${one.name})`,
      ran.form === 'ran' && ran.output === one.want,
      ran.form === 'ran' ? `got ${JSON.stringify(ran.output)}` : `${ran.stage}: ${ran.reason.slice(0, 900)}`,
    )
  }
}

console.log(`\npresence-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
