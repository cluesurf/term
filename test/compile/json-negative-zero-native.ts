// NEGATIVE ZERO LIVES THROUGH JSON ON EVERY BACKEND (item term-self-host-001-0792). Rust's runtime json.rs wrote any whole
// float as a whole number on its way into a serde value, so `as-number(parse(<-0.0>))` lost the sign after dynamic became
// the boxed dynamic (item 0763), and @term/host's scanner reads a decimal literal through that path. A value keeps its sign
// when read, and stringify still writes it as TypeScript's JSON.stringify does: 0.
// Run: npx tsx test/compile/json-negative-zero-native.ts   (from deck/term/deck/term; SLOT_ONLY=typescript|rust|swift|kotlin)

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { BACKENDS, runOn } from './shared/run-on'

let pass = 0
let fail = 0

const PROGRAM = `load @term/base/json
  find parse
  find stringify
  find get-field
  find get-item
  find set-field
  find make-object
  find from-number
  find as-number

load @term/base/float/64
  find f64-to-bytes

load @term/base/bytes
  find to-byte-list

task sign
  take value, like float
  like number
  save bits, to-byte-list(f64-to-bytes(value))
  back bits/0

task run
  like text
  save answer, <>
  fork
    mark unsafe
    save zero, as-number(parse(<-0.0>))
    save kept, set-field(make-object(), <k>, from-number(zero))
    save read, sign(zero)
    save plain, sign(as-number(parse(<0.0>)))
    save field, sign(as-number(get-field(parse(<\\{"k":-0.0\\}>), <k>)))
    save item, sign(as-number(get-item(parse(<[-0.0]>), 0)))
    save held, sign(as-number(get-field(kept, <k>)))
    save answer, <{read} {plain} {field} {item} {held}|{stringify(parse(<-0.0>))}|{stringify(parse(<[-0.0]>))}|{stringify(kept)}>
  halt take
    take problem
    save answer, <raised {problem/form}>
  back answer
`

const EXPECTED = '128 0 128 128 128|0|[0]|{"k":0}'

// a backend's own defect, named so a new one still fails. Swift's stringify writes -0 inside a container (it predates this)
const GAPS: Record<string, string> = {
  swift: '128 0 128 128 128|0|[-0]|{"k":-0}',
}

// NZ_DIR keeps the emitted program where a reader can find it
const dir = process.env.NZ_DIR ?? mkdtempSync(join(tmpdir(), 'term-json-negative-zero-'))
const only = process.env.SLOT_ONLY ?? ''

if (!process.env.NZ_DIR) {
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
}

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({
    backend,
    program: PROGRAM,
    resolve: env => projectResolver(process.cwd(), env),
    dir,
    name: 'json-negative-zero',
  })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  if (ran.form === 'ran' && ran.output === EXPECTED) {
    pass++
    console.log(`ok    ${backend}: prints what TypeScript prints`)
  } else if (ran.form === 'ran' && ran.output === GAPS[backend]) {
    console.log(`gap   ${backend}: the signs are kept, stringify writes -0, its own defect`)
  } else {
    fail++
    console.log(
      `FAIL  ${backend}  ${
        ran.form === 'ran'
          ? `got ${JSON.stringify(ran.output)}`
          : `${ran.stage}: ${ran.reason.slice(0, 900)}`
      }`,
    )
  }
}

console.log(`\njson-negative-zero-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
