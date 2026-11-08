// SHAPE TYPE-OF ANSWERS TERM'S WORDS, THE SAME ON EVERY BACKEND (item term-self-host-001-1089). The shape runtime shim
// answered JavaScript's own `typeof` on TypeScript (`string`, `undefined`), and `flag`, `void` and `record` on Rust
// (a list too read `record`), where Swift and Kotlin answered `text`, `boolean`, `null`, `list` and `object`. The
// words are Term's: `text` and `boolean` are its type names, `list` its list, `null` and `object` the words the stdlib's
// json-kind answers (deck/base/code/json.tree).
//
// One program asks the kind of a text, an integer, a decimal, a boolean, a list, a record and a hash, and every backend
// whose toolchain is here must print the one line below.
// Run: npx tsx test/compile/shape-type-of.ts

import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { BACKENDS, runOn } from './shared/run-on'
import { projectResolver } from '@term/call/code/make'

const ROOT = join(import.meta.dirname, '..', '..')

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

const PROGRAM = `dock load
  load <global:shape>, name shape

form point
  link x, like number

task run
  like text
  save xs
    make list
      code 1
      code 2
  save p
    make point
      bind x, code 1
  save h
    make hash
      save <k>, code 1
  host a, like text
    call shape/type-of
      bind value, text <a>
  host b, like text
    call shape/type-of
      bind value, code 7
  host c, like text
    call shape/type-of
      bind value, code 1.5
  host d, like text
    call shape/type-of
      bind value, true
  host e, like text
    call shape/type-of
      bind value, read xs
  host f, like text
    call shape/type-of
      bind value, read p
  host g, like text
    call shape/type-of
      bind value, read h
  back <{a} {b} {c} {d} {e} {f} {g}>
`

const WANT = 'text number number boolean list object object'

// inside the root, as the other run-on suites keep their programs
mkdirSync(join(ROOT, 'tmp'), { recursive: true })
const dir = mkdtempSync(join(ROOT, 'tmp', 'shape-type-of-'))

const resolve = (env: Parameters<typeof projectResolver>[1]) =>
  projectResolver(ROOT, env, ROOT)

let ran = 0

for (const backend of BACKENDS) {
  const done = runOn({
    backend,
    program: PROGRAM,
    resolve,
    dir,
    name: 'kinds',
  })

  if (done.form === 'skipped') {
    console.log(`skip  ${backend}: toolchain not installed`)
    continue
  }

  ran++

  const said =
    done.form === 'ran'
      ? done.output
      : `${done.form}: ${done.reason.slice(0, 400)}`

  ok(`${backend}: type-of answers Term's words`, said === WANT, said)
}

ok('at least TypeScript ran', ran > 0)
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
