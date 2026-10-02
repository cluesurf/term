// Structured-concurrency test: spawn a task and wait for its result, and gather a group of tasks so they all finish
// before control returns. Compiles the public task module (with its node runtime shim) to TypeScript and runs it.
// Built on the async-closure lowering: the `work` closures are async and the runtime awaits them.
// Run: npx tsx test/compile/concurrency.ts

import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
import { resolve as resolveNames } from '@term/make/code/check/resolve'
import { check } from '@term/make/code/check/infer'
import { resolveAsync } from '@term/make/code/check/async-resolve'
import { simplify } from '@term/make/code/ir/simplify'
import { collectModules } from '@term/make/code/compile/load'
import {
  withNativeEnv,
  nativePrelude,
} from '@term/make/code/compile/native'
import type { Source } from '@term/make/code/compile/load'
import { emitTypeScript } from '@term/make/code/compile/typescript'
import type { Program } from '@term/make/code/compile/node'

const baseTree = join(process.cwd(), 'deck', 'base')

// the stdlib's own modules import each other as `@term/base/...` (the Term rename); older test programs still say
// `@term/base/...`. Both spell the same package, so the resolver accepts either prefix.
const STDLIB_PREFIX = /^@term\/base\//

const stdlib = (path: string): Source | undefined => {
  if (!STDLIB_PREFIX.test(path)) {
    return undefined
  }

  const file = join(
    baseTree,
    `${path.replace(STDLIB_PREFIX, '')}.tree`,
  )

  return existsSync(file)
    ? { file, text: readFileSync(file, 'utf8') }
    : undefined
}

