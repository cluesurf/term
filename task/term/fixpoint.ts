// THE FIXPOINT (item term-self-host-001-0170, spec.md sections 3 and 4.16 of change 001-finish-self-host, decisions 123
// and 124): stage0 builds the stage1 compiler, stage1 builds the stage2 compiler, and the two emit the same TypeScript
// and the same Rust text for every toolchain module.
//
//   pnpm term:fixpoint [--stage0 <dir>] [--targets ts,rust] [--out <dir>] [--jobs <n>] [--only <text>]
//   pnpm term:fixpoint --compare <stage dir> <stage dir> [--targets ts,rust] [--out <dir>]
//
// It never builds in this tree. It copies the Term root to <out>/tree (copy on write where the disk can, with
// link/@term pointed at the copy, traps T-0792), then works only there, with port-build's own two steps (decision 030
// section 1) and stage0's own bundle (decision 036), never a build path of its own:
//
// port-build is the Term task task/port-build.tree, run by the copy's launcher (`node task/launch.mjs port-build`,
// decision 140), so in C the build task itself is compiled by the stage1 bundle.
//
//   A  port-build --stage-check, stage0 the pin (or --stage0): stage0 writes every port, the stage1 compiler's source
//      (stage1/ts), then the stage1 compiler compiles every module again (stage2/ts). With rust, the stage1 compiler
//      emits Rust for every module (stage2/rust), as emit-manifest.ts emits it
//   B  stage0:pin in the copy bundles the stage1 compiler, the copy's own pin
//   C  port-build --stage-check with that bundle as stage0: it writes every port again (stage2-bundle/ts, the stage2
//      compiler's source), then the stage2 compiler compiles every module (stage3/ts) and emits Rust (stage3/rust)
//
// A stage folder holds <target>/<module> texts and manifest-<target>.txt, one `<module> <sha256>` line per module,
// sorted. A module a compiler refuses is `<module> refused-<sha256 of the message>`, so the same refusal on both sides
// is equal (and listed) and a changed message is a change. The pairs compared:
//
//   fixpoint       stage2 and stage3, ts and rust: what the stage1 and the stage2 compilers emit (the verdict)
//   stage0-stage1  stage1 and stage2, ts: what stage0 and the stage1 compiler emit (port-build --stage-check's number,
//                  0 once stage0 is re-pinned from this source). A stage0 bundle carries no Rust emitter
//   bundle         stage2 and stage2-bundle, ts: the stage1 compiler run from its source and from its bundle
//
// Every differing module, with the first differing line of each side, goes to <out>/differ-<pair>-<target>.txt,
// grouped by folder. The verdict prints at most three groups a pair. --compare compares two stage folders the same way.
//
// The copy (about 6 GB by copy on write, kilobytes on disk) and every stage stay under <out>, which must not exist:
// remove a run's folder by hand. Default <out>: tmp/self-host/fixpoint/<UTC time>. --stage0 <dir>: a folder holding a
// stage0 compile.mjs, installed into the user home store by its sha256 when absent (task/stage0.ts stage0Path).
//
// Exit 0 when the fixpoint holds on every target asked, 1 when a module differs, 2 on usage, 3 when a stage could not
// build (a module stage0 or the stage1 bundle refuses, a step killed, a copy that failed).

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CALLER_CWD, TERM_ROOT } from './root'

const USAGE =
  'usage: fixpoint.ts [--stage0 <dir>] [--targets ts,rust] [--out <dir>] | --compare <stage dir> <stage dir> [--targets ts,rust] [--out <dir>]'

const argv = process.argv.slice(2)

function flag(name: string): string | undefined {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}

function usage(message: string): never {
  console.error(`${message}\n${USAGE}`)
  process.exit(2)
}

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
const clock = (): string => `${new Date().toISOString().slice(11, 19)}Z`
// the deck folders port-build's plan covers (task/port-build.tree `decks`)
const PORT_DECKS = ['make', 'deck', 'flow', 'scan', 'test', 'call']

