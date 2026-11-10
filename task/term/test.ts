// Every Term gate, in one command. Run from the repository root:
//
//   pnpm term:test                 every suite
//   pnpm term:test --only host     the suites whose name holds "host"
//   pnpm term:test --list          the suites, without running them
//   pnpm term:test --skip x,y      leave out the suites whose name holds "x" or "y"
//   pnpm term:test --jobs 4        how many suites run at once (default: the cores minus one, at most eight)
//   pnpm term:test --full          also the checks a suite keeps behind a flag because they take minutes (CAD_FULL)
//   pnpm term:test --keep          keep each suite's temporary folder and print its path (debugging only)
//   pnpm term:test --temp-strict   fail a suite that leaves anything in its temporary folder
//   pnpm term:test --quick [s]     only the suites that last took under s seconds (default 30): about 200 of 240,
//                                  two minutes at eight jobs. The long poles (cargo builds, the package builds, the
//                                  format sweep over every file, the native roundtrips) are named, with their time,
//                                  as LEFT OUT, never passed. Iterate on --quick; run the whole gate before done
//
// Each suite is a script under test that prints its own `<name>: N pass, M fail` line and exits
// non-zero on a failure; this runs each from the package root (the repository root's vitest runs database tests that
// refuse), reads that line, and prints one line per suite. Suites run CONCURRENTLY, longest first, so the wall clock
// is the longest suite (the native roundtrip, about four minutes) and not the sum of all of them (ten). A suite that needs a toolchain (cargo, swiftc, kotlinc) is
// skipped with the reason when the toolchain is absent, never failed. The stdlib closure is compiled through a probe
// package this script links in a temporary directory, so the gate depends on nothing outside the repository. The
// exit code is non-zero when any suite fails, and the baseline of every count lives in
// note/project/term/term-gates/readme.md. See note/project/term/term-gates/readme.md.
//
// TEMPORARY FOLDERS (term-cli-in-term-0177). Each suite runs with TMPDIR pointed at a scratch folder of its own
// (task/term/temp-run.ts), removed when the suite ends, so nothing a suite makes there outlives it. What a suite left in
// it is named at the end of the run (`LEFT temporary folders`), and fails the suite under `--temp-strict`: a test
// removes what it makes (test/temp.ts `tempDir`). And the run as a whole FAILS when the machine's own temporary folder
// holds a new mkdtemp-shaped entry at the end that it did not hold at the start, which is a temporary folder some suite
// made outside its TMPDIR. Leaked folders filled the laptop's disk on 2026-10-23 (123 GB). Another session making temporary
// folders at the same time can trip the second check: the names are printed, and a rerun tells the two apart.

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { holdDevice } from '../../test/compile/shared/device-hold'
import { makeCache } from './gate/cache'
import { compileLegs } from './gate/compile-packages'
import { SYSTEM_TEMP, leftIn, madeEntries, madeSince, makeScratch, removeOwnRuns, removeTree, scratchEnv, sweepStaleRuns } from './temp-run'
import { PARENT_ROOT, TERM_ROOT } from './root'

// run from the repository root (`pnpm term:test`); the package root is fixed relative to it
const ROOT = TERM_ROOT
const TERM = TERM_ROOT

// the CLI under test: TERM_LINE names another bundle (host/term-line.js before the switch, decision 013 of
// note/project/term/cli-in-term), made absolute here so every suite, whatever its folder, reads the same file through
// test/call/cli.ts. Unset, the built CLI of this checkout
if (process.env.TERM_LINE) process.env.TERM_LINE = resolve(process.env.TERM_LINE)
const LINE = process.env.TERM_LINE ?? join(TERM, 'host/line.js')

if (!existsSync(join(TERM, 'deck/make/code/compile/compile.ts'))) {
  console.log(`run this from the repository root: ${TERM} is not the Term package`)
  process.exit(1)
}

type Suite = {
  name: string
  // the script, relative to the package root; or a custom runner, handed the environment its processes must carry
  // (the input tracker's, see task/term/gate/cache.ts)
  file?: string
  run?: (env: Record<string, string>) => Result | Promise<Result>
  // false for a suite whose answer depends on something outside the files it reads (a live database, a remote box,
  // vitest's own worker pool that loads tests where the tracker cannot see): it runs every time
  cache?: boolean
  // seconds the suite is expected to take, so the long ones start first and the pool's tail is short
  slow?: number
  // environment for the suite's process (a leg of a suite that splits itself by toolchain)
  env?: Record<string, string>
  // toolchains the suite needs to do anything; absent means it is skipped
  needs?: string[]
  // environment variables the suite needs (a live database); unset means it is skipped
  needsEnv?: string[]
  // seconds before the suite is killed and reported as failed
  timeout?: number
  // a device the suite drives and must have to itself: two suites holding the same one never run at once. Two suites on
  // one emulator clear each other's log (`adb logcat -c`) and read nothing back. `pasteboard` is the Mac's own: each
  // suite that writes it keeps the person's text and puts it back on exit, so two at once overwrite each other's token
  // between the write and the `pbpaste` that reads it back
  holds?: 'emulator' | 'simulator' | 'pasteboard'
}

type Result = { ok: boolean; pass: number; fail: number; note: string; skipped?: string }

function have(tool: string): boolean {
  try {
    execFileSync('which', [tool], { stdio: 'ignore' })

    return true
  } catch {
    return false
  }
}

// the suite's own summary line: `<name>: N pass, M fail` (or `N pass, M fail, K skipped`)
function summary(output: string): { pass: number; fail: number } | undefined {
  const lines = output.split('\n').reverse()

  for (const line of lines) {
    const found = /(\d+) pass(?:ed)?(?:, (\d+) fail(?:ed)?)?/.exec(line)

    if (found) {
      return { pass: Number(found[1]), fail: Number(found[2] ?? 0) }
    }

    const passed = /(\d+) tests? passed/.exec(line)

    if (passed) {
      return { pass: Number(passed[1]), fail: 0 }
    }
  }

  return undefined
}

// how long a suite's pipes may stay open after the suite itself has exited, for its last output to drain
const DRAIN_SECONDS = 5

// the process groups of the suites running now. Each suite has its own group (`child`), so the terminal's ctrl-c no
// longer reaches it: the runner passes it on, and kills every group still running when it leaves
const groups = new Set<number>()

// the scratch folders of the suites running now, removed on the way out whatever ends the run
const scratches = new Set<string>()

// `--keep`: each suite's scratch folder stays, and its path is printed
const keepTemp = process.argv.includes('--keep')
// `--temp-strict`: a suite that leaves anything in its scratch folder fails
const tempStrict = process.argv.includes('--temp-strict')
// the suites that left something in their scratch folder (removed with it), named at the end of the run
const leftBehind: string[] = []

function killGroups(): void {
  for (const group of groups) {
    try {
      process.kill(-group, 'SIGKILL')
    } catch {
      // already gone
    }
  }

  if (!keepTemp) {
    for (const dir of scratches) {
      removeTree(dir)
    }
  }
}

process.on('exit', killGroups)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    killGroups()
    process.exit(130)
  })
}

// a child process, awaited: its output, exit status and signal, killed after `timeout` seconds.
//
// THE RUN ENDS WHEN THE SUITE EXITS, NOT WHEN ITS PIPES CLOSE. `close` waits for every holder of stdout and stderr, and
// a daemon a suite starts (an `adb` server, a Gradle or Kotlin daemon) inherits both and outlives it. Waiting on
// `close` alone held the whole run for over half an hour on 2026-10-06 with no suite running and an emulator suite's
// device lock never let go, so every emulator suite after it waited forever. The suite runs in its own process group,
// so a timeout kills what it started as well as the suite
function child(command: string, argv: string[], cwd: string, timeout: number, env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; status: number | null; signal: string | null; killed: boolean }> {
  return new Promise(resolve => {
    // TERM_NATIVE_ITERM opts a suite into opening real iTerm2 windows (test/compile/find-native.ts). The gate never
    // passes it on, even from the caller's shell: the user stopped those windows appearing mid-work (2026-10-13)
    const { TERM_NATIVE_ITERM: _iterm, ...inherited } = process.env
    const run = spawn(command, argv, { cwd, env: { ...inherited, INIT_CWD: cwd, ...env }, detached: true })

    if (run.pid !== undefined) {
      groups.add(run.pid)
    }

    let stdout = ''
    let stderr = ''
    let killed = false
    let done = false
    let drain: ReturnType<typeof setTimeout> | undefined
    const finish = (result: { stdout: string; stderr: string; status: number | null; signal: string | null; killed: boolean }): void => {
      if (done) {
        return
      }

      done = true

      if (run.pid !== undefined) {
        groups.delete(run.pid)
      }

      clearTimeout(timer)
      clearTimeout(drain)
      run.stdout.destroy()
      run.stderr.destroy()
      resolve(result)
    }
    const timer = setTimeout(() => {
      killed = true

      try {
        // the group: the suite and everything it started
        process.kill(-run.pid!, 'SIGKILL')
      } catch {
        run.kill('SIGKILL')
      }
    }, timeout * 1000)

    run.stdout.on('data', chunk => { stdout += String(chunk) })
    run.stderr.on('data', chunk => { stderr += String(chunk) })
    // a process that could not start (ENOENT, EACCES) never closes: report it as a failed run rather than hang
    run.on('error', error => {
      finish({ stdout, stderr: `${stderr}\n${String(error)}`, status: null, signal: null, killed: false })
    })
    // exited: give the pipes a moment to drain, then end whether or not a daemon still holds them
    run.on('exit', (status, signal) => {
      drain = setTimeout(() => finish({ stdout, stderr, status, signal, killed }), DRAIN_SECONDS * 1000)
    })
    run.on('close', (status, signal) => {
      finish({ stdout, stderr, status, signal, killed })
    })
  })
}

// why a suite that printed no FAIL line failed: its last error lines, else its last lines at all. A suite that reports
// in its own words (`cask  device answers wrong: ...`) otherwise failed with no reason on the gate line
function failureTail(output: string): string {
  const lines = output.split('\n').filter(line => line.trim() !== '')
  const errors = lines.filter(line => /error|Error/.test(line))
  return (errors.length > 0 ? errors : lines).slice(-2).join(' | ').slice(0, 200)
}

async function script(file: string, timeout = 600, env: Record<string, string> = {}): Promise<Result> {
  const run = await child('npx', ['tsx', file], TERM, timeout, env)
  const output = `${run.stdout}\n${run.stderr}`
  const counts = summary(output)
  const failLines = output
    .split('\n')
    .filter(line => /^FAIL\b/.test(line))
    .slice(0, 3)
    .map(line => line.slice(0, 160))
  const note =
    run.killed || (run.signal && run.status === null)
      ? `killed after ${timeout}s`
      : failLines.length
        ? failLines.join(' | ')
        : run.status !== 0
          ? failureTail(output)
          : ''

  // a clean exit that passed nothing and said `skip` (no Android device online, say) skipped: it is not a pass
  const skipLine = output.split('\n').find(line => /^skip\s/.test(line))
  const skipped = run.status === 0 && !run.signal && !counts?.pass && !counts?.fail && skipLine ? skipLine.replace(/^skip\s+/, '').trim().slice(0, 160) : undefined

  return {
    ok: run.status === 0 && (counts?.fail ?? 0) === 0 && !run.signal,
    pass: counts?.pass ?? 0,
    fail: counts?.fail ?? (run.status === 0 ? 0 : 1),
    note,
    skipped,
  }
}

// vitest from the package root
async function vitest(env: Record<string, string> = {}): Promise<Result> {
  // a minute per test: the pool runs vitest beside the native compiles, and a registry round trip over a local
  // server that takes a second alone can take ten there
  const run = await child('npx', ['vitest', 'run', '--testTimeout=60000'], TERM, 900, env)
  const output = `${run.stdout}\n${run.stderr}`
  const tests = /Tests\s+(\d+) passed/.exec(output)
  const failed = /Tests\s+(?:\d+ failed)/.exec(output) ? Number(/(\d+) failed/.exec(output)?.[1] ?? 1) : 0

  return { ok: run.status === 0 && failed === 0, pass: Number(tests?.[1] ?? 0), fail: failed, note: run.status === 0 ? '' : output.split('\n').filter(l => /FAIL|Error/.test(l)).slice(0, 3).join(' | ') }
}

// does the renderer compile natively (native-dom-0002): task/term/native-render.sh emits view/reactive, view/render
// and the in-memory dom for swift and kotlin and compiles each. A module that compiles is a pass
async function nativeRender(env: Record<string, string> = {}): Promise<Result> {
  const run = await child('sh', [join(ROOT, 'task/term/native-render.sh')], ROOT, 900, env)
  const output = `${run.stdout}\n${run.stderr}`
  const pass = output.split('\n').filter(l => /^swiftc .*: 0 errors$|^kotlinc .*: compiles$/.test(l)).length
  const failed = output.split('\n').filter(l => /^swiftc .*: [1-9]\d* errors$|^kotlinc .*: FAILS/.test(l))

  return {
    ok: run.status === 0 && failed.length === 0,
    pass,
    fail: failed.length + (run.status === 0 || failed.length > 0 ? 0 : 1),
    note: failed.slice(0, 3).join(' | '),
  }
}

