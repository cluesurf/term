// A console the compiler lowers for Rust answers what node's booted console answers (decision 138 rules 2 and 3,
// term-self-host-001-1121). For an entry whose dock holds hook routes, `term make --emit rust --build` writes the
// routes as one module-level host (a `thread_local!` on Rust, decision 138 rule 4 as amended by 1172), a generated
// call from a task name to the typed task, and the entry's run over work/hook/deciding.tree. One console (two routes,
// a global flag, a required slot, a number take defaulting to 1, a list slot) is booted for node (`term boot`) and
// built for Rust by this checkout's CLI, and every command line below gives the same stdout, stderr and exit code on
// both. The tasks answer what they were handed as the exit code (greet its times, count its word count), so a call is
// witnessed by its handed values. Only the refusal's clock (time of day and elapsed time) is masked. The emitted
// program reaches no compiler module (item 0160), and the Rust binary spawns neither stty nor date before a call route
// or the version runs (decision 149, item 1273).
// Run: npx tsx test/compile/console-native.ts

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TERM = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LINE = join(TERM, 'host', 'line.js')

let pass = 0
let fail = 0

function ok(name: string, holds: boolean, detail = ''): void {
  if (holds) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

const CONSOLE = `# The tool
hook tool
  # Print less
  take quiet
    like boolean
    code q

  # Greet someone
  hook greet
    # who to greet
    slot name
      like text
      need true
    # how many times
    take times
      like number
      bind code 1
    task greet

  # Count words
  hook count
    slot words, like list, like text
    task count

task greet
  take name, like text
  take times, like number
  like number

  send back, read times

task count
  take words, like list, like text
  like number

  send back, read words/length
`

const out = mkdtempSync(join(tmpdir(), 'term-console-native-'))
const project = join(out, 'project')
mkdirSync(join(project, 'code'), { recursive: true })
mkdirSync(join(project, 'link', '@term'), { recursive: true })
writeFileSync(join(project, 'deck.tree'), 'deck @probe/tool\n')
writeFileSync(join(project, 'code', 'base.tree'), CONSOLE)
for (const name of ['base', 'call']) symlinkSync(join(TERM, 'deck', name), join(project, 'link', '@term', name))
const cwd = join(out, 'cwd')
mkdirSync(cwd)

const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' }
for (const name of ['TERM_DEPTH', 'TERM_LINE_NAME', 'TERM_LINE_LOCK', 'TERM_LINE_LOCK_BY', 'TERM_ROOT', 'TERM_STDLIB', 'FORCE_COLOR', 'CI'])
  delete env[name]

const tail = (r: { stdout: string; stderr: string }, size: number): string => `${r.stdout}${r.stderr}`.slice(-size)

// node: the console booted, run through its run.mjs
const boot = spawnSync('node', [LINE, 'boot', join(project, 'code/base.tree'), '--out', join(out, 'booted')], { cwd: project, encoding: 'utf8', env, maxBuffer: 1 << 26 })
ok('node: term boot builds the console', boot.status === 0, tail(boot, 3000))
const nodeRun = join(out, 'booted', 'run.mjs')

// rust: the emitted program holds the route table as a thread_local host, then builds with cargo
const emitted = spawnSync('node', [LINE, 'make', 'code/base.tree', '--emit', 'rust', '--out', join(out, 'main.rs')], { cwd: project, encoding: 'utf8', env, maxBuffer: 1 << 26 })
ok('rust: term make --emit rust writes the console', emitted.status === 0, tail(emitted, 4000))
if (emitted.status === 0) {
  const rs = readFileSync(join(out, 'main.rs'), 'utf8')
  ok('rust: the route table is one thread_local host', /thread_local![^;]*CONSOLE_ROUTES/s.test(rs))
  // item 0160: the program reaches no compiler module, read for each class term:native-entry reads. The source files
  // it holds, by the `.at("<task> <package path>:<line>")` mark on each fallible call
  const reached = new Set([...rs.matchAll(/\.at\("[^ "]+ (@[^ ":]+\/[^ ":]+\/[^":]+):\d+/g)].map(m => m[1]!))
  const compiler = [...reached].filter(f => f.startsWith('@term/make/'))
  ok('rust: the program holds the dispatcher (work/hook/deciding.tree)', reached.has('@term/call/code/work/hook/deciding.tree'), [...reached].join(', '))
  ok('rust: the program reaches no @term/make source', compiler.length === 0 && !rs.includes('@term/make/'), compiler.join(', '))
  const unsupported = rs.match(/SEED_UNSUPPORTED_BIND_\w+/g) ?? []
  ok('rust: no bind without a rust case', unsupported.length === 0, [...new Set(unsupported)].join(', '))
  const foreign = rs.split('\n').filter(l => /^\s*use /.test(l) && !/^\s*use (std|serde_json)::/.test(l))
  ok('rust: every use names std or serde_json', foreign.length === 0, foreign.join('\n'))
}

let rustBin: string | undefined
const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8' })
if (cargo.status !== 0) {
  console.log('skip  rust build and run  (cargo not installed)')
} else {
  const built = spawnSync('node', [LINE, 'make', 'code/base.tree', '--emit', 'rust', '--build', '--out', join(out, 'rust')], { cwd: project, encoding: 'utf8', env, maxBuffer: 1 << 26 })
  ok('rust: term make --emit rust --build builds the console', built.status === 0, tail(built, 6000))
  if (built.status === 0) {
    const files = readdirSync(join(out, 'rust'))
    const isBin = (f: string): boolean => existsSync(f) && statSync(f).isFile() && (statSync(f).mode & 0o111) !== 0 && !/\.(rs|d|toml)$/.test(f)
    // a program naming a stdlib crate is a cargo project: its binary is under <name>-cargo/target/release
    const cargoBins = files.filter(f => f.endsWith('-cargo')).map(f => join(out, 'rust', f, 'target', 'release', f.slice(0, -6)))
    rustBin = [...files.map(f => join(out, 'rust', f)), ...cargoBins].find(isBin)
    ok('rust: the build leaves a binary', rustBin !== undefined, files.join(', '))
  }
}

// --version is item 1173's (the mark a lowered console is built with), so it is not asked here. Each line's exit code
// is node's as it answers today; a global flag before the command (-q) is only compared, never pinned, since its
// answer is the node dispatcher's and no item here decides it
const lines: [string[], number | null][] = [
  [['--help'], 0], [['-h'], 0], [['greet', '--help'], 0], [['count', '--help'], 0], [[], 2],
  [['frobnicate'], 2], [['gret'], 2], [['greet'], 2], [['greet', 'bob', '--times', 'x'], 2], [['greet', 'bob', '--zzz'], 2],
  [['greet', 'bob'], 1], [['greet', 'bob', '--times', '3'], 3], [['-q', 'greet', 'bob', '--times', '5'], null],
  [['greet', '--name', 'al', '--times', '7'], 7],
  [['count', 'a', 'b', 'c'], 3], [['count'], 0], [['count', '--', '--help', 'z'], 2],
]
const mask = (text: string): string =>
  text
    .replace(/\d\d:\d\d:\d\d\.\d\d\d/g, 'HH:MM:SS.mmm')
    .replace(/ · \d+(\.\d+)?(ms|s)/g, ' · ELAPSED')
    .replace(/^ {2}\d+(\.\d+)?(ms|s)$/gm, '  ELAPSED')
const runOne = (command: string[], words: string[]): { out: string; err: string; code: number | null } => {
  const ran = spawnSync(command[0]!, [...command.slice(1), ...words], { cwd, encoding: 'utf8', env, timeout: 60000 })
  return { out: ran.stdout ?? '', err: mask(ran.stderr ?? ''), code: ran.status }
}

if (boot.status === 0) {
  for (const [words, code] of lines) {
    const shown = words.length ? words.join(' ') : '(bare)'
    const n = runOne(['node', nodeRun], words)
    if (code !== null) ok(`node: ${shown} exits ${code}`, n.code === code, `exit ${n.code}\n${n.out}${n.err}`)
    if (!rustBin) continue
    const r = runOne([rustBin], words)
    ok(`rust: ${shown} exit equals node's`, r.code === n.code, `node ${n.code}, rust ${r.code}`)
    ok(`rust: ${shown} stdout equals node's`, r.out === n.out, `node:\n${n.out}\nrust:\n${r.out}`)
    ok(`rust: ${shown} stderr equals node's`, r.err === n.err, `node:\n${n.err}\nrust:\n${r.err}`)
  }
}

// NOTHING RUNS BEFORE THE MATCHED TASK but collecting argv, reading TERM_LINE_NAME and deciding (decision 149, item
// 1273, 07-the-binary "Startup"): what a refusal draws from (the terminal width by `stty size`, the zone offset by
// `date +%z`, the home and working folders, the clock) is read only when a refusal is drawn. stty and date are put
// first on PATH as shims that log each call, then run the real tool. A call route and the version spawn neither (2
// each before this item); help and a refusal may read what their own output needs, and are only counted
const realTool = (name: string): string | undefined =>
  (process.env.PATH ?? '').split(':').map(dir => join(dir, name)).find(f => existsSync(f) && statSync(f).isFile())
if (rustBin) {
  const shims = join(out, 'spawn-bin')
  mkdirSync(shims)
  const tools = ['stty', 'date'].map(name => [name, realTool(name)] as const)
  for (const [name, real] of tools)
    if (real) writeFileSync(join(shims, name), `#!/bin/sh\necho "${name} $*" >> "$SPAWN_LOG"\nexec ${real} "$@"\n`, { mode: 0o755 })
  ok('spawn: stty and date are found to shim', tools.every(([, real]) => real !== undefined), tools.map(([n, r]) => `${n}=${r}`).join(' '))
  const spawned = (words: string[]): { code: number | null; calls: string[] } => {
    const log = join(out, `spawn-${words.join('_').replace(/[^a-z0-9_]/gi, '-') || 'bare'}.log`)
    writeFileSync(log, '')
    const ran = spawnSync(rustBin!, words, { cwd, encoding: 'utf8', env: { ...env, SPAWN_LOG: log, PATH: `${shims}:${env.PATH ?? ''}` }, timeout: 60000 })
    return { code: ran.status, calls: readFileSync(log, 'utf8').split('\n').filter(Boolean) }
  }
  for (const words of [['greet', 'bob'], ['greet', 'bob', '--times', '3'], ['greet', '--name', 'al', '--times', '7'], ['count', 'a', 'b', 'c'], ['count']]) {
    const s = spawned(words)
    ok(`spawn: rust ${words.join(' ')} spawns nothing before its task`, s.calls.length === 0, `exit ${s.code}, spawned ${s.calls.length}: ${s.calls.join(', ')}`)
  }
  // --version answers the mark only once the lowered console is built with one (item 1173): before that it is a
  // refusal like any unknown flag, which may draw
  const version = spawned(['--version'])
  if (version.code === 0) ok('spawn: rust --version spawns nothing', version.calls.length === 0, `spawned ${version.calls.length}: ${version.calls.join(', ')}`)
  else console.log(`skip  spawn: rust --version (exit ${version.code}: no mark on this console, item 1173)`)
  for (const words of [['--help'], ['frobnicate'], ['greet']]) {
    const s = spawned(words)
    console.log(`note  spawn: rust ${words.join(' ')} exit ${s.code}, spawned ${s.calls.length}${s.calls.length ? `: ${s.calls.join(', ')}` : ''}`)
  }
}

console.log(`\nconsole-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
