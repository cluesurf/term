// THE BIT WORDS ARE BUILT IN (decisions-2026-10.md, D3): `bitwise-and`, `bitwise-or`, `bitwise-exclusive-or`,
// `bitwise-not`, `shift-left`, `shift-right` (arithmetic) and `unsigned-shift-right` (logical) need no `load`, as `add`
// needs none. Each is @term/base/bit's own task, given to a module that names it (compile/load.ts `BIT_WORDS`), so it
// is 64-bit on every backend: a 32-bit mask is a mask and not -1 on TypeScript, and a shift past 32 bits keeps its
// bits. A module that loads the module itself is unchanged, and one that defines a task by a bit word's name keeps
// its own. The guide's gap read: "no bitwise operators among the names. The library has its own bit tasks".
// Run: sh tmp/run-term-ts.sh test/compile/bit-builtin.ts   (BIT_ONLY=typescript, rust, swift or kotlin runs one)

import { mkdtempSync } from 'node:fs'
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

// no `load` anywhere: every word below is built in
const BUILT_IN = `task run
  like text

  save a, bitwise-and(12, 10)
  save o, bitwise-or(12, 10)
  save x, bitwise-exclusive-or(12, 10)
  save n, bitwise-not(0)
  save wide, shift-left(1, 40)
  save down, shift-right(-16, 2)
  save logical, unsigned-shift-right(-1, 60)
  save mask, bitwise-and(4294967295, 255)
  save high, bitwise-and(shift-left(1, 40), 1099511627776)
  back <{a} {o} {x} {n} {wide} {down} {logical} {mask} {high}>
`

const BUILT_IN_EXPECTED = '8 14 6 -1 1099511627776 -4 15 255 1099511627776'

// the module loaded by hand, as before: the same answers
const LOADED = `load @term/base/bit
  find bitwise-and
  find shift-left

task run
  like text

  back <{bitwise-and(12, 10)} {shift-left(1, 40)}>
`

// a task of the module's own by a bit word's name is the one its calls reach
const OWN = `task shift-left
  take value, like number
  take count, like number

  like number

  back add(value, count)

task run
  like text

  back <{shift-left(1, 40)} {bitwise-or(1, 2)}>
`

const dir = mkdtempSync(join(tmpdir(), 'term-bit-builtin-'))
const only = process.env.BIT_ONLY ?? ''

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const said = (program: string, name: string) => runOn({ backend, program, resolve: env => projectResolver(process.cwd(), env), dir, name })
  const shown = (ran: ReturnType<typeof said>): string =>
    ran.form === 'ran' ? `got ${JSON.stringify(ran.output)}` : ran.form === 'skipped' ? ran.reason : `${ran.stage}: ${ran.reason}`

  const builtIn = said(BUILT_IN, 'builtin')

  if (builtIn.form === 'skipped') {
    console.log(`skip  ${backend}: ${builtIn.reason}`)
    continue
  }

  ok(`${backend}: the seven bit words need no load, 64-bit`, builtIn.form === 'ran' && builtIn.output === BUILT_IN_EXPECTED, shown(builtIn))

  const loaded = said(LOADED, 'loaded')
  ok(`${backend}: a module that loads them itself answers the same`, loaded.form === 'ran' && loaded.output === '8 1099511627776', shown(loaded))

  const own = said(OWN, 'own')
  ok(`${backend}: a task of the module's own by a bit word's name is its own`, own.form === 'ran' && own.output === '41 3', shown(own))
}

console.log(`\nbit-builtin: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
