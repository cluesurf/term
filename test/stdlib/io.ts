// Native-delegated IO test: the public `file` API forwards (internally, hidden) to the per-env native implementation,
// selected by the build target. Here the node target resolves `native/file` -> `native/node/file`, which docks to
// node:fs. We compile a program that only ever names `file`, transpile + import it, and run real file operations on a
// temp file. Proves the Tier-3 architecture end to end. Run: npx tsx test/stdlib/io.ts

import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@/code/compile/compile'
import { withNativeEnv } from '@/code/compile/native'
import type { Source } from '@/code/compile/load'
import { render } from '@/code/parser/diagnostic'

const here = dirname(fileURLToPath(import.meta.url))
const baseTree = join(here, '..', '..', '..', 'base.tree')
const stdlib = (path: string): Source | undefined => {
  const prefix = '@cluesurf/base/'
  if (!path.startsWith(prefix)) return undefined
  const file = join(baseTree, `${path.slice(prefix.length)}.tree`)
  return existsSync(file) ? { file, text: readFileSync(file, 'utf8') } : undefined
}
// the node target: abstract native imports resolve to native/node/*
const resolve = withNativeEnv('node', stdlib)

let pass = 0
let fail = 0
function expect(name: string, got: unknown, want: unknown): void {
  if (got === want) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)
  }
}

async function loadProgram(source: string): Promise<Record<string, (...a: Array<unknown>) => unknown>> {
  const result = compile({ file: 'main.tree', text: source }, { resolve })
  if (!result.ok) {
    for (const d of result.diagnostics) console.log(render(d, source.split('\n'), false))
    throw new Error('compile failed')
  }
  const js = transformSync(result.typescript, { loader: 'ts', format: 'esm' }).code
  const dir = mkdtempSync(join(tmpdir(), 'seed-io-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, js)
  return (await import(pathToFileURL(file).href)) as Record<string, (...a: Array<unknown>) => unknown>
}

// the program only ever names `file` — the node platform is hidden behind the API
const PROGRAM = `load @cluesurf/base/code/file
  find file

task round-trip
  mark async
  take p, like text
  like text
  call write
    read p
    text <hello world>
    wait true
  send back
    call read
      read p
      wait true

task exists
  take p, like text
  like boolean
  send back
    call test
      read p
`

// clock: forwards to node:perf_hooks (now) + node:timers/promises (sleep), hidden behind the API
const CLOCK = `load @cluesurf/base/code/clock
  find clock

task get-now
  like number
  send back
    call now

task sleep-then-now
  mark async
  take ms, like number
  like number
  call sleep
    read ms
    wait true
  send back
    call now
`

// process + console: forward to host globals via the `<global:X>` dock (no import), hidden behind the API
const PROCESS = `load @cluesurf/base/code/process
  find process

task plat
  like text
  send back
    call platform
`

const CONSOLE = `load @cluesurf/base/code/console
  find console

task say
  take m, like text
  call log
    read m
`

const ENVIRONMENT = `load @cluesurf/base/code/environment
  find environment

task cwd
  like text
  send back
    call directory
`

const TIME = `load @cluesurf/base/code/time
  find time

task epoch
  like number
  send back
    call now
`

async function main(): Promise<void> {
  const en = await loadProgram(ENVIRONMENT)
  const cwd = en.cwd!() as string
  expect('environment: directory reads the working dir (non-empty)', typeof cwd === 'string' && cwd.length > 0, true)

  const ti = await loadProgram(TIME)
  const epoch = ti.epoch!() as number
  expect('time: now returns a positive epoch', typeof epoch === 'number' && epoch > 0, true)

  const pr = await loadProgram(PROCESS)
  const plat = pr.plat!() as string
  expect('process: platform reads the host global (non-empty string)', typeof plat === 'string' && plat.length > 0, true)

  const co = await loadProgram(CONSOLE)
  expect('console: log forwards to the host console and returns unit', co.say!('') === undefined, true)

  const c = await loadProgram(CLOCK)
  const t0 = c.getNow!() as number
  expect('clock: now returns a positive number (node perf_hooks)', typeof t0 === 'number' && t0 > 0, true)
  const t1 = (await c.sleepThenNow!(5)) as number
  expect('clock: sleep then now advances time', t1 >= t0, true)

  const m = await loadProgram(PROGRAM)
  const dir = mkdtempSync(join(tmpdir(), 'seed-iofile-'))
  const path = join(dir, 'note.txt')
  const missing = join(dir, 'nope.txt')

  const content = await m.roundTrip!(path)
  expect('file: write then read round-trips through node fs', content, 'hello world')
  expect('file: the file really exists on disk after write', existsSync(path), true)
  expect('file: test reports an existing file', m.exists!(path), true)
  expect('file: test reports a missing file', m.exists!(missing), false)

  console.log(`\nio: ${pass} pass, ${fail} fail  (public file API -> hidden node native -> real fs)`)
  if (fail > 0) process.exit(1)
}

main()
