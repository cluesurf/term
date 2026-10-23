// task/port-build.ts never writes a port compiled from a source that has changed since (term-cli-in-term-0151).
//
// The race it reproduces, the one that fed three builders' checks stale code on 2026-10-23 (cli-in-term traps.md,
// items 0075, 0101, 0077): a build A compiles a module from its text, a builder edits that text, a build B writes the
// new text's port and says `built`, and A then writes the OLD text's port over it, with no error anywhere. On a CLONE
// of the toolchain tree (APFS clones, so seconds), where no line lock is taken, so the two builds overlap the way
// they did when they slipped past it:
//
//   A runs with TERM_PORT_BUILD_HOLD, which stops it after its compile and before its write-time check
//   the probe's source is edited, and B builds it to completion: B's port holds the edit
//   A goes on: it must see the source changed, compile it again, and leave B's port (the edit) in place
//   `--verify` then passes, and fails once the source is edited again with no build
//
//   npx tsx test/call/port-race.ts          (about a minute: three one-module builds on the clone)
//
// PORT_RACE_SCRIPT=<abs path to a port-build.ts> runs the same race against another copy of the script (the proof
// ran the one before this fix, with the hold added by hand, and it failed `A leaves B's port`).
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, constants, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { tempDir } from '../temp'

const TERM = join(import.meta.dirname, '..', '..')
const TSX = createRequire(import.meta.url).resolve('tsx/cli')
const SCRIPT = process.env.PORT_RACE_SCRIPT ?? join(TERM, 'task', 'port-build.ts')

// a toolchain module with a text literal to change, and its port
const PROBE = 'deck/test/code/bench-report.tree'
const PORT = 'deck/test/host/port/code/bench-report.ts'
const ONLY = 'deck/test/code/bench-report'
// a second module whose compile reads a file the probe's compile reads too (term-cli-in-term-0158)
const OTHER = 'deck/test/code/seeded-random'
const SHARED = 'deck/base/code/list.tree'

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

// the clone port-build-skip.ts makes: the package's deck/ without caches and outputs other than the ports
const LEAVE = new Set(['node_modules', 'target', '.build', '.base', 'tmp', '.git'])
const copy = realpathSync(tempDir('term-port-race-'))

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

      const at = relative(TERM, source).split('/')
      const host = at.indexOf('host')

      return host < 0 || at.length === host + 1 || at[host + 1] === 'port'
    },
  })

  mkdirSync(join(copy, 'task'))
  cpSync(SCRIPT, join(copy, 'task', 'port-build.ts'))

  for (const file of ['task/port-trace.ts', 'package.json']) {
    cpSync(join(TERM, file), join(copy, file))
  }

  const tsconfig = readFileSync(join(TERM, 'tsconfig.json'), 'utf8').replaceAll('"../../../../', `"${join(TERM, '../../../..')}/`)

  writeFileSync(join(copy, 'tsconfig.json'), tsconfig)
  symlinkSync(join(TERM, 'node_modules'), join(copy, 'node_modules'))
}

type Run = { code: number; out: string }

function build(...args: string[]): Run {
  try {
    return { code: 0, out: execFileSync(process.execPath, [TSX, 'task/port-build.ts', ...args], { cwd: copy, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }) }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string }
    return { code: failure.status ?? 1, out: failure.stdout ?? '' }
  }
}

function until(test: () => boolean, seconds: number): Promise<boolean> {
  const end = Date.now() + seconds * 1000

  return new Promise(done => {
    const look = (): void => {
      if (test()) {
        done(true)
      } else if (Date.now() > end) {
        done(false)
      } else {
        setTimeout(look, 100)
      }
    }

    look()
  })
}

// a text literal of the probe changed to hold `mark`: the module's emitted TypeScript must hold it too
function edit(mark: string): void {
  const file = join(copy, PROBE)
  const text = readFileSync(file, 'utf8')
  const changed = text.replace(/<([A-Za-z][^<>{}\\\n]*)>/, `<$1 ${mark}>`)

  ok(`the probe holds a text literal to change (${mark})`, changed !== text)
  writeFileSync(file, changed)
}

const port = (): string => readFileSync(join(copy, PORT), 'utf8')