// ---- the copy ----

// left out of the copy at its root: the repository, scratch, homes, and the two folders made fresh below
const LEFT_AT_ROOT = new Set(['.git', 'tmp', '.base', 'node_modules', 'link', '.DS_Store'])
// left out below the root: build homes, scratch and native build output, never a source (port-build's SKIP)
const LEFT_BELOW = new Set(['.base', 'tmp', 'target', '.build', '.git', '.DS_Store'])

function copyRoot(from: string, to: string): void {
  mkdirSync(to, { recursive: true })

  for (const name of readdirSync(from).sort()) {
    if (LEFT_AT_ROOT.has(name)) {
      continue
    }

    cpSync(join(from, name), join(to, name), {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
      filter: source => source === join(from, name) || !(LEFT_BELOW.has(basename(source)) || basename(source).endsWith('-cache')),
    })
  }

  // the packages, shared: the copy builds nothing into them
  symlinkSync(join(from, 'node_modules'), join(to, 'node_modules'))
  copyLinks(join(from, 'link'), join(to, 'link'), from, to)
}

// link/: a symlink into the source root points at the same place in the copy (T-0792), any other is kept as it is
function copyLinks(from: string, to: string, root: string, copy: string): void {
  if (!existsSync(from)) {
    return
  }

  mkdirSync(to, { recursive: true })

  for (const name of readdirSync(from)) {
    const source = join(from, name)
    const stat = lstatSync(source)

    if (stat.isSymbolicLink()) {
      const target = resolve(dirname(source), readlinkSync(source))
      const inside = relative(root, target)
      symlinkSync(inside.startsWith('..') ? target : join(copy, inside), join(to, name))
    } else if (stat.isDirectory()) {
      copyLinks(source, join(to, name), root, copy)
    } else {
      copyFileSync(source, join(to, name))
    }
  }
}

// ---- running a step in the copy ----

function stepEnv(tree: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TERM_STDLIB: join(tree, 'deck', 'base') }

  // the copy finds its own root and takes its own line lock, never one this process was handed
  delete env.TERM_ROOT
  delete env.TERM_LINE_LOCK
  delete env.TERM_LINE_LOCK_BY
  delete env.TERM_DEPTH
  env.NODE_OPTIONS = `${(env.NODE_OPTIONS ?? '').replace(/--max-old-space-size=\d+/g, '')} --max-old-space-size=8192`.trim()
  return env
}

type Ended = { status: number | null; signal: NodeJS.Signals | null }

// a tsx script in the copy, its output to a log: its exit status, or the signal that ended it
function step(tree: string, log: string, args: string[]): Ended {
  const fd = openSync(log, 'w')

  try {
    const run = spawnSync(process.execPath, [join(tree, 'node_modules', 'tsx', 'dist', 'cli.mjs'), ...args], {
      cwd: tree,
      env: stepEnv(tree),
      stdio: ['ignore', fd, fd],
    })

    return { status: run.status, signal: run.signal }
  } finally {
    closeSync(fd)
  }
}

// a Term task in the copy, run by the copy's own launcher on the copy's stage0 pin (decision 140): `port-build` in A
// and C, so step C's port-build is itself compiled by the stage1 bundle
function launchStep(tree: string, log: string, args: string[]): Ended {
  const fd = openSync(log, 'w')

  try {
    const run = spawnSync(process.execPath, [join(tree, 'task', 'launch.mjs'), ...args], {
      cwd: tree,
      env: stepEnv(tree),
      stdio: ['ignore', fd, fd],
    })

    return { status: run.status, signal: run.signal }
  } finally {
    closeSync(fd)
  }
}

// the same, beside others
function stepAsync(tree: string, log: string, args: string[]): Promise<Ended> {
  const fd = openSync(log, 'w')
  const child = spawn(process.execPath, [join(tree, 'node_modules', 'tsx', 'dist', 'cli.mjs'), ...args], {
    cwd: tree,
    env: stepEnv(tree),
    stdio: ['ignore', fd, fd],
  })

  return new Promise(done => {
    child.on('close', (status, signal) => {
      closeSync(fd)
      done({ status, signal })
    })
  })
}

