// A `mark shared` form read inside a call's arguments is not still borrowed when the callee writes it (traps.md T010,
// term-decisions-2026-10-0020). Rust lowers a shared form to an `Rc<RefCell<..>>`, and `set_scheme(m.clone(),
// m.borrow().scheme.clone())` kept the argument's `Ref` to the end of the statement, so the callee's `borrow_mut`
// panicked `RefCell already borrowed` where TypeScript, Swift and Kotlin ran it. Each argument now binds to a `let` in a
// block before the call. Two shapes: a field read as an argument, and a field passed through a nested call.
// Run: npx tsx test/compile/shared-borrow-native.ts   (SB_ONLY=typescript, rust, swift or kotlin runs one)

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

const PROGRAM = `form session
  mark shared
  link scheme, like text
  link buffer, like text

# writes the form it is handed, from a value read off that same form
task set-scheme
  take m, like session
  take value, like text
  save m/scheme, <{value}!>

# writes the form it is handed, from a nested call over a field of that same form
task set-both
  take m, like session
  take value, like text
  take other, like text
  save m/scheme, <{value}+{other}>

task shout
  take s, like text
  like text
  back <{s}?>

task run
  like text
  save m
    make session
      bind scheme, <http>
      bind buffer, <abc>
  call set-scheme
    read m
    read m/scheme
  save first, read m/scheme
  call set-both
    read m
    read m/scheme
    call shout
      read m/buffer
  back <{first}|{m/scheme}>
`

const only = process.env.SB_ONLY
const dir = mkdtempSync(join(tmpdir(), 'term-shared-borrow-'))

for (const backend of BACKENDS.filter(one => !only || one === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: env => projectResolver(process.cwd(), env), dir, name: 'borrow' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  // first: http!; then scheme = (http!) + (abc?)
  ok(
    `${backend}: a shared form read in a call's arguments, written by the callee`,
    ran.form === 'ran' && ran.output === 'http!|http!+abc?',
    ran.form === 'ran' ? ran.output : `${ran.stage}: ${ran.reason}`,
  )
}

console.log(`\nshared-borrow-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
