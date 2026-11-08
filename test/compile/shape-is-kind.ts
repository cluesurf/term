// SHAPE IS-LIST AND IS-NUMBER ANSWER THE SAME ON EVERY BACKEND (item term-self-host-001-1091, found by 1089). Swift's
// isList answered false for every Term list (a Term list is the prelude's SeedList<T>, never an [Any]), and Rust's
// is_number answered false for a bare integer literal and a number variable (an i32 handed to the generic, where it
// asked i64 and f64 only). is-number was Rust's alone: node, browser, swift and kotlin now answer it too, as type-of's
// `number`.
//
// Two programs, so one op's absence never hides the other's answer: is-list of a list and of a text, and is-number of
// a bare integer, a decimal, a number variable, a text and a boolean. Every backend whose toolchain is here must print
// the line each wants. The neighbour suite is shape-type-of.ts (1089).
// Run: npx tsx test/compile/shape-is-kind.ts

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

const LIST = `dock load
  load <global:shape>, name shape

task run
  like text
  save xs
    make list
      code 1
      code 2
  host a, like boolean
    call shape/is-list
      bind value, read xs
  host b, like boolean
    call shape/is-list
      bind value, text <a>
  back <{a} {b}>
`

const NUMBER = `dock load
  load <global:shape>, name shape

task run
  like text
  save n, code 5
  host c, like boolean
    call shape/is-number
      bind value, code 7
  host d, like boolean
    call shape/is-number
      bind value, code 1.5
  host e, like boolean
    call shape/is-number
      bind value, read n
  host f, like boolean
    call shape/is-number
      bind value, text <7>
  host g, like boolean
    call shape/is-number
      bind value, true
  back <{c} {d} {e} {f} {g}>
`

const CASES = [
  { name: 'is-list', file: 'lists', program: LIST, want: 'true false' },
  { name: 'is-number', file: 'numbers', program: NUMBER, want: 'true true true false false' },
]

// inside the root, as the other run-on suites keep their programs
mkdirSync(join(ROOT, 'tmp'), { recursive: true })
const dir = mkdtempSync(join(ROOT, 'tmp', 'shape-is-kind-'))

const resolve = (env: Parameters<typeof projectResolver>[1]) =>
  projectResolver(ROOT, env, ROOT)

let ran = 0

for (const backend of BACKENDS) {
  for (const { name, file, program, want } of CASES) {
    const done = runOn({
      backend,
      program,
      resolve,
      dir,
      name: file,
    })

    if (done.form === 'skipped') {
      console.log(`skip  ${backend} ${name}: toolchain not installed`)
      continue
    }

    ran++

    const said =
      done.form === 'ran'
        ? done.output
        : `${done.form}: ${done.reason.slice(0, 400)}`

    ok(`${backend}: ${name} answers alike`, said === want, said)
  }
}

ok('at least TypeScript ran', ran > 0)
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
