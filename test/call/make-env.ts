// `term make --env <rust|swift|kotlin|node>`: every program of the project for one backend, one file each under
// host/<env>/ (call/code/make-native.ts, note/term/plan/backends-complete.md step 2). A program is a file with a
// `run`, `boot` or `main` task taking nothing; a library is not written on its own. One program that does not build is
// reported, the rest are written, and the run fails. `--build` builds each beside its source.
// Run: npx tsx test/call/make-env.ts   (MAKE_ENV_ONLY=node, rust, swift or kotlin runs one)

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
const TOOLS: Record<string, string[]> = { node: [], rust: ['rustc'], swift: ['swiftc'], kotlin: ['kotlinc', 'java'] }
const EXTENSION: Record<string, string> = { node: 'ts', rust: 'rs', swift: 'swift', kotlin: 'kt' }
const have = (tool: string): boolean => spawnSync('which', [tool], { encoding: 'utf8' }).status === 0

// a project of two programs and a library one of them loads, and with `broken` a third program that does not check
function project(broken: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'term-make-env-'))
  mkdirSync(join(root, 'code/tool'), { recursive: true })
  writeFileSync(join(root, 'deck.tree'), 'deck @probe/make-env\nhead <Probe>\nmark <0.0.2>\nlink @term/base, mark <0.0.x>\n')
  writeFileSync(join(root, 'code/twice.tree'), 'task twice\n  take n, like number\n  like number\n  back multiply(n, 2)\n')
  writeFileSync(join(root, 'code/answer.tree'), 'load ./twice\n  find twice\n\ntask run\n  like text\n  back <answer {twice(21)}>\n')
  writeFileSync(join(root, 'code/tool/other.tree'), 'task main\n  like text\n  back <the other program>\n')

  if (broken) {
    writeFileSync(join(root, 'code/broken.tree'), 'task run\n  like number\n  back <not a number>\n')
  }

  return root
}

const term = (root: string, ...args: string[]) => {
  const ran = spawnSync(process.execPath, [LINE, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 })

  return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr.replace(/\s+/g, ' ') }
}

const only = process.env.MAKE_ENV_ONLY ?? ''

// usage, once
{
  const root = project(false)
  const wrong = term(root, 'make', '--env', 'cobol')
  ok('an unknown backend is a usage error, naming the backends', wrong.status === 2 && /rust, swift, kotlin, node/.test(wrong.stderr), `${wrong.status} ${wrong.stderr}`)

  const empty = mkdtempSync(join(tmpdir(), 'term-make-env-'))
  mkdirSync(join(empty, 'code'))
  writeFileSync(join(empty, 'deck.tree'), 'deck @probe/make-env-empty\nhead <Probe>\nmark <0.0.2>\nlink @term/base, mark <0.0.x>\n')
  writeFileSync(join(empty, 'code/twice.tree'), 'task twice\n  take n, like number\n  like number\n  back multiply(n, 2)\n')
  const none = term(empty, 'make', '--env', 'node')
  ok('a project with no program is refused, naming the entries', none.status !== 0 && /`run`, `boot`, `main`/.test(none.stderr), `${none.status} ${none.stderr}`)
}

for (const env of ['node', 'rust', 'swift', 'kotlin'].filter(one => !only || one === only)) {
  const missing = TOOLS[env]!.filter(one => !have(one))

  if (missing.length > 0) {
    console.log(`skip  ${env}: ${missing.join(', ')} not installed`)
    continue
  }

  const ext = EXTENSION[env]!
  const clean = project(false)
  const made = term(clean, 'make', '--env', env)
  const answer = join(clean, `host/${env}/code/answer.${ext}`)
  const other = join(clean, `host/${env}/code/tool/other.${ext}`)
  ok(`${env}: each program is written under host/${env}/, by its path`, made.status === 0 && existsSync(answer) && existsSync(other), `${made.status} ${made.stderr}`)
  ok(`${env}: a library is not written on its own`, !existsSync(join(clean, `host/${env}/code/twice.${ext}`)))
  ok(`${env}: the verdict counts the programs`, /Emitted 2 of 2 programs for/.test(made.stderr), made.stderr)

  const dirty = project(true)
  const partial = term(dirty, 'make', '--env', env)
  ok(
    `${env}: a program that does not check is reported, the rest written, and the run fails`,
    partial.status === 1 && /broken\.tree/.test(partial.stderr) && existsSync(join(dirty, `host/${env}/code/answer.${ext}`)) && !existsSync(join(dirty, `host/${env}/code/broken.${ext}`)) && /2 of 3/.test(partial.stderr),
    `${partial.status} ${partial.stderr}`,
  )

  const built = term(clean, 'make', '--env', env, '--build')
  ok(`${env}: --build builds every program`, built.status === 0 && /Built 2 of 2/.test(built.stderr), `${built.status} ${built.stderr}`)

  // what each built program answers, by the command native-build writes for it. `answer 42` is also the proof the
  // library came along: `twice` lives in another file, and the program is folded from it
  // and `other` starts at `task main`, which Rust and Kotlin reserve for the main the build adds (`main_`)
  const runs: Record<string, string[]> = {
    node: [process.execPath, join(clean, 'host/node/code/build/answer.mjs')],
    rust: [join(clean, 'host/rust/code/build/answer')],
    swift: [join(clean, 'host/swift/code/build/answer')],
    kotlin: ['java', '-jar', join(clean, 'host/kotlin/code/build/answer.jar')],
  }
  const ran = spawnSync(runs[env]![0]!, runs[env]!.slice(1), { encoding: 'utf8' })
  ok(`${env}: a built program answers, its library with it`, ran.status === 0 && ran.stdout === 'answer 42', `${ran.status} ${ran.stdout} ${ran.stderr}`)

  const otherRuns: Record<string, string[]> = {
    node: [process.execPath, join(clean, 'host/node/code/tool/build/other.mjs')],
    rust: [join(clean, 'host/rust/code/tool/build/other')],
    swift: [join(clean, 'host/swift/code/tool/build/other')],
    kotlin: ['java', '-jar', join(clean, 'host/kotlin/code/tool/build/other.jar')],
  }
  const started = spawnSync(otherRuns[env]![0]!, otherRuns[env]!.slice(1), { encoding: 'utf8' })
  ok(`${env}: a program that starts at \`task main\` builds and answers`, started.status === 0 && started.stdout === 'the other program', `${started.status} ${started.stdout} ${started.stderr}`)
}

console.log(`\nmake-env: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
