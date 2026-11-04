// The pair harness leaves nothing in the machine's temporary folder (term-cli-in-term-0177): run from the repository
// root as a gate suite (`pnpm term:test --only temp`) or alone, from anywhere:
//
//   npx tsx task/term/temp-pair-check.ts [pair] [--sample N]
//
// Three runs of task/term/pair.ts on a pair whose cases each make temporary folders (need-version by default, the one
// that left 17,680 of them): one to its end, one stopped with SIGINT (ctrl-c) mid-run, and one under --keep. After
// each, the run's own scratch folder (tp<pid>-XXXXXX) must be gone (kept and then removed by this check for --keep),
// and the machine's temporary folder must hold no new mkdtemp-shaped entry. Prints `temp-pair: N pass, M fail`.

import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SYSTEM_TEMP, madeEntries, madeSince, removeTree } from './temp-run'
import { TERM_ROOT } from './root'

const ROOT = TERM_ROOT
const TERM = TERM_ROOT
const args = process.argv.slice(2)
const pair = args.find(arg => !arg.startsWith('--') && args[args.indexOf(arg) - 1] !== '--sample') ?? 'need-version'
const sample = args.includes('--sample') ? args[args.indexOf('--sample') + 1]! : '40'

let pass = 0
let fail = 0

function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    pass++
  } else {
    fail++
    console.log(`FAIL ${name}: ${detail}`)
  }
}

// the harness's scratch folders for one process id
function runFolders(pid: number): string[] {
  return readdirSync(SYSTEM_TEMP).filter(name => name.startsWith(`tp${pid}-`))
}

type Ran = { pid: number; status: number | null; signal: string | null; stderr: string; stdout: string }

function runPair(input: { extra: string[]; interruptAfterMs?: number; sample?: string }): Promise<Ran> {
  return new Promise(resolve => {
    // the real temporary folder: a gate suite's own TMPDIR would hide a leak into the machine's
    const env = { ...process.env, TMPDIR: SYSTEM_TEMP }

    delete env.TERM_SYSTEM_TEMP

    const run = spawn('node', ['--import', 'tsx', join(ROOT, 'task/term/pair.ts'), pair, '--sample', input.sample ?? sample, ...input.extra], { cwd: TERM, env })
    let stdout = ''
    let stderr = ''
    let interrupt: ReturnType<typeof setTimeout> | undefined

    run.stdout.on('data', chunk => { stdout += String(chunk) })
    run.stderr.on('data', chunk => {
      stderr += String(chunk)
    })

    if (input.interruptAfterMs !== undefined) {
      // only once the run has made its folder, so the interrupt is the thing tested
      const poll = setInterval(() => {
        if (run.pid !== undefined && runFolders(run.pid).length > 0) {
          clearInterval(poll)
          interrupt = setTimeout(() => run.kill('SIGINT'), input.interruptAfterMs)
        }
      }, 50)

      run.on('exit', () => clearInterval(poll))
    }

    run.on('close', (status, signal) => {
      clearTimeout(interrupt)
      resolve({ pid: run.pid ?? -1, status, signal, stdout, stderr })
    })
  })
}

async function main(): Promise<void> {
  const before = madeEntries()

  // to its end
  const whole = await runPair({ extra: [] })

  check('whole run', whole.status === 0 || whole.status === 1, `pair.ts exited ${whole.status}: ${whole.stderr.slice(-300)}`)
  check('whole run folder removed', runFolders(whole.pid).length === 0, `left ${runFolders(whole.pid).join(', ')}`)

  // ctrl-c mid-run
  // a sample long enough that the interrupt lands mid-run, never after it
  const stopped = await runPair({ extra: [], interruptAfterMs: 1500, sample: '100000' })

  check('interrupted', stopped.status === 130 || stopped.signal === 'SIGINT', `exited ${stopped.status} ${stopped.signal}`)
  check('interrupted run folder removed', runFolders(stopped.pid).length === 0, `left ${runFolders(stopped.pid).join(', ')}`)

  // --keep keeps it and says where
  const kept = await runPair({ extra: ['--keep'] })
  const keptAt = /kept: (\S+)/.exec(kept.stderr)?.[1]

  check('kept run names its folder', keptAt !== undefined && existsSync(keptAt), `stderr: ${kept.stderr.slice(-300)}`)

  for (const name of runFolders(kept.pid)) {
    removeTree(join(SYSTEM_TEMP, name))
  }

  // and nothing new beside them
  const leaked = madeSince(before)

  check('no new temporary folder', leaked.length === 0, `${leaked.length} new: ${leaked.slice(0, 8).join(', ')}`)
  console.log(`temp-pair: ${pass} pass, ${fail} fail`)
  process.exitCode = fail === 0 ? 0 : 1
}

void main()