// which `term` verbs have a test. task/term/cli-coverage.ts carries the baseline of the ones with none, and
// fails if a verb outside it loses coverage or one on it gains some.
async function cliCoverage(env: Record<string, string> = {}): Promise<Result> {
  const run = await child('npx', ['tsx', join(ROOT, 'task/term/cli-coverage.ts')], ROOT, 300, env)
  const output = `${run.stdout}\n${run.stderr}`
  const found = /term cli-coverage: (\d+) verbs, (\d+) with a test, (\d+) without/.exec(output)

  return {
    ok: run.status === 0,
    pass: Number(found?.[2] ?? 0),
    fail: run.status === 0 ? 0 : 1,
    note: run.status === 0
      ? `${found?.[3] ?? '?'} of ${found?.[1] ?? '?'} verbs have no test (see task/term/cli-coverage.ts)`
      : output.split('\n').filter(l => /^(LOST|GAINED)/.test(l)).slice(0, 3).join(' | '),
  }
}

// is anything reading `.tree` syntax with a regex instead of the parser? There is ONE parser for `.tree`
// (note/project/term/one-parser.md), and the rule was broken inside the compiler itself: an import scan counted the angles
// on comment lines, so one bare `<` in a sentence made a file's `load` directives vanish. task/term/one-parser.ts
// carries the baseline of the marker probes and editor affordances that are allowed, with the reason for each.
async function oneParser(env: Record<string, string> = {}): Promise<Result> {
  const run = await child('npx', ['tsx', join(ROOT, 'task/term/one-parser.ts')], ROOT, 300, env)
  const output = `${run.stdout}\n${run.stderr}`
  const found = /term one-parser: (\d+) files match, (\d+) allowed with a reason, (\d+) unexplained/.exec(output)

  return {
    ok: run.status === 0,
    pass: Number(found?.[2] ?? 0),
    fail: run.status === 0 ? 0 : 1,
    note: run.status === 0
      ? `${found?.[2] ?? '?'} allowed with a reason, 0 unexplained`
      : output.split('\n').filter(l => /^(NEW|GONE)/.test(l)).slice(0, 3).join(' | '),
  }
}

// every Term package built with `term make`. The suites cannot catch a package that does not compile at all,
// because a package with no working build has no suite to fail. task/term/build-all.ts carries the baseline of
// which packages are known broken, and fails if one outside that list breaks or one on it starts working.
// One package at a time (`--only`), so each is its own suite in the pool.
function buildAll(pack: string): (env: Record<string, string>) => Promise<Result> {
  return async (env = {}) => {
    const run = await child('npx', ['tsx', join(ROOT, 'task/term/build-all.ts'), '--only', pack], ROOT, 3600, env)
    const output = `${run.stdout}\n${run.stderr}`
    const found = /term build-all: (\d+) build, (\d+) known broken, (\d+) newly broken, (\d+) newly fixed/.exec(output)
    const broke = Number(found?.[3] ?? 0) + Number(found?.[4] ?? 0)
    const skippedLine = output.split('\n').find(l => /^skip\s/.test(l))

    return {
      ok: run.status === 0 && broke === 0,
      pass: Number(found?.[1] ?? 0),
      fail: broke || (run.status === 0 ? 0 : 1),
      note: broke
        ? output.split('\n').filter(l => /^(BROKE|FIXED)/.test(l)).slice(0, 3).join(' | ')
        : skippedLine?.trim() ?? (output.split('\n').find(l => /^(ok|known)\s/.test(l)) ?? '').trim().slice(0, 160),
    }
  }
}

// the packages build-all walks: every directory under deck/ with a deck.tree (build-all.ts skips `mill` itself)
function buildAllPackages(): string[] {
  return readdirSync(join(TERM, 'deck'))
    .filter(name => existsSync(join(TERM, 'deck', name, 'deck.tree')))
    .sort()
}

// the stdlib closure: a probe package linking @term/base and @term/host, compiled whole with the built CLI
async function closure(env: Record<string, string> = {}): Promise<Result> {
  const line = LINE

  if (!existsSync(line)) {
    return { ok: false, pass: 0, fail: 1, note: 'host/line.js is not built (see deck/term/CLAUDE.md)' }
  }

  // in the suite's scratch folder (runOne), removed with it
  const probe = mkdtempSync(join(env.TMPDIR ?? tmpdir(), 'term-probe-'))
  mkdirSync(join(probe, 'link/@term'), { recursive: true })
  mkdirSync(join(probe, 'code'), { recursive: true })
  symlinkSync(join(TERM, 'deck/base'), join(probe, 'link/@term/base'))
  symlinkSync(join(TERM, 'deck/host'), join(probe, 'link/@term/host'))
  writeFileSync(join(probe, 'deck.tree'), 'deck @probe/closure\n  code <0.0.0>\n')
  writeFileSync(
    join(probe, 'code/base.tree'),
    'load @term/base/code/hive\n  find hive-wake\n\nload @term/host/code/base\n  find read\n\ntask probe\n  like number\n  send back, code 1\n',
  )

  const run = await child('node', [line, 'make'], probe, 900, env).finally(() => removeTree(probe))
  const output = `${run.stdout}\n${run.stderr}`
  const compiled = /Compiled (\d+) files/.exec(output)
  const failed = /(\d+) failed/.exec(output)

  return {
    ok: run.status === 0 && !failed,
    pass: Number(compiled?.[1] ?? 0),
    fail: Number(failed?.[1] ?? (run.status === 0 ? 0 : 1)),
    note: failed ? output.split('\n').filter(l => /: /.test(l) && /tree/.test(l)).slice(0, 3).join(' | ') : '',
  }
}

// the emitted stdlib typechecks (compiler-hygiene-0012): a fresh probe build (the closure's shape), then tsc
// over every emitted module. The instrument is the repository root's tsc, pinned by the lockfile.
async function emitTypes(env: Record<string, string> = {}): Promise<Result> {
  const line = LINE

  if (!existsSync(line)) {
    return { ok: false, pass: 0, fail: 1, note: 'host/line.js is not built (see deck/term/CLAUDE.md)' }
  }

  const probe = mkdtempSync(join(env.TMPDIR ?? tmpdir(), 'term-emit-'))
  mkdirSync(join(probe, 'link/@term'), { recursive: true })
  mkdirSync(join(probe, 'code'), { recursive: true })
  symlinkSync(join(TERM, 'deck/base'), join(probe, 'link/@term/base'))
  symlinkSync(join(TERM, 'deck/host'), join(probe, 'link/@term/host'))
  writeFileSync(join(probe, 'deck.tree'), 'deck @probe/emit\n  code <0.0.0>\n')
  writeFileSync(
    join(probe, 'code/base.tree'),
    'load @term/base/code/hive\n  find hive-wake\n\nload @term/host/code/base\n  find read\n\ntask probe\n  like number\n  send back, code 1\n',
  )

  const built = await child('node', [line, 'make'], probe, 600, env)

  if (built.status !== 0 || /failed/.test(`${built.stdout}${built.stderr}`)) {
    removeTree(probe)

    return { ok: false, pass: 0, fail: 1, note: `probe build failed: ${`${built.stdout}${built.stderr}`.split('\n').filter(l => /: /.test(l)).slice(0, 2).join(' | ')}` }
  }

  const run = await child('npx', ['tsx', 'task/term/check-emitted-types.ts', join(probe, 'host')], ROOT, 600, env).finally(() => removeTree(probe))
  const output = `${run.stdout}\n${run.stderr}`
  const counts = /(\d+) error\(s\) in total/.exec(output)
  const modules = /(\d+) emitted modules/.exec(output)

  return {
    ok: run.status === 0,
    pass: Number(modules?.[1] ?? 0),
    fail: Number(counts?.[1] ?? (run.status === 0 ? 0 : 1)),
    note: run.status === 0 ? '' : output.split('\n').filter(l => /error TS/.test(l)).slice(0, 3).join(' | ').slice(0, 300),
  }
}

// a package's own Term tests through the CLI
// a package's own `.tree` tests, run in the package's directory. `dir` defaults to its place in the Term tree; zone
// passes its own, because it moved out to the repository's deck/zone on 2026-10-02
function packageTests(pack: string, dir = join(TERM, 'deck', pack)): (env: Record<string, string>) => Promise<Result> {
  return async (env = {}) => {
    const run = await child('node', [LINE, 'test'], dir, 900, env)
    const output = `${run.stdout}\n${run.stderr}`
    const passed = /(\d+) tests? passed/.exec(output)
    const failed = /(\d+) failed/.exec(output)

    return {
      ok: run.status === 0 && !failed,
      pass: Number(passed?.[1] ?? 0),
      fail: Number(failed?.[1] ?? (run.status === 0 ? 0 : 1)),
      note: failed ? output.split('\n').filter(l => /✗/.test(l)).slice(0, 3).join(' | ') : '',
    }
  }
}

// every script under a test directory, each its own suite
function each(dir: string, prefix: string, skip: string[] = []): Suite[] {
  return readdirSync(join(TERM, 'test', dir))
    .filter(name => name.endsWith('.ts') && !skip.includes(name))
    .sort()
    .map(name => ({ name: `${prefix}/${name.replace(/\.ts$/, '')}`, file: `test/${dir}/${name}` }))
}

// the self-contained gate (decision 004 of note/project/term): no absolute path, no climb out of the root, parent names
// no higher than the baseline. Plain node strips the types. Skipped until task/term/self-contained.ts exists
async function selfContained(env: Record<string, string> = {}): Promise<Result> {
  if (!existsSync(join(TERM, 'task/term/self-contained.ts'))) {
    return { ok: true, pass: 0, fail: 0, note: '', skipped: 'task/term/self-contained.ts is not landed' }
  }

  const run = await child('node', ['--experimental-strip-types', '--no-warnings', 'task/term/self-contained.ts'], TERM, 600, env)
  const output = `${run.stdout}\n${run.stderr}`
  const leaks = output.split('\n').filter(line => line.trim() !== '')

  return {
    ok: run.status === 0,
    pass: run.status === 0 ? 1 : 0,
    fail: run.status === 0 ? 0 : 1,
    note: run.status === 0 ? '' : leaks.slice(-3).join(' | ').slice(0, 200),
  }
}

