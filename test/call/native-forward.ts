// A FORWARDED VERB answers as the node build it forwards to (07-the-binary.md "Forwarding, during the transition",
// item term-self-host-001-0161 requirement 5). A probe console whose `host` verb docks <node:os> is built for Rust by
// this checkout's CLI, so its arm forwards (item 0800), and the binary is installed as the forward expects it,
// <folder>/native/tool beside <folder>/line.js. That line.js is a stand-in node program that reports its words, its
// working folder, an environment variable and its standard input, exits with a given code, or waits for a signal.
// Each case runs the native binary and its node twin (`node <folder>/line.js` with the same words, environment, working
// folder and input) and asks for the same stdout, stderr and exit code, a signal death read as 128 plus its number:
// a success, a failure exit code, stdin piped through, a non-default working folder, an environment variable, TERM
// sent to the parent (handled by the child, and the child's default death), and INT sent to the terminal's group.
// The probe answers --version with its own deck's mark and --help under its program hook's name, and a console whose
// folder an enclosing deck's `line` names is handed that deck's mark (term/compiler decision 018). When the native
// term is built (`pnpm make:native`, host/native/term), its --version and --help equal node's host/line.js byte for
// byte, and a forwarded verb of the real CLI is run against node's too.
// Run: npx tsx test/call/native-forward.ts

import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
    task greet

  # Ask the node build
  hook host
    # the exit code to answer
    take code
      like number
      bind code 0
    # yes to read standard input
    take input
      like text
      bind <no>
    # handle or die: wait for a signal
    take wait
      like text
      bind <no>
    task host-name

dock load
  load <node:os>, name os

task greet
  take name, like text
  like number

  send back, code 0

task host-name
  take code, like number
  take input, like text
  take wait, like text
  like number

  call os/hostname
  send back, code 4
