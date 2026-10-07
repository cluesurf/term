// Two Rust builds that the process shims used to refuse (items term-self-host-001-0217 and 0218):
//   attached   a program that reaches only `run-attached` (the emitter dropped the unreached `run-result` struct, and
//              runner.rs's `use super::RunResult` failed to resolve)
//   current    a program that loads @term/base/process/current and listens for a signal (current.rs called
//              signal_hook, a crate the stdlib's Cargo.toml never named; it uses libc's signal(2) through extern "C" now)
// Each program is built with rustc or cargo and run, and its output read.
// Run: sh /Users/lancepollard/base/crew/cluesurf/tmp/run-term.sh npx tsx test/compile/process-rust-reach.ts

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { runOn } from './shared/run-on'

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

const ATTACHED = String.raw`load @term/base/process/run
  find run-attached

load @term/base/list
  find list

task run
  mark async
  like text
  save arguments, make list
  call arguments/push(<-c>)
  call arguments/push(<exit 3>)
  save code, run-attached(<sh>, arguments)
  back <attached {code}>
`

const CURRENT = String.raw`load @term/base/process/current
  find read-process
  find listen-process

task run
  like text
  save info, read-process()
  back <current {info/id}>
`

const dir = mkdtempSync(join(tmpdir(), 'term-process-rust-reach-'))

const cases: { key: string; name: string; program: string; want: RegExp }[] = [
  { key: 'attached', name: 'a program that reaches only run-attached builds and runs', program: ATTACHED, want: /^attached 3$/ },
  { key: 'current', name: 'a program that loads process/current builds and runs', program: CURRENT, want: /^current \d+$/ },
]

for (const one of cases) {
  const ran = runOn({ backend: 'rust', program: one.program, resolve: env => projectResolver(process.cwd(), env), dir, name: one.key })

  if (ran.form === 'skipped') {
    console.log(`skip  ${one.name}: ${ran.reason}`)
    continue
  }

  ok(`rust: ${one.name}`, ran.form === 'ran' && one.want.test(ran.output.trim()), ran.form === 'ran' ? ran.output : `${ran.stage}: ${ran.reason}`)
}

console.log(`\nprocess-rust-reach: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