const SUITES: Suite[] = [
  { name: 'self-contained', run: selfContained, cache: false, slow: 10, timeout: 600 },
  // the release payload installed into a temporary HOME and run as a person runs it, from a project outside this
  // checkout: make, test, boot from another folder, a local link, and no machine path in what it writes (zone-0144).
  // It reads the payload, which no tracked input names, so it runs every time
  { name: 'release-user', file: 'task/term/release-user.ts', cache: false, slow: 180, timeout: 1800 },
  // the front of the compiler, cheapest first
  { name: 'parser', file: 'test/parser/run.ts' },
  // the fixture files ported from the original tree implementation, which this repo had never carried
  { name: 'parser-fixture', file: 'test/parser/fixture.ts' },
  // the raw text literal `<<...>>`: its value, its refusal when left open, and what every printer writes back
  { name: 'parser-raw-text', file: 'test/parser/raw-text.ts' },
  // a whole number in braces in a text literal is its value, `<{123}>`, and a quantifier or JSON stays text
  { name: 'parser-brace-number', file: 'test/parser/brace-number.ts' },
  // a span names the physical line after a text literal that spans lines, and so does a compiler error there
  { name: 'parser-span-lines', file: 'test/parser/span-lines.ts' },
  // the streaming reader and the whole-file reader produce the identical tree, on every .tree in the repository
  { name: 'parser-stream', file: 'test/parser/stream.ts', slow: 20, timeout: 600 },
  // 343 MB of generated source through a 32 MB heap. Needs the small cap and --expose-gc to mean anything.
  { name: 'parser-stream-memory', file: 'test/parser/stream-memory.ts', slow: 60, timeout: 1500, env: { NODE_OPTIONS: '--expose-gc --max-old-space-size=32' } },
  { name: 'parser-robust', file: 'test/parser/robust.ts', slow: 25, timeout: 900 },
  // every .tree file in the repository through the formatter, about 21,800 checks: 879s under a full concurrent run on
  // 2026-10-06, and killed at a 900s limit on the next, with nothing failed
  { name: 'format-sweep', file: 'test/format/sweep.ts', slow: 900, timeout: 2400 },
  { name: 'cli-coverage', run: cliCoverage, slow: 3, timeout: 300 },
  { name: 'one-parser', run: oneParser, slow: 3, timeout: 300 },
  // every package built with `term make`. The suites below cannot catch a package that does not compile at all,
  // because a package with no working build has no suite to fail. ONE SUITE PER PACKAGE, so the packages build side
  // by side in the pool: as one suite they built one after another, 1,157 seconds on 2026-10-02, the gate's longest
  // bind is 3,091 files and took 1,060s alone and longer under load on 2026-10-02, so the limit is generous
  ...buildAllPackages().map(pack => ({ name: `build-all/${pack}`, run: buildAll(pack), slow: 60, timeout: 3600 })),
  { name: 'format', file: 'test/format/run.ts' },
  // test/tree/run.ts is a tool (`npx tsx test/tree/run.ts <file.tree>`), not a suite
  { name: 'tree/preprocess', file: 'test/tree/preprocess.ts' },
  { name: 'lint', file: 'test/lint/run.ts' },
  // every lint rule: is it named by a test, and does it fire? Fails when a rule has no test at all
  { name: 'lint/audit', file: 'test/lint/audit.ts', timeout: 600, slow: 20 },
  // the generated rule catalog matches the registry
  { name: 'lint/catalog', file: 'test/lint/catalog.ts' },
  ...each('ir', 'ir'),
  // the facts the emitters read (ir/facts/), each held both ways: proven where it holds, refused at a counterexample
  ...each('ir/facts', 'ir/facts'),
  // the checker: every suite under test/check, each on its own
  ...each('check', 'check').map(suite => (suite.name === 'check/cad-nvar' ? { ...suite, slow: 240 } : suite)),
  // the compile driver and the backends
  // feed-mill-bench builds the same program through rustc, swiftc and kotlinc, so it costs more than a suite that
  // only runs TypeScript. MEASURED at 15.6s on 2026-08-31, not guessed: the first version of this line said 120
  // on the assumption that three toolchains must mean minutes, and an inflated hint misorders the schedule just
  // as surely as a missing one.
  ...each('compile', 'compile', ['roundtrip.ts', 'host-native.ts', 'remote-cache.ts', 'server-roundtrip.ts', 'watch.ts', 'guard-native.ts', 'unknown-native.ts', 'shared-native.ts', 'render-native.ts', 'toolkit-view.ts', 'blog-native.ts', 'toolkit-words.ts', 'toolkit-font.ts', 'toolkit-grow.ts', 'toolkit-compose.ts', 'text-golden.ts', 'toolkit-accessibility.ts', 'toolkit-navigation.ts', 'toolkit-swiftui.ts', 'toolkit-keys.ts', 'toolkit-leak.ts', 'route-table.ts', 'hive-native.ts', 'key-native.ts', 'tag-native.ts', 'inspect-native.ts', 'loop-name-native.ts', 'mask-native.ts', 'unknown-narrow.ts', 'lowered-members.ts', 'spawn-native.ts', 'caught-prop-native.ts','build-memory.ts', 'twin-diff.ts', 'compose-view.ts', 'compose-make.ts', 'compose-work.ts', 'device-features.ts', 'permission-prompt.ts', 'device-watch.ts', 'notification-prompt.ts', 'photos-prompt.ts', 'device-audio.ts', 'device-transfer.ts', 'beat-term.ts', 'beat-term-build.ts', 'uikit-make.ts', 'manifest-boot.ts', 'slot-report.ts', 'shake-differential.ts']).map(
    suite =>
      suite.name === 'compile/feed-mill-bench'
        ? { ...suite, slow: 20 }
        : // every native meaning check on three toolchains: about 1,100s alone, so the default 600s killed it partway
          // with nothing failed (2026-10-06), a run that answered nothing
          suite.name === 'compile/meaning-native'
          ? { ...suite, timeout: 2400, slow: 1100 }
          : // writes the Mac's pasteboard and reads it back with pbpaste
            suite.name === 'compile/device-rust' || suite.name === 'compile/device-rust-table'
            ? { ...suite, holds: 'pasteboard' as const }
            : suite,
  ),
  // needs --expose-gc to measure RETAINED heap rather than whatever the collector has not got to yet
  // 481s under a full concurrent run, and killed at 600s on the next with nothing failed (2026-10-06)
  { name: 'compile/build-memory', file: 'test/compile/build-memory.ts', timeout: 1500, slow: 500, env: { NODE_OPTIONS: '--expose-gc --max-old-space-size=8192' } },
  // the `view` role: the sandboxed document dialect
  ...each('view', 'view', ['terminal-host.ts', 'terminal-input.ts', 'terminal-keys.ts', 'terminal-words.ts', 'terminal-routes.ts', 'terminal-pty.ts']),
  // a program that owns a real terminal, in a pseudo-terminal, on the two backends with terminal natives
  ...(['typescript', 'rust'] as const).map(backend => ({
    name: `view/terminal-pty ${backend}`,
    file: 'test/view/terminal-pty.ts',
    needs: backend === 'rust' ? ['rustc', 'python3'] : ['python3'],
    timeout: 600,
    slow: backend === 'rust' ? 30 : 6,
    env: { TERMINAL_ONLY: backend },
  })),
  // the terminal host (terminal-target-0002..0004): the same screens and keys on every backend, one line each, so a
  // missing toolchain skips its line rather than the suite
  ...(['typescript', 'rust', 'swift', 'kotlin'] as const).flatMap(backend => {
    const needs = { typescript: [], rust: ['rustc'], swift: ['swiftc'], kotlin: ['kotlinc'] }[backend]
    const slow = { typescript: 4, rust: 30, swift: 40, kotlin: 60 }[backend]

    return ['terminal-host', 'terminal-input', 'terminal-keys', 'terminal-words', 'terminal-routes'].map(name => ({
      name: `view/${name} ${backend}`,
      file: `test/view/${name}.ts`,
      needs,
      timeout: 900,
      slow,
      env: { TERMINAL_ONLY: backend },
    }))
  }),
  // every stdlib module built shaken and unshaken: the same verdict, and every kept statement identical. A gate, not a
  // suite, so it lives in task/term (item term-self-host-001-1200)
  { name: 'compile/shake-differential', file: 'task/term/shake-differential.ts' },
  { name: 'compile/module-blame', file: 'test/compile/module-blame.ts', timeout: 300 },
  // the lean surface: every fixture written lean and long must build the same program, and every refusal
  // must say why. note/project/term/mill/lean.md
  { name: 'compile/lean', file: 'test/compile/lean.ts', timeout: 300 },
  // every port's module on the native backends: over 1,020 checks, which ran 1,663s on a loaded machine and were
  // killed at 900s with nothing failed (2026-10-06), then at 2400s the same way at load 15 to 50 (item 0528). One suite
  // per backend, so the limit holds a quarter of the work and the pool's --jobs still bounds the parallelism. `slow`
  // orders the run longest first, so they start early
  ...(['node', 'rust', 'swift', 'kotlin'] as const).map(backend => ({
    name: `port-native ${backend}`,
    file: 'task/term/port-native.ts',
    timeout: 2400,
    slow: 225,
    env: { PORT_NATIVE_ONLY: backend },
  })),
  { name: 'compile/watch', file: 'test/compile/watch.ts', timeout: 300 },
  { name: 'compile/remote-cache', file: 'test/compile/remote-cache.ts', timeout: 300 },
  { name: 'compile/server-roundtrip', file: 'test/compile/server-roundtrip.ts', timeout: 600, slow: 6 },
  // compose-target-0001: the toolkit program drawn by Compose on the desktop JVM, read back from its semantics. The
  // first run resolves Compose (and fetches Gradle into the cache when none is installed), so its timeout is generous
  { name: 'compile/compose-view', file: 'test/compile/compose-view.ts', needs: ['kotlinc', 'java'], timeout: 900, slow: 60, env: { COMPOSE_VIEW_ONLY: 'desktop' } },
  // compose-target-0004: the same program as Jetpack Compose on the Android emulator, an APK made with no Android Gradle
  // plugin (test/compile/shared/compose-android.ts), every judgment the same as the desktop's
  { name: 'compile/compose-view android', file: 'test/compile/compose-view.ts', needs: ['kotlinc', 'java'], timeout: 1200, slow: 120, env: { COMPOSE_VIEW_ONLY: 'android' }, holds: 'emulator' },
  // compose-target-0004: `term make --target compose` (a jpackage app image with its JVM, its launcher run) and
  // `--target compose-android` (an APK, run on the emulator), through the CLI's own makeCompose
  { name: 'compile/compose-make', file: 'test/compile/compose-make.ts', needs: ['kotlinc', 'java', 'jpackage'], timeout: 1200, slow: 60, env: { COMPOSE_MAKE_ONLY: 'compose' } },
  { name: 'compile/compose-make android', file: 'test/compile/compose-make.ts', needs: ['kotlinc', 'java'], timeout: 1200, slow: 120, env: { COMPOSE_MAKE_ONLY: 'compose-android' }, holds: 'emulator' },
  // live-reload: `term work --target compose|compose-android`, real edits to a two-file app through the loop's own
  // watcher, each relaunch starting where the last one was
  { name: 'compile/compose-work', file: 'test/compile/compose-work.ts', needs: ['kotlinc', 'java'], timeout: 1200, slow: 90, env: { COMPOSE_WORK_ONLY: 'compose' } },
  { name: 'compile/compose-work android', file: 'test/compile/compose-work.ts', needs: ['kotlinc', 'java'], timeout: 1800, slow: 180, env: { COMPOSE_WORK_ONLY: 'compose-android' }, holds: 'emulator' },
  // the CLI, the package manager, the language server, the dev loop. The two that need another machine are left out of
  // the sweep and registered below with the machine each needs, so they skip, naming it, rather than fail without one
  ...each('call', 'call', ['cli.ts', 'self-release-windows.ts', 'update-app-remote.ts', 'emit-build.ts', 'make-env.ts', 'update-app-android.ts', 'port-build-skip.ts']),
  // emit-fragment.ts (WGSL and HVM through `--emit`) runs from the `each` above, and so does emit-llvm-wasm.ts (LLVM IR
  // and WASI through the Rust), which skips itself without rustc and checks the rustup refusals where llc or the
  // wasm32-wasip1 target is absent
  // `term make --emit <target> <file> --build / --run` through the built CLI, one suite per target
  { name: 'call/emit-build node', file: 'test/call/emit-build.ts', timeout: 300, env: { EMIT_BUILD_ONLY: 'node' } },
  { name: 'call/emit-build rust', file: 'test/call/emit-build.ts', needs: ['rustc', 'cargo'], timeout: 900, slow: 40, env: { EMIT_BUILD_ONLY: 'rust' } },
  { name: 'call/emit-build swift', file: 'test/call/emit-build.ts', needs: ['swiftc'], timeout: 900, slow: 40, env: { EMIT_BUILD_ONLY: 'swift' } },
  { name: 'call/emit-build kotlin', file: 'test/call/emit-build.ts', needs: ['kotlinc', 'java'], timeout: 1200, slow: 60, env: { EMIT_BUILD_ONLY: 'kotlin' } },
  // task/port-build.ts's skip on a clone of the tree: an edited stdlib file, port and compiler file each make the skip
  // run write what a --full run writes, and --check still catches a stale or missing port (term-cli-in-term-0002). Five
  // full builds of 614 modules: 2988 s alone at load 6 to 9 once the printer keeper stopped compiling twice
  // (term-cli-in-term-0252), so the timeout leaves room for a loaded machine. 687 modules on 2026-11-03: one cold build
  // took 23 min at load 13 to 22, about 95 min for the test, so the limit is 9,000 s until the test drops the full
  // rebuilds it can do without (term-self-host-001-0917)
  { name: 'call/port-build-skip', file: 'test/call/port-build-skip.ts', timeout: 9000, slow: 3600 },
  // `term make --env`: every program of a project for one backend (call/code/make-native.ts)
  { name: 'call/make-env node', file: 'test/call/make-env.ts', timeout: 300, env: { MAKE_ENV_ONLY: 'node' } },
  { name: 'call/make-env rust', file: 'test/call/make-env.ts', needs: ['rustc'], timeout: 900, slow: 40, env: { MAKE_ENV_ONLY: 'rust' } },
  { name: 'call/make-env swift', file: 'test/call/make-env.ts', needs: ['swiftc'], timeout: 900, slow: 40, env: { MAKE_ENV_ONLY: 'swift' } },
  { name: 'call/make-env kotlin', file: 'test/call/make-env.ts', needs: ['kotlinc', 'java'], timeout: 1200, slow: 60, env: { MAKE_ENV_ONLY: 'kotlin' } },
  // `term` on Windows: installed by load.ps1 from a loopback registry here through an ssh tunnel, then run there
  // (note/project/term/term-load-install.md W4). Needs the windows payload `pnpm run release --dry` writes
  { name: 'call/self-release-windows', file: 'test/call/self-release-windows.ts', needsEnv: ['WINDOWS_VM'], timeout: 1200, slow: 120 },
  // the Rust cask's update client on its own platforms, launched, updated and launched again (native-dom-0032)
  { name: 'call/update-app-linux', file: 'test/call/update-app-remote.ts', env: { UPDATE_REMOTE: 'linux' }, needsEnv: ['CASK_DROPLET'], timeout: 2400, slow: 300 },
  { name: 'call/update-app-windows', file: 'test/call/update-app-remote.ts', env: { UPDATE_REMOTE: 'windows' }, needsEnv: ['WINDOWS_VM'], timeout: 2400, slow: 300 },
  // an APK installed on the emulator and updated over the air: it reaches the emulator through adb, so it holds it
  // (beat-term-0035; the sweep above missed it, and it used to run with no hold)
  { name: 'call/update-app-android', file: 'test/call/update-app-android.ts', needs: ['kotlinc'], timeout: 1200, slow: 120, holds: 'emulator' },
  // the terminal output library (deck/call/code/work/item/): every card of note/project/term/output/mockups.html drawn and
  // compared character by character and role by role, then the unit cases the cards cannot reach. The other files in
  // test/item/ are the cards and their helpers, not suites
  { name: 'item/golden', file: 'test/item/golden.ts', slow: 3 },
  { name: 'item/unit', file: 'test/item/unit.ts', slow: 3 },
  // and the same library built for Rust answers the same: every line of parity.tree drawn by node and by rustc's build
  { name: 'item/rust-parity', file: 'test/item/rust-parity.ts', needs: ['rustc'], slow: 20, timeout: 600 },
  ...each('deck', 'deck'),
  ...each('flow', 'flow'),
  ...each('dev', 'dev'),
  ...each('server', 'server'),
  ...each('time', 'time'),
  { name: 'repl', file: 'test/repl/run.ts' },
  { name: 'http', file: 'test/http/run.ts' },
  ...each('scan', 'scan'),
  // the assurance MVP's gates (note/project/term/assurance/mvp.md): Lean re-checks the notes demo's laws, skipped
  // with a message when no Lean is installed
  ...each('assurance', 'assurance'),
  // the framework and the stdlib
  ...each('site', 'site', ['blog-db.ts', 'blog-loop.ts']),
  // the blog's database legs need a live Postgres (and the `pg` package the emitted app imports)
  { name: 'site/blog-db', file: 'test/site/blog-db.ts', needsEnv: ['DATABASE_URL'] },
  { name: 'site/blog-loop', file: 'test/site/blog-loop.ts', needsEnv: ['DATABASE_URL'] },
  ...each('zone', 'zone'),
  ...each('stdlib', 'stdlib', ['ordered-collections.ts', 'sorted-map.ts', 'sorted-set.ts', 'text-case.ts', 'text-format.ts', 'text-format-platforms.ts', 'decimal-native.ts']),
  // the exact decimal's sums, division and seven rounding modes, on every toolchain (Rust through cargo, for num-bigint)
  { name: 'stdlib/decimal-native typescript', file: 'test/stdlib/decimal-native.ts', timeout: 300, env: { DECIMAL_ONLY: 'typescript' } },
  { name: 'stdlib/decimal-native rust', file: 'test/stdlib/decimal-native.ts', needs: ['cargo'], timeout: 900, slow: 30, env: { DECIMAL_ONLY: 'rust' } },
  { name: 'stdlib/decimal-native swift', file: 'test/stdlib/decimal-native.ts', needs: ['swiftc'], timeout: 600, slow: 10, env: { DECIMAL_ONLY: 'swift' } },
  { name: 'stdlib/decimal-native kotlin', file: 'test/stdlib/decimal-native.ts', needs: ['kotlinc', 'java'], timeout: 900, slow: 20, env: { DECIMAL_ONLY: 'kotlin' } },
  // numbers and money by language: the Term formatter, every backend held to node's Intl but for the cases in known.json
  { name: 'stdlib/text-format typescript', file: 'test/stdlib/text-format.ts', timeout: 900, slow: 30, env: { FORMAT_ONLY: 'typescript' } },
  { name: 'stdlib/text-format rust', file: 'test/stdlib/text-format.ts', needs: ['rustc'], timeout: 1200, slow: 30, env: { FORMAT_ONLY: 'rust' } },
  { name: 'stdlib/text-format swift', file: 'test/stdlib/text-format.ts', needs: ['swiftc'], timeout: 1200, slow: 30, env: { FORMAT_ONLY: 'swift' } },
  { name: 'stdlib/text-format kotlin', file: 'test/stdlib/text-format.ts', needs: ['kotlinc', 'java'], timeout: 1200, slow: 30, env: { FORMAT_ONLY: 'kotlin' } },
  // casing by language, every backend held to node's toLocaleUpperCase / toLocaleLowerCase
  { name: 'stdlib/text-case typescript', file: 'test/stdlib/text-case.ts', timeout: 300, env: { CASE_ONLY: 'typescript' } },
  { name: 'stdlib/text-case rust', file: 'test/stdlib/text-case.ts', needs: ['rustc'], timeout: 600, slow: 10, env: { CASE_ONLY: 'rust' } },
  { name: 'stdlib/text-case swift', file: 'test/stdlib/text-case.ts', needs: ['swiftc'], timeout: 600, slow: 10, env: { CASE_ONLY: 'swift' } },
  { name: 'stdlib/text-case kotlin', file: 'test/stdlib/text-case.ts', needs: ['kotlinc', 'java'], timeout: 900, slow: 20, env: { CASE_ONLY: 'kotlin' } },
  // the WHATWG URL parser in Term, every backend held to the web-platform-tests corpus but for the cases in test/stdlib/url/known.json
  { name: 'stdlib/url typescript', file: 'test/stdlib/url.ts', timeout: 900, slow: 30, env: { URL_ONLY: 'typescript' } },
  { name: 'stdlib/url rust', file: 'test/stdlib/url.ts', needs: ['rustc'], timeout: 1800, slow: 30, env: { URL_ONLY: 'rust' } },
  { name: 'stdlib/url swift', file: 'test/stdlib/url.ts', needs: ['swiftc'], timeout: 1800, slow: 30, env: { URL_ONLY: 'swift' } },
  { name: 'stdlib/url kotlin', file: 'test/stdlib/url.ts', needs: ['kotlinc', 'java'], timeout: 1800, slow: 30, env: { URL_ONLY: 'kotlin' } },
  { name: 'stdlib/sorted-set typescript', file: 'test/stdlib/sorted-set.ts', timeout: 300, env: { SORTED_ONLY: 'typescript' } },
  { name: 'stdlib/sorted-set rust', file: 'test/stdlib/sorted-set.ts', needs: ['rustc'], timeout: 600, slow: 10, env: { SORTED_ONLY: 'rust' } },
  { name: 'stdlib/sorted-set swift', file: 'test/stdlib/sorted-set.ts', needs: ['swiftc'], timeout: 600, slow: 10, env: { SORTED_ONLY: 'swift' } },
  { name: 'stdlib/sorted-set kotlin', file: 'test/stdlib/sorted-set.ts', needs: ['kotlinc', 'java'], timeout: 900, slow: 20, env: { SORTED_ONLY: 'kotlin' } },
  // the sorted map's B-tree against a JavaScript Map under 6,000 seeded puts and drops, on every toolchain
  { name: 'stdlib/sorted-map typescript', file: 'test/stdlib/sorted-map.ts', timeout: 300, env: { SORTED_ONLY: 'typescript' } },
  { name: 'stdlib/sorted-map rust', file: 'test/stdlib/sorted-map.ts', needs: ['rustc'], timeout: 600, slow: 10, env: { SORTED_ONLY: 'rust' } },
  { name: 'stdlib/sorted-map swift', file: 'test/stdlib/sorted-map.ts', needs: ['swiftc'], timeout: 600, slow: 10, env: { SORTED_ONLY: 'swift' } },
  { name: 'stdlib/sorted-map kotlin', file: 'test/stdlib/sorted-map.ts', needs: ['kotlinc', 'java'], timeout: 900, slow: 20, env: { SORTED_ONLY: 'kotlin' } },
  // bag, ordered set and linked list, stable since 2026-10-05, on every toolchain
  { name: 'stdlib/ordered-collections typescript', file: 'test/stdlib/ordered-collections.ts', timeout: 300, env: { COLLECTION_ONLY: 'typescript' } },
  { name: 'stdlib/ordered-collections rust', file: 'test/stdlib/ordered-collections.ts', needs: ['rustc'], timeout: 600, slow: 10, env: { COLLECTION_ONLY: 'rust' } },
  { name: 'stdlib/ordered-collections swift', file: 'test/stdlib/ordered-collections.ts', needs: ['swiftc'], timeout: 600, slow: 10, env: { COLLECTION_ONLY: 'swift' } },
  { name: 'stdlib/ordered-collections kotlin', file: 'test/stdlib/ordered-collections.ts', needs: ['kotlinc', 'java'], timeout: 900, slow: 20, env: { COLLECTION_ONLY: 'kotlin' } },
  // the whole tree
  { name: 'vitest', run: vitest, slow: 3, cache: false },
  { name: 'stdlib closure', run: closure },
  // the code role's grammar must match the whole stdlib through the executor (mill-self-hosting)
  // What a program can DO on each backend, as opposed to what compiles. A build gate cannot see a module that
  // was never written, because nothing imports what does not exist, so `native-gate` was green for months while
  // the whole asynchronous filesystem and the HTTP server side were simply absent on rust, swift and kotlin.
  // Held at ZERO here (native-surface-parity-0007). It reads the tree and runs no toolchain, so it costs a
  // second, unlike `native-gate` which is minutes and stays out of this suite.
  { name: 'native surface', file: 'task/term/native-surface.ts', slow: 2 },
  // Does the cache HIT? `term cache` asks how big it is, which is how 101 GB was found, and cannot ask whether it
  // is worth having. The two had opposite answers: the day the size was measured, a warm build of @term/bind took
  // 423s against a cold 411s. This compiles twice and counts hits, and holds the per-kind version scoping that
  // stops a change to one level stranding the other (build-cache-size).
  { name: 'cache hit', file: 'task/term/cache-hit.ts', slow: 3 },
  // and the scope those versions are computed from must still match the import graph, or a kind can miss a file
  // it can reach and serve a stale hit
  { name: 'cache scope', file: 'task/term/cache-scope.ts', slow: 2 },
  { name: 'mill coverage', file: 'task/term/mill-coverage.ts', slow: 30, timeout: 600 },
  // and the grammar's two halves must agree with each other: every site a mine fills is read by a mint, no rule
  // name defined twice, no alternative made unreachable by an earlier greedy one, and every file in every
  // package still builds a Program. All seven counts are held at zero (mint-bridge)
  { name: 'mint parity', file: 'task/term/mint-parity.ts', slow: 90, timeout: 900 },
  // the separate build (`term make`) against the merged one (`--merged`), every file of every package: a stub that
  // leaves out what an analysis reads of a body makes the two disagree, and nothing else notices
  // ONE LEG PER PACKAGE, @term/bind in eight (task/term/gate/compile-packages.ts): as one suite it was killed at 3600s
  // on 2026-10-20 and 21 with no verdict. Timings: note/project/term/term-gates/readme.md, "separate-diff and roll-fast"
  ...compileLegs().map(({ pkg, shard }) => ({
    name: `separate-diff/${pkg.split('/').at(-1)}${shard ? ` ${shard}` : ''}`,
    file: 'task/term/separate-diff.ts',
    env: { SEPARATE_DIFF_PACKAGE: pkg, ...(shard ? { SEPARATE_DIFF_SHARD: shard } : {}) },
    slow: shard ? 900 : 300,
    timeout: 3600,
  })),
  // and the incremental build against a clean one, after every edit of a random sequence on real packages: every
  // shortcut (the name-level key, the replayed entry, the kept walk) is a claim that skipping work changes nothing
  // 689s under a full concurrent run, and killed at 1800s on 2026-10-06 at a load average near 55 with nothing failed
  { name: 'edit-replay', file: 'task/term/edit-replay.ts', slow: 700, timeout: 3600 },
  // and how fast it is: each scenario's units built exactly as predicted, its p50 within 1.5 times the baseline
  // (decision 077 section 11 of term/self-host/change/001-finish-self-host). @term/bind only with --full
  { name: 'incremental-bench', file: 'task/term/incremental-bench.ts', slow: 900, timeout: 3600 },
  // and the roll `term make` reads off a typed program, against the roll of the whole compile, every file that builds
  // one leg per package, @term/bind in eight, as separate-diff
  ...compileLegs().map(({ pkg, shard }) => ({
    name: `roll-fast/${pkg.split('/').at(-1)}${shard ? ` ${shard}` : ''}`,
    file: 'task/term/roll-fast.ts',
    env: { ROLL_FAST_PACKAGE: pkg, ...(shard ? { ROLL_FAST_SHARD: shard } : {}) },
    slow: shard ? 900 : 300,
    timeout: 3600,
  })),
  // and one definition's roll entry the same whichever entry computes it, every entry of @term/feed: a raise read off
  // what the closure happens to hold, or a merge key two definitions share, changes the project's roll with file order
  { name: 'roll-cover', file: 'task/term/roll-cover.ts', env: { ROLL_COVER_DIR: 'deck/mill' }, slow: 120, timeout: 900 },
  // and the roll assembled from units the same as every entry's own, entry for entry: what makes `term make` roll a
  // package without typing each entry's closure again
  { name: 'roll-units', file: 'task/term/roll-units.ts', slow: 300, timeout: 1800 },
  // no cache over its byte budget. 101 GB accumulated across the tree in two days of ordinary work with every gate
  // green, because no gate asked. This one asks (build-cache-size)
  { name: 'cache budget', file: 'task/term/cache.ts', slow: 60, timeout: 600 },
  // the CLI's command tree in Term and the CLI that ships describe the same 47 commands, flag for flag, while the
  // conversion runs (cli-in-term)
  { name: 'cli drift', file: 'task/term/cli-drift.ts', slow: 30, timeout: 600 },
  // and each CLI module already ported to Term answers exactly what the TypeScript it replaces answers, on real
  // input rather than a fixture (cli-in-term)
  { name: 'cli port', file: 'task/term/cli-port.ts', slow: 20, timeout: 600 },
  // the pair harness leaves nothing in the machine's temporary folder: a whole run, a ctrl-c, a --keep (term-cli-in-term-0177)
  { name: 'temp pair', file: 'task/term/temp-pair-check.ts', cache: false, slow: 30, timeout: 600 },
  // rung 1 of the bootstrap: every piece of the compiler written in Term answers what the TypeScript answers,
  // over every name in every .tree file in the tree (self-hosting)
  { name: 'self host', file: 'task/term/self-host.ts', slow: 30, timeout: 600, needsEnv: ['TERM_PARENT_ROOT'] },
  // every sample on every term.surf guide page compiles, fails with the error it names, or runs and prints exactly
  // what its page says, under the compiler in this tree (term-guides). Cached by the compiler's bytes, so a change
  // that moves no output costs seconds, and one that does rebuilds every sample
  { name: 'guide samples', file: join(PARENT_ROOT ?? '', 'task/term/guide-samples.ts'), slow: 120, timeout: 3600, needsEnv: ['TERM_PARENT_ROOT'] },
  // a guide's `term` transcript is painted in the terminal's colors by a reader on the page: its table is what the
  // output standard says, and it reads real events' plain text back in the roles the terminal's layout drew them in
  { name: 'log standard', file: join(PARENT_ROOT ?? '', 'task/term/log-standard.ts'), slow: 10, timeout: 300, needsEnv: ['TERM_PARENT_ROOT'] },
  { name: 'stdlib emit-types', run: emitTypes, slow: 90, timeout: 900 },
  { name: 'host package tests', run: packageTests('host') },
  // the self-hosting ports' own Term tests (note/project/term/self-host/archive/port-log.md): the compiler modules ported to Term, and
  // @term/test's. Natively they run on the base gate (BG_MATCH=deck/make/test/, deck/test/test/)
  { name: 'make package tests', run: packageTests('make') },
  { name: 'test package tests', run: packageTests('test') },
  // the CLI's own Term tests: the item card (test/item, also run by item/unit) and the build engine's (test/build,
  // item term-self-host-001-0495)
  { name: 'call package tests', run: packageTests('call') },
  { name: 'zone package tests', run: packageTests('zone', join(PARENT_ROOT ?? '', 'deck/zone')), needsEnv: ['TERM_PARENT_ROOT'] },
  // the native toolchains, one leg per toolchain so they run side by side (HN_ONLY and RT_ONLY are the suites' own
  // filters; `other` is the roundtrip's node and emitted-text checks)
  { name: 'compile/host-native rust', file: 'test/compile/host-native.ts', needs: ['cargo'], timeout: 1800, slow: 40, env: { HN_ONLY: 'rust' } },
  { name: 'compile/host-native swift', file: 'test/compile/host-native.ts', needs: ['swiftc'], timeout: 1800, slow: 20, env: { HN_ONLY: 'swift' } },
  { name: 'compile/host-native kotlin', file: 'test/compile/host-native.ts', needs: ['kotlinc'], timeout: 1800, slow: 30, env: { HN_ONLY: 'kotlin' } },
  // the native app cask: a macOS app built from Term, one bridge round trip each way, and its negative control. Opens
  // no window. task/term/app-smoke.ts, the proof of cask-0004 in note/project/term/cask/checklist.json
  { name: 'cask/smoke', file: join(PARENT_ROOT ?? '', 'task/term/app-smoke.ts'), needs: ['swiftc'], timeout: 900, slow: 60, needsEnv: ['TERM_PARENT_ROOT'] },
  // the generated bridge is what is on disk: the webview shims and the smoke app's dispatcher regenerate byte for byte
  { name: 'cask/generate', file: 'task/term/cask/generate.ts', env: { CASK_GENERATE_ARGS: '--page deck/cask/test/smoke/page.tree --check' }, timeout: 300 },
  // the data app: SQLite in the cask reached through the generated bridge, rows as opaque handles, text and number
  // parameters, and its negative control. The proof of cask-0012
  { name: 'cask/data', file: join(PARENT_ROOT ?? '', 'task/term/app-smoke.ts'), env: { CASK_SMOKE_ARGS: '--app data' }, needs: ['swiftc'], timeout: 900, slow: 60, needsEnv: ['TERM_PARENT_ROOT'] },
  // the generated shim and dispatcher of the data app and of the blog held to their pages
  // the route app: the app's router registered in the cask answers the page in process. The proof of cask-0018
  { name: 'cask/route', file: join(PARENT_ROOT ?? '', 'task/term/app-smoke.ts'), env: { CASK_SMOKE_ARGS: '--app route' }, needs: ['swiftc'], timeout: 900, slow: 60, needsEnv: ['TERM_PARENT_ROOT'] },
  { name: 'cask/generate-route', file: 'task/term/cask/generate.ts', env: { CASK_GENERATE_ARGS: '--page deck/cask/test/route/page.tree --check' }, timeout: 300 },
  // the same two apps on the two Rust cask platforms, each on its own box: the Windows guest WINDOWS_VM names, and
  // the work droplet through Docker when CASK_DROPLET is set (task/term/cask/windows.ts, task/term/cask/droplet.ts)
  { name: 'cask/data-windows', file: join(PARENT_ROOT ?? '', 'task/term/app-smoke.ts'), env: { CASK_SMOKE_ARGS: '--app data --target windows' }, needsEnv: ['TERM_PARENT_ROOT', 'WINDOWS_VM'], timeout: 1800, slow: 120 },
  { name: 'cask/route-windows', file: join(PARENT_ROOT ?? '', 'task/term/app-smoke.ts'), env: { CASK_SMOKE_ARGS: '--app route --target windows' }, needsEnv: ['TERM_PARENT_ROOT', 'WINDOWS_VM'], timeout: 1800, slow: 120 },
  { name: 'cask/data-linux', file: join(PARENT_ROOT ?? '', 'task/term/app-smoke.ts'), env: { CASK_SMOKE_ARGS: '--app data --target linux' }, needsEnv: ['TERM_PARENT_ROOT', 'CASK_DROPLET'], timeout: 1800, slow: 120 },
  { name: 'cask/route-linux', file: join(PARENT_ROOT ?? '', 'task/term/app-smoke.ts'), env: { CASK_SMOKE_ARGS: '--app route --target linux' }, needsEnv: ['TERM_PARENT_ROOT', 'CASK_DROPLET'], timeout: 1800, slow: 120 },
  { name: 'cask/generate-data', file: 'task/term/cask/generate.ts', env: { CASK_GENERATE_ARGS: '--page deck/cask/test/data/page.tree --check' }, timeout: 300 },
  // device-layer-0013: the device contracts from a WebView page, answered by the platform's own API in the cask, each
  // answer judged against pmset and pbpaste
  { name: 'cask/device', file: join(PARENT_ROOT ?? '', 'task/term/app-smoke.ts'), env: { CASK_SMOKE_ARGS: '--app device' }, needs: ['swiftc'], timeout: 900, slow: 60, holds: 'pasteboard', needsEnv: ['TERM_PARENT_ROOT'] },
  { name: 'cask/device-linux', file: join(PARENT_ROOT ?? '', 'task/term/app-smoke.ts'), env: { CASK_SMOKE_ARGS: '--app device --target linux' }, needsEnv: ['TERM_PARENT_ROOT', 'CASK_DROPLET'], timeout: 1800, slow: 120 },
  { name: 'cask/device-windows', file: join(PARENT_ROOT ?? '', 'task/term/app-smoke.ts'), env: { CASK_SMOKE_ARGS: '--app device --target windows' }, needsEnv: ['TERM_PARENT_ROOT', 'WINDOWS_VM'], timeout: 1800, slow: 120 },
  { name: 'cask/generate-device', file: 'task/term/cask/generate.ts', env: { CASK_GENERATE_ARGS: '--page deck/cask/test/device/page.tree --check' }, timeout: 300 },
  // native-dom-0030: two windows, each owning its handles, and a window's handles let go when it closes
  { name: 'cask/windows', file: join(PARENT_ROOT ?? '', 'task/term/app-smoke.ts'), env: { CASK_SMOKE_ARGS: '--app windows' }, needs: ['swiftc'], timeout: 900, slow: 60, needsEnv: ['TERM_PARENT_ROOT'] },
  { name: 'cask/generate-windows', file: 'task/term/cask/generate.ts', env: { CASK_GENERATE_ARGS: '--page deck/cask/test/windows/page.tree --check' }, timeout: 300 },
  { name: 'cask/generate-blog', file: 'task/term/cask/generate.ts', env: { CASK_GENERATE_ARGS: '--page deck/site/test/site/face/base.tree --out deck/site/test/site --check' }, timeout: 300 },
  { name: 'compile/roundtrip rust', file: 'test/compile/roundtrip.ts', needs: ['cargo'], timeout: 2400, slow: 60, env: { RT_ONLY: 'rust' } },
  { name: 'compile/roundtrip swift', file: 'test/compile/roundtrip.ts', needs: ['swiftc'], timeout: 2400, slow: 20, env: { RT_ONLY: 'swift' } },
  { name: 'compile/roundtrip kotlin', file: 'test/compile/roundtrip.ts', needs: ['kotlinc'], timeout: 2400, slow: 40, env: { RT_ONLY: 'kotlin' } },
  { name: 'compile/roundtrip other', file: 'test/compile/roundtrip.ts', timeout: 600, slow: 10, env: { RT_ONLY: 'other' } },
  // a raise caught on each native backend (note/project/term/hive/11-native-exceptions.md)
  { name: 'compile/guard-native rust', file: 'test/compile/guard-native.ts', needs: ['cargo'], timeout: 1200, slow: 40, env: { GN_ONLY: 'rust' } },
  { name: 'compile/guard-native swift', file: 'test/compile/guard-native.ts', needs: ['swiftc'], timeout: 600, slow: 15, env: { GN_ONLY: 'swift' } },
  { name: 'compile/guard-native kotlin', file: 'test/compile/guard-native.ts', needs: ['kotlinc'], timeout: 600, slow: 20, env: { GN_ONLY: 'kotlin' } },
  { name: 'compile/unknown-native rust', file: 'test/compile/unknown-native.ts', needs: ['rustc'], timeout: 600, slow: 10, env: { UN_ONLY: 'rust' } },
  { name: 'compile/unknown-native swift', file: 'test/compile/unknown-native.ts', needs: ['swiftc'], timeout: 600, slow: 10, env: { UN_ONLY: 'swift' } },
  { name: 'compile/unknown-native kotlin', file: 'test/compile/unknown-native.ts', needs: ['kotlinc'], timeout: 600, slow: 20, env: { UN_ONLY: 'kotlin' } },
  // `note shared` (native-dom-0001): one object through every binding, with a struct negative control on Swift
  { name: 'compile/shared-native typescript', file: 'test/compile/shared-native.ts', timeout: 300, slow: 5, env: { SN_ONLY: 'typescript' } },
  { name: 'compile/shared-native rust', file: 'test/compile/shared-native.ts', needs: ['rustc'], timeout: 600, slow: 10, env: { SN_ONLY: 'rust' } },
  // differential admission of the stdlib's twins (optimize-0010): thousands of inputs in process, mutants, and a replay
  // on each native toolchain. Long, so it has its own limit; a missing toolchain is reported, not failed
  { name: 'compile/twin-diff', file: 'test/compile/twin-diff.ts', timeout: 2400, slow: 300 },
  { name: 'compile/shared-native swift', file: 'test/compile/shared-native.ts', needs: ['swiftc'], timeout: 600, slow: 10, env: { SN_ONLY: 'swift' } },
  { name: 'compile/shared-native kotlin', file: 'test/compile/shared-native.ts', needs: ['kotlinc'], timeout: 600, slow: 20, env: { SN_ONLY: 'kotlin' } },
  // the renderer on three backends (native-dom-0004): the same component into the same in-memory host, the same HTML
  { name: 'compile/render-native typescript', file: 'test/compile/render-native.ts', timeout: 300, slow: 10, env: { RN_ONLY: 'typescript' } },
  // the same views over the server's DOM host beside the memory host (reactive-bridge-0004)
  { name: 'compile/render-native dom', file: 'test/compile/render-native.ts', timeout: 300, slow: 10, env: { RN_ONLY: 'dom' } },
  { name: 'compile/render-native swift', file: 'test/compile/render-native.ts', needs: ['swiftc'], timeout: 600, slow: 30, env: { RN_ONLY: 'swift' } },
  { name: 'compile/render-native kotlin', file: 'test/compile/render-native.ts', needs: ['kotlinc'], timeout: 900, slow: 60, env: { RN_ONLY: 'kotlin' } },
  { name: 'compile/render-native rust', file: 'test/compile/render-native.ts', needs: ['rustc'], timeout: 900, slow: 30, env: { RN_ONLY: 'rust' } },
  // the dom on the platform's own views (native-dom-0005, 0006): ONE program, its button pressed eleven times with
  // the platform's own click, the tree read back from the views. AppKit in a window, UIKit in the iOS simulator (booted
  // when none is), Android views on the emulator (skipped, with the reason, when no device is online)
  { name: 'compile/toolkit-view macos', file: 'test/compile/toolkit-view.ts', needs: ['swiftc'], timeout: 600, slow: 30, env: { TOOLKIT_ONLY: 'macos' } },
  { name: 'compile/toolkit-view ios', file: 'test/compile/toolkit-view.ts', needs: ['xcrun'], timeout: 900, slow: 60, env: { TOOLKIT_ONLY: 'ios' }, holds: 'simulator' },
  { name: 'compile/toolkit-view android', file: 'test/compile/toolkit-view.ts', needs: ['kotlinc'], timeout: 900, slow: 120, env: { TOOLKIT_ONLY: 'android' }, holds: 'emulator' },
  // native-dom-0014: the blog app's own page, its views on the toolkit and its posts in SQLite, no WebView
  { name: 'compile/blog-native macos', file: 'test/compile/blog-native.ts', needs: ['swiftc'], timeout: 600, slow: 30, env: { BLOG_ONLY: 'macos' } },
  { name: 'compile/blog-native ios', file: 'test/compile/blog-native.ts', needs: ['xcrun'], timeout: 900, slow: 60, env: { BLOG_ONLY: 'ios' }, holds: 'simulator' },
  { name: 'compile/blog-native android', file: 'test/compile/blog-native.ts', needs: ['kotlinc'], timeout: 900, slow: 120, env: { BLOG_ONLY: 'android' }, holds: 'emulator' },
  // compose-target-0005: the blog on Compose on the desktop JVM (its SQLite through JDBC), then as Jetpack Compose on the
  // emulator, its SQLite store in the same process
  { name: 'compile/blog-native compose', file: 'test/compile/blog-native.ts', needs: ['kotlinc', 'java'], timeout: 900, slow: 30, env: { BLOG_ONLY: 'compose' } },
  { name: 'compile/blog-native compose-android', file: 'test/compile/blog-native.ts', needs: ['kotlinc', 'java'], timeout: 1200, slow: 120, env: { BLOG_ONLY: 'compose-android' }, holds: 'emulator' },
  // compose-target-0004, 0005: the blog as an app image packaged by the target's own jpackage and run there, the work
  // droplet's Linux and the Windows guest's, gated as the Linux and Windows casks are on the machine being named
  { name: 'compile/blog-native compose-linux', file: 'test/compile/blog-native.ts', needs: ['kotlinc', 'java'], needsEnv: ['CASK_DROPLET'], timeout: 1800, slow: 180, env: { BLOG_ONLY: 'compose-linux' } },
  { name: 'compile/blog-native compose-windows', file: 'test/compile/blog-native.ts', needs: ['kotlinc', 'java'], needsEnv: ['WINDOWS_VM'], timeout: 1800, slow: 180, env: { BLOG_ONLY: 'compose-windows' } },
  // view-vocabulary-0005: every word of the view vocabulary against every target, read from the spec and the lowerings
  { name: 'view/conformance', file: 'task/term/view-conformance.ts', timeout: 120, needsEnv: ['TERM_PARENT_ROOT'] },
  // native-text-0001: the font contract against the web resolver, every script, alias and family, on each target
  { name: 'face/font-registry typescript', file: 'test/face/font-registry.ts', timeout: 300, env: { FONT_LEGS: 'typescript' } },
  { name: 'face/font-registry swift', file: 'test/face/font-registry.ts', needs: ['swiftc'], timeout: 600, slow: 60, env: { FONT_LEGS: 'swift' } },
  { name: 'face/font-registry kotlin', file: 'test/face/font-registry.ts', needs: ['kotlinc'], timeout: 600, slow: 120, env: { FONT_LEGS: 'kotlin' } },
  // native-text-0002: a face registered with CoreText or as a Typeface, checked, watched and drawn, read off the views
  { name: 'compile/toolkit-font macos', file: 'test/compile/toolkit-font.ts', needs: ['swiftc'], timeout: 600, slow: 30, env: { FONT_ONLY: 'macos' } },
  { name: 'compile/toolkit-font ios', file: 'test/compile/toolkit-font.ts', needs: ['xcrun'], timeout: 900, slow: 60, env: { FONT_ONLY: 'ios' }, holds: 'simulator' },
  // beat-term-0061 (D025): free room in a stack is held by constraints, a growing scroll filling the window after a layout pass
  { name: 'compile/toolkit-grow ios', file: 'test/compile/toolkit-grow.ts', needs: ['xcrun'], timeout: 900, slow: 60, env: { GROW_ONLY: 'ios' }, holds: 'simulator' },
  { name: 'compile/toolkit-font android', file: 'test/compile/toolkit-font.ts', needs: ['kotlinc'], timeout: 900, slow: 120, env: { FONT_ONLY: 'android' }, holds: 'emulator' },
  // compose-target: CrowMark registered and drawn by Compose, on the desktop and as Jetpack Compose (the APK carries it)
  { name: 'compile/toolkit-font compose', file: 'test/compile/toolkit-font.ts', needs: ['kotlinc', 'java'], timeout: 900, slow: 30, env: { FONT_ONLY: 'compose' } },
  { name: 'compile/toolkit-font compose-android', file: 'test/compile/toolkit-font.ts', needs: ['kotlinc', 'java'], timeout: 1200, slow: 120, env: { FONT_ONLY: 'compose-android' }, holds: 'emulator' },
  // native-text-0003: Korean, Japanese and Chinese composed through each platform's input method entry points
  { name: 'compile/toolkit-compose macos', file: 'test/compile/toolkit-compose.ts', needs: ['swiftc'], timeout: 600, slow: 30, env: { COMPOSE_ONLY: 'macos' } },
  { name: 'compile/toolkit-compose ios', file: 'test/compile/toolkit-compose.ts', needs: ['xcrun'], timeout: 900, slow: 60, env: { COMPOSE_ONLY: 'ios' }, holds: 'simulator' },
  { name: 'compile/toolkit-compose android', file: 'test/compile/toolkit-compose.ts', needs: ['kotlinc'], timeout: 900, slow: 120, env: { COMPOSE_ONLY: 'android' }, holds: 'emulator' },
  // compose-target-0011: the same, through each Compose field's own text input session
  { name: 'compile/toolkit-compose compose', file: 'test/compile/toolkit-compose.ts', needs: ['kotlinc', 'java'], timeout: 900, slow: 30, env: { COMPOSE_ONLY: 'compose' } },
  { name: 'compile/toolkit-compose compose-android', file: 'test/compile/toolkit-compose.ts', needs: ['kotlinc', 'java'], timeout: 1200, slow: 120, env: { COMPOSE_ONLY: 'compose-android' }, holds: 'emulator' },
  // decision 096 of term/self-host/change/001-finish-self-host: a raise in a callback @term/site keeps for a host loop
  // is reported and the loop goes on (Rust and Swift legs wait for item 0464)
  { name: 'compile/slot-report typescript', file: 'test/compile/slot-report.ts', timeout: 300, env: { REPORT_ONLY: 'typescript' } },
  { name: 'compile/slot-report kotlin', file: 'test/compile/slot-report.ts', needs: ['kotlinc'], timeout: 900, slow: 60, env: { REPORT_ONLY: 'kotlin' } },
  // native-navigation-0002: one route table on every target, lowered before checking, a parameter and a load
  { name: 'compile/route-table typescript', file: 'test/compile/route-table.ts', timeout: 300, env: { ROUTE_ONLY: 'typescript' } },
  { name: 'compile/route-table macos', file: 'test/compile/route-table.ts', needs: ['swiftc'], timeout: 600, slow: 30, env: { ROUTE_ONLY: 'macos' } },
  { name: 'compile/route-table ios', file: 'test/compile/route-table.ts', needs: ['xcrun'], timeout: 900, slow: 60, env: { ROUTE_ONLY: 'ios' }, holds: 'simulator' },
  { name: 'compile/route-table android', file: 'test/compile/route-table.ts', needs: ['kotlinc'], timeout: 900, slow: 120, env: { ROUTE_ONLY: 'android' }, holds: 'emulator' },
  { name: 'compile/route-table compose', file: 'test/compile/route-table.ts', needs: ['kotlinc', 'java'], timeout: 900, slow: 30, env: { ROUTE_ONLY: 'compose' } },
  { name: 'compile/route-table compose-android', file: 'test/compile/route-table.ts', needs: ['kotlinc', 'java'], timeout: 1200, slow: 120, env: { ROUTE_ONLY: 'compose-android' }, holds: 'emulator' },
  // native-navigation-0007: the routed app on the toolkits, moved by the contract and by each platform's own back
  { name: 'compile/toolkit-navigation macos', file: 'test/compile/toolkit-navigation.ts', needs: ['swiftc'], timeout: 600, slow: 30, env: { NAVIGATION_ONLY: 'macos' } },
  { name: 'compile/toolkit-navigation ios', file: 'test/compile/toolkit-navigation.ts', needs: ['xcrun'], timeout: 900, slow: 60, env: { NAVIGATION_ONLY: 'ios' }, holds: 'simulator' },
  { name: 'compile/toolkit-navigation android', file: 'test/compile/toolkit-navigation.ts', needs: ['kotlinc'], timeout: 900, slow: 120, env: { NAVIGATION_ONLY: 'android' }, holds: 'emulator' },
  { name: 'compile/toolkit-navigation compose', file: 'test/compile/toolkit-navigation.ts', needs: ['kotlinc', 'java'], timeout: 900, slow: 30, env: { NAVIGATION_ONLY: 'compose' } },
  { name: 'compile/toolkit-navigation compose-android', file: 'test/compile/toolkit-navigation.ts', needs: ['kotlinc', 'java'], timeout: 1200, slow: 120, env: { NAVIGATION_ONLY: 'compose-android' }, holds: 'emulator' },
  // SwiftUI in a slot of the retained tree (swiftui-target-0001), on Apple
  { name: 'compile/toolkit-swiftui macos', file: 'test/compile/toolkit-swiftui.ts', needs: ['swiftc'], timeout: 600, slow: 30, env: { SWIFTUI_ONLY: 'macos' } },
  { name: 'compile/toolkit-swiftui ios', file: 'test/compile/toolkit-swiftui.ts', needs: ['xcrun'], timeout: 900, slow: 60, env: { SWIFTUI_ONLY: 'ios' }, holds: 'simulator' },
  // compose-target-0013: the composable slot, the SwiftUI slot's twin
  { name: 'compile/toolkit-swiftui compose', file: 'test/compile/toolkit-swiftui.ts', needs: ['kotlinc', 'java'], timeout: 900, slow: 30, env: { SWIFTUI_ONLY: 'compose' } },
  { name: 'compile/toolkit-swiftui compose-android', file: 'test/compile/toolkit-swiftui.ts', needs: ['kotlinc', 'java'], timeout: 1200, slow: 120, env: { SWIFTUI_ONLY: 'compose-android' }, holds: 'emulator' },
  // the portable keyboard (`listen-key`) through each platform's own key route (swiftui-target-0003)
  { name: 'compile/toolkit-keys macos', file: 'test/compile/toolkit-keys.ts', needs: ['swiftc'], timeout: 600, slow: 30, env: { KEYS_ONLY: 'macos' } },
  { name: 'compile/toolkit-keys ios', file: 'test/compile/toolkit-keys.ts', needs: ['xcrun'], timeout: 900, slow: 60, env: { KEYS_ONLY: 'ios' }, holds: 'simulator' },
  { name: 'compile/toolkit-keys android', file: 'test/compile/toolkit-keys.ts', needs: ['kotlinc'], timeout: 900, slow: 120, env: { KEYS_ONLY: 'android' }, holds: 'emulator' },
  { name: 'compile/toolkit-keys compose', file: 'test/compile/toolkit-keys.ts', needs: ['kotlinc', 'java'], timeout: 900, slow: 30, env: { KEYS_ONLY: 'compose' } },
  // disposal frees native views: forty branch swaps leave as many nodes alive as two (reactive-bridge-0005)
  { name: 'compile/toolkit-leak macos', file: 'test/compile/toolkit-leak.ts', needs: ['swiftc'], timeout: 600, slow: 30, env: { LEAK_ONLY: 'macos' } },
  { name: 'compile/toolkit-leak ios', file: 'test/compile/toolkit-leak.ts', needs: ['xcrun'], timeout: 900, slow: 60, env: { LEAK_ONLY: 'ios' }, holds: 'simulator' },
  { name: 'compile/toolkit-leak android', file: 'test/compile/toolkit-leak.ts', needs: ['kotlinc'], timeout: 900, slow: 120, env: { LEAK_ONLY: 'android' }, holds: 'emulator' },
  { name: 'compile/toolkit-leak compose', file: 'test/compile/toolkit-leak.ts', needs: ['kotlinc', 'java'], timeout: 900, slow: 30, env: { LEAK_ONLY: 'compose' } },
  { name: 'compile/toolkit-leak compose-android', file: 'test/compile/toolkit-leak.ts', needs: ['kotlinc', 'java'], timeout: 1200, slow: 120, env: { LEAK_ONLY: 'compose-android' }, holds: 'emulator' },
  // native-accessibility-0007: every word's role and name, read back from each platform's accessibility API
  { name: 'compile/toolkit-accessibility macos', file: 'test/compile/toolkit-accessibility.ts', needs: ['swiftc'], timeout: 600, slow: 30, env: { A11Y_ONLY: 'macos' } },
  { name: 'compile/toolkit-accessibility ios', file: 'test/compile/toolkit-accessibility.ts', needs: ['xcrun'], timeout: 900, slow: 60, env: { A11Y_ONLY: 'ios' }, holds: 'simulator' },
  { name: 'compile/toolkit-accessibility android', file: 'test/compile/toolkit-accessibility.ts', needs: ['kotlinc'], timeout: 900, slow: 120, env: { A11Y_ONLY: 'android' }, holds: 'emulator' },
  { name: 'compile/toolkit-accessibility compose', file: 'test/compile/toolkit-accessibility.ts', needs: ['kotlinc', 'java'], timeout: 900, slow: 30, env: { A11Y_ONLY: 'compose' } },
  { name: 'compile/toolkit-accessibility compose-android', file: 'test/compile/toolkit-accessibility.ts', needs: ['kotlinc', 'java'], timeout: 1200, slow: 120, env: { A11Y_ONLY: 'compose-android' }, holds: 'emulator' },
  // native-text-0004: every script the font table sets, its boxes per platform held to a baseline that may only shrink
  { name: 'compile/text-golden macos', file: 'test/compile/text-golden.ts', needs: ['swiftc'], timeout: 600, slow: 30, env: { GOLDEN_ONLY: 'macos' } },
  { name: 'compile/text-golden ios', file: 'test/compile/text-golden.ts', needs: ['xcrun'], timeout: 900, slow: 60, env: { GOLDEN_ONLY: 'ios' }, holds: 'simulator' },
  { name: 'compile/text-golden android', file: 'test/compile/text-golden.ts', needs: ['kotlinc'], timeout: 900, slow: 120, env: { GOLDEN_ONLY: 'android' }, holds: 'emulator' },
  // compose-target: the boxes Compose draws, through Skia's fallback on the desktop and the Paint's on Android
  { name: 'compile/text-golden compose', file: 'test/compile/text-golden.ts', needs: ['kotlinc', 'java'], timeout: 900, slow: 30, env: { GOLDEN_ONLY: 'compose' } },
  { name: 'compile/text-golden compose-android', file: 'test/compile/text-golden.ts', needs: ['kotlinc', 'java'], timeout: 1200, slow: 120, env: { GOLDEN_ONLY: 'compose-android' }, holds: 'emulator' },
  // native-dom-0049: the vocabulary's spacer, divider, image and scroll, and frame's bounds, read back off the views
  { name: 'compile/toolkit-words macos', file: 'test/compile/toolkit-words.ts', needs: ['swiftc'], timeout: 600, slow: 30, env: { WORDS_ONLY: 'macos' } },
  { name: 'compile/toolkit-words ios', file: 'test/compile/toolkit-words.ts', needs: ['xcrun'], timeout: 900, slow: 60, env: { WORDS_ONLY: 'ios' }, holds: 'simulator' },
  { name: 'compile/toolkit-words android', file: 'test/compile/toolkit-words.ts', needs: ['kotlinc'], timeout: 900, slow: 120, env: { WORDS_ONLY: 'android' }, holds: 'emulator' },
  { name: 'compile/toolkit-words compose', file: 'test/compile/toolkit-words.ts', needs: ['kotlinc', 'java'], timeout: 900, slow: 30, env: { WORDS_ONLY: 'compose' } },
  // the device capabilities (device-layer): the camera, the torch, location, the clipboard, vibration, notifications,
  // open and share, the battery, the network and motion through their contracts, each answer read back from the
  // platform where it keeps one (a grant, a position, a battery level, an acceleration the simulator or emulator was
  // told; the camera service's torch log; the vibrator's record; the posted notification; the photo's own bytes)
  { name: 'compile/device-features macos', file: 'test/compile/device-features.ts', needs: ['swiftc'], timeout: 600, slow: 30, env: { DEVICE_ONLY: 'macos' }, holds: 'pasteboard' },
  { name: 'compile/device-features ios', file: 'test/compile/device-features.ts', needs: ['xcrun'], timeout: 900, slow: 60, env: { DEVICE_ONLY: 'ios' }, holds: 'simulator' },
  { name: 'compile/device-features android', file: 'test/compile/device-features.ts', needs: ['kotlinc'], timeout: 900, slow: 120, env: { DEVICE_ONLY: 'android' }, holds: 'emulator' },
  { name: 'compile/device-features compose', file: 'test/compile/device-features.ts', needs: ['kotlinc', 'java'], timeout: 900, slow: 60, env: { DEVICE_ONLY: 'compose' } },
  { name: 'compile/device-features compose-android', file: 'test/compile/device-features.ts', needs: ['kotlinc', 'java'], timeout: 1800, slow: 180, env: { DEVICE_ONLY: 'compose-android' }, holds: 'emulator' },
  // the watchers (device-layer-0016): the platform is told a new place, battery level and acceleration every two
  // seconds, and each watcher must hear the change without being asked again; two share one subscription, one is
  // dropped at once and must hear nothing after
  { name: 'compile/device-watch macos', file: 'test/compile/device-watch.ts', needs: ['swiftc'], timeout: 600, slow: 30, env: { WATCH_ONLY: 'macos' } },
  { name: 'compile/device-watch ios', file: 'test/compile/device-watch.ts', needs: ['xcrun'], timeout: 900, slow: 60, env: { WATCH_ONLY: 'ios' }, holds: 'simulator' },
  { name: 'compile/device-watch android', file: 'test/compile/device-watch.ts', needs: ['kotlinc'], timeout: 900, slow: 120, env: { WATCH_ONLY: 'android' }, holds: 'emulator' },
  { name: 'compile/device-watch compose', file: 'test/compile/device-watch.ts', needs: ['kotlinc', 'java'], timeout: 900, slow: 60, env: { WATCH_ONLY: 'compose' } },
  { name: 'compile/device-watch compose-android', file: 'test/compile/device-watch.ts', needs: ['kotlinc', 'java'], timeout: 1800, slow: 180, env: { WATCH_ONLY: 'compose-android' }, holds: 'emulator' },
  // a notification on iOS through SpringBoard's own prompt (device-layer-0018): an XCUITest taps Allow and waits for
  // the banner SpringBoard draws with the notification's title
  { name: 'compile/notification-prompt ios', file: 'test/compile/notification-prompt.ts', needs: ['xcodebuild'], timeout: 1200, slow: 120, holds: 'simulator' },
  { name: 'compile/photos-prompt ios', file: 'test/compile/photos-prompt.ts', needs: ['xcodebuild'], timeout: 1200, slow: 120, holds: 'simulator' },
  { name: 'compile/device-audio macos', file: 'test/compile/device-audio.ts', needs: ['swiftc'], timeout: 600, slow: 30, env: { AUDIO_ONLY: 'macos' } },
  { name: 'compile/device-audio ios', file: 'test/compile/device-audio.ts', needs: ['xcrun'], timeout: 900, slow: 60, env: { AUDIO_ONLY: 'ios' }, holds: 'simulator' },
  // beat-term (beat-term-0015): the transfer modules, the app's screens and the toolkit make all reach the one shared
  // simulator, so each iOS entry holds it (traps.md#t008). They are in the skip list above so each() does not
  // also register them with no hold
  { name: 'compile/device-transfer macos', file: 'test/compile/device-transfer.ts', needs: ['swiftc'], timeout: 600, slow: 60, env: { TRANSFER_ONLY: 'macos' } },
  { name: 'compile/device-transfer ios', file: 'test/compile/device-transfer.ts', needs: ['xcrun'], timeout: 1200, slow: 60, env: { TRANSFER_ONLY: 'ios' }, holds: 'simulator' },
  { name: 'compile/beat-term screens', file: 'test/compile/beat-term.ts', needs: ['xcrun'], timeout: 1200, slow: 60, holds: 'simulator' },
  // the shipped build (beat-term-0022): it builds and reads plists, it never installs, so it holds nothing
  { name: 'compile/beat-term-build', file: 'test/compile/beat-term-build.ts', needs: ['xcrun'], timeout: 1800, slow: 120 },
  { name: 'compile/uikit-make', file:'test/compile/uikit-make.ts', needs: ['xcrun'], timeout: 1800, slow: 120, holds: 'simulator' },
  // the entry rule (beat-term-0017): UIKit apps built and launched on the shared simulator, Compose by its emitted source
  { name: 'compile/manifest-boot', file: 'test/compile/manifest-boot.ts', needs: ['xcrun'], timeout: 1800, slow: 120, holds: 'simulator' },
  // the permission prompt itself (device-layer-0001): Android's own dialog, answered by a tap found with uiautomator
  { name: 'compile/permission-prompt android allow', file: 'test/compile/permission-prompt.ts', needs: ['kotlinc'], timeout: 900, slow: 120, env: { PROMPT_ONLY: 'android', PROMPT_ANSWER: 'allow' }, holds: 'emulator' },
  { name: 'compile/permission-prompt android deny', file: 'test/compile/permission-prompt.ts', needs: ['kotlinc'], timeout: 900, slow: 120, env: { PROMPT_ONLY: 'android', PROMPT_ANSWER: 'deny' }, holds: 'emulator' },
  { name: 'compile/permission-prompt compose-android', file: 'test/compile/permission-prompt.ts', needs: ['kotlinc', 'java'], timeout: 1800, slow: 180, env: { PROMPT_ONLY: 'compose-android', PROMPT_ANSWER: 'allow' }, holds: 'emulator' },
  // the renderer and the memory host compile natively (native-dom-0002): swiftc and kotlinc over the emitted modules
  { name: 'native render', run: nativeRender, needs: ['swiftc', 'kotlinc'], timeout: 900, slow: 60 },
  { name: 'compile/hive-native rust', file: 'test/compile/hive-native.ts', needs: ['cargo'], timeout: 1200, slow: 40, env: { HV_ONLY: 'rust' } },
  { name: 'compile/hive-native swift', file: 'test/compile/hive-native.ts', needs: ['swiftc'], timeout: 600, slow: 20, env: { HV_ONLY: 'swift' } },
  { name: 'compile/hive-native kotlin', file: 'test/compile/hive-native.ts', needs: ['kotlinc'], timeout: 600, slow: 25, env: { HV_ONLY: 'kotlin' } },
  // a float as a map key (one NaN, -0.0 the same key as 0.0) and as a value under is-equal (IEEE), every backend
  // printing what TypeScript prints
  { name: 'compile/key-native typescript', file: 'test/compile/key-native.ts', timeout: 300, env: { KEY_ONLY: 'typescript' } },
  { name: 'compile/key-native rust', file: 'test/compile/key-native.ts', needs: ['rustc'], timeout: 600, slow: 20, env: { KEY_ONLY: 'rust' } },
  { name: 'compile/key-native swift', file: 'test/compile/key-native.ts', needs: ['swiftc'], timeout: 600, slow: 30, env: { KEY_ONLY: 'swift' } },
  { name: 'compile/key-native kotlin', file: 'test/compile/key-native.ts', needs: ['kotlinc', 'java'], timeout: 900, slow: 60, env: { KEY_ONLY: 'kotlin' } },
  // a form's tag read as a field (`s/form`, `s/kind`): the case's name as text on every backend
  { name: 'compile/tag-native typescript', file: 'test/compile/tag-native.ts', timeout: 300, env: { TAG_ONLY: 'typescript' } },
  { name: 'compile/tag-native rust', file: 'test/compile/tag-native.ts', needs: ['rustc'], timeout: 600, slow: 10, env: { TAG_ONLY: 'rust' } },
  { name: 'compile/tag-native swift', file: 'test/compile/tag-native.ts', needs: ['swiftc'], timeout: 600, slow: 15, env: { TAG_ONLY: 'swift' } },
  { name: 'compile/tag-native kotlin', file: 'test/compile/tag-native.ts', needs: ['kotlinc', 'java'], timeout: 900, slow: 30, env: { TAG_ONLY: 'kotlin' } },
  // `inspect` and `print` of @term/base/debug: one line of Term construction, the same bytes on every backend
  { name: 'compile/inspect-native typescript', file: 'test/compile/inspect-native.ts', timeout: 300, env: { INSPECT_ONLY: 'typescript' } },
  { name: 'compile/inspect-native rust', file: 'test/compile/inspect-native.ts', needs: ['rustc'], timeout: 600, slow: 10, env: { INSPECT_ONLY: 'rust' } },
  { name: 'compile/inspect-native swift', file: 'test/compile/inspect-native.ts', needs: ['swiftc'], timeout: 600, slow: 20, env: { INSPECT_ONLY: 'swift' } },
  { name: 'compile/inspect-native kotlin', file: 'test/compile/inspect-native.ts', needs: ['kotlinc', 'java'], timeout: 900, slow: 30, env: { INSPECT_ONLY: 'kotlin' } },
  // a raise's flow: Term frames, the same bytes on every backend, caught and uncaught (term/hive decision 001)
  { name: 'compile/raise-flow-native typescript', file: 'test/compile/raise-flow-native.ts', timeout: 300, env: { FLOW_ONLY: 'typescript' } },
  { name: 'compile/raise-flow-native rust', file: 'test/compile/raise-flow-native.ts', needs: ['rustc'], timeout: 600, slow: 10, env: { FLOW_ONLY: 'rust' } },
  { name: 'compile/raise-flow-native swift', file: 'test/compile/raise-flow-native.ts', needs: ['swiftc'], timeout: 600, slow: 20, env: { FLOW_ONLY: 'swift' } },
  { name: 'compile/raise-flow-native kotlin', file: 'test/compile/raise-flow-native.ts', needs: ['kotlinc', 'java'], timeout: 900, slow: 30, env: { FLOW_ONLY: 'kotlin' } },
  // named loops: `halt, name outer` and `turn next, name outer` reach the loop they name on every backend
  { name: 'compile/loop-name-native typescript', file: 'test/compile/loop-name-native.ts', timeout: 300, env: { LOOP_ONLY: 'typescript' } },
  { name: 'compile/loop-name-native rust', file: 'test/compile/loop-name-native.ts', needs: ['rustc'], timeout: 600, slow: 10, env: { LOOP_ONLY: 'rust' } },
  { name: 'compile/loop-name-native swift', file: 'test/compile/loop-name-native.ts', needs: ['swiftc'], timeout: 600, slow: 10, env: { LOOP_ONLY: 'swift' } },
  { name: 'compile/loop-name-native kotlin', file: 'test/compile/loop-name-native.ts', needs: ['kotlinc', 'java'], timeout: 900, slow: 20, env: { LOOP_ONLY: 'kotlin' } },
  // masks: `suit`, a mask's default tasks, and a mask task's result typed and range-checked, run on every toolchain
  { name: 'compile/mask-native typescript', file: 'test/compile/mask-native.ts', timeout: 300, env: { MASK_ONLY: 'typescript' } },
  { name: 'compile/mask-native rust', file: 'test/compile/mask-native.ts', needs: ['rustc'], timeout: 600, slow: 10, env: { MASK_ONLY: 'rust' } },
  { name: 'compile/mask-native swift', file: 'test/compile/mask-native.ts', needs: ['swiftc'], timeout: 600, slow: 10, env: { MASK_ONLY: 'swift' } },
  { name: 'compile/mask-native kotlin', file: 'test/compile/mask-native.ts', needs: ['kotlinc', 'java'], timeout: 900, slow: 20, env: { MASK_ONLY: 'kotlin' } },
  // an `unknown` narrowed by a `sift` over its type, on every toolchain, and the seam's refusals
  { name: 'compile/unknown-narrow typescript', file: 'test/compile/unknown-narrow.ts', timeout: 300, env: { NARROW_ONLY: 'typescript' } },
  { name: 'compile/unknown-narrow rust', file: 'test/compile/unknown-narrow.ts', needs: ['rustc'], timeout: 600, slow: 10, env: { NARROW_ONLY: 'rust' } },
  { name: 'compile/unknown-narrow swift', file: 'test/compile/unknown-narrow.ts', needs: ['swiftc'], timeout: 600, slow: 10, env: { NARROW_ONLY: 'swift' } },
  { name: 'compile/unknown-narrow kotlin', file: 'test/compile/unknown-narrow.ts', needs: ['kotlinc', 'java'], timeout: 900, slow: 20, env: { NARROW_ONLY: 'kotlin' } },
  // one table of what a native list and map answer, and the refusal of the rest before emit (check/lowered.ts)
  { name: 'compile/lowered-members typescript', file: 'test/compile/lowered-members.ts', timeout: 300, env: { LOWERED_ONLY: 'typescript' } },
  { name: 'compile/lowered-members rust', file: 'test/compile/lowered-members.ts', needs: ['rustc'], timeout: 600, slow: 10, env: { LOWERED_ONLY: 'rust' } },
  { name: 'compile/lowered-members swift', file: 'test/compile/lowered-members.ts', needs: ['swiftc'], timeout: 600, slow: 10, env: { LOWERED_ONLY: 'swift' } },
  { name: 'compile/lowered-members kotlin', file: 'test/compile/lowered-members.ts', needs: ['kotlinc', 'java'], timeout: 900, slow: 20, env: { LOWERED_ONLY: 'kotlin' } },
  // jobs run at once and interleave at their waits on every backend, and a ticked value is its pending job
  { name: 'compile/spawn-native typescript', file: 'test/compile/spawn-native.ts', timeout: 300, env: { SPAWN_ONLY: 'typescript' } },
  { name: 'compile/spawn-native rust', file: 'test/compile/spawn-native.ts', needs: ['rustc'], timeout: 600, slow: 20, env: { SPAWN_ONLY: 'rust' } },
  { name: 'compile/spawn-native swift', file: 'test/compile/spawn-native.ts', needs: ['swiftc'], timeout: 600, slow: 30, env: { SPAWN_ONLY: 'swift' } },
  { name: 'compile/spawn-native kotlin', file: 'test/compile/spawn-native.ts', needs: ['kotlinc', 'java'], timeout: 900, slow: 60, env: { SPAWN_ONLY: 'kotlin' } },
  // a prop read off a caught value, `problem/link/actual`, on every backend
  { name: 'compile/caught-prop-native typescript', file: 'test/compile/caught-prop-native.ts', timeout: 300, env: { CAUGHT_ONLY: 'typescript' } },
  { name: 'compile/caught-prop-native rust', file: 'test/compile/caught-prop-native.ts', needs: ['rustc'], timeout: 600, slow: 10, env: { CAUGHT_ONLY: 'rust' } },
  { name: 'compile/caught-prop-native swift', file: 'test/compile/caught-prop-native.ts', needs: ['swiftc'], timeout: 600, slow: 10, env: { CAUGHT_ONLY: 'swift' } },
  { name: 'compile/caught-prop-native kotlin', file: 'test/compile/caught-prop-native.ts', needs: ['kotlinc', 'java'], timeout: 900, slow: 20, env: { CAUGHT_ONLY: 'kotlin' } },
]