// ---- stage folders and manifests ----

type Stage = { dir: string; target: string }

function walk(dir: string, out: string[], base = dir): void {
  if (!existsSync(dir)) {
    return
  }

  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)

    if (statSync(full).isDirectory()) {
      walk(full, out, base)
    } else {
      out.push(relative(base, full))
    }
  }
}

// the module a port path holds: deck/<d>/host/port/<rest>.ts is deck/<d>/<rest>.tree, and <rest>-run.ts is that
// module's run entry where no <rest>-run.tree exists (port-build THE RUN ENTRY)
function sourceOfPort(tree: string, port: string): { source: string; run: boolean } | undefined {
  const match = /^deck\/([^/]+)\/host\/port\/(.+)\.ts$/.exec(port)

  if (!match) {
    return undefined
  }

  const own = `deck/${match[1]}/${match[2]}.tree`

  if (existsSync(join(tree, own))) {
    return { source: own, run: false }
  }

  if (match[2]!.endsWith('-run')) {
    const ran = `deck/${match[1]}/${match[2]!.slice(0, -4)}.tree`
    return existsSync(join(tree, ran)) ? { source: ran, run: true } : undefined
  }

  return undefined
}

function portOf(source: string): string {
  const match = /^deck\/([^/]+)\/(.+)\.tree$/.exec(source)!
  return `deck/${match[1]}/host/port/${match[2]}.ts`
}

function put(stage: Stage, module: string, from: string): void {
  const to = join(stage.dir, stage.target, module)
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to, constants.COPYFILE_FICLONE)
}

function refuse(stage: Stage, module: string, message: string): void {
  const to = join(stage.dir, stage.target, `${module}.refused`)
  mkdirSync(dirname(to), { recursive: true })
  writeFileSync(to, message)
}

// manifest-<target>.txt from the stage's texts: `<module> <sha256>`, `<module> refused-<sha256>` for a refusal
function writeManifest(stage: Stage): Map<string, string> {
  const files: string[] = []
  walk(join(stage.dir, stage.target), files)
  const digests = new Map<string, string>()

  for (const file of files) {
    const text = readFileSync(join(stage.dir, stage.target, file))

    if (file.endsWith('.refused')) {
      digests.set(file.slice(0, -'.refused'.length), `refused-${sha(text)}`)
    } else {
      digests.set(file, sha(text))
    }
  }

  const lines = [...digests].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([module, digest]) => `${module} ${digest}`)
  writeFileSync(join(stage.dir, `manifest-${stage.target}.txt`), `${lines.join('\n')}\n`)
  return digests
}

function readManifest(stage: Stage): Map<string, string> | undefined {
  const path = join(stage.dir, `manifest-${stage.target}.txt`)

  if (!existsSync(path)) {
    return undefined
  }

  return new Map(
    readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const at = line.lastIndexOf(' ')
        return [line.slice(0, at), line.slice(at + 1)] as [string, string]
      }),
  )
}

// ---- comparing ----

type Pair = { label: string; left: Stage; right: Stage; leftName: string; rightName: string }
type Compared = { label: string; target: string; modules: number; differ: number; refusedAlike: string[]; groups: [string, string[]][]; file: string; missing?: string }

function textOf(stage: Stage, module: string): string {
  const path = join(stage.dir, stage.target, module)

  if (existsSync(path)) {
    return readFileSync(path, 'utf8')
  }

  return existsSync(`${path}.refused`) ? `<refused: ${readFileSync(`${path}.refused`, 'utf8').split('\n')[0]}>` : '<absent>'
}

