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

const baseTree = join(process.cwd(), 'deck', 'seed')

// the stdlib's own modules import each other as `@term/seed/...` (the Term rename); older test programs still say
// `@cluesurf/seed/...`. Both spell the same package, so the resolver accepts either prefix.
const STDLIB_PREFIX = /^@(?:cluesurf|term)\/seed\//

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
const SPAWN = `load @cluesurf/seed/code/task
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
const GATHER = `load @cluesurf/seed/code/task
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

async function main(): Promise<void> {
  ok(
    'spawn then wait returns the task result',
    (await runProgram('spawn', SPAWN)) === 'hello-from-task',
  )
  ok(
    'gather runs tasks concurrently and joins all results',
    (await runProgram('gather', GATHER)) === 'AB',
  )

  console.log(`\nconcurrency: ${pass} pass, ${fail} fail`)
}

main()
