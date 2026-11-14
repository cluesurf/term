// A console lowered for Rust builds only its dispatcher and the verbs whose closure is native, and forwards the rest
// (decision 109 rule 1, item term-self-host-001-0800). One console with two native routes and one whose task docks
// `<node:os>` is built for Rust by this checkout's CLI: the docking task's arm calls `console-forward`, the console's
// shake drops the task and its dock, so the emitted program names no node module and cargo builds it, and the record
// `console-forwarded` names the one forwarded command. The native routes answer what node's booted console answers,
// the forwarded route's help is the dispatcher's own, and a call of it runs `node <folder>/line.js` with the same
// words (a stand-in line.js that prints them and exits 7, where <folder> holds the folder the binary is in).
// Run: npx tsx test/compile/console-forward.ts

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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

  # Name this machine
  hook host
    # how to show it
    take style
      like text
      bind <short>
    task host-name

dock load
  load <node:os>, name os

task greet
  take name, like text
  take times, like number
  like number

  send back, read times

task count
  take words, like list, like text
  like number

  send back, read words/length

task host-name
  take style, like text
  like number

  call os/hostname
  send back, code 4
`

const out = mkdtempSync(join(tmpdir(), 'term-console-forward-'))
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

// rust: the emitted program
const emitted = spawnSync('node', [LINE, 'make', 'code/base.tree', '--emit', 'rust', '--out', join(out, 'main.rs')], { cwd: project, encoding: 'utf8', env, maxBuffer: 1 << 26 })
ok('rust: term make --emit rust writes the console', emitted.status === 0, tail(emitted, 4000))
if (emitted.status === 0) {
  const rs = readFileSync(join(out, 'main.rs'), 'utf8')
  ok('rust: the match forwards through console_forward', /\bconsole_forward\b/.test(rs))
  ok('rust: the forwarded task is not in the program', !/\bhost_name\b/.test(rs), (rs.match(/.*\bhost_name\b.*/g) ?? []).slice(0, 5).join('\n'))
  // the native tasks are called, not forwarded: their arms hold no forward (a task the match alone calls may be
  // inlined into it, so its own `fn` is not asked for)
  const call = /fn console_call\b[\s\S]*?\n\}/.exec(rs)?.[0] ?? ''
  const arm = (name: string): string => new RegExp(`"${name}"[^{]*\\{([^}]*)\\}`).exec(call)?.[1] ?? ''
  ok('rust: the native routes call their tasks, the forwarded one forwards', !arm('greet').includes('console_forward') && !arm('count').includes('console_forward') && arm('host-name').includes('console_forward'), `greet: ${arm('greet')}\ncount: ${arm('count')}\nhost-name: ${arm('host-name')}`)
  const docks = rs.split('\n').filter(l => /node::|hostname/.test(l))
  ok('rust: the program names no node module', docks.length === 0, docks.slice(0, 5).join('\n'))
  // a linked shim's own module may `use super::...` (process/run's RunResult): only a crate outside std and
  // serde_json, or a dock's module, is foreign
  const foreign = rs.split('\n').filter(l => /^\s*use /.test(l) && !/^\s*use (std|serde_json|super|crate)::/.test(l))
  ok('rust: every use names std, serde_json or the program itself', foreign.length === 0, foreign.join('\n'))
  const unsupported = rs.match(/SEED_UNSUPPORTED_BIND_\w+/g) ?? []
  ok('rust: no bind without a rust case', unsupported.length === 0, [...new Set(unsupported)].join(', '))
  const record = /CONSOLE_FORWARDED[\s\S]{0,400}?\]/.exec(rs)?.[0] ?? ''
  const named = [...record.matchAll(/"([^"]*)"/g)].map(m => m[1])
  ok('rust: console-forwarded names the one forwarded command', named.length === 1 && named[0] === 'tool host', record.slice(0, 400))
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
    const cargoBins = files.filter(f => f.endsWith('-cargo')).map(f => join(out, 'rust', f, 'target', 'release', f.slice(0, -6)))
    const found = [...files.map(f => join(out, 'rust', f)), ...cargoBins].find(isBin)
    ok('rust: the build leaves a binary', found !== undefined, files.join(', '))
    // installed as the forward expects: <folder>/native/<binary> beside <folder>/line.js, a stand-in that prints the
    // words it was given and exits 7
    if (found) {
      const folder = join(out, 'install')
      mkdirSync(join(folder, 'native'), { recursive: true })
      rustBin = join(folder, 'native', 'tool')
      copyFileSync(found, rustBin)
      spawnSync('chmod', ['755', rustBin])
      writeFileSync(join(folder, 'line.js'), 'console.log(JSON.stringify(process.argv.slice(2)))\nprocess.exit(7)\n')
    }
  }
}

const mask = (text: string): string =>
  text
    .replace(/\d\d:\d\d:\d\d\.\d\d\d/g, 'HH:MM:SS.mmm')
    .replace(/ · \d+(\.\d+)?(ms|s)/g, ' · ELAPSED')
    .replace(/^ {2}\d+(\.\d+)?(ms|s)$/gm, '  ELAPSED')
const runOne = (command: string[], words: string[]): { out: string; err: string; code: number | null } => {
  const ran = spawnSync(command[0]!, [...command.slice(1), ...words], { cwd, encoding: 'utf8', env, timeout: 60000 })
  return { out: ran.stdout ?? '', err: mask(ran.stderr ?? ''), code: ran.status }
}

// the native routes, help, the forwarded route's help and its refusals answer as node's console answers
const lines: [string[], number | null][] = [
  [['--help'], 0], [['greet', '--help'], 0], [['host', '--help'], 0], [[], 2], [['frobnicate'], 2],
  [['greet', 'bob'], 1], [['greet', 'bob', '--times', '3'], 3], [['count', 'a', 'b', 'c'], 3],
  [['host', '--zzz'], 2],
]
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

// the forwarded route runs the node build with this process's own words, and exits with its code
if (rustBin) {
  for (const words of [['host'], ['host', '--style', 'long']]) {
    const r = runOne([rustBin], words)
    ok(`forward: ${words.join(' ')} runs line.js with the same words`, r.out === `${JSON.stringify(words)}\n`, `stdout ${JSON.stringify(r.out)} stderr ${JSON.stringify(r.err)}`)
    ok(`forward: ${words.join(' ')} exits with line.js's code`, r.code === 7, `exit ${r.code}`)
  }
}

console.log(`\nconsole-forward: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
