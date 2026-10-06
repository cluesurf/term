// `term make --emit <target> <file> --build` and `--run`, through the built CLI on every target (call/code/native-build.ts,
// 2026-10-05). Until then `--emit` wrote source and built nothing, and the main and the toolchain call were the caller's.
// The entry is `run`, else `boot`, else `main`, or the task `--main` names; what it answers is printed and nothing after.
// A program that names a crate builds through cargo on Rust. A program with nothing to start it is refused.
// Run: npx tsx test/call/emit-build.ts   (EMIT_BUILD_ONLY=node, rust, swift or kotlin runs one)

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const LINE = join(dirname(fileURLToPath(import.meta.url)), '../../host/line.js')
const TOOLS: Record<string, string[]> = { node: [], rust: ['rustc', 'cargo'], swift: ['swiftc'], kotlin: ['kotlinc', 'java'] }
const have = (tool: string): boolean => spawnSync('which', [tool], { encoding: 'utf8' }).status === 0

const project = mkdtempSync(join(tmpdir(), 'term-emit-build-'))
mkdirSync(join(project, 'code'))
writeFileSync(join(project, 'deck.tree'), 'deck @probe/emit-build\nhead <Probe>\nmark <0.0.2>\nlink @term/base, mark <0.0.x>\n')

// the answer of `run`, and a second entry `--main` can name
writeFileSync(
  join(project, 'code/answer.tree'),
  `task double
  take n, like number
  like number
  back multiply(n, 2)

task run
  like text
  back <answer {double(21)}>

task other
  like text
  back <the other entry>
`,
)

// `boot` answers nothing: it prints through the console, and the main adds nothing
writeFileSync(
  join(project, 'code/boot.tree'),
  `load @term/base/console
  find log

task boot
  log <booted>
`,
)

// a program that names a crate on Rust: the exact decimal, over num-bigint
writeFileSync(
  join(project, 'code/money.tree'),
  `load @term/base/decimal
  find make-big-decimal
  find decimal-add

task run
  like text
  back text(decimal-add(make-big-decimal(<0.1>), make-big-decimal(<0.2>)))
`,
)

// nothing to start
writeFileSync(join(project, 'code/library.tree'), 'task helper\n  take n, like number\n  like number\n  back n\n')

const term = (...args: string[]) => spawnSync(process.execPath, [LINE, ...args], { cwd: project, encoding: 'utf8' })
const only = process.env.EMIT_BUILD_ONLY ?? ''

for (const target of ['node', 'rust', 'swift', 'kotlin'].filter(one => !only || one === only)) {
  const missing = TOOLS[target]!.filter(one => !have(one))

  if (missing.length > 0) {
    console.log(`skip  ${target}: ${missing.join(', ')} not installed`)
    continue
  }

  const answer = term('make', '--emit', target, 'code/answer.tree', '--run')
  ok(`${target}: --run prints what run answers`, answer.status === 0 && answer.stdout === 'answer 42', `${answer.status} ${answer.stdout} ${answer.stderr}`)

  const other = term('make', '--emit', target, 'code/answer.tree', '--run', '--main', 'other')
  ok(`${target}: --main names the entry`, other.status === 0 && other.stdout === 'the other entry', `${other.status} ${other.stdout} ${other.stderr}`)

  const boot = term('make', '--emit', target, 'code/boot.tree', '--run')
  ok(`${target}: boot answers nothing, and only its own output is printed`, boot.status === 0 && boot.stdout.trim() === 'booted', `${boot.status} ${JSON.stringify(boot.stdout)} ${boot.stderr}`)

  const money = term('make', '--emit', target, 'code/money.tree', '--run')
  ok(`${target}: a program naming a crate builds (cargo on rust)`, money.status === 0 && money.stdout === '0.3', `${money.status} ${money.stdout} ${money.stderr}`)

  const library = term('make', '--emit', target, 'code/library.tree', '--run')
  ok(`${target}: a program with nothing to start is refused, naming --main`, library.status !== 0 && /--main/.test(library.stderr), `${library.status} ${library.stderr}`)

  const built = term('make', '--emit', target, 'code/answer.tree', '--build', '--out', `out-${target}`)
  ok(`${target}: --build alone writes a runnable artifact and does not run it`, built.status === 0 && built.stdout === '' && existsSync(join(project, `out-${target}`)), `${built.status} ${built.stdout} ${built.stderr}`)
}

console.log(`\nemit-build: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
