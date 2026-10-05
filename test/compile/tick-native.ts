// Fire and forget on every backend (deck/base/code/pending.tree): an asynchronous task started with `tick` from
// synchronous code, twice, and once more from inside a handler closure, runs AT ONCE to its first wait, as an async
// function called on TypeScript does, and all three have run once `run-pending` returns. Rust polls the future once
// where it is started and queues it if it waits (compile/rust.ts `__term_spawn`, `__term_drain`): a bare call of an
// `async fn` only builds a future, so before the executor the count was 0 and the blog in a terminal added no post
// (terminal-target-0005). Swift starts a `Task.immediate` and `run-pending` waits for what is outstanding
// (compile/swift.ts `__termSpawn`, `__termDrain`): a `Task { }` ran later on another thread and the count read 1.
// Kotlin starts the coroutine where it stands (`termStart`).
// Run: npx tsx test/compile/tick-native.ts

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { runOn } from './shared/run-on'
import type { Backend } from './shared/run-on'

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

const PROGRAM = `load @term/base/pending
  find run-pending

form tally
  mark shared
  link count, like number

task bump
  take seen, like tally
  mark async
  save seen/count
    call add
      read seen/count
      code 1

task start-from
  take seen, like tally
  like task
  send back
    task start
      tick bump
        read seen

task run
  like text
  save seen
    make tally
      bind count, code 0
  tick bump
    read seen
  tick bump
    read seen
  save handler
    call start-from
      read seen
  call handler
  save before, read seen/count
  call run-pending
  save count, read seen/count
  send back, text <{before} {count}>
`

const dir = mkdtempSync(join(tmpdir(), 'term-tick-native-'))
const only = process.env.TICK_ONLY ?? ''

for (const backend of (['typescript', 'rust', 'swift', 'kotlin'] as Backend[]).filter(b => !only || b === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: env => projectResolver(process.cwd(), env), dir, name: 'tick' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  ok(`${backend}: compiles, builds and runs`, ran.form === 'ran', ran.form === 'failed' ? `${ran.stage}: ${ran.reason}` : '')

  if (ran.form === 'ran') {
    ok(`${backend}: three ticked calls, two plain and one from a handler, each ran at once, before run-pending, and all by the time it returns`, ran.output === '3 3', `got ${JSON.stringify(ran.output)}`)
  }
}

console.log(`\ntick-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
