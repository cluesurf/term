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
// byte, and a forwarded verb of the real CLI is run against node's too. Every verb its build record lists as native
// must have cases here, run against node's, or this fails naming it (item 1456), and each such verb's --help byte for
// byte, its global takes after and before the verb, and the runs where its task throws (item 1409).
// Run: npx tsx test/call/native-forward.ts   (NATIVE_FORWARD_RECORD=<file> reads another build record)

import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TERM = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LINE = join(TERM, 'host', 'line.js')

let pass = 0
let fail = 0
// the runs a filed item says differ (each names its item): neither a pass nor a fail
let known = 0

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

// the command lines each NATIVE verb is checked with against node, by the task host/native/build.json names it by
// (`nativeTasks`). A verb the build makes native lands with its lines here (decision 167 point 6), its globals among
// them (`--log json`, `--plain`), since the native run opens through the entry's open-console (term/compiler decision
// 019)
//
// halt, mind and wake (item term-self-host-001-1451: the printer split made their closures build on Rust): the runs of
// tmp/self-host/1434/part2's capture that leave the folder as they found it, in the line view, under --log json and
// --plain, the exit-1 runs among them, each global after the verb. Node's twin runs first in the same folder, so a run
// that writes (wake into a new folder, mind remembering or forgetting a fact) would hand the native run a different
// folder: the capture (capture2.sh) compares those, each side in a folder of its own. `halt` bare is left out: outside
// a project it stops every term boot on the machine
const VERB_CASES: Record<string, string[][]> = {
  halt: [
    ['halt', '-p', '59997'],
    ['halt', '-p', '59997', '--log', 'json'],
    ['halt', '-p', '59997', '--plain'],
  ],
  mind: [
    ['mind'],
    ['mind', '--log', 'json'],
    ['mind', '--plain'],
    ['mind', '--back', 'json'],
    ['mind', '--find', 'tabs'],
    ['mind', '--find', 'tabs', '--log', 'json'],
    ['mind', '--forget', 'nope'],
    ['mind', '--forget', 'nope', '--log', 'json'],
    ['mind', '--forget', 'nope', '--plain'],
    ['mind', '--forget', 'nope', '--back', 'json'],
  ],
  wake: [
    ['wake', '/dev/null/demo'],
    ['wake', '/dev/null/demo', '--log', 'json'],
    ['wake', '/dev/null/demo', '--plain'],
    // item term-self-host-001-1465: a folder two below the refusal, which node's mkdir names by the full path given
    ['wake', '/dev/null/a/b'],
    ['wake', '/dev/null/a/b', '--log', 'json'],
    ['wake', '/dev/null/a/b', '--plain'],
  ],
}
const NATIVE_RECORD = process.env.NATIVE_FORWARD_RECORD ?? join(TERM, 'host', 'native', 'build.json')