const args = process.argv.slice(2)
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] ?? '' : ''
const list = args.includes('--list')
// `--fresh` runs every suite, ignoring the result cache (task/term/gate/cache.ts)
const fresh = args.includes('--fresh')
const cache = makeCache(ROOT, TERM)

// and every per-item memo inside a suite (test/memo.ts), which the suites inherit
if (fresh) {
  process.env.TERM_MEMO = 'off'
}

// every test app a suite launches opens its window past the right edge of the screens and never takes focus, so a gate
// run does not throw windows over whatever the person at the machine is typing into (native-view.swift, cask.swift)
process.env.TERM_WINDOW_AWAY ??= '1'
// the minute-long checks some suites keep behind an environment flag (the three-variable CAD cases) run under --full
if (args.includes('--full')) {
  process.env.CAD_FULL = '1'
}

const jobs = args.includes('--jobs')
  ? Math.max(1, Number(args[args.indexOf('--jobs') + 1] ?? 1))
  : Math.max(1, Math.min(8, cpus().length - 1))

let pass = 0
let fail = 0
let skipped = 0
const failed: string[] = []

// `--skip <substr>` leaves out the suites whose name holds it (a suite waiting on another session's line lock)
// (several, comma-separated)
const skipNames = args.includes('--skip') ? (args[args.indexOf('--skip') + 1] ?? '').split(',').filter(name => name !== '') : []
const named = SUITES.filter(suite => (!only || suite.name.includes(only)) && !skipNames.some(name => suite.name.includes(name)))