try {
  clone()
  ok(`probe ${PROBE} and its port exist`, existsSync(join(copy, PROBE)) && existsSync(join(copy, PORT)))

  const hold = join(copy, 'hold')
  mkdirSync(hold)

  // ---- A: compiles the probe's text as it is, then stops before its write-time check ----

  let aOut = ''
  const a = spawn(process.execPath, [TSX, 'task/port-build.ts', '--only', ONLY], {
    cwd: copy,
    env: { ...process.env, TERM_PORT_BUILD_HOLD: hold },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const aExit = new Promise<number>(done => a.on('exit', code => done(code ?? 1)))

  a.stdout!.on('data', (chunk: Buffer) => {
    aOut += chunk.toString('utf8')
  })

  const held = await until(() => existsSync(join(hold, 'held')), 600)
  ok('A compiled the probe and holds before its write', held && readFileSync(join(hold, 'held'), 'utf8') === PROBE)

  // ---- the edit, and B: a whole build of the new text while A holds ----

  edit('race-new')

  const b = build('--only', ONLY)
  ok('B builds the edited probe', b.code === 0 && b.out.includes(`built ${PORT}`) && port().includes('race-new'), b.out.slice(-400))

  // ---- A goes on ----

  writeFileSync(join(hold, 'go'), '')
  const aCode = await aExit

  ok("A leaves B's port: the port still holds the edit", port().includes('race-new'), aOut.slice(-400))
  ok('A saw the source change and compiled it again', aOut.includes(`again ${PROBE}`), aOut.slice(-400))
  ok('A ends clean', aCode === 0, aOut.slice(-400))

  // ---- --verify ----

  const current = build('--verify', ONLY)
  ok('--verify: the probe is current', current.code === 0 && current.out.includes('1 current, 0 stale'), current.out.slice(-400))

  edit('race-later')

  const later = build('--verify', ONLY)
  ok('--verify: an edit with no build after it is stale', later.code === 1 && later.out.includes(`STALE ${PROBE}  (its source changed after its port was built)`), later.out.slice(-400))

  const nothing = build('--verify', 'no/such/module')
  ok('--verify: a path text that names no module fails', nothing.code === 1, nothing.out.slice(-400))

  // ---- a later build keeps the probe's row (term-cli-in-term-0158) ----
  //
  // Each manifest entry is keyed by every observation its build made, and a build that wrote the manifest DROPPED an
  // old entry when any one of those disagreed with what it saw itself (a file edited since, by anyone). The probe's
  // port was still its source's last build, so `--verify` said 'no build has recorded it' until the probe was built
  // again, which said `unchanged`. Seen 2026-10-23: three preprocess ports, then the live manifest held 6 modules of 321

  const rebuilt = build('--only', ONLY)
  ok('the probe is built from its edited source', rebuilt.code === 0 && rebuilt.out.includes(`built ${PORT}`), rebuilt.out.slice(-400))

  const before = port()

  // a file the compiles of the probe and of a second module both read, changed in a byte no port holds
  appendFileSync(join(copy, SHARED), '\n')

  const other = build('--only', OTHER)
  ok('a second module builds after the shared file changed', other.code === 0, other.out.slice(-400))

  const kept = build('--verify', ONLY)
  ok("--verify: the probe is current after another module's build disagreed with its reads", kept.code === 0 && kept.out.includes('1 current, 0 stale'), kept.out.slice(-400))

  const same = build('--only', ONLY, '--explain')
  ok('and it was: the probe compiles again (its reads moved, so it is not skipped) and writes nothing', same.code === 0 && same.out.includes('0 built, 1 unchanged') && !same.out.includes(`skip  ${PROBE}`) && port() === before, same.out.slice(-400))

  // ---- a build that fails keeps the port's row, and says so (never falsely current) ----

  const shared = readFileSync(join(copy, SHARED), 'utf8')
  writeFileSync(join(copy, SHARED), `${shared}\nhost broken-0158, <unclosed\n`)

  const broken = build('--only', ONLY)
  ok('the probe fails to build over a broken dependency', broken.code === 1 && broken.out.includes(`FAIL  ${PROBE}`), broken.out.slice(-400))

  const failed = build('--verify', ONLY)
  ok('--verify: a port whose last build failed is not current', failed.code === 1 && failed.out.includes(`STALE ${PROBE}  (its last build failed`), failed.out.slice(-400))

  writeFileSync(join(copy, SHARED), shared)

  const mended = build('--only', ONLY)
  ok('the probe builds again once the dependency is mended', mended.code === 0 && mended.out.includes('1 unchanged'), mended.out.slice(-400))
  ok('--verify: current again', build('--verify', ONLY).out.includes('1 current, 0 stale'))

  // ---- --verify while a build of the probe is held mid-run, and after it ----

  appendFileSync(join(copy, SHARED), '\n')

  const hold2 = join(copy, 'hold2')
  mkdirSync(hold2)

  let cOut = ''
  const c = spawn(process.execPath, [TSX, 'task/port-build.ts', '--only', ONLY], {
    cwd: copy,
    env: { ...process.env, TERM_PORT_BUILD_HOLD: hold2 },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const cExit = new Promise<number>(done => c.on('exit', code => done(code ?? 1)))

  c.stdout!.on('data', (chunk: Buffer) => {
    cOut += chunk.toString('utf8')
  })

  ok('a build of the probe holds mid-run', await until(() => existsSync(join(hold2, 'held')), 600))

  const during = build('--verify', ONLY)
  ok('--verify during that build: current', during.code === 0 && during.out.includes('1 current, 0 stale'), during.out.slice(-400))

  writeFileSync(join(hold2, 'go'), '')
  ok('the held build ends clean', (await cExit) === 0, cOut.slice(-400))

  const after = build('--verify', ONLY)
  ok('--verify after it: current', after.code === 0 && after.out.includes('1 current, 0 stale'), after.out.slice(-400))
} finally {
  if (fail === 0) {
    rmSync(copy, { recursive: true, force: true })
  } else {
    console.log(`the clone is kept for a look: ${copy}`)
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail > 0 ? 1 : 0