// THE REAL CLI, when it is built: a forwarded verb against node's host/line.js, in an empty folder
const real = join(TERM, 'host', 'native', 'term')
if (!existsSync(real)) {
  console.log('skip  the real native term  (host/native/term not built: pnpm make:native)')
} else {
  const mask = (text: string): string =>
    text
      .replace(/\d\d:\d\d:\d\d\.\d\d\d/g, 'HH:MM:SS.mmm')
      .replace(/\b\d+(\.\d+)?(ms|s)\b/g, 'ELAPSED')
      // --log json gives the elapsed time as a number field, as the line view's `4ms`
      .replace(/"ms":\d+(\.\d+)?/g, '"ms":ELAPSED')
      // under --color always the unit is coloured apart from its number: `3\e[90mms\e[0m`
      .replace(/\b\d+(\.\d+)?(\x1b\[\d+m)(ms|s)\b/g, 'ELAPSED$2$3')
  const empty = folderAt('empty')

  // EACH NATIVE VERB'S SURFACE (item term-self-host-001-1409, procedure task/native-surface.md section B): every other
  // global take of the program hook (--quiet, --strict, --color, --utc) after the verb and before it, and the runs
  // where the verb's task throws (node's fail-run: `✗ <verb> <message>` then `✗ <verb> Failed`, exit 1). Each side
  // runs in the SAME folder path, made again between the two, so a path the run prints is byte-equal and a run that
  // writes hands the other side nothing. A run `known` to differ names the item that owns the difference: it prints
  // `known` while it differs and passes once it does not, and its mark goes with the fix
  type Ran2 = { out: string; err: string; code: number | null }
  type SurfaceCase = {
    verb: string
    name: string
    words: string[]
    setup?: (dir: string) => void
    env?: NodeJS.ProcessEnv
    known?: string
    // a further check over both runs: the empty text when it holds, else what is wrong
    check?: (node: Ran2, native: Ran2) => string
  }
  const memoryAt = (dir: string): string => join(dir, '.base', '@term', 'code', 'memory')
  const memoryFile = (dir: string): void => {
    mkdirSync(join(dir, '.base', '@term', 'code'), { recursive: true })
    writeFileSync(memoryAt(dir), 'not a folder\n')
  }
  const factFolder = (dir: string): void => {
    mkdirSync(join(memoryAt(dir), 'tabs.md'), { recursive: true })
  }
  const memoryLocked = (dir: string): void => {
    mkdirSync(memoryAt(dir), { recursive: true })
    chmodSync(memoryAt(dir), 0o000)
  }
  const colourless: NodeJS.ProcessEnv = { ...env }
  delete colourless.NO_COLOR
  // fourteen hours ahead of UTC all year, so a local clock never reads as a UTC one
  const kiritimati: NodeJS.ProcessEnv = { ...env, TZ: 'Pacific/Kiritimati' }
  const clockHours = (text: string): string[] => [...text.matchAll(/^\s*(\d\d):\d\d:\d\d\.\d\d\d$/gm)].map(m => m[1]!)
  let utcHours: string[] = []
  const inUtc = (twin: Ran2, native: Ran2): string => {
    const node = clockHours(twin.err)
    const ran = clockHours(native.err)
    if (node.length === 0 || ran.length === 0) return `no clock line: node ${JSON.stringify(node)}, native ${JSON.stringify(ran)}`
    const wrong = [...node, ...ran].filter(hour => !utcHours.includes(hour))
    return wrong.length === 0 ? '' : `clock hours ${JSON.stringify(wrong)} are not UTC's ${JSON.stringify(utcHours)}`
  }
  const ON_PORT = ['halt', '-p', '59997']
  const NOPE = ['mind', '--forget', 'nope']
  const NO_DIR = ['wake', '/dev/null/demo']
  // A THROWN RUN (item term-self-host-001-1460, term/compiler decision 021): the host's file failure raises node's
  // wording natively (1463) and the console's catch-console prints node's fail-run (1464), so each side exits 1 with
  // `x mind <message>` then `x mind Failed`, under --log json and --plain alike, and a fact that cannot be written leaves
  // the memory file as it was
  const thrownOnNode = (twin: Ran2): string => (twin.code === 1 ? '' : `node exit ${twin.code}, not 1`)
  const memoryKept = (twin: Ran2): string => {
    const wrong = thrownOnNode(twin)
    if (wrong !== '') return wrong
    let kept = ''
    try {
      kept = readFileSync(memoryAt(join(out, 'surface')), 'utf8')
    } catch (problem) {
      return `the memory file is gone after the native run: ${String(problem)}`
    }
    return kept === 'not a folder\n' ? '' : `the memory file reads ${JSON.stringify(kept)} after the native run`
  }
  const THROWN: Array<{ name: string; words: string[]; setup: (dir: string) => void; check: (twin: Ran2, native: Ran2) => string }> = [
    { name: 'the memory folder is a file, listed', words: ['mind'], setup: memoryFile, check: thrownOnNode },
    { name: 'the memory folder is a file, a fact remembered', words: ['mind', 'Use tabs'], setup: memoryFile, check: memoryKept },
    { name: 'a fact file is a folder', words: ['mind'], setup: factFolder, check: thrownOnNode },
    { name: 'the memory folder cannot be read', words: ['mind'], setup: memoryLocked, check: thrownOnNode },
  ]
  const thrownCases: SurfaceCase[] = THROWN.flatMap(one => [
    { verb: 'mind', name: `thrown: ${one.name}`, words: one.words, setup: one.setup, check: one.check },
    { verb: 'mind', name: `thrown: ${one.name}, --log json`, words: [...one.words, '--log', 'json'], setup: one.setup, check: one.check },
    { verb: 'mind', name: `thrown: ${one.name}, --plain`, words: [...one.words, '--plain'], setup: one.setup, check: one.check },
  ])
  const SURFACE_CASES: SurfaceCase[] = [
    { verb: 'halt', name: '--quiet after the verb', words: [...ON_PORT, '--quiet'] },
    { verb: 'halt', name: '--strict after the verb (a warning fails the run)', words: [...ON_PORT, '--strict'], check: (twin: Ran2) => (twin.code === 1 ? '' : `node exit ${twin.code}, not 1`) },
    { verb: 'halt', name: '--color never after the verb, NO_COLOR unset', words: [...ON_PORT, '--color', 'never'], env: colourless },
    { verb: 'halt', name: '--utc after the verb, TZ fourteen hours ahead', words: [...ON_PORT, '--utc'], env: kiritimati, check: inUtc },
    { verb: 'halt', name: 'no lsof, ps or netstat on the PATH', words: ON_PORT, env: { ...env, PATH: '/nonexistent' } },
    { verb: 'mind', name: '--quiet after the verb', words: [...NOPE, '--quiet'] },
    { verb: 'mind', name: '--strict after the verb', words: ['mind', '--strict'] },
    { verb: 'mind', name: '--color never after the verb, NO_COLOR unset', words: [...NOPE, '--color', 'never'], env: colourless },
    { verb: 'mind', name: '--color always after the verb', words: [...NOPE, '--color', 'always'] },
    ...thrownCases,
    { verb: 'wake', name: '--quiet after the verb', words: [...NO_DIR, '--quiet'] },
    { verb: 'wake', name: '--strict after the verb', words: [...NO_DIR, '--strict'] },
    { verb: 'wake', name: '--color never after the verb, NO_COLOR unset', words: [...NO_DIR, '--color', 'never'], env: colourless },
    { verb: 'wake', name: 'a file where the project folder goes', words: ['wake', 'demo'], setup: dir => writeFileSync(join(dir, 'demo'), 'a file\n') },
  ]
  // GLOBALS BEFORE THE VERB (item term-self-host-001-1459): a global take written before the verb is the same take as
  // after it, short or valued, inline or not, on node and natively. Each case names the line with the take after the
  // verb (`after`), which node runs first in the same folder, made again for it: node's run of the line as written must
  // equal it (the take applied, never read as a command word), and the native run must equal node's, as every surface
  // case. A word that names no command past a valued global is refused naming that word, the same after it
  type BeforeCase = SurfaceCase & { after: string[] }
  const BEFORE_CASES: BeforeCase[] = [
    { verb: 'halt', name: '-q before the verb', words: ['-q', ...ON_PORT], after: [...ON_PORT, '-q'] },
    { verb: 'halt', name: '--utc before the verb, TZ fourteen hours ahead', words: ['--utc', ...ON_PORT], after: [...ON_PORT, '--utc'], env: kiritimati, check: inUtc },
    { verb: 'halt', name: '--log json before the verb', words: ['--log', 'json', ...ON_PORT], after: [...ON_PORT, '--log', 'json'] },
    { verb: 'halt', name: '--color=never before the verb, NO_COLOR unset', words: ['--color=never', ...ON_PORT], after: [...ON_PORT, '--color=never'], env: colourless },
    { verb: 'mind', name: '--strict before the verb', words: ['--strict', 'mind'], after: ['mind', '--strict'] },
    { verb: 'mind', name: '--log json before the verb', words: ['--log', 'json', 'mind'], after: ['mind', '--log', 'json'] },
    { verb: 'mind', name: '-q before the verb', words: ['-q', ...NOPE], after: [...NOPE, '-q'] },
    { verb: 'mind', name: '--color never before the verb, NO_COLOR unset', words: ['--color', 'never', ...NOPE], after: [...NOPE, '--color', 'never'], env: colourless },
    { verb: 'mind', name: '--back json before the verb (a take mind declares too)', words: ['--back', 'json', 'mind'], after: ['mind', '--back', 'json'] },
    { verb: 'mind', name: '--log json before a word that names no command', words: ['--log', 'json', 'nope'], after: ['nope', '--log', 'json'] },
    { verb: 'wake', name: '-q before the verb', words: ['-q', ...NO_DIR], after: [...NO_DIR, '-q'] },
    { verb: 'wake', name: '--log json before the verb', words: ['--log', 'json', ...NO_DIR], after: [...NO_DIR, '--log', 'json'] },
    { verb: 'wake', name: '--color never before the verb, NO_COLOR unset', words: ['--color', 'never', ...NO_DIR], after: [...NO_DIR, '--color', 'never'], env: colourless },
  ]
  for (const one of BEFORE_CASES) {
    const dir = join(out, 'surface')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const after = await run([process.execPath, LINE], { words: one.after, cwd: dir, env: one.env ?? env })
    const further = one.check
    one.check = (twin: Ran2, native: Ran2): string => {
      const wrong: string[] = []
      if (twin.code !== after.code) wrong.push(`node exit ${twin.code}, ${after.code} with the take after the verb`)
      if (mask(twin.out) !== mask(after.out)) wrong.push(`node stdout ${JSON.stringify(twin.out.slice(0, 400))}, with the take after the verb ${JSON.stringify(after.out.slice(0, 400))}`)
      if (mask(twin.err) !== mask(after.err)) wrong.push(`node stderr ${JSON.stringify(twin.err.slice(0, 400))}, with the take after the verb ${JSON.stringify(after.err.slice(0, 400))}`)
      const more = further?.(twin, native) ?? ''
      if (more !== '') wrong.push(more)
      return wrong.join('\n        ')
    }
    SURFACE_CASES.push(one)
  }
  const unlock = (dir: string): void => {
    try {
      chmodSync(memoryAt(dir), 0o755)
    } catch {}
  }
  const surfaceCase = async (one: SurfaceCase): Promise<void> => {
    const dir = join(out, 'surface')
    const fresh = (): void => {
      unlock(dir)
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      one.setup?.(dir)
    }
    const shown = `verb ${one.verb}: ${one.name}: term ${one.words.join(' ')}`
    const before = new Date().getUTCHours()
    fresh()
    const twin = await run([process.execPath, LINE], { words: one.words, cwd: dir, env: one.env ?? env })
    fresh()
    const native = await run([real], { words: one.words, cwd: dir, env: one.env ?? env })
    unlock(dir)
    utcHours = [before, new Date().getUTCHours()].map(hour => String(hour).padStart(2, '0'))
    const wrong: string[] = []
    if (native.code !== twin.code) wrong.push(`exit: node ${twin.code}, native ${native.code}`)
    if (mask(native.out) !== mask(twin.out)) wrong.push(`stdout: node ${JSON.stringify(twin.out.slice(0, 400))}\n        native ${JSON.stringify(native.out.slice(0, 400))}`)
    if (mask(native.err) !== mask(twin.err)) wrong.push(`stderr: node ${JSON.stringify(twin.err.slice(0, 400))}\n        native ${JSON.stringify(native.err.slice(0, 400))}`)
    const further = one.check?.(twin, native) ?? ''
    if (further !== '') wrong.push(further)
    if (one.known !== undefined && wrong.length > 0) {
      known++
      console.log(`known ${shown}  (${one.known})`)
      return
    }
    ok(`${shown}: exit, stdout and stderr equal node's`, wrong.length === 0, wrong.join('\n        '))
  }
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

  // A VERB GOES NATIVE ONLY WITH ITS CASES (decision 167 point 6 of term/self-host/change/001-finish-self-host, item
  // term-self-host-001-1456): every task host/native/build.json lists as native has its command lines here, each run
  // on the real native term against node's, so a closure that starts to build on Rust never turns a verb native
  // unseen (trap T-1451 (4)). The build alone decides what is native, and this fails, naming the verb, for one with
  // no case
  let record: { nativeTasks?: unknown } | undefined
  try {
    record = JSON.parse(readFileSync(NATIVE_RECORD, 'utf8')) as { nativeTasks?: unknown }
  } catch {
    record = undefined
  }
  const nativeTasks = record && Array.isArray(record.nativeTasks) ? record.nativeTasks.filter((one): one is string => typeof one === 'string') : undefined
  if (nativeTasks === undefined) {
    ok('guard: host/native/build.json beside host/native/term lists its native verbs', false, `${NATIVE_RECORD} is missing or holds no nativeTasks list: run pnpm make:native`)
  } else {
    for (const task of nativeTasks) {
      const cases = VERB_CASES[task] ?? []
      ok(`guard: native verb ${task} has native-forward cases`, cases.length > 0, `host/native/build.json lists ${task} as native and native-forward has no case for it: add its command lines to VERB_CASES`)
      for (const words of cases) {
        const ask = { words, cwd: empty, env }
        const twin = await run(['node', LINE], ask)
        const native = await run([real], ask)
        const shown = words.join(' ')
        ok(`verb ${task}: term ${shown} exit equals node's`, native.code === twin.code, `node ${twin.code}, native ${native.code}`)
        ok(`verb ${task}: term ${shown} stdout equals node's`, mask(native.out) === mask(twin.out), `node ${JSON.stringify(twin.out.slice(0, 400))}\nnative ${JSON.stringify(native.out.slice(0, 400))}`)
        ok(`verb ${task}: term ${shown} stderr equals node's`, mask(native.err) === mask(twin.err), `node ${JSON.stringify(twin.err.slice(0, 400))}\nnative ${JSON.stringify(native.err.slice(0, 400))}`)
      }
      // the verb's own --help, byte for byte: it is the console's usage text, no clock in it (item 1409)
      if (cases.length > 0) {
        const ask = { words: [task, '--help'], cwd: empty, env }
        const twin = await run([process.execPath, LINE], ask)
        const native = await run([real], ask)
        ok(`verb ${task}: term ${task} --help exit equals node's`, native.code === twin.code, `node ${twin.code}, native ${native.code}`)
        ok(`verb ${task}: term ${task} --help stdout equals node's byte for byte`, native.out === twin.out && twin.out.length > 0, `node ${JSON.stringify(twin.out.slice(0, 400))}\nnative ${JSON.stringify(native.out.slice(0, 400))}`)
        ok(`verb ${task}: term ${task} --help stderr equals node's byte for byte`, native.err === twin.err, `node ${JSON.stringify(twin.err.slice(0, 400))}\nnative ${JSON.stringify(native.err.slice(0, 400))}`)
      }
      for (const one of SURFACE_CASES.filter(c => c.verb === task)) await surfaceCase(one)
    }
  }
}

// the probe's own folder goes, as the gate's --temp-strict asks
rmSync(out, { recursive: true, force: true })

console.log(`\nnative-forward: ${pass} pass, ${fail} fail${known > 0 ? `, ${known} known` : ''}`)

if (fail > 0 || pass === 0) {
  process.exitCode = 1
}