// `--quick [seconds]`: leave out every suite whose last run (or, before its first, its hand-written `slow`) took
// longer than the budget. Measured 2026-10-02: 199 of 241 suites run under 30s and sum to about two minutes at eight
// jobs, while the other 42 hold over 85% of the gate's 8,367 suite-seconds
const quickAt = args.indexOf('--quick')
const quick = quickAt >= 0 ? Number(/^\d+$/.test(args[quickAt + 1] ?? '') ? args[quickAt + 1] : 30) : undefined
const tooSlow = (suite: Suite): boolean =>
  quick !== undefined && (cache.lastSeconds(suite.name) ?? suite.slow ?? 0) > quick
const leftOut = named.filter(tooSlow)
const chosen = named.filter(suite => !tooSlow(suite))

if (list) {
  for (const suite of chosen) {
    console.log(suite.name)
  }

  process.exit(0)
}

// a suite whose answer rides on something outside the files it reads is run every time
const cacheable = (suite: Suite): boolean => suite.cache !== false && !(suite.needsEnv?.length)

// the queue: longest first, by the time each suite took the last time it ran (a hand-written `slow` only until it
// has run once), so the slow suites start at once and the short ones fill the gaps behind them
const expected = (suite: Suite): number => cache.lastSeconds(suite.name) ?? suite.slow ?? 0
const queue = [...chosen].sort((a, b) => expected(b) - expected(a))
let cached = 0
let cachedSeconds = 0

