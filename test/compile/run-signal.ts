// `run-attached` passes signals as system(3) does (item term-self-host-001-0191, spec 4.24, D024): while it waits for its
// child the parent ignores INT and QUIT (a terminal sends them to the child's own process group, which gets each) and
// passes TERM and HUP, sent to the parent alone, on to the child. Node does it with process.on handlers set after the
// spawn (deck/base/code/native/node/process/runtime/runner.ts) and Rust with signal(2) through extern "C", set after
// the spawn too so the child keeps the default dispositions (runtime/runner.rs). The dispositions come back when the
// child ends.
//
// One Term program per backend, built once, run once per case as a real process of its own group. It runs
// `run-attached(sh, [-c, <script>])` and exits with the code that returned (`@term/base/process` `exit`). The script traps
// TERM (kills its sleep, exit 7) and INT (exit 9), tells the test it is ready (its pid, written to the file
// TERM_SIGNAL_READY names, after the traps are set) and waits on a background sleep, so the test never signals a shell
// that has not yet set its trap. A signal ignored on entry cannot be trapped by a non-interactive shell, so the INT
// trap is also what shows the child started with INT at its default. Cases:
//   term      TERM to the parent alone: forwarded, the trap runs, the parent exits 7
//   hangup    HUP to the parent alone: forwarded, the shell (no HUP trap) dies of it, the parent exits 129 and not by HUP
//   alone     INT then QUIT to the parent's pid alone: ignored, parent and child still there 300 ms later, then TERM ends both
//   kill      the child killed by KILL: the parent exits 137
//   group     INT to the whole process group, as a terminal's ctrl-c does: the child's trap runs, the parent (ignoring it)
//             answers 9 and is not killed by it. This is the invariant: a child started this way still ends on ctrl-c
// Each case holds under 10 s. The background `sleep 30` the script starts is killed by the test when the case ends.
// Run: sh /Users/lancepollard/base/crew/cluesurf/tmp/run-term.sh npx tsx test/compile/run-signal.ts
// (SIGNAL_ONLY=typescript or rust runs one backend, SIGNAL_CASE=<name> one case)

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { buildOn } from './shared/run-on'
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

// the shell script the child runs: trap, say ready, wait on a sleep in the background
const SCRIPT = String.raw`trap 'kill $!; exit 7' TERM; trap 'exit 9' INT; echo $$ \> $TERM_SIGNAL_READY; sleep 30 & wait`

// The program also calls `run` once, ahead of the case. A program that reaches only `run-attached` does not build on
// Rust: the emitter keeps what is reachable, drops the `run-result` struct, and runner.rs's `use super::RunResult` fails
// ("unresolved import"). That is a defect beside this item (see its report), and the call keeps the struct.
const PROGRAM = String.raw`load @term/base/process/run
  find run-attached
  find run, name run-command

load @term/base/process
  find exit

load @term/base/list
  find list

task run
  mark async
  like text
  save empty, make list
  save probe, run-command(<true>, empty)
  save arguments, make list
  call arguments/push(<-c>)
  call arguments/push(<${SCRIPT}>)
  save code, run-attached(<sh>, arguments)
  call exit(code)
  back <unreachable>
`

type Outcome = { code: number | null; signal: string | null }

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)

    return true
  } catch {
    return false
  }
}

// the direct children of a process, by pgrep
const childrenOf = (pid: number): number[] => {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split('\n')
      .filter(line => line !== '')
      .map(Number)
  } catch {
    return []
  }
}

type Run = {
  parent: number
  child: number
  // the process ended, answered once
  done: Promise<Outcome | 'timeout'>
  // the sleep the child started
  sleeper: number
}

// start the command in a process group of its own, and answer once the child shell has set its trap
async function start(command: string[], ready: string): Promise<Run | undefined> {
  const process_ = spawn(command[0]!, command.slice(1), { detached: true, stdio: 'ignore', env: { ...process.env, TERM_SIGNAL_READY: ready } })
  const parent = process_.pid!
  const done = new Promise<Outcome | 'timeout'>(resolve => {
    process_.on('exit', (code, signal) => resolve({ code, signal }))
    setTimeout(() => resolve('timeout'), 9000)
  })

  for (let waited = 0; waited < 8000; waited += 20) {
    if (existsSync(ready) && readFileSync(ready, 'utf8').trim() !== '') {
      const child = Number(readFileSync(ready, 'utf8').trim())
      let sleeper = 0

      // the sleep starts a moment after the pid is written
      for (let tries = 0; tries < 50 && sleeper === 0; tries++) {
        sleeper = childrenOf(child)[0] ?? 0

        if (sleeper === 0) {
          await sleep(20)
        }
      }

      return { parent, child, done, sleeper }
    }

    await sleep(20)
  }

  try {
    process.kill(-parent, 'SIGKILL')
  } catch {}

  return undefined
}

