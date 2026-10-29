// `term make --merged` on a project big enough for the worker pool (16 files or more, more than two cores): the
// whole-program build's answer is waited for before it is read. Until term-self-host-001-0334 the pool's
// compile-project-parallel handed back its promise, build-command.tree read `result/problems` off it, and the build
// stopped on "entries is not iterable" (exit 70) while the separate build passed.
// Run: npx tsx test/call/make-merged.ts

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'
import { tempDir } from '../temp'
import { LINE } from './cli'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info.slice(0, 1200)}`)
  }
}

// the pool's own threshold (build-command.tree `build-project`): at least 16 files and more than two cores
const FILES = 18

function project(broken: boolean): string {
  // a prefix without the word the build's output is searched for
  const root = tempDir('term-pool-')
  mkdirSync(join(root, 'code'), { recursive: true })
  writeFileSync(
    join(root, 'deck.tree'),
    'deck @probe/make-merged\nhead <Probe>\nmark <0.0.2>\nlink @term/base, mark <0.0.x>\n',
  )

  for (let n = 1; n <= FILES; n++) {
    writeFileSync(
      join(root, `code/times-${n}.tree`),
      `task times-${n}\n  take x, like number\n  like number\n  back multiply(x, ${n})\n`,
    )
  }

  if (broken) {
    writeFileSync(
      join(root, 'code/broken.tree'),
      'task wrong\n  like number\n  back <not a number>\n',
    )
  }

  return root
}

const term = (root: string, ...args: string[]) => {
  const ran = spawnSync(process.execPath, [LINE, ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  })

  return { status: ran.status, out: `${ran.stdout}\n${ran.stderr}` }
}

const pooled = cpus().length > 2
if (!pooled) {
  console.log(
    `skip  the pool needs more than two cores, this machine has ${cpus().length}`,
  )
}

// 1. a clean project: the merged build passes and writes every file
{
  const root = project(false)
  const merged = term(root, 'make', '--merged')
  ok(
    'merged build of a pooled project exits 0',
    merged.status === 0,
    `${merged.status} ${merged.out}`,
  )
  ok(
    'merged build never stops on an internal error',
    !/internal error|not iterable/.test(merged.out),
    merged.out,
  )
  ok(
    'merged build says it was merged',
    /merged/.test(merged.out),
    merged.out,
  )
  ok(
    'merged build writes every module',
    Array.from({ length: FILES }, (_, i) =>
      existsSync(join(root, `host/code/times-${i + 1}.ts`)),
    ).every(Boolean),
    merged.out,
  )

  const separate = term(root, 'make')
  ok(
    'separate build of the same project exits 0',
    separate.status === 0,
    `${separate.status} ${separate.out}`,
  )
}

// 2. a project with one file that does not check: the merged build reads the pool's problems and reports that file
{
  const root = project(true)
  const merged = term(root, 'make', '--merged')
  ok(
    'merged build of a failing file exits 1',
    merged.status === 1,
    `${merged.status} ${merged.out}`,
  )
  ok(
    'merged build never stops on an internal error (failing file)',
    !/internal error|not iterable/.test(merged.out),
    merged.out,
  )
  ok(
    'merged build names the failing file',
    /broken\.tree/.test(merged.out),
    merged.out,
  )
}

console.log(`\nmake-merged: ${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