`

// the node build the forward runs: its words, folder, TERM_PROBE_VALUE and input, as one JSON line on stdout
const STAND_IN = `const argv = process.argv.slice(2)
const flag = name => { const at = argv.indexOf('--' + name); return at >= 0 ? argv[at + 1] : undefined }
const report = extra => process.stdout.write(JSON.stringify({ argv, cwd: process.cwd(), probe: process.env.TERM_PROBE_VALUE ?? null, ...extra }) + '\\n')
const code = Number(flag('code') ?? 0)
if (flag('input') === 'yes') {
  let text = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => { text += chunk })
  process.stdin.on('end', () => { report({ stdin: text }); process.exit(code) })
} else if (flag('wait') === 'handle') {
  process.on('SIGTERM', () => { process.stdout.write('got TERM\\n'); process.exit(42) })
  process.on('SIGINT', () => { process.stdout.write('got INT\\n'); process.exit(43) })
  process.stderr.write('ready ' + process.pid + '\\n')
  setInterval(() => {}, 1000)
} else if (flag('wait') === 'die') {
  process.stderr.write('ready ' + process.pid + '\\n')
  setInterval(() => {}, 1000)
} else {
  report({})
  process.stderr.write('a line on stderr\\n')
  process.exit(code)
}
`

const out = mkdtempSync(join(tmpdir(), 'term-native-forward-'))
const project = join(out, 'project')
mkdirSync(join(project, 'code'), { recursive: true })
mkdirSync(join(project, 'link', '@term'), { recursive: true })
// a deck with no `line` above it: the console shows its program hook's name and its own deck's mark
writeFileSync(join(project, 'deck.tree'), 'deck @probe/tool\n  mark <3.4.5>\n')
writeFileSync(join(project, 'code', 'base.tree'), CONSOLE)
for (const name of ['base', 'call']) symlinkSync(join(TERM, 'deck', name), join(project, 'link', '@term', name))
const folderAt = (name: string): string => {
  mkdirSync(join(out, name), { recursive: true })
  return realpathSync(join(out, name))
}
const cwd = folderAt('cwd')
const other = folderAt('another folder')

const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' }
for (const name of ['TERM_DEPTH', 'TERM_LINE_NAME', 'TERM_LINE_LOCK', 'TERM_LINE_LOCK_BY', 'TERM_ROOT', 'TERM_STDLIB', 'TERM_PROBE_VALUE', 'FORCE_COLOR', 'CI'])
  delete env[name]

const tail = (r: { stdout: string; stderr: string }, size: number): string => `${r.stdout}${r.stderr}`.slice(-size)

let tool: string | undefined
let folder: string | undefined
const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8' })
if (cargo.status !== 0) {
  console.log('skip  the probe build and its forwards  (cargo not installed)')
} else {
  const built = spawnSync('node', [LINE, 'make', 'code/base.tree', '--emit', 'rust', '--build', '--out', join(out, 'rust')], { cwd: project, encoding: 'utf8', env, maxBuffer: 1 << 26 })
  ok('probe: term make --emit rust --build builds the console', built.status === 0, tail(built, 6000))
  if (built.status === 0) {
    const files = readdirSync(join(out, 'rust'))
    const isBin = (f: string): boolean => existsSync(f) && statSync(f).isFile() && (statSync(f).mode & 0o111) !== 0 && !/\.(rs|d|toml)$/.test(f)
    const cargoBins = files.filter(f => f.endsWith('-cargo')).map(f => join(out, 'rust', f, 'target', 'release', f.slice(0, -6)))
    const found = [...files.map(f => join(out, 'rust', f)), ...cargoBins].find(isBin)
    ok('probe: the build leaves a binary', found !== undefined, files.join(', '))
    if (found) {
      folder = join(out, 'install')
      mkdirSync(join(folder, 'native'), { recursive: true })
      tool = join(folder, 'native', 'tool')
      copyFileSync(found, tool)
      spawnSync('chmod', ['755', tool])
      writeFileSync(join(folder, 'line.js'), STAND_IN)
    }
  }
}

type Ran = { out: string; err: string; code: number | null; pid: number | undefined }

// a run's exit as a shell reads it: a signal death is 128 plus the signal's number
const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 }
const shellCode = (code: number | null, signal: NodeJS.Signals | null): number | null =>
  code !== null ? code : signal !== null ? 128 + (SIGNALS[signal] ?? 0) : null

// one run: the input written and closed, and once the child says `ready` on stderr, `signal` sent to the process
// (`group` false) or to its whole group (`group` true, the way a terminal sends ctrl-c to its foreground group)
function run(command: string[], ask: { words: string[]; cwd: string; env: NodeJS.ProcessEnv; input?: string; signal?: NodeJS.Signals; group?: boolean }): Promise<Ran> {
  return new Promise(resolve => {
    const child = spawn(command[0]!, [...command.slice(1), ...ask.words], { cwd: ask.cwd, env: ask.env, detached: ask.group === true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let sent = false
    let readyPid: number | undefined
    let settled = false
    const kill = (pid: number | undefined): void => {
      try {
        if (pid !== undefined) process.kill(pid, 'SIGKILL')
      } catch {}
    }
    const limit = setTimeout(() => {
      kill(ask.group ? -child.pid! : child.pid!)
      kill(readyPid)
    }, 30000)
    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      clearTimeout(limit)
      resolve({ out: stdout, err: stderr.replace(/ready \d+/g, 'ready PID'), code: shellCode(code, signal), pid: readyPid })
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
      const ready = /ready (\d+)/.exec(stderr)
      if (ready && ask.signal && !sent) {
        sent = true
        readyPid = Number(ready[1])
        // a little time for the parent to be waiting on the child, as a person's ctrl-c comes after the start
        setTimeout(() => process.kill(ask.group ? -child.pid! : child.pid!, ask.signal!), 200)
      }
    })
    if (ask.input !== undefined) child.stdin.write(ask.input)
    child.stdin.end()
    child.on('close', (code, signal) => settle(code, signal))
    // a child left behind holds the pipes open, and then no close comes: the answer is the exit, 2 s on
    child.on('exit', (code, signal) => setTimeout(() => settle(code, signal), 2000))
  })
}

const alive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

type Case = { name: string; words: string[]; cwd?: string; env?: NodeJS.ProcessEnv; input?: string; signal?: NodeJS.Signals; group?: boolean; code: number; out?: (text: string) => boolean }

const parsed = (text: string): Record<string, unknown> => {
  try {
    return JSON.parse(text.split('\n')[0] ?? '') as Record<string, unknown>
  } catch {
    return {}
  }
}

const CASES: Case[] = [
  { name: 'a success', words: ['host'], code: 0, out: t => JSON.stringify(parsed(t).argv) === '["host"]' },
  { name: 'a failure exit code', words: ['host', '--code', '9'], code: 9, out: t => JSON.stringify(parsed(t).argv) === '["host","--code","9"]' },
  { name: 'stdin piped through', words: ['host', '--input', 'yes'], input: 'piped words\nand a second line\n', code: 0, out: t => parsed(t).stdin === 'piped words\nand a second line\n' },
  { name: 'a non-default working folder', words: ['host'], cwd: other, code: 0, out: t => parsed(t).cwd === other },
  { name: 'an environment variable read by the verb', words: ['host'], env: { ...env, TERM_PROBE_VALUE: 'forty two' }, code: 0, out: t => parsed(t).probe === 'forty two' },
  { name: 'TERM sent to the parent, handled by the child', words: ['host', '--wait', 'handle'], signal: 'SIGTERM', code: 42, out: t => t === 'got TERM\n' },
  { name: 'TERM sent to the parent, the child ended by it', words: ['host', '--wait', 'die'], signal: 'SIGTERM', code: 143, out: t => t === '' },
  { name: 'INT sent to the terminal group', words: ['host', '--wait', 'handle'], signal: 'SIGINT', group: true, code: 43, out: t => t === 'got INT\n' },
]

// THE NAME AND MARK (term/compiler decision 018): the probe's own deck has no `line` above it, so --version is its mark
if (tool) {
  const version = await run([tool], { words: ['--version'], cwd, env })
  ok('probe: --version prints its own deck\'s mark, 3.4.5', version.code === 0 && version.out === '3.4.5\n', `exit ${version.code} ${JSON.stringify(version.out)} ${JSON.stringify(version.err)}`)
  const help = await run([tool], { words: ['--help'], cwd, env })
  ok('probe: --help names the program hook, tool', help.code === 0 && /\btool\b/.test(help.out) && !/@probe/.test(help.out), JSON.stringify(help.out.slice(0, 300)))
}

// a console whose folder an enclosing deck's `line` names shows THAT deck's mark, not its own deck's. Emitted only:
// the mark is a text the run is handed (`console_decide("tool", "<mark>", ...)`)
{
  const outer = join(out, 'outer')
  const inner = join(outer, 'inner')
  mkdirSync(join(inner, 'code'), { recursive: true })
  mkdirSync(join(inner, 'link', '@term'), { recursive: true })
  writeFileSync(join(outer, 'deck.tree'), 'deck @probe/outer\n  mark <7.8.9>\n  line ./inner/code\n')
  writeFileSync(join(inner, 'deck.tree'), 'deck @probe/inner\n  mark <0.0.2>\n')
  writeFileSync(join(inner, 'code', 'base.tree'), CONSOLE)
  for (const name of ['base', 'call']) symlinkSync(join(TERM, 'deck', name), join(inner, 'link', '@term', name))
  const emitted = spawnSync('node', [LINE, 'make', 'code/base.tree', '--emit', 'rust', '--out', join(out, 'line.rs')], { cwd: inner, encoding: 'utf8', env, maxBuffer: 1 << 26 })
  ok('line probe: term make --emit rust writes the console', emitted.status === 0, tail(emitted, 4000))
  if (emitted.status === 0) {
    const rs = readFileSync(join(out, 'line.rs'), 'utf8')
    // the call, not the definition: its first argument is the name, a text literal
    const decide = /console_decide\(\s*"[^\n]{0,200}/.exec(rs)?.[0] ?? ''
    ok('line probe: the run is handed the line deck\'s mark 7.8.9, not its own 0.0.2', decide.includes('"7.8.9"') && !decide.includes('"0.0.2"'), decide)
    ok('line probe: the run is handed the program hook\'s name', decide.includes('"tool"'), decide)
  }
}

if (tool && folder) {
  for (const one of CASES) {
    const ask = { words: one.words, cwd: one.cwd ?? cwd, env: one.env ?? env, input: one.input, signal: one.signal, group: one.group }
    const twin = await run(['node', join(folder, 'line.js')], ask)
    const native = await run([tool], ask)
    ok(`node twin: ${one.name} exits ${one.code}`, twin.code === one.code, `exit ${twin.code}\n${twin.out}${twin.err}`)
    ok(`node twin: ${one.name} writes what the case asks`, one.out ? one.out(twin.out) : true, JSON.stringify(twin.out))
    ok(`forward: ${one.name}: exit equals the node twin's`, native.code === twin.code, `twin ${twin.code}, native ${native.code}\nnative stderr ${JSON.stringify(native.err)}`)
    ok(`forward: ${one.name}: stdout equals the node twin's`, native.out === twin.out, `twin ${JSON.stringify(twin.out)}\nnative ${JSON.stringify(native.out)}`)
    ok(`forward: ${one.name}: stderr equals the node twin's`, native.err === twin.err, `twin ${JSON.stringify(twin.err)}\nnative ${JSON.stringify(native.err)}`)
    if (one.signal) {
      const left = alive(native.pid)
      ok(`forward: ${one.name}: the child is gone once the parent answers`, native.pid !== undefined && !left, `child pid ${native.pid}`)
      if (left) process.kill(native.pid!, 'SIGKILL')
    }
  }
}