const signalTo = (pid: number, signal: NodeJS.Signals): void => {
  process.kill(pid, signal)
}

// the end of a case: the group and the sleep are gone whatever the case did
function clean(run: Run): void {
  for (const pid of [run.sleeper, run.child, run.parent]) {
    if (pid > 0 && alive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  }
}

type Case = {
  name: string
  says: string
  drive: (run: Run) => Promise<{ passed: boolean; info: string }>
}

const outcome = (got: Outcome | 'timeout'): string => (got === 'timeout' ? 'still running after 9 s' : `exit ${got.code} signal ${got.signal}`)

const CASES: Case[] = [
  {
    name: 'term',
    says: 'TERM to the parent alone is passed to the child, whose trap exits 7, and the parent exits 7',
    drive: async run => {
      signalTo(run.parent, 'SIGTERM')
      const got = await run.done

      return { passed: got !== 'timeout' && got.code === 7 && got.signal === null, info: outcome(got) }
    },
  },
  {
    name: 'hangup',
    says: 'HUP to the parent alone is passed to the child, which dies of it, and the parent exits 129 rather than dying of HUP',
    drive: async run => {
      signalTo(run.parent, 'SIGHUP')
      const got = await run.done

      return { passed: got !== 'timeout' && got.code === 129 && got.signal === null, info: outcome(got) }
    },
  },
  {
    name: 'alone',
    says: 'INT and QUIT to the parent alone are ignored (both still waiting 300 ms later), then TERM ends both',
    drive: async run => {
      signalTo(run.parent, 'SIGINT')
      signalTo(run.parent, 'SIGQUIT')
      await sleep(300)
      const waiting = alive(run.parent) && alive(run.child)
      signalTo(run.parent, 'SIGTERM')
      const got = await run.done
      await sleep(100)

      return {
        passed: waiting && got !== 'timeout' && got.code === 7 && got.signal === null && !alive(run.child),
        info: `waiting after INT and QUIT ${waiting}, then ${outcome(got)}, child alive ${alive(run.child)}`,
      }
    },
  },
  {
    name: 'kill',
    says: 'the child killed by KILL makes the parent exit 137',
    drive: async run => {
      signalTo(run.child, 'SIGKILL')
      const got = await run.done

      return { passed: got !== 'timeout' && got.code === 137 && got.signal === null, info: outcome(got) }
    },
  },
  {
    name: 'group',
    says: 'INT to the whole group, as a terminal sends ctrl-c, reaches the child (its trap exits 9, which an INT ignored on entry could not set off) and the parent, ignoring it, answers 9',
    drive: async run => {
      // the group id is the parent's pid: the process was started in a group of its own
      process.kill(-run.parent, 'SIGINT')
      const got = await run.done
      await sleep(100)

      return { passed: got !== 'timeout' && got.code === 9 && got.signal === null && !alive(run.child), info: `${outcome(got)}, child alive ${alive(run.child)}` }
    },
  },
]

const dir = mkdtempSync(join(tmpdir(), 'term-run-signal-'))
const only = process.env.SIGNAL_ONLY ?? ''
const oneCase = process.env.SIGNAL_CASE ?? ''

for (const backend of (['typescript', 'rust'] as Backend[]).filter(b => !only || b === only)) {
  const built = buildOn({ backend, program: PROGRAM, resolve: env => projectResolver(process.cwd(), env), dir, name: 'signal' })

  if (built.form === 'skipped') {
    console.log(`skip  ${backend}: ${built.reason}`)
    continue
  }

  ok(`${backend}: the program compiles and builds`, built.form === 'built', built.form === 'failed' ? `${built.stage}: ${built.reason}` : '')

  if (built.form !== 'built') {
    continue
  }

  for (const one of CASES.filter(c => !oneCase || c.name === oneCase)) {
    const run = await start(built.command, join(dir, `ready-${backend}-${one.name}`))

    if (run === undefined) {
      ok(`${backend}: ${one.says} (${one.name})`, false, 'the child shell never said it was ready')
      continue
    }

    const result = await one.drive(run)
    clean(run)
    ok(`${backend}: ${one.says} (${one.name})`, result.passed, result.info)
  }
}

console.log(`\nrun-signal: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
