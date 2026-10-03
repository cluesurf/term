// Fire and forget on Rust (compile/rust.ts `__term_spawn`, `__term_drain`; deck/base/code/pending.tree): an asynchronous
// task started with `tick` from synchronous code, twice, and once more from inside a handler closure, must have run
// all three times once `run-pending` returns. A bare call of an `async fn` in Rust only builds a future, so before the
// executor the count was 0 and the blog in a terminal added no post (terminal-target-0005). TypeScript is held to the
// same answer: an async function runs to its first await when it is called.
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
  call run-pending
  save count, read seen/count
  send back, text <{count}>
`

const dir = mkdtempSync(join(tmpdir(), 'term-tick-native-'))
const only = process.env.TICK_ONLY ?? ''

for (const backend of (['typescript', 'rust'] as Backend[]).filter(b => !only || b === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: env => projectResolver(process.cwd(), env), dir, name: 'tick' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  ok(`${backend}: compiles, builds and runs`, ran.form === 'ran', ran.form === 'failed' ? `${ran.stage}: ${ran.reason}` : '')

  if (ran.form === 'ran') {
    ok(`${backend}: three ticked calls, two plain and one from a handler, all ran by the time run-pending returns`, ran.output === '3', `got ${JSON.stringify(ran.output)}`)
  }
}

console.log(`\ntick-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
