// Jobs run at once on every backend (deck/base/code/task.tree): `spawn` starts its work and returns, the work runs to
// its first wait, and the rest of it runs while the caller waits on something else, one thread, interleaved at each
// wait, which is node's model. Before 2026-10-05 a job's `work` was a synchronous task, so on Rust, Swift and Kotlin it
// ran to its end inside `spawn`, `delay` held the thread, and a `gather` of two waits took their sum. Each backend's
// runtime: Rust's one-thread executor (compile/rust.ts `__term_spawn`, `__term_until`, `__term_block_on`, runtime/job.rs),
// Swift tasks started with `Task.immediate` (runtime/job.swift), Kotlin coroutines on one event loop (`termLoop`,
// runtime/job.kt).
// Run: npx tsx test/compile/spawn-native.ts   (SPAWN_ONLY=typescript, rust, swift or kotlin runs one)

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

const HEAD = `load @term/base/task
  find spawn
  find gather
  find handle

load @term/base/clock
  find delay
  find current-time

load @term/base/list
  find list

load @term/base/exception
  find timeout
  find outage
`

type Case = { name: string; says: string; want: (output: string) => boolean; program: string }

const CASES: Case[] = [
  {
    name: 'order',
    says: 'two jobs that wait finish in the order their waits end, not the order they started',
    want: output => output === 'ba',
    program: `${HEAD}
task run
  mark async
  like text
  save done, make list
  save works, make list
  call works/push
    task a
      mark async
      like text
      call delay(80)
      call done/push(<a>)
      back <a>
  call works/push
    task b
      mark async
      like text
      call delay(10)
      call done/push(<b>)
      back <b>
  save results, gather(works)
  back <{done/0}{done/1}>
`,
  },
  {
    name: 'gather',
    says: 'a gather answers in source order, and two 200 ms waits take about 200 ms, not 400',
    want: output => /^AB [0-9]+$/.test(output) && Number(output.split(' ')[1]) < 330,
    program: `${HEAD}
task run
  mark async
  like text
  save works, make list
  call works/push
    task a
      mark async
      like text
      call delay(200)
      back <A>
  call works/push
    task b
      mark async
      like text
      call delay(200)
      back <B>
  save start, current-time()
  save results, gather(works)
  save took, subtract(current-time(), start)
  back <{results/0}{results/1} {took}>
`,
  },
  {
    name: 'spawn',
    says: 'spawn returns before its work is done, and wait answers its result',
    want: output => output === 'running hello',
    program: `${HEAD}
task run
  mark async
  like text
  save job
    call spawn
      task work
        mark async
        like text
        call delay(20)
        back <hello>
  save state
    fork test, call(alive, job)
      hold, <running>
      miss, <done>
  save answer
    call wait
      read job
      wait true
  back <{state} {answer}>
`,
  },
  {
    name: 'within',
    says: 'wait-within past its limit raises timeout, and does not wait out the work',
    want: output => /^timeout [0-9]+$/.test(output) && Number(output.split(' ')[1]) < 250,
    program: `${HEAD}
task run
  mark async
  like text
  save job
    call spawn
      task work
        mark async
        like text
        call delay(400)
        back <late>
  save start, current-time()
  save answer, <none>
  mark unsafe
    save answer
      call wait-within
        read job
        code 30
        wait true
  halt take
    take problem
    save answer, problem/form
  back <{answer} {subtract(current-time(), start)}>
`,
  },
  {
    name: 'pending',
    says: 'a ticked call used as a value is its pending job: started at once, read with wait, and two of them wait together',
    want: output => /^10 12 [0-9]+$/.test(output) && Number(output.split(' ')[2]) < 330,
    program: `${HEAD}
task double
  mark async
  take n, like number
  like number
  call delay(200)
  back multiply(n, 2)

task run
  mark async
  like text
  save start, current-time()
  save first, tick double(5)
  save second, tick double(6)
  save a
    call wait
      read first
      wait true
  save b
    call wait
      read second
      wait true
  back <{a} {b} {subtract(current-time(), start)}>
`,
  },
  {
    name: 'cancel',
    says: 'waiting on a cancelled job raises outage',
    want: output => output === 'outage',
    program: `${HEAD}
task run
  mark async
  like text
  save job
    call spawn
      task work
        mark async
        like text
        call delay(50)
        back <late>
  call cancel
    read job
  save answer, <none>
  mark unsafe
    save answer
      call wait
        read job
        wait true
  halt take
    take problem
    save answer, problem/form
  back answer
`,
  },
]

const dir = mkdtempSync(join(tmpdir(), 'term-spawn-native-'))
const only = process.env.SPAWN_ONLY ?? ''

for (const one of CASES) {
  for (const backend of BACKENDS.filter(b => !only || b === only)) {
    const ran = runOn({ backend, program: one.program, resolve: env => projectResolver(process.cwd(), env), dir, name: one.name })

    if (ran.form === 'skipped') {
      console.log(`skip  ${backend}: ${ran.reason}`)
      continue
    }

    ok(
      `${backend}: ${one.says} (${one.name})`,
      ran.form === 'ran' && one.want(ran.output),
      ran.form === 'ran' ? `got ${JSON.stringify(ran.output)}` : `${ran.stage}: ${ran.reason}`,
    )
  }
}

console.log(`\nspawn-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