// THE REAL CLI, when it is built: a forwarded verb against node's host/line.js, in an empty folder
const real = join(TERM, 'host', 'native', 'term')
if (!existsSync(real)) {
  console.log('skip  the real native term  (host/native/term not built: pnpm make:native)')
} else {
  const mask = (text: string): string =>
    text
      .replace(/\d\d:\d\d:\d\d\.\d\d\d/g, 'HH:MM:SS.mmm')
      .replace(/\b\d+(\.\d+)?(ms|s)\b/g, 'ELAPSED')
  const empty = folderAt('empty')
  // the dispatcher's own answers (term/compiler decision 018): `term` and the root deck's mark. --version and a verb's
  // --help byte for byte. The program's --help byte for byte from its second line on, and its first line PINNED on
  // each side (decision 018 rule 3's exception, item 1361 option b): node's CLI prints the program hook's note there
  // (work/dispatch.tree show-help), the console runtime the native term runs prints `<name> [command]` (work/hook/
  // deciding.tree help-of). Item term-self-host-001-1365 removes the pins
  const PINNED_NODE = 'Usage: term <verb> [objects] [options]'
  const PINNED_NATIVE = 'term [command]'
  const firstLine = (text: string): string => text.slice(0, Math.max(0, text.indexOf('\n')))
  const afterFirst = (text: string): string => text.slice(text.indexOf('\n') + 1)
  for (const words of [['--version'], ['make', '--help'], ['self', '--help'], ['--help']]) {
    const ask = { words, cwd: empty, env }
    const twin = await run(['node', LINE], ask)
    const native = await run([real], ask)
    const shown = words.join(' ')
    ok(`real: term ${shown} exit equals node's`, native.code === twin.code, `node ${twin.code}, native ${native.code}`)
    if (shown === '--help') {
      ok(`real: term --help line 1 on node is the pinned ${JSON.stringify(PINNED_NODE)}`, firstLine(twin.out) === PINNED_NODE, JSON.stringify(firstLine(twin.out)))
      ok(`real: term --help line 1 natively is the pinned ${JSON.stringify(PINNED_NATIVE)}`, firstLine(native.out) === PINNED_NATIVE, JSON.stringify(firstLine(native.out)))
      ok('real: term --help stdout equals node\'s byte for byte from line 2 on', afterFirst(native.out) === afterFirst(twin.out) && twin.out.length > 0, `node ${JSON.stringify(afterFirst(twin.out).slice(0, 400))}\nnative ${JSON.stringify(afterFirst(native.out).slice(0, 400))}`)
    } else {
      ok(`real: term ${shown} stdout equals node's byte for byte`, native.out === twin.out && twin.out.length > 0, `node ${JSON.stringify(twin.out.slice(0, 400))}\nnative ${JSON.stringify(native.out.slice(0, 400))}`)
    }
    ok(`real: term ${shown} stderr equals node's`, native.err === twin.err, `node ${JSON.stringify(twin.err)}\nnative ${JSON.stringify(native.err)}`)
  }
  // a forwarded verb that refuses in an empty folder (`term base status` was this case until the base verbs left
  // Term, change 001 decision 129)
  for (const words of [['note']]) {
    const ask = { words, cwd: empty, env }
    const twin = await run(['node', LINE], ask)
    const native = await run([real], ask)
    ok(`real: term ${words.join(' ')} exit equals node's`, native.code === twin.code, `node ${twin.code}, native ${native.code}`)
    ok(`real: term ${words.join(' ')} stdout equals node's`, mask(native.out) === mask(twin.out), `node ${JSON.stringify(twin.out)}\nnative ${JSON.stringify(native.out)}`)
    ok(`real: term ${words.join(' ')} stderr equals node's`, mask(native.err) === mask(twin.err), `node ${JSON.stringify(twin.err)}\nnative ${JSON.stringify(native.err)}`)
  }
}

// the probe's own folder goes, as the gate's --temp-strict asks
rmSync(out, { recursive: true, force: true })

console.log(`\nnative-forward: ${pass} pass, ${fail} fail`)

if (fail > 0 || pass === 0) {
  process.exitCode = 1
}
