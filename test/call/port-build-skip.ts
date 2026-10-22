// task/port-build.ts skips a module only when a compile would write what is already there (term-cli-in-term-0002).
// On a CLONE of the toolchain tree (APFS clones, so seconds and no space), never the tree itself:
//
//   steady: a second run with nothing changed skips every module and writes nothing
//   --check: still catches a port output edited by hand, and one that is missing
//   a stdlib file the ports read: every module whose trace read it compiles again, and the skip run writes exactly
//     what a --full run from the same state writes
//   a toolchain .tree body: the module compiles again and builds, byte-identical to --full
//   a compiler .ts file: nothing is skipped at all, byte-identical to --full
//
// Each edit's comparison starts both runs from the same state: the ports are put back between the skip run and the
// --full run, since a port the skip run rewrote is part of the compiler the --full run would load.
//
// Run: npx tsx test/call/port-build-skip.ts      (about 15 minutes: four full compiles of the 321 modules)
import { execFileSync } from 'node:child_process'
import { constants, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const TERM = join(import.meta.dirname, '..', '..')
// tsx's command, wherever the workspace hoisted it
const TSX = createRequire(import.meta.url).resolve('tsx/cli')

// the probes. A stdlib module the ports load, a toolchain module to change, a compiler file. A probe that is gone
// fails the test by name, so a move is caught rather than tested against nothing
const STDLIB_PROBE = 'deck/base/code/list.tree'
const PORT_PROBE = 'deck/test/code/bench-report.tree'
const COMPILER_PROBE = 'deck/make/code/compile/native.ts'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

// the build trees the clone leaves out: outputs other than the ports, and caches
const LEAVE = new Set(['node_modules', 'target', '.build', '.base', 'tmp', '.git'])

const copy = mkdtempSync(join(tmpdir(), 'term-port-build-skip-'))

function clone(): void {
  cpSync(join(TERM, 'deck'), join(copy, 'deck'), {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
    verbatimSymlinks: true,
    filter: source => {
      const name = source.split('/').pop()!

      if (LEAVE.has(name) || name.endsWith('-cache')) {
        return false
      }

      // of a `host/`, only `host/port/`: the ported modules the compiler is built from
      const at = relative(TERM, source).split('/')
      const host = at.indexOf('host')

      return host < 0 || at.length === host + 1 || at[host + 1] === 'port'
    },
  })

  for (const file of ['task/port-build.ts', 'task/port-trace.ts', 'package.json']) {
    cpSync(join(TERM, file), join(copy, file))
  }

  // the one path tsconfig.json writes relative to the package, outside it, made absolute for the clone
  const tsconfig = readFileSync(join(TERM, 'tsconfig.json'), 'utf8').replaceAll('"../../../../', `"${join(TERM, '../../../..')}/`)

  writeFileSync(join(copy, 'tsconfig.json'), tsconfig)
  symlinkSync(join(TERM, 'node_modules'), join(copy, 'node_modules'))
}

type Run = { code: number; built: number; unchanged: number; failed: number; skipped: Set<string>; out: string }

function run(...args: string[]): Run {
  let out = ''
  let code = 0

  try {
    out = execFileSync(process.execPath, [TSX, 'task/port-build.ts', '--explain', ...args], {
      cwd: copy,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; message?: string }
    code = failure.status ?? 1
    out = failure.stdout || `${failure.message}`
  }

  const summary = /term port-build: (\d+) built, (\d+) unchanged(?:, \d+ stale)?, (\d+) failed/.exec(out)
  const skipped = new Set([...out.matchAll(/^ {2}skip {2}(\S+)$/gm)].map(match => match[1]!))

  return {
    code,
    built: Number(summary?.[1] ?? -1),
    unchanged: Number(summary?.[2] ?? -1),
    failed: Number(summary?.[3] ?? -1),
    skipped,
    out,
  }
}

// every port output of the clone, path to content
function ports(): Map<string, string> {
  const found = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)

      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        found.set(relative(copy, full), readFileSync(full, 'utf8'))
      }
    }
  }

  for (const deck of readdirSync(join(copy, 'deck'))) {
    const port = join(copy, 'deck', deck, 'host', 'port')

    if (existsSync(port)) {
      walk(port)
    }
  }

  return found
}

function restore(snapshot: Map<string, string>): void {
  for (const [path, text] of snapshot) {
    writeFileSync(join(copy, path), text)
  }
}

function differences(a: Map<string, string>, b: Map<string, string>): string[] {
  const out: string[] = []

  for (const path of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(path) !== b.get(path)) {
      out.push(path)
    }
  }

  return out
}

