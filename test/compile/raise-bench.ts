// The cost of a raise, per backend (term/hive decision 001, Cost bound): 100k raise-and-catch, one call deep and ten
// calls deep, each the wall time of a run with N raises minus one of the same program with none, so process start (a
// JVM is a third of a second) is not counted. The zero-raise run's own time is printed too: it is the happy path,
// which a raise's frames must leave within noise. Best of three runs each.
// Run from deck/term/deck/term: npx tsx test/compile/raise-bench.ts [label]   RB_ONLY=rust runs one backend.

import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { BACKENDS, buildOn } from './shared/run-on'

// the guard in `run`, raising from `fails` one call below it
const oneDeep = (n: number): string => `task fails
  take i, like number
  like number
  halt <no key {{i}}>

task run
  like text
  save caught, code 0
  walk size
    take i
    bind base, code 0
    bind head, code ${n}
    hook next
      fork
        mark unsafe
        call fails
          read i
      halt take
        take problem
        save caught
          call add
            read caught
            code 1
  send back, text <{{caught}}>
`

// the guard in `run`, calling a0, which calls a1 ... a9, which raises: ten calls deep
const tenDeep = (n: number): string => {
  const tasks: string[] = [
    `task a9
  take i, like number
  like number
  halt <no key {{i}}>
`,
  ]

  for (let k = 8; k >= 0; k--) {
    tasks.push(`task a${k}
  take i, like number
  like number
  send back
    call a${k + 1}
      read i
`)
  }

  return `${tasks.join('\n')}
task run
  like text
  save caught, code 0
  walk size
    take i
    bind base, code 0
    bind head, code ${n}
    hook next
      fork
        mark unsafe
        call a0
          read i
      halt take
        take problem
        save caught
          call add
            read caught
            code 1
  send back, text <{{caught}}>
`
}

const dir = join(tmpdir(), 'term-raise-bench')
mkdirSync(dir, { recursive: true })
const only = process.env.RB_ONLY ?? ''
const label = process.argv[2] ?? 'now'

function timed(command: string[]): { ms: number; out: string } {
  let best = Infinity
  let out = ''

  for (let k = 0; k < 3; k++) {
    const start = performance.now()
    const run = spawnSync(command[0]!, command.slice(1), {
      encoding: 'utf8',
    })
    best = Math.min(best, performance.now() - start)
    out =
      run.status === 0
        ? String(run.stdout)
        : `exit ${run.status}: ${String(run.stderr).slice(0, 300)}`
  }

  return { ms: best, out }
}

const programs: [string, (n: number) => string][] = [
  ['one deep', oneDeep],
  ['ten deep', tenDeep],
]

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  for (const [shape, program] of programs) {
    const runs: number[] = []
    let said = ''

    for (const n of [0, 100000]) {
      const name = `bench-${shape.replace(' ', '-')}-${n}`
      const built = buildOn({
        backend,
        program: program(n),
        resolve: env => projectResolver(process.cwd(), env),
        dir,
        name,
      })

      if (built.form !== 'built') {
        said =
          built.form === 'skipped'
            ? built.reason
            : `${built.stage}: ${built.reason}`
        break
      }

      const { ms, out } = timed(built.command)
      runs.push(ms)
      said = out
    }

    if (runs.length < 2) {
      console.log(`${label} ${backend} ${shape}: ${said}`)
      continue
    }

    console.log(
      `${label} ${backend} ${shape}: 100k raise-and-catch ${(runs[1]! - runs[0]!).toFixed(1)} ms, zero-raise run ${runs[0]!.toFixed(1)} ms (caught ${said})`,
    )
  }
}
