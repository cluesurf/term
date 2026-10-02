// Supervision trees (deck/base/code/supervisor.tree): restarts by OTP's protocol, compiled to TypeScript and run, and
// the build's refusals, which are what Term adds over OTP: a tree whose limits mean nothing, and a transient worker that
// can never restart, both fail before anything runs. note/term/research/beam-otp-lessons.md, design 4.
// Run: npx tsx test/compile/supervisor.ts

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude, withNativeEnv } from '@term/make/code/compile/native'
import type { Source } from '@term/make/code/compile/load'

const baseTree = join(process.cwd(), 'deck', 'base')
const PREFIX = /^@term\/base\//

const stdlib = (path: string): Source | undefined => {
  if (!PREFIX.test(path)) {
    return undefined
  }

  const file = join(baseTree, `${path.replace(PREFIX, '')}.tree`)

  return existsSync(file) ? { file, text: readFileSync(file, 'utf8') } : undefined
}

const readRuntime = (path: string): string | undefined => {
  if (existsSync(path)) {
    return readFileSync(path, 'utf8')
  }

  const file = join(baseTree, path.replace(PREFIX, ''))

  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
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

const dir = mkdtempSync(join(tmpdir(), 'term-supervisor-'))

// the build's refusal, or undefined when it builds
function refusal(source: string): string | undefined {
  const compiled = compile({ file: 'main.tree', text: source }, { resolve: withNativeEnv('node', stdlib) })

  return compiled.ok ? undefined : compiled.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | ')
}

// run `run`: its answer, or the exception it raised
async function outcome(name: string, source: string): Promise<{ value?: unknown; form?: string; thing?: unknown }> {
  const compiled = compile({ file: 'main.tree', text: source }, { resolve: withNativeEnv('node', stdlib) })

  if (!compiled.ok) {
    throw new Error(compiled.diagnostics.map(d => `${d.file}:${d.span.start.line + 1} ${d.message}`).join('\n'))
  }

  const file = join(dir, `${name}.ts`)

  writeFileSync(file, `${nativePrelude(compiled.program, 'node', readRuntime)}\n${compiled.typescript}`)

  const mod = (await import(pathToFileURL(file).href)) as { run: () => Promise<unknown> }

  try {
    return { value: await mod.run() }
  } catch (error) {
    const e = error as { form?: string; link?: { thing?: unknown } }

    return { form: e.form, thing: e.link?.thing }
  }
}

const HEAD = `load @term/base/code/supervisor
  find make-supervisor
  find supervise

load @term/base/code/exception
  find conflict

load @term/base/code/list
  find join
`

// a transient worker that raises every time: two restarts in the window, then the supervisor stops and escalates
const CRASH_LOOP = `${HEAD}
task run
  note async
  like text
  save children
    make list
  call children/push
    make worker
      bind name, text <flaky>
      bind restart
        make transient
      bind work
        task flaky
          like text
          halt conflict
            bind thing, text <flaky>
  save tree
    call make-supervisor
      text <root>
      make one-for-one
      code 2
      code 10000
      read children
  send back
    call supervise
      read tree
      wait true
`

// a worker under `restart`, counting its runs in `runs`, raising until `fails` runs have happened
const counting = (name: string, restart: string, fails: number) => `  call children/push
    make worker
      bind name, text <${name}>
      bind restart
        make ${restart}
      bind work
        task ${name}
          like text
          call ${name}-runs/push
            text <${name}>
          fork test
            hook test
              call is-maximum
                read ${name}-runs/length
                code ${fails}
            hook hold
              halt conflict
                bind thing, text <${name}>
          send back, text <${name}>
`

const program = (strategy: string, intensity: number, body: string, lists: string[]) => `${HEAD}
task run
  note async
  like text
${lists.map(l => `  save ${l}-runs\n    make list\n`).join('')}  save children
    make list
${body}  save tree
    call make-supervisor
      text <root>
      make ${strategy}
      code ${intensity}
      code 10000
      read children
  save ended
    call supervise
      read tree
      wait true
  send back
    call join
      make list
        read ended
${lists.map(l => `        call join\n          read ${l}-runs\n          text <>\n`).join('')}      text <,>
`

// a temporary worker that returns once: nothing to restart, the supervisor ends and answers its name
const TEMPORARY = program('one-for-one', 3, counting('a', 'temporary', 0), ['a'])

// a transient worker that fails twice then returns: restarted twice, then the supervisor ends
const TRANSIENT_RECOVERS = program('one-for-one', 3, counting('a', 'transient', 2), ['a'])

// one-for-all: `b` fails once, which restarts `a` too, so `a` runs twice though it never failed
const ONE_FOR_ALL = program('one-for-all', 3, `${counting('a', 'transient', 0)}${counting('b', 'transient', 1)}`, ['a', 'b'])

// one-for-one: the same failure restarts only `b`
const ONE_FOR_ONE = program('one-for-one', 3, `${counting('a', 'transient', 0)}${counting('b', 'transient', 1)}`, ['a', 'b'])

// a nested supervisor allowed no restarts, around a worker that always fails: it stops and raises, its parent sees a
// failed child, restarts it once, sees it fail again, and stops too, naming itself
const NESTED = `${HEAD}
task run
  note async
  like text
  save inner
    make list
  call inner/push
    make worker
      bind name, text <deep>
      bind restart
        make transient
      bind work
        task deep
          like text
          halt conflict
            bind thing, text <deep>
  save children
    make list
  call children/push
    make nested
      bind tree
        call make-supervisor
          text <inner>
          make one-for-one
          code 0
          code 10000
          read inner
  save tree
    call make-supervisor
      text <outer>
      make one-for-one
      code 1
      code 10000
      read children
  send back
    call supervise
      read tree
      wait true
`

// a restart limit below zero means nothing: `make-supervisor` owes `intensity >= 0`
const NEGATIVE = `${HEAD}
task run
  like text
  save children
    make list
  save tree
    call make-supervisor
      text <root>
      make one-for-one
      code -1
      code 10000
      read children
  send back, read tree/name
`

// a transient worker whose work cannot raise: it can never restart, so it is a temporary under a misleading name
const DEAD_TRANSIENT = `${HEAD}
task run
  note async
  like text
  save children
    make list
  call children/push
    make worker
      bind name, text <calm>
      bind restart
        make transient
      bind work
        task calm
          like text
          send back, text <calm>
  save tree
    call make-supervisor
      text <root>
      make one-for-one
      code 1
      code 10000
      read children
  send back
    call supervise
      read tree
      wait true
`

// a two-level tree for the roll: inner allows 2 restarts, outer 3, so inner's workers can restart 2 × (3 + 1) = 8
// times before outer stops
const ROLLED = `${HEAD}
task run
  like text
  save inner
    make list
  call inner/push
    make worker
      bind name, text <deep>
      bind restart
        make permanent
      bind work
        task deep
          like text
          send back, text <deep>
  save children
    make list
  call children/push
    make nested
      bind tree
        call make-supervisor
          text <inner>
          make one-for-one
          code 2
          code 5000
          read inner
  save tree
    call make-supervisor
      text <outer>
      make rest-for-one
      code 3
      code 10000
      read children
  send back, read tree/name
`

async function main(): Promise<void> {
  const rolled = compile({ file: 'main.tree', text: ROLLED }, { resolve: withNativeEnv('node', stdlib), roll: true })
  const trees = rolled.ok ? (rolled.roll?.supervision ?? []) : []
  const inner = trees.find(t => t.name === 'inner')
  const outer = trees.find(t => t.name === 'outer')

  ok(
    'the roll lists each supervisor with its strategy, limits and children',
    outer?.strategy === 'rest-for-one' && outer.intensity === 3 && outer.period === 10000 && (outer.nested as string[])?.[0] === 'inner' && inner?.worker === 1,
    JSON.stringify(trees),
  )
  ok(
    'and the worst case: a nested limit times one more than each limit above it',
    inner?.worst === 8 && inner.under === 'outer' && outer?.worst === 3,
    JSON.stringify(trees),
  )

  const loop = await outcome('crash-loop', CRASH_LOOP)

  ok('a crash loop past the intensity stops the supervisor with overload', loop.form === 'overload' && loop.thing === 'root', JSON.stringify(loop))

  const temporary = await outcome('temporary', TEMPORARY)

  ok('a temporary child that returns is not restarted, and the supervisor ends', temporary.value === 'root,a', JSON.stringify(temporary))

  const recovers = await outcome('transient-recovers', TRANSIENT_RECOVERS)

  ok('a transient child is restarted while it raises, and not once it returns', recovers.value === 'root,aaa', JSON.stringify(recovers))

  const all = await outcome('one-for-all', ONE_FOR_ALL)

  ok('one-for-all restarts the sibling of the child that failed', all.value === 'root,aa,bb', JSON.stringify(all))

  const one = await outcome('one-for-one', ONE_FOR_ONE)

  ok('one-for-one restarts only the child that failed', one.value === 'root,a,bb', JSON.stringify(one))

  const nested = await outcome('nested', NESTED)

  ok('a nested supervisor that stops escalates to its parent, which stops too', nested.form === 'overload' && nested.thing === 'outer', JSON.stringify(nested))

  const negative = refusal(NEGATIVE)

  ok('a negative restart limit fails the build', negative !== undefined && /have|unproven|refuted/.test(negative), negative ?? 'it built')

  const dead = refusal(DEAD_TRANSIENT)

  ok('a transient worker whose work cannot raise fails the build', dead !== undefined && /transient/.test(dead), dead ?? 'it built')

  console.log(`\nsupervisor: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exitCode = 1
  }
}

main().catch(error => {
  console.log(`FAIL  the suite stopped: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