function firstDifference(a: string, b: string, left: string, right: string): string {
  const one = a.split('\n')
  const two = b.split('\n')

  for (let line = 0; line < Math.max(one.length, two.length); line++) {
    if (one[line] !== two[line]) {
      return `line ${line + 1}\n    ${left}: ${(one[line] ?? '<end>').slice(0, 200)}\n    ${right}: ${(two[line] ?? '<end>').slice(0, 200)}`
    }
  }

  return 'no line differs (a byte at the end)'
}

// a module's group: its source folder, the port tree's host/port left out
function groupOf(module: string): string {
  return dirname(module.replace(/\/host\/port\//, '/'))
}

function compare(pair: Pair, out: string): Compared {
  const file = join(out, `differ-${pair.label}-${pair.left.target}.txt`)
  const left = readManifest(pair.left)
  const right = readManifest(pair.right)

  if (!left || !right) {
    return { label: pair.label, target: pair.left.target, modules: 0, differ: 0, refusedAlike: [], groups: [], file, missing: !left ? pair.left.dir : pair.right.dir }
  }

  const modules = [...new Set([...left.keys(), ...right.keys()])].sort()
  const refusedAlike: string[] = []
  const groups = new Map<string, string[]>()
  const lines: string[] = []

  for (const module of modules) {
    const a = left.get(module)
    const b = right.get(module)

    if (a === b) {
      if (a!.startsWith('refused-')) {
        refusedAlike.push(module)
      }

      continue
    }

    const group = groupOf(module)
    groups.set(group, [...(groups.get(group) ?? []), module])
    lines.push(`${module}  ${firstDifference(textOf(pair.left, module), textOf(pair.right, module), pair.leftName, pair.rightName)}`)
  }

  const sorted = [...groups].sort((x, y) => y[1].length - x[1].length || (x[0] < y[0] ? -1 : 1))
  const differ = lines.length

  writeFileSync(
    file,
    [
      `${pair.label} ${pair.left.target}: ${pair.leftName} ${pair.left.dir} against ${pair.rightName} ${pair.right.dir}`,
      `${modules.length} modules, ${differ} differ in ${sorted.length} groups, ${refusedAlike.length} refused alike`,
      ...sorted.map(([group, list]) => `group ${group} ${list.length}`),
      ...lines,
      ...refusedAlike.map(module => `refused alike ${module}`),
      '',
    ].join('\n'),
  )

  return { label: pair.label, target: pair.left.target, modules: modules.length, differ, refusedAlike, groups: sorted, file }
}

function report(found: Compared, pair: Pair): string[] {
  if (found.missing) {
    return [`${found.label} ${found.target}: not compared, no manifest in ${found.missing}`]
  }

  const alike = found.refusedAlike.length > 0 ? `, ${found.refusedAlike.length} refused alike` : ''

  if (found.differ === 0) {
    return [`${found.label} ${found.target}: ${found.modules} modules, identical${alike}`]
  }

  const lines = [`${found.label} ${found.target}: ${found.modules} modules, ${found.differ} differ in ${found.groups.length} groups${alike} (${found.file})`]

  for (const [group, list] of found.groups.slice(0, 3)) {
    const first = list[0]!
    const excerpt = firstDifference(textOf(pair.left, first), textOf(pair.right, first), pair.leftName, pair.rightName).split('\n')
    lines.push(`  ${group} ${list.length}: ${basename(first)} ${excerpt[0]}`)
    lines.push(...excerpt.slice(1).map(line => `  ${line.trim().slice(0, 150)}`))
  }

  return lines
}

// ---- emitting Rust, run in the copy by the compiler it holds ----

async function emitRust(list: string, outDir: string): Promise<void> {
  const { build } = await import('./shared-nodes')
  const { emitRust: emit } = await import('@term/make/code/compile/rust')
  const { nativePrelude } = await import('@term/make/code/compile/native')
  const readRuntime = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)
  const modules = readFileSync(list, 'utf8').split('\n').filter(Boolean)
  const started = Date.now()
  let emitted = 0
  let refused = 0

  for (const [index, source] of modules.entries()) {
    const module = source.replace(/\.tree$/, '.rs')
    const to = join(outDir, module)
    mkdirSync(dirname(to), { recursive: true })
    const built = build({ file: source, text: readFileSync(source, 'utf8') }, true, 'rust')
    let text: string | undefined
    let reason = built.reason

    if (built.program) {
      try {
        const program = built.program as Parameters<typeof emit>[0]
        const body = emit(program)
        text = `${nativePrelude(program, 'rust', readRuntime, body)}\n${body}`
      } catch (error) {
        reason = `threw ${(error as Error).message.split('\n')[0]}`
      }
    }

    if (text === undefined) {
      writeFileSync(`${to}.refused`, reason ?? 'no program')
      refused++
    } else {
      writeFileSync(to, text)
      emitted++
    }

    if ((index + 1) % 50 === 0) {
      console.log(`rust ${index + 1}/${modules.length} ${Math.round((Date.now() - started) / 1000)} s`)
    }
  }

  console.log(`rust done: ${emitted} emitted, ${refused} refused, ${Math.round((Date.now() - started) / 1000)} s`)
}

// ---- the stages ----

// port-build's stage-two refusals, `  FAIL   <module>  (stage1 cannot compile it: <why>)`
function stageTwoRefusals(log: string): Map<string, string> {
  const found = new Map<string, string>()

  for (const line of readFileSync(log, 'utf8').split('\n')) {
    const match = /^ {2}FAIL {3}(\S+) {2}\((.*)\)$/.exec(line)

    if (match) {
      found.set(match[1]!, match[2]!)
    }
  }

  return found
}

// port-build's stage-one refusals, `  FAIL  <module>` and the diagnostics under it
function stageOneRefusals(log: string): string[] {
  const lines = readFileSync(log, 'utf8').split('\n')
  const found: string[] = []

  for (const [at, line] of lines.entries()) {
    const match = /^ {2}FAIL {2}(\S+)$/.exec(line)

    if (match) {
      found.push(`${match[1]}: ${(lines[at + 1] ?? '').trim().slice(0, 160)}`)
    }
  }

  return found
}

function lastLine(log: string, pattern: RegExp): string {
  return (
    readFileSync(log, 'utf8')
      .split('\n')
      .filter(line => pattern.test(line))
      .pop() ?? '<none>'
  )
}

async function run(): Promise<void> {
  const targets = (flag('--targets') ?? 'ts,rust').split(',')

  if (targets.some(target => target !== 'ts' && target !== 'rust') || targets.length === 0) {
    usage(`--targets takes ts, rust or both, not ${flag('--targets')}`)
  }

  const out = resolve(CALLER_CWD, flag('--out') ?? join(TERM_ROOT, 'tmp', 'self-host', 'fixpoint', new Date().toISOString().replace(/[:.]/g, '-')))

  if (existsSync(out)) {
    usage(`${out} exists: a run never writes over another (remove it by hand, or name another --out)`)
  }

  const stage0Dir = flag('--stage0')
  // --only <text>: port-build's own filter, the modules whose path holds the text (a smoke run, never a verdict)
  const only = flag('--only') === undefined ? [] : ['--only', flag('--only')!]
  // --jobs <n>: processes emitting Rust at once (each about 2 GB), 3 by default
  const jobs = Number(flag('--jobs') ?? '3')

  if (!Number.isInteger(jobs) || jobs < 1) {
    usage(`--jobs takes a whole number above 0, not ${flag('--jobs')}`)
  }

  const tree = join(out, 'tree')
  const logs = join(out, 'log')
  mkdirSync(logs, { recursive: true })
  const say = (line: string): void => console.log(line)
  const stop = (line: string): never => {
    say(line)
    say('status: FAIL')
    process.exit(3)
  }

  // A shifting tree copies as no tree ever stood: say who holds the line lock as the copy starts
  const holder = spawnSync(process.execPath, [join(TERM_ROOT, 'task', 'term', 'line-lock.ts'), 'show'], { encoding: 'utf8', cwd: TERM_ROOT })
  say(`${clock()} copy ${TERM_ROOT} to ${tree} (${(holder.stdout ?? '').trim() || 'line lock: unknown'})`)

  try {
    copyRoot(TERM_ROOT, tree)
  } catch (error) {
    stop(`copy failed: ${(error as Error).message}`)
  }

  // the harness runs in the copy as it runs here
  copyFileSync(fileURLToPath(import.meta.url), join(tree, 'task', 'term', 'fixpoint.ts'))

  if (stage0Dir) {
    const bundle = join(resolve(CALLER_CWD, stage0Dir), 'compile.mjs')

    if (!existsSync(bundle)) {
      usage(`--stage0 ${stage0Dir} holds no compile.mjs`)
    }

    const id = sha(readFileSync(bundle))
    const { stage0Path } = (await import('../stage0')) as { stage0Path: (id: string, ...parts: string[]) => string }
    const stored = stage0Path(id, 'compile.mjs')

    if (!existsSync(stored)) {
      mkdirSync(dirname(stored), { recursive: true })
      copyFileSync(bundle, stored, constants.COPYFILE_EXCL)
    }

    writeFileSync(
      join(tree, 'task', 'stage0.json'),
      `${JSON.stringify({ id, pinned: new Date().toISOString(), head: '', make_digest: '', sources_digest: '', sources: 0 }, null, 2)}\n`,
    )
  }

  const pin = JSON.parse(readFileSync(join(tree, 'task', 'stage0.json'), 'utf8')) as { id: string }
  say(`${clock()} stage0 ${pin.id}`)

  const stages = {
    stage1: { dir: join(out, 'stage1'), target: 'ts' },
    stage2: { dir: join(out, 'stage2'), target: 'ts' },
    bundle: { dir: join(out, 'stage2-bundle'), target: 'ts' },
    stage3: { dir: join(out, 'stage3'), target: 'ts' },
    rust2: { dir: join(out, 'stage2'), target: 'rust' },
    rust3: { dir: join(out, 'stage3'), target: 'rust' },
  }
  const checkScratch = join(tree, 'tmp', 'self-host', 'stage-check')

  // A: stage0 writes the ports, the stage1 compiler compiles every module again
  const logA = join(logs, 'a-port-build.log')
  const a = launchStep(tree, logA, ['port-build', '--stage-check', ...only])
  say(`${clock()} A ${lastLine(logA, /^term port-build: /)}; ${lastLine(logA, /^term port-build --stage-check/)}`)

  if (a.signal) {
    stop(`A killed by ${a.signal} (memory?): ${logA}`)
  }

  const refusedByStage0 = stageOneRefusals(logA)

  if (refusedByStage0.length > 0 || !/step 2 \d+ same/.test(readFileSync(logA, 'utf8'))) {
    stop(`A: stage0 cannot build the source, ${refusedByStage0.length} refused (${refusedByStage0.slice(0, 2).join('; ')}), ${logA}`)
  }

  // the modules: every one port-build's step 2 reached, written or refused
  const written: string[] = []
  walk(checkScratch, written)
  const refusedA = stageTwoRefusals(logA)
  const sources = new Set<string>(refusedA.keys())

  for (const port of written) {
    const found = sourceOfPort(tree, port)

    if (found) {
      sources.add(found.source)
    }
  }

  const modules = [...sources].sort()
  writeFileSync(join(out, 'modules.txt'), `${modules.join('\n')}\n`)

  // THE COUNT: a verdict covers every module port-build's plan holds. A module neither manifest lists compares as
  // nothing, so without this an empty or a short scratch folder reads as identical (audit 0994)
  const planned = /^term port-build: (\d+) built, (\d+) unchanged, (\d+) failed/m.exec(readFileSync(logA, 'utf8'))
  const plan = planned ? Number(planned[1]) + Number(planned[2]) + Number(planned[3]) : 0

  if (modules.length === 0 || (only.length === 0 && modules.length !== plan)) {
    stop(`A: ${modules.length} modules reached step 2, and port-build's plan holds ${plan}: no verdict over part of the toolchain, ${logA}`)
  }

  // the ports stage0 wrote, and what the stage1 compiler wrote of each module or refused
  const takePorts = (stage: Stage): void => {
    for (const source of modules) {
      const port = portOf(source)
      const run = port.replace(/\.ts$/, '-run.ts')

      for (const one of [port, run]) {
        if (existsSync(join(tree, one))) {
          put(stage, one, join(tree, one))
        }
      }
    }
  }
  const takeScratch = (stage: Stage, refused: Map<string, string>, since: number): void => {
    const files: string[] = []
    walk(checkScratch, files)

    for (const file of files) {
      if (statSync(join(checkScratch, file)).mtimeMs >= since) {
        put(stage, file, join(checkScratch, file))
      }
    }

    for (const [source, why] of refused) {
      refuse(stage, portOf(source), why)
    }
  }

  takePorts(stages.stage1)
  takeScratch(stages.stage2, refusedA, 0)
  writeManifest(stages.stage1)
  writeManifest(stages.stage2)

  // the modules dealt round to `jobs` processes, each emitting its share by the compiler the copy holds now
  const rustOf = async (stage: Stage, label: string): Promise<void> => {
    const shares = Array.from({ length: jobs }, (_, job) => modules.filter((_, at) => at % jobs === job))
    const runs = shares.map(async (share, job) => {
      const list = join(out, `modules-${label}-${job + 1}.txt`)
      const log = join(logs, `${label}-rust-${job + 1}.log`)
      writeFileSync(list, `${share.join('\n')}\n`)
      const ran = await stepAsync(tree, log, ['task/term/fixpoint.ts', '--emit-rust', list, join(stage.dir, 'rust')])
      return { log, ran }
    })
    const ended = await Promise.all(runs)

    for (const { log, ran } of ended) {
      say(`${clock()} ${label} rust: ${lastLine(log, /^rust done/)}`)

      if (ran.signal || ran.status !== 0) {
        stop(`${label} rust emit ${ran.signal ? `killed by ${ran.signal} (memory?)` : `exit ${ran.status}`}: ${log}`)
      }
    }

    writeManifest(stage)
  }

  if (targets.includes('rust')) {
    await rustOf(stages.rust2, 'A')
  }

  // B: the stage1 compiler, bundled the way stage0 is, pinned in the copy
  const logB = join(logs, 'b-stage0-pin.log')
  const b = step(tree, logB, ['task/stage0.ts', 'pin'])
  const stage1Pin = JSON.parse(readFileSync(join(tree, 'task', 'stage0.json'), 'utf8')) as { id: string }
  say(`${clock()} B stage1 bundle ${stage1Pin.id} (exit ${b.status})`)

  // the same id as stage0 is a stage0 pinned from this very source: no failure
  if (b.status !== 0) {
    stop(`B: no stage1 bundle was pinned: ${logB}`)
  }

  // C: the stage1 bundle writes the ports, the stage2 compiler compiles every module again
  const logC = join(logs, 'c-port-build.log')
  const startC = Date.now()
  const c = launchStep(tree, logC, ['port-build', '--stage-check', ...only])
  say(`${clock()} C ${lastLine(logC, /^term port-build: /)}; ${lastLine(logC, /^term port-build --stage-check/)}`)

  if (c.signal) {
    stop(`C killed by ${c.signal} (memory?): ${logC}`)
  }

  const refusedByStage1 = stageOneRefusals(logC)

  if (refusedByStage1.length > 0 || !/step 2 \d+ same/.test(readFileSync(logC, 'utf8'))) {
    stop(`C: the stage1 bundle cannot build the source, ${refusedByStage1.length} refused (${refusedByStage1.slice(0, 2).join('; ')}), ${logC}`)
  }

  takePorts(stages.bundle)
  takeScratch(stages.stage3, stageTwoRefusals(logC), startC)
  writeManifest(stages.bundle)
  writeManifest(stages.stage3)

  if (targets.includes('rust')) {
    await rustOf(stages.rust3, 'C')
  }

  // the verdict
  const pairs: Pair[] = [
    ...(targets.includes('ts') ? [{ label: 'fixpoint', left: stages.stage2, right: stages.stage3, leftName: 'stage1', rightName: 'stage2' }] : []),
    ...(targets.includes('rust') ? [{ label: 'fixpoint', left: stages.rust2, right: stages.rust3, leftName: 'stage1', rightName: 'stage2' }] : []),
    { label: 'stage0-stage1', left: stages.stage1, right: stages.stage2, leftName: 'stage0', rightName: 'stage1' },
    { label: 'bundle', left: stages.stage2, right: stages.bundle, leftName: 'source', rightName: 'bundle' },
  ]
  let holds = true

  say(`term:fixpoint stage0 ${pin.id.slice(0, 12)}, stage1 bundle ${stage1Pin.id.slice(0, 12)}, ${modules.length} modules, out ${out}`)

  for (const pair of pairs) {
    const found = compare(pair, out)
    // a fixpoint pair covers every module step 2 reached: a module neither of its manifests lists (a Rust emit that
    // wrote nothing for it on both sides) compares as nothing, so a short pair is no verdict (audit 0994)
    const short = only.length === 0 && !found.missing && found.modules < modules.length

    if (pair.label === 'fixpoint' && (found.differ > 0 || found.missing || short)) {
      holds = false
    }

    if (short) {
      say(`${pair.label} ${found.target}: ${found.modules} modules compared, and step 2 reached ${modules.length}: no verdict over part of the toolchain`)
    }

    for (const line of report(found, pair)) {
      say(line)
    }
  }

  say(`manifests ${join(out, 'stage{1,2,2-bundle,3}', 'manifest-{ts,rust}.txt')}`)
  if (only.length > 0) {
    say(`--only ${only[1]}: a smoke run over part of the toolchain, never a verdict`)
  }

  say(`status: ${holds && only.length === 0 ? 'PASS' : 'FAIL'}`)
  process.exitCode = holds && only.length === 0 ? 0 : 1
}

// --compare <a> <b>: two stage folders, each target present in both
function compareMode(): void {
  const at = argv.indexOf('--compare')
  const one = argv[at + 1]
  const two = argv[at + 2]

  if (!one || !two) {
    usage('--compare takes two stage folders')
  }

  const left = resolve(CALLER_CWD, one)
  const right = resolve(CALLER_CWD, two)
  const out = resolve(CALLER_CWD, flag('--out') ?? dirname(left))
  const targets = (flag('--targets') ?? 'ts,rust').split(',')
  let differ = 0
  let compared = 0

  mkdirSync(out, { recursive: true })

  for (const target of targets) {
    const pair: Pair = { label: 'compare', left: { dir: left, target }, right: { dir: right, target }, leftName: 'left', rightName: 'right' }

    if (!existsSync(join(left, `manifest-${target}.txt`)) || !existsSync(join(right, `manifest-${target}.txt`))) {
      continue
    }

    const found = compare(pair, out)
    compared++
    differ += found.differ

    for (const line of report(found, pair)) {
      console.log(line)
    }
  }

  if (compared === 0) {
    usage(`no target has a manifest in both ${left} and ${right}`)
  }

  console.log(`status: ${differ === 0 ? 'PASS' : 'FAIL'}`)
  process.exitCode = differ === 0 ? 0 : 1
}

// no top-level await: task/term runs as CommonJS (task/term/package.json)
async function main(): Promise<void> {
  if (argv.includes('--emit-rust')) {
    const at = argv.indexOf('--emit-rust')
    await emitRust(resolve(argv[at + 1]!), resolve(argv[at + 2]!))
  } else if (argv.includes('--compare')) {
    compareMode()
  } else {
    await run()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error)
    process.exit(3)
  })
}
