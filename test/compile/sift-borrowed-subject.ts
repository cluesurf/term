// A SIFT STRAIGHT ON A CALL OVER AN ARM'S FIELD (item term-self-host-001-0060). `case fields / link values /
// sift get(values, 0)` emitted `match values.borrow()[0].clone() { .. }` as the arm's last statement on Rust, and a
// temporary in a block's tail expression lives past the block's locals, so rustc refused it, E0597 "`values` does not
// live long enough". The Rust emitter (compile/rust-emit.tree `emit-match`) binds a subject holding a borrow with a
// `let` first. Built AND run on every backend. Run from deck/term/deck/term: npx tsx test/compile/sift-borrowed-subject.ts (SIFT_ONLY=rust runs one)

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

const PROGRAM = `load @term/base/list
  find get

form cell
  case number
    link value, like integer
  case word
    link value, like text

form row
  case fields
    link values, like list, like cell
  case blank

task first-text
  take r, like row
  like text

  sift r
    case fields
      link values
      sift get(values, 0)
        case number
          back <n {value}>
        case word
          back <w {value}>
    case blank
      back <blank>

task run
  like text

  save cells, make list
  push(cells, make(word, <hi>))
  push(cells, make(number, 3))
  save a
    make fields
      bind values, cells
  save b, make blank
  back <{first-text(a)} {first-text(b)}>
`

const EXPECTED = 'w hi blank'

const dir = mkdtempSync(join(tmpdir(), 'term-sift-borrowed-'))
const only = process.env.SIFT_ONLY ?? ''

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: env => projectResolver(process.cwd(), env), dir, name: 'sift-borrowed' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  ok(
    `${backend}: a sift straight on a call over an arm's field builds and runs`,
    ran.form === 'ran' && ran.output.trim() === EXPECTED,
    ran.form === 'ran' ? `got ${ran.output.trim()}` : `${ran.stage}: ${ran.reason.slice(0, 600)}`,
  )
}

console.log(`\nsift-borrowed-subject: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