const readRuntime = (path: string): string | undefined => {
  if (existsSync(path)) {
    return readFileSync(path, 'utf8')
  }

  if (!STDLIB_PREFIX.test(path)) {
    return undefined
  }

  const file = join(baseTree, path.replace(STDLIB_PREFIX, ''))

  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

function frontEnd(text: string): Program {
  const sources = collectModules(
    { file: 'main.tree', text },
    withNativeEnv('node', stdlib),
  ).sources

  const program: Program = []
  const roots = new Set<string>()

  for (const unit of sources) {
    const parsed = parse(unit)

    if (!parsed.ok) {
      throw new Error('parse failed: ' + unit.file)
    }

    const built = mill(parsed.tree, unit.file)

    if (!built.ok) {
      throw new Error(
        'mill failed: ' +
          built.diagnostics.map(d => d.message).join(', '),
      )
    }

    if (unit.file === 'main.tree') {
      for (const node of built.program) {
        if (node.form === 'function') {
          roots.add(node.name)
        }
      }
    }

    program.push(...built.program)
  }

  resolveNames(program, 'main.tree')
  check(program, 'main.tree')
  resolveAsync(program)

  return simplify(program, roots)
}

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

const dir = mkdtempSync(join(tmpdir(), 'seed-concurrency-'))

async function runProgram(
  name: string,
  source: string,
): Promise<string> {
  const program = frontEnd(source)
  const ts =
    nativePrelude(program, 'node', readRuntime) +
    '\n' +
    emitTypeScript(program)
  const file = join(dir, `${name}.ts`)
  writeFileSync(file, ts)

  const mod = (await import(pathToFileURL(file).href)) as {
    run: () => Promise<string>
  }

  return mod.run()
}

// spawn a task, wait for its result
const SPAWN = `load @term/base/code/task
  find spawn

task run
  note async
  like text
  save job
    call spawn
      task work
        like text
        send back
          text <hello-from-task>
  send back
    call wait
      read job
      wait true
`

// gather two tasks: both complete before gather returns, results in source order, joined -> "AB"
const GATHER = `load @term/base/code/task
  find gather

task run
  note async
  like text
  save works
    make list
  call works/push
    task a
      like text
      send back
        text <A>
  call works/push
    task b
      like text
      send back
        text <B>
  save results
    call gather
      read works
      wait true
  send back
    call add
      call results/at
        code 0
      call results/at
        code 1
`

// the imports every failure case below shares
const HEAD = `load @term/base/code/task
  find spawn
  find gather

load @term/base/code/clock
  find sleep

load @term/base/code/exception
  find failure
`

// a job that sleeps, then answers
const slow = (name: string, ms: number, value: string) => `  call works/push
    task ${name}
      like text
      call sleep
        code ${ms}
        wait true
      send back
        text <${value}>
`

// a job that sleeps, then raises `failure` naming itself
const raising = (name: string, ms: number) => `  call works/push
    task ${name}
      like text
      call sleep
        code ${ms}
        wait true
      halt failure
        bind thing, text <${name}>
`

const gatherOf = (jobs: string) => `${HEAD}
task run
  note async
  like text
  save works
    make list
${jobs}  save results
    call gather
      read works
      wait true
  send back
    call results/at
      code 0
`

// one job raises at once, the other would take 400 ms: gather must raise without waiting for it
const GATHER_FAILS_FAST = gatherOf(`${slow('a', 400, 'A')}${raising('b', 0)}`)

// the job FIRST in the list is still running when the second fails: the raise is the second's, not an outage for
// the first, which is cancelled along the way
const GATHER_RAISES_THE_FAILURE = gatherOf(`${raising('a', 300)}${raising('b', 0)}`)

const CANCELLED = `${HEAD}
task run
  note async
  like text
  save job
    call spawn
      task work
        like text
        call sleep
          code 200
          wait true
        send back
          text <late>
  call cancel
    read job
  send back
    call wait
      read job
      wait true
`

const TIMED_OUT = `${HEAD}
task run
  note async
  like text
  save job
    call spawn
      task work
        like text
        call sleep
          code 400
          wait true
        send back
          text <late>
  send back
    call wait-within
      read job
      code 50
      wait true
`

// a cancelled job that raises afterwards: nobody is waiting, and nothing may surface. Before, an unawaited job that
// raised was an unhandled rejection, which ends a Node process
const CANCELLED_THEN_RAISES = `${HEAD}
task run
  note async
  like text
  save job
    call spawn
      task work
        like text
        call sleep
          code 30
          wait true
        halt failure
          bind thing, text <after-cancel>
  call cancel
    read job
  call sleep
    code 120
    wait true
  send back
    text <quiet>
`

// run a program expected to raise: the exception's form, its `link`, and how long it took
async function raised(
  name: string,
  source: string,
): Promise<{ form?: string; link?: Record<string, unknown>; ms: number; value?: string; message?: string }> {
  const start = Date.now()

  try {
    const value = await runProgram(name, source)

    return { ms: Date.now() - start, value }
  } catch (error) {
    const e = error as { form?: string; link?: Record<string, unknown>; message?: string }

    return { form: e.form, link: e.link, ms: Date.now() - start, message: e.form ? undefined : e.message }
  }
}

async function main(): Promise<void> {
  let unhandled = 0

  process.on('unhandledRejection', () => {
    unhandled++
  })

  ok(
    'spawn then wait returns the task result',
    (await runProgram('spawn', SPAWN)) === 'hello-from-task',
  )
  ok(
    'gather runs tasks concurrently and joins all results',
    (await runProgram('gather', GATHER)) === 'AB',
  )

  const fast = await raised('gather-fails-fast', GATHER_FAILS_FAST)

  ok(
    'gather raises the failing job`s own exception',
    fast.form === 'failure' && fast.link?.thing === 'b',
    JSON.stringify(fast),
  )
  ok(
    'and raises it when it happens, not after the slow job before it',
    fast.ms < 300,
    `${fast.ms} ms`,
  )

  const order = await raised('gather-raises-the-failure', GATHER_RAISES_THE_FAILURE)

  ok(
    'gather raises the job that failed, not an outage for a sibling still running',
    order.form === 'failure' && order.link?.thing === 'b',
    JSON.stringify(order),
  )

  const cancelled = await raised('cancelled', CANCELLED)

  ok(
    'waiting on a cancelled task raises outage',
    cancelled.form === 'outage',
    JSON.stringify(cancelled),
  )
  ok('and does not wait for the work it gave up on', cancelled.ms < 150, `${cancelled.ms} ms`)

  const timed = await raised('timed-out', TIMED_OUT)

  ok(
    'wait-within raises timeout with the time waited',
    timed.form === 'timeout' && timed.link?.waited === 50,
    JSON.stringify(timed),
  )
  ok('and gives up at the limit', timed.ms < 300, `${timed.ms} ms`)

  const quiet = await raised('cancelled-then-raises', CANCELLED_THEN_RAISES)

  ok(
    'a cancelled task that raises later surfaces nothing',
    quiet.value === 'quiet' && unhandled === 0,
    JSON.stringify({ ...quiet, unhandled }),
  )

  // the slow jobs the failures above left behind settle within this, and none of them may surface either
  await new Promise(resolve => setTimeout(resolve, 500))

  ok('no job left behind by a failure becomes an unhandled rejection', unhandled === 0, `${unhandled}`)

  console.log(`\nconcurrency: ${pass} pass, ${fail} fail`)
}

main()
