// Native work that finishes on another thread is HANDED BACK to the program's one loop
// (note/project/term/decision/001-native-work-hands-back-to-the-loop.md): a file read or an HTTP request runs on the
// runtime's pool of 4, and the loop runs the other jobs while it waits. Each case below fails on a loop that blocks:
//
//   fifo     one job reads a FIFO, a second job writes it after a 50 ms clock delay. The read blocks a worker until the
//            write, so a loop that ran the read on its own thread never reaches the writer, and the program hangs
//   http     a ticked clock job takes four 40 ms beats while an HTTP request waits 400 ms on a local server: its last
//            beat lands before the response, not after it
//   stall    a job that waits on a channel nothing sends to, after a file read that came back: the read's hand-back
//            leaves the count, and the wait still stops with the defect. On every backend: Swift's loop is
//            native/swift/runtime/loop.swift (term-stdlib-parity-0014), and node's main (compile/main-entry.tree)
//            stops when its event loop empties with the entry unsettled (term-stdlib-parity-0016)
//
// Every run has a 20 s limit, so a hang is a failure and never a stuck suite.
// Run: npx tsx test/compile/hand-back-native.ts   (HAND_BACK_ONLY=typescript, rust, swift or kotlin runs one)

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { BACKENDS, buildOn } from './shared/run-on'
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

const LIMIT = 20_000
const DEFECT = 'defect: the program waits on work that nothing can finish'

const dir = mkdtempSync(join(tmpdir(), 'term-hand-back-native-'))
const only = process.env.HAND_BACK_ONLY ?? ''

// a local server whose one route answers `pong` after 400 ms, in a process of its own: the program under test is run
// synchronously, and a server on this process's event loop could not answer it
const SERVER = `require('node:http').createServer((q, s) => setTimeout(() => s.end('pong'), 400)).listen(0, '127.0.0.1', function () { console.log(this.address().port) })`

const fifoProgram = (pipe: string): string => `load @term/base/task
  find spawn
  find handle

load @term/base/clock
  find delay

load @term/base/file
  find read, name file-read
  find write, name file-write

task feed
  mark async
  like text
  call delay(50)
  call file-write(<${pipe}>, <hello>)
  back <wrote>

task run
  mark async
  like text
  save got, tick file-read(<${pipe}>)
  save put, tick feed()
  save a
    call wait
      read got
      wait true
  save b
    call wait
      read put
      wait true
  back <{a} {b}>
`

const httpProgram = (port: number): string => `load @term/base/task
  find spawn
  find handle

load @term/base/clock
  find delay
  find current-time

load @term/base/network/http
  find fetch

task beat
  mark async
  like number
  call delay(40)
  call delay(40)
  call delay(40)
  call delay(40)
  back current-time()

task run
  mark async
  like text
  save clock, tick beat()
  save answer, fetch(<http://127.0.0.1:${port}/>)
  save fetched, current-time()
  save beaten
    call wait
      read clock
      wait true
  save during
    fork test, is-below(beaten, fetched)
      hold, <during>
      miss, <after>
  back <{answer/body} {during}>
`

const stallProgram = (file: string): string => `load @term/base/task
  find spawn
  find handle

load @term/base/channel
  find make-text-channel

load @term/base/file
  find read, name file-read

task never
  mark async
  like text
  save first, file-read(<${file}>)
  save box, make-text-channel()
  call box/receive()
  back first

task run
  mark async
  like text
  save job, tick never()
  save got
    call wait
      read job
      wait true
  back got
`

type Outcome = { status: number | null; output: string; error: string; timedOut: boolean }

function runBuilt(backend: Backend, name: string, program: string): Outcome | string {
  const built = buildOn({ backend, program, resolve: env => projectResolver(process.cwd(), env), dir, name })

  if (built.form === 'skipped') return `skip ${built.reason}`
  if (built.form === 'failed') return `${built.stage}: ${built.reason}`

  const ran = spawnSync(built.command[0]!, built.command.slice(1), { encoding: 'utf8', timeout: LIMIT })

  return {
    status: ran.status,
    output: String(ran.stdout ?? ''),
    error: String(ran.stderr ?? ''),
    timedOut: ran.error !== undefined && /ETIMEDOUT/.test(String(ran.error)),
  }
}

function report(backend: Backend, says: string, outcome: Outcome | string, want: (o: Outcome) => boolean): void {
  if (typeof outcome === 'string') {
    if (outcome.startsWith('skip ')) {
      console.log(`skip  ${backend}: ${outcome.slice(5)}`)
      return
    }

    ok(`${backend}: ${says}`, false, outcome.slice(0, 1200))
    return
  }

  const info = outcome.timedOut
    ? `hung past ${LIMIT} ms`
    : `exit ${outcome.status}, out ${JSON.stringify(outcome.output)}, err ${JSON.stringify(outcome.error.slice(0, 600))}`
  ok(`${backend}: ${says}`, !outcome.timedOut && want(outcome), info)
}

async function serve(): Promise<{ port: number; stop: () => void }> {
  const child = spawn(process.execPath, ['-e', SERVER], { stdio: ['ignore', 'pipe', 'inherit'] })
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout.once('data', chunk => resolve(Number(String(chunk).trim())))
    child.once('exit', code => reject(new Error(`server exited ${code}`)))
  })

  return { port, stop: () => child.kill() }
}

const server = await serve()
const plain = join(dir, 'plain.txt')
writeFileSync(plain, 'x')

try {
  for (const backend of BACKENDS.filter(b => !only || b === only)) {
    const pipe = join(dir, `pipe-${backend}`)
    execFileSync('mkfifo', [pipe])

    report(
      backend,
      'a FIFO read by one job and written by another after a clock delay: both end (fifo)',
      runBuilt(backend, 'fifo', fifoProgram(pipe)),
      o => o.status === 0 && o.output === 'hello wrote',
    )

    report(
      backend,
      'a ticked clock job beats while an HTTP request waits (http)',
      runBuilt(backend, 'http', httpProgram(server.port)),
      o => o.status === 0 && o.output === 'pong during',
    )

    report(
      backend,
      'a wait on a job that never ends stops with the defect, after a hand-back came back (stall)',
      runBuilt(backend, 'stall', stallProgram(plain)),
      o => o.status !== 0 && o.error.includes(DEFECT),
    )
  }
} finally {
  server.stop()
}

console.log(`\nhand-back-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
