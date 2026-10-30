// A trailing `need false` parameter typed `maybe` and left out is the maybe's none in the body, on every backend (item
// term-self-host-001-0403 of note/project/term/self-host/change/001-finish-self-host, decision 074). Until 2026-10-29 it
// reached the body undefined on TypeScript, so `sift extra` read `.form` off undefined and threw, and Rust passed the
// filled none by value to a task that borrows it (E0308). The signature keeps `extra?:` (decision 074): the body sets
// a left-out maybe to the module's own none constant, the one a `sift` tests, `case none` first included.
// Run: npx tsx test/compile/need-false-maybe.ts (from deck/term/deck/term)
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { BACKENDS, runOn } from './shared/run-on'

let pass = 0
let fail = 0

function ok(name: string, holds: boolean, detail = ''): void {
  if (holds) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

// each task left out, given some, and given none; `none-first` sifts its none case first, which TypeScript tests by
// the constant's identity
const PROGRAM = `load @term/base/maybe
  find maybe

task with-maybe
  take base, like number
  take extra
    like maybe
      like number
    need false
  like number
  sift extra
    case some
      link given
      back add(base, given)
    case none
      back base

task none-first
  take base, like number
  take extra
    like maybe
      like text
    need false
  like text
  sift extra
    case none
      back <none {base}>
    case some
      link given
      back <some {given}>

task run
  like text
  save none, make none
  back <{with-maybe(1)} {with-maybe(1, make(some, 4))} {with-maybe(1, none)} {none-first(2)} {none-first(2, make(some, <x>))}>
`

const WANT = '1 5 1 none 2 some x'
const dir = mkdtempSync(join(tmpdir(), 'term-need-false-maybe-'))

for (const backend of BACKENDS) {
  const ran = runOn({
    backend,
    program: PROGRAM,
    resolve: env => projectResolver(process.cwd(), env),
    dir,
    name: 'maybe',
  })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  ok(
    `${backend}: a left-out maybe is none in the body, a given one itself`,
    ran.form === 'ran' && ran.output === WANT,
    ran.form === 'ran'
      ? `got ${JSON.stringify(ran.output)}`
      : `${ran.stage}: ${ran.reason.slice(0, 600)}`,
  )
}

console.log(`\nneed-false-maybe: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
