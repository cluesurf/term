// THE LAUNCHER (decision 140 of change 001-finish-self-host): runs a Term task under `task/` on STAGE0, before any
// `term` exists. `make:port` is `node task/launch.mjs port-build`, and `term:fixpoint` calls it the same way.
//
//   node task/launch.mjs <name> [argument ...]
//
// It does this and nothing else, so it holds no decision of the build (an F7 script, task/term/floor.ts HOST_SCRIPTS):
//
//   1. reads task/stage0.json and loads the pinned bundle `~/.base/@term/code/stage0/<id>/compile.mjs` (the path
//      deck/call/code/home.ts `userHome('stage0', id, 'compile.mjs')` names, held equal by test/call/launch-home.ts).
//      A missing bundle exits 1 naming the command that installs it
//   2. compiles `task/<name>.tree` as ONE merged node program with stage0's own names (compile, nativePrelude,
//      projectResolver, projectLeanOf), never a name stage0 does not already export. A refused compile prints its
//      first diagnostics and exits 1
//   3. writes the program, its native prelude in front, to `.base/@term/code/task/<name>/<sha256 of its text>.ts`
//      (never over other bytes: the name is the hash) and runs it with the repository's tsx, the arguments after the
//      name passed on, `TERM_TASK_PROGRAM` set to that file, and exits with its code
//
// Run from the Term root, the way every script under task/ is. Imports only `node:*`.

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const [name, ...rest] = process.argv.slice(2)

if (!name) {
  console.error('usage: node task/launch.mjs <task name under task/> [argument ...]')
  process.exit(2)
}

const sha = data => createHash('sha256').update(data).digest('hex')

// the stdlib every task loads is the working tree's: stage0's file sits under the user home, where the compiler's walk
// up from its own file finds none (the same folder that walk finds from deck/make)
process.env.TERM_STDLIB ??= join(ROOT, 'deck', 'base')

// 1. stage0
const pin = JSON.parse(readFileSync(join(ROOT, 'task', 'stage0.json'), 'utf8'))
const bundle = join(homedir(), '.base', '@term', 'code', 'stage0', pin.id, 'compile.mjs')

if (!existsSync(bundle) || sha(readFileSync(bundle)) !== pin.id) {
  console.error(`launch: stage0 ${pin.id} is not installed at ${bundle}. Install it: pnpm --dir ${ROOT} run stage0:pin`)
  process.exit(1)
}

const stage0 = await import(pathToFileURL(bundle).href)

// 2. the task, compiled whole
const file = join(ROOT, 'task', `${name}.tree`)
const result = stage0.compile(
  { file, text: readFileSync(file, 'utf8') },
  { resolve: stage0.projectResolver(ROOT), leanOf: stage0.projectLeanOf(ROOT) },
)

if (!result.ok) {
  console.error(`launch: task/${name}.tree does not compile`)

  for (const d of result.diagnostics.slice(0, 5)) {
    const at = d.file ? ` (${d.file.startsWith(ROOT) ? d.file.slice(ROOT.length + 1) : d.file}${d.span ? `:${d.span.start.line + 1}` : ''})` : ''

    console.error(`  ${d.name}${at}: ${d.message}`)
  }

  process.exit(1)
}

// the native runtime shims the program docks, each file once (a second path to one file, as a case-insensitive disk
// gives, reads as empty)
const given = new Set()
const prelude = stage0.nativePrelude(result.program, 'node', path => {
  if (!existsSync(path)) {
    return undefined
  }

  const stat = statSync(path)
  const key = `${stat.dev}:${stat.ino}`

  if (given.has(key)) {
    return ''
  }

  given.add(key)
  return readFileSync(path, 'utf8')
})
const text = `${prelude ? `${prelude}\n` : ''}${result.typescript}`

// 3. the program, by its hash, then run
const dir = join(ROOT, '.base', '@term', 'code', 'task', name)
const program = join(dir, `${sha(text)}.ts`)

if (!existsSync(program)) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${program}.${process.pid}`, text)
  renameSync(`${program}.${process.pid}`, program)
}

const run = spawnSync(process.execPath, ['--import', 'tsx', program, ...rest], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, TERM_TASK_PROGRAM: program },
})

process.exit(run.status ?? 1)