async function runOne(suite: Suite): Promise<void> {
  const missing = [
    ...(suite.needs ?? []).filter(tool => !have(tool)),
    ...(suite.needsEnv ?? []).filter(name => !process.env[name]),
  ]

  if (missing.length) {
    skipped++
    console.log(`skip  ${suite.name.padEnd(36)} needs ${missing.join(', ')}`)

    return
  }

  const track = cacheable(suite) ? cache.trackDir(suite.name) : undefined
  // a suite with `holds` runs under the machine-wide hold the worker took: its child inherits it through TERM_HELD, so
  // a harness that takes the same hold itself answers at once (test/compile/shared/device-hold.ts)
  const heldHere = suite.holds
    ? { TERM_HELD: [...(process.env.TERM_HELD ?? '').split(',').filter(name => name !== ''), suite.holds].join(',') }
    : {}
  // the suite's own temporary folder: everything it makes through os.tmpdir() lands there, and is removed below
  const scratch = makeScratch('tt')

  scratches.add(scratch)

  const env: Record<string, string> = { ...(suite.env ?? {}), ...(track ? cache.trackEnv(track, suite.env) : {}), ...heldHere, ...scratchEnv(scratch) }

  // the kept corpus of a checker census (decision 096 rule 8 of term/self-host/change/001-finish-self-host): with
  // TERM_CENSUS_KEEP set, every Node process of the suite keeps each program it builds (task/term/census-keep.cjs),
  // named for the suite. Run with --fresh, or a cached suite builds nothing and keeps nothing
  if (process.env.TERM_CENSUS_KEEP) {
    env.TERM_SUITE = suite.name
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? process.env.NODE_OPTIONS ?? ''} --require ${join(ROOT, 'task/term/census-keep.cjs')}`.trim()
  }

  const started = Date.now()
  const ran = suite.run ? await suite.run(env) : await script(suite.file!, suite.timeout, env)
  // what the suite left in its temporary folder: removed below either way, named at the end of the run, and a failure
  // under --temp-strict. A test removes what it makes (test/temp.ts `tempDir`)
  const left = leftIn(scratch)
  const leftNote = `left ${left.length} in its temporary folder: ${left.slice(0, 4).join(', ')}${left.length > 4 ? ', ...' : ''}`

  if (left.length > 0 && !ran.skipped) {
    leftBehind.push(`${suite.name} (${left.length}: ${left.slice(0, 3).join(', ')}${left.length > 3 ? ', ...' : ''})`)
  }

  const result: Result = left.length === 0 || ran.skipped || !tempStrict
    ? ran
    : { ...ran, ok: false, fail: ran.fail + 1, note: `${ran.note ? `${ran.note} | ` : ''}${leftNote}` }

  scratches.delete(scratch)

  if (keepTemp) {
    console.log(`kept  ${suite.name.padEnd(36)} ${scratch}`)
  } else {
    removeTree(scratch)
  }

  const elapsed = (Date.now() - started) / 1000
  const seconds = elapsed.toFixed(1)
  const count = result.fail ? `${result.pass} pass, ${result.fail} fail` : `${result.pass} pass`

  cache.noteSeconds(suite.name, elapsed)

  if (result.skipped) {
    // never stored: the next run, with the device back, must run it
    skipped++
    cache.forget(suite.name)
    console.log(`skip  ${suite.name.padEnd(36)} ${result.skipped}`)
  } else if (result.ok) {
    pass++

    // a pass is stored with every input it read; a suite whose record cannot be trusted is simply not stored
    const stored = track ? cache.store(suite, track, { pass: result.pass, note: result.note, seconds: elapsed }) : undefined
    console.log(`ok    ${suite.name.padEnd(36)} ${count.padEnd(22)} ${seconds}s${stored && !stored.ok ? `  (not cached: ${stored.reason})` : ''}`)
  } else {
    fail++
    failed.push(suite.name)
    cache.forget(suite.name)
    console.log(`FAIL  ${suite.name.padEnd(36)} ${count.padEnd(22)} ${seconds}s  ${result.note}`)
  }

  // never fatal: a suite's child can still be writing here, and ENOTEMPTY ended a whole run (gate/cache.ts `store`)
  if (track) {
    try {
      rmSync(track, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // left for the system's temporary folder to clear
    }
  }
}

// the devices a running suite holds, and a promise that settles whenever one is let go
const held = new Set<string>()
let letGo: () => void = () => {}
let released = new Promise<void>(settle => { letGo = settle })

async function worker(): Promise<void> {
  for (;;) {
    if (queue.length === 0) {
      return
    }

    // the longest suite whose device is free; when every one left waits on a held device, wait for it
    const at = queue.findIndex(suite => !suite.holds || !held.has(suite.holds))

    if (at === -1) {
      await released
      continue
    }

    const [suite] = queue.splice(at, 1)

    if (suite.holds) {
      held.add(suite.holds)
    }

    let release = (): void => {}

    try {
      // the lock folder every process on the Mac respects: a second gate run, or a builder's direct run, waits here
      if (suite.holds) {
        release = await holdDevice(suite.holds, suite.name)
      }

      await runOne(suite)
    } finally {
      release()

      if (suite.holds) {
        held.delete(suite.holds)
        const settle = letGo
        released = new Promise<void>(next => { letGo = next })
        settle()
      }
    }
  }
}

async function main(): Promise<void> {
  const started = Date.now()

  // the scratch folders of runs killed past their cleanup, then what the machine's temporary folder holds now
  sweepStaleRuns()
  const tempBefore = madeEntries()

  // a suite whose last pass still stands is answered from the cache before the pool starts, so it holds no slot
  if (!fresh) {
    for (const suite of [...queue]) {
      const entry = cacheable(suite) ? cache.lookup(suite) : undefined

      // a stored pass of nothing proves nothing (a skip recorded before skips were told apart): run it
      if (!entry || entry.pass === 0) {
        continue
      }

      queue.splice(queue.indexOf(suite), 1)
      pass++
      cached++
      cachedSeconds += entry.seconds
      console.log(`ok    ${suite.name.padEnd(36)} ${`${entry.pass} pass`.padEnd(22)} cached, ran ${entry.at.slice(0, 16).replace('T', ' ')} in ${entry.seconds.toFixed(1)}s`)
    }
  }

  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, worker))
  cache.saveSeconds()

  console.log(
    `\nterm: ${pass} suites pass, ${fail} fail, ${skipped} skipped in ${((Date.now() - started) / 1000).toFixed(0)}s with ${jobs} jobs` +
      (cached ? `, ${cached} from the cache (${cachedSeconds.toFixed(0)}s of suite time not spent, --fresh runs them)` : '') +
      (failed.length ? `\n  failing: ${failed.join(', ')}` : ''),
  )

  // a quick run is not the gate: say what it did not run, and what those cost
  if (leftOut.length) {
    const seconds = leftOut.reduce((sum, suite) => sum + (cache.lastSeconds(suite.name) ?? suite.slow ?? 0), 0)
    console.log(
      `  LEFT OUT by --quick ${quick}: ${leftOut.length} suites, ${seconds.toFixed(0)}s of suite time, NOT run:\n    ` +
        leftOut.map(suite => suite.name).join(', '),
    )
  }

  if (leftBehind.length) {
    console.log(
      `  LEFT temporary folders (removed by the gate, ${tempStrict ? 'failed' : 'a failure under --temp-strict'}): ${leftBehind.length} suites\n    ` +
        leftBehind.join('\n    '),
    )
  }

  // the post-check: no new temporary folder in the machine's own temporary folder, made outside a suite's TMPDIR, and
  // none of this run's own scratch folders left (a removal that raced a suite's lingering child is retried here)
  const leaked = [...madeSince(tempBefore), ...(keepTemp ? [] : removeOwnRuns())]

  if (leaked.length > 0) {
    console.log(
      `FAIL  temp-leak: ${leaked.length} new in ${SYSTEM_TEMP}: ${leaked.slice(0, 8).join(', ')}${leaked.length > 8 ? ', ...' : ''}` +
        '\n  (a suite made a temporary folder outside its TMPDIR, or another session made one meanwhile: rerun to tell)',
    )
    process.exit(1)
  }

  if (fail > 0) {
    process.exit(1)
  }
}

main()