// the modules whose recorded trace read a file, from the clone's manifest
function readers(file: string): Set<string> {
  const manifest = JSON.parse(readFileSync(join(copy, '.base', '@term', 'code', 'port-build.json'), 'utf8')) as {
    table: [string, string][]
    modules: Record<string, { reads: [number, number][] }>
  }
  const row = manifest.table.findIndex(([key]) => key === `read\0${join(copy, file)}`)
  const out = new Set<string>()

  for (const [name, entry] of Object.entries(manifest.modules)) {
    if (entry.reads.some(([from, to]) => row >= from && row < to)) {
      out.add(name)
    }
  }

  return out
}

// an edit, then a skip run and a --full run from the same state, compared byte for byte
function compare(label: string, edit: () => void): Run {
  edit()

  const before = ports()
  const skip = run()
  const skipped = ports()

  restore(before)

  const full = run('--full')
  const reference = ports()
  const diff = differences(skipped, reference)

  ok(`${label}: the skip run and the --full run write the same bytes`, diff.length === 0 && skip.failed === 0 && full.failed === 0, diff.slice(0, 5).join(' '))

  return skip
}

try {
  clone()

  for (const probe of [STDLIB_PROBE, PORT_PROBE, COMPILER_PROBE]) {
    ok(`probe ${probe} exists`, existsSync(join(copy, probe)))
  }

  // ---- cold, then steady ----

  const cold = run()
  ok('cold: every module compiles to the port already there', cold.built === 0 && cold.failed === 0 && cold.skipped.size === 0, cold.out.slice(-400))

  const total = cold.unchanged
  const started = Date.now()
  const steady = run()
  const seconds = (Date.now() - started) / 1000

  ok(`steady: all ${total} skipped, nothing built (${seconds.toFixed(1)}s)`, steady.built === 0 && steady.unchanged === total && steady.skipped.size === total, steady.out.slice(-400))

  // ---- --check: a hand-edited port, and a missing one ----

  const outputs = ports()
  const victim = [...outputs.keys()].find(path => path.includes(PORT_PROBE.replace(/^deck\/(\w+)\/(.*)\.tree$/, '$1/host/port/$2.ts')))!

  writeFileSync(join(copy, victim), `${outputs.get(victim)}// by hand\n`)
  const edited = run('--check')
  ok('--check: a port edited by hand is stale', edited.code === 1 && edited.out.includes(`STALE ${PORT_PROBE}`), edited.out.slice(-400))

  renameSync(join(copy, victim), join(copy, `${victim}.away`))
  const missing = run('--check')
  ok('--check: a missing port is stale', missing.code === 1 && missing.out.includes(`STALE ${PORT_PROBE}`), missing.out.slice(-400))
  renameSync(join(copy, `${victim}.away`), join(copy, victim))
  writeFileSync(join(copy, victim), outputs.get(victim)!)

  const clean = run('--check')
  ok('--check: put back, nothing stale', clean.code === 0, clean.out.slice(-400))

  // ---- a stdlib file the ports read ----

  const reading = readers(STDLIB_PROBE)
  ok(`stdlib: the manifest names the modules that read ${STDLIB_PROBE}`, reading.size > 0)

  const stdlib = compare('stdlib edit', () => {
    const file = join(copy, STDLIB_PROBE)

    writeFileSync(file, `${readFileSync(file, 'utf8')}\n# port-build-skip probe\n`)
  })
  const wrong = [...reading].filter(name => stdlib.skipped.has(name))
  ok('stdlib edit: no module that read it is skipped', wrong.length === 0, wrong.slice(0, 5).join(' '))

  // ---- a toolchain .tree body ----

  const port = compare('toolchain .tree edit', () => {
    const file = join(copy, PORT_PROBE)
    const text = readFileSync(file, 'utf8')
    // a text literal changed: the module's emitted TypeScript must change with it
    const changed = text.replace(/<([A-Za-z][^<>{}\\\n]*)>/, '<$1 probe>')

    ok('toolchain .tree edit: the probe holds a text literal to change', changed !== text)
    writeFileSync(file, changed)
  })
  ok('toolchain .tree edit: the module is not skipped, and builds', !port.skipped.has(PORT_PROBE) && port.built >= 1, port.out.slice(-400))

  // ---- a compiler .ts file ----

  const compiler = compare('compiler .ts edit', () => {
    const file = join(copy, COMPILER_PROBE)

    writeFileSync(file, `${readFileSync(file, 'utf8')}\n// port-build-skip probe\n`)
  })
  ok('compiler .ts edit: nothing is skipped', compiler.skipped.size === 0, `${compiler.skipped.size} skipped`)
} finally {
  if (fail === 0) {
    rmSync(copy, { recursive: true, force: true })
  } else {
    console.log(`the clone is kept for a look: ${copy}`)
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail > 0 ? 1 : 0
