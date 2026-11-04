// THE BASELINES, re-taken by one command (term-self-host-001-0015,
// note/project/term/self-host/verification.md#baselines).
//
//   node task/term/baselines.ts                  make:line, then every gate one at a time, against that state
//   node task/term/baselines.ts --hold           the same, holding the make:line lock for the whole run
//   node task/term/baselines.ts --only a,b       only those gates (after the make:line); `--list` names them
//   node task/term/baselines.ts --no-line        skip the make:line (only when one just succeeded)
//
// A baseline taken while a compiler builder is half way through an edit is worthless, so the run starts with
// `make:line` (which takes the line lock itself, decision note/project/term/decision/002-make-line-lock.md) and
// records the STATE it measured: the git commit, a sha256 over the working tree's deck/make (code and test, every
// file, sorted by path) and over host/line.js. Each gate's state is fingerprinted again before and after it runs. A
// gate whose fingerprint differs from the make:line state is marked `moved`: another session rebuilt or edited the
// compiler while it ran, so its number belongs to no one state, and `--only <gate>` re-takes it.
//
// `--hold` takes the line lock for the whole run (through line-lock.ts `run`, so the make:line inside passes
// through on the inherited token). By the lock's rule no live compiler file is edited and no make:line runs while
// it is held, so nothing moves, but every builder's switch waits for the run (about two hours with the board).
//
// It refuses to start while a board runs (`traps.md#t032`: two boards exhaust memory and spoil both), unless `--only`
// names only the seconds-long counts (left, floor, defaulting-writes), which neither load the machine nor depend on
// its load. Each failing
// board suite is then run ALONE (`--only <suite> --jobs 2`) and recorded as failing alone or passing alone.
//
// Writes only under <term>/tmp/self-host/baselines/<stamp>/ (a new folder per run, never overwritten): a log per
// gate, summary.json and summary.md (the table verification.md holds). Prints the table.
//
// Exit 0 when every gate ran, 1 when one could not run or make:line failed, 2 on a usage error, 3 when a board is
// already running.
//
// Plain node (Node strips the types), CommonJS, node builtins only, like line-lock.ts.

const { spawn, spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } = require('node:fs')
const { dirname, join, relative, resolve } = require('node:path')

const REPO = (process.env.TERM_ROOT || require('node:path').resolve(__dirname, '../..'))
const TERM = (process.env.TERM_ROOT || require('node:path').resolve(__dirname, '../..'))
const MAKE = join(TERM, 'deck', 'make')
const LINE = join(TERM, 'host', 'line.js')
const TSX = join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const VITEST = join(TERM, 'node_modules', 'vitest', 'vitest.mjs')
const LOCK = join(REPO, 'task', 'term', 'line-lock.ts')
const OUT = join(TERM, 'tmp', 'self-host', 'baselines')
const SKIP_DIRS = new Set(['host', 'tmp', 'node_modules', '.base', 'link', '.git'])
const LIGHT = new Set(['left', 'floor', 'defaulting-writes'])

type Gate = {
  name: string
  label: string
  cwd: string
  command: string[]
  minutes: number
  // the baseline's number, read from the log
  read: (log: string, exit: number | null) => string
}

type State = { commit: string; dirty: number; make: string; line: string }

type Run = {
  name: string
  label: string
  command: string
  exit: number | null
  seconds: number
  number: string
  moved: boolean
  log: string
  tail: string[]
}

function strip(text: string): string {
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
}

function last(log: string, pattern: RegExp): RegExpMatchArray | undefined {
  const all = [...strip(log).matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))]
  return all[all.length - 1]
}

function tsxIn(cwd: string, script: string, ...args: string[]): { cwd: string; command: string[] } {
  return { cwd, command: [process.execPath, TSX, script, ...args] }
}

const GATES: Gate[] = [
  {
    name: 'node-switch',
    label: 'switch typecheck, `run-node-switch.sh`',
    cwd: REPO,
    command: ['sh', join(require('./root').parentRoot(), 'tmp/run-node-switch.sh')],
    minutes: 15,
    read: log => {
      const m = last(log, /errors in all: (\d+)/)
      return m ? `${m[1]} errors` : 'unparsed'
    },
  },
  {
    name: 'vitest',
    label: 'vitest',
    cwd: TERM,
    command: [process.execPath, VITEST, 'run'],
    minutes: 30,
    read: log => {
      const files = last(log, /Test Files\s+(.*?)\s*\(/)
      const tests = last(log, /Tests\s+(.*?)\s*\(/)
      return tests ? `tests ${tests[1]}; files ${files ? files[1] : '?'}` : 'unparsed'
    },
  },
  {
    name: 'term-tests',
    label: 'Term tests in `deck/test/test` and `deck/make/test`',
    cwd: REPO,
    command: ['sh', join(require('./root').parentRoot(), 'tmp/self-host-term-tests.sh')],
    minutes: 40,
    read: log => {
      const lines = strip(log).split('\n').filter(line => /\b\d+ (pass|passed|fail|failed)\b/.test(line))
      return lines.length > 0 ? lines.slice(-2).map(line => line.trim()).join(' / ') : 'unparsed'
    },
  },
  {
    name: 'port-native',
    label: '`term:port-native`',
    ...tsxIn(TERM, 'task/term/port-native.ts'),
    minutes: 60,
    read: (log, exit) => `exit ${exit}; ${lastLine(log)}`,
  },
  {
    name: 'mint-parity',
    label: '`term:mint-parity`',
    ...tsxIn(TERM, 'task/term/mint-parity.ts'),
    minutes: 30,
    read: (log, exit) => `exit ${exit}; ${lastLine(log)}`,
  },
  {
    name: 'edit-replay',
    label: '`term:edit-replay`',
    ...tsxIn(TERM, 'task/term/edit-replay.ts'),
    minutes: 30,
    read: log => {
      const m = last(log, /edit-replay: (\d+) pass, (\d+) fail/)
      return m ? `${m[1]} pass, ${m[2]} fail` : 'unparsed'
    },
  },
  {
    name: 'separate-diff',
    label: '`term:separate-diff`',
    ...tsxIn(TERM, 'task/term/separate-diff.ts'),
    minutes: 30,
    read: log => {
      const m = last(log, /separate-diff: (\d+) pass, (\d+) fail/)
      return m ? `${m[1]} pass, ${m[2]} fail` : 'unparsed'
    },
  },
  {
    name: 'sweep',
    label: 'the sweep, `pair-sweep.ts`',
    ...tsxIn(TERM, 'task/term/pair-sweep.ts'),
    minutes: 120,
    read: log => {
      const run = last(log, /SWEEP (\d+) lines run of (\d+)/)
      const pass = last(log, /PASS: (\d+)/)
      const fail = last(log, /FAIL: (\d+)(.*)/)
      const timeout = last(log, /TIMEOUT: (\d+)(.*)/)
      const unparsed = last(log, /UNPARSED: (\d+)(.*)/)
      if (!run || !pass) return 'unparsed'
      const named = (m: RegExpMatchArray | undefined, word: string): string =>
        m && m[1] !== '0' ? `, ${m[1]} ${word} (${m[2].trim()})` : ''
      return `${pass[1]} PASS of ${run[2]}${named(fail, 'FAIL')}${named(timeout, 'TIMEOUT')}${named(unparsed, 'UNPARSED')}`
    },
  },
  {
    name: 'left',
    label: '`self-host-left.ts` (the inventory)',
    ...tsxIn(TERM, 'task/term/self-host-left.ts'),
    minutes: 10,
    read: log => {
      const m = last(log, /^total\s+(\d+) files\s+(\d+) lines: (.*)$/m)
      return m ? `${m[1]} files, ${m[2]} lines: ${m[3]}` : 'unparsed'
    },
  },
  {
    name: 'floor',
    label: '`term:floor`',
    ...tsxIn(REPO, 'task/term/floor.ts'),
    minutes: 10,
    read: (log, exit) => {
      const out = last(log, /(\d+) files and (\d+) lines outside the floor/)
      const fresh = last(log, /NEW outside the floor, (\d+) file/)
      const gone = last(log, /(\d+) baselined file\(s\) are gone/)
      return `exits ${exit}; ${out ? `${out[1]} files, ${out[2]} lines outside` : 'unparsed'}; ${fresh ? fresh[1] : 0} new, ${gone ? gone[1] : 0} gone`
    },
  },
  {
    name: 'defaulting-writes',
    label: '`count-defaulting-writes.sh`',
    cwd: REPO,
    command: ['sh', join(require('./root').parentRoot(), 'tmp/count-defaulting-writes.sh')],
    minutes: 5,
    read: log => {
      const lines = strip(log).split('\n').map(line => line.trim()).filter(Boolean)
      const extra = lines.filter(line => line !== 'checked').map(line => line.replace(`${MAKE}/`, ''))
      return extra.length === 0 && lines.includes('checked') ? 'prints only `checked`' : `${extra.length} port(s) over 3: ${extra.slice(0, 3).join('; ')}`
    },
  },
  {
    name: 'board',
    label: 'the board, `term:test`',
    ...tsxIn(REPO, 'task/term/test.ts'),
    minutes: 180,
    read: log => {
      const m = last(log, /term: (\d+) suites pass, (\d+) fail, (\d+) skipped/)
      return m ? `${m[1]} pass, ${m[2]} fail, ${m[3]} skipped` : 'unparsed'
    },
  },
]

function lastLine(log: string): string {
  const lines = strip(log).split('\n').map(line => line.trim()).filter(Boolean)
  return lines[lines.length - 1] ?? '(no output)'
}

// ---- the state ----

function hashTree(base: string): string {
  const hash = createHash('sha256')
  const files: string[] = []

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name))
      } else if (entry.isFile()) {
        files.push(join(dir, entry.name))
      }
    }
  }

  walk(base)
  files.sort()

  for (const file of files) {
    hash.update(relative(base, file))
    hash.update('\0')
    hash.update(readFileSync(file))
    hash.update('\0')
  }

  return `${hash.digest('hex').slice(0, 16)} (${files.length} files)`
}

function hashFile(file: string): string {
  return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16) : 'missing'
}

// the Term package is its own git repository (deck/ is ignored by the outer one)
function git(...args: string[]): string {
  const result = spawnSync('git', ['-C', TERM, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return (result.stdout ?? '').trim()
}

function readState(): State {
  return {
    commit: git('rev-parse', '--short=12', 'HEAD'),
    dirty: git('status', '--porcelain', '--', relative(TERM, MAKE)).split('\n').filter(Boolean).length,
    make: hashTree(MAKE),
    line: hashFile(LINE),
  }
}

function same(a: State, b: State): boolean {
  return a.make === b.make && a.line === b.line
}

// ---- running ----

function boardsRunning(): string[] {
  const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return (result.stdout ?? '')
    .split('\n')
    .filter((line: string) => line.includes('task/term/test.ts') && !line.includes('baselines.ts'))
    .map((line: string) => line.trim())
}

function run(cwd: string, command: string[], logFile: string, minutes: number): Promise<{ exit: number | null; seconds: number }> {
  const started = Date.now()

  return new Promise(done => {
    const log = createWriteStream(logFile)
    log.write(`$ (cd ${cwd}) ${command.join(' ')}\n`)
    const child = spawn(command[0], command.slice(1), { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    child.stdout.pipe(log, { end: false })
    child.stderr.pipe(log, { end: false })

    const timer = setTimeout(() => {
      log.write(`\nbaselines: killed after ${minutes} minutes\n`)
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }, minutes * 60_000)

    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      log.end(() => done({ exit: code, seconds: Math.round((Date.now() - started) / 1000) }))
    })
  })
}

function usage(message: string): never {
  process.stderr.write(`${message}\nusage: node task/term/baselines.ts [--hold] [--no-line] [--only a,b] [--list]\n`)
  process.exit(2)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let only: string[] | null = null
  let hold = false
  let line = true

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--hold') hold = true
    else if (arg === '--held') continue
    else if (arg === '--no-line') line = false
    else if (arg === '--only') only = (args[++i] ?? usage('--only needs gate names')).split(',')
    else if (arg === '--list') {
      for (const gate of GATES) console.log(`${gate.name.padEnd(18)} ${gate.label}`)
      return
    } else usage(`unknown argument ${arg}`)
  }

  for (const name of only ?? []) {
    if (!GATES.some(gate => gate.name === name)) usage(`no gate named ${name}`)
  }

  const boards = boardsRunning()
  // the seconds-long counts neither load the machine nor depend on its load, so they may run beside a board
  const light = only !== null && only.every(name => LIGHT.has(name))

  if (boards.length > 0 && !light) {
    process.stderr.write(`baselines: a board is running (traps.md#t032), refusing:\n  ${boards.join('\n  ')}\n`)
    process.exit(3)
  }

  // --hold: run this whole command again inside the line lock. make:line inside passes through on the token
  if (hold && !process.env.TERM_LINE_LOCK) {
    const inner = args.filter(arg => arg !== '--hold')
    const result = spawnSync(process.execPath, [LOCK, 'run', '--by', 'baselines', '--', process.execPath, __filename, '--held', ...inner], { stdio: 'inherit' })
    process.exit(result.status ?? 1)
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = join(OUT, stamp)

  if (existsSync(dir)) usage(`${dir} exists; never overwritten`)
  mkdirSync(dir, { recursive: true })

  if (line) {
    process.stderr.write('baselines: make:line (waits for the line lock)\n')
    const built = await run(TERM, ['pnpm', 'run', 'make:line'], join(dir, 'make-line.log'), 60)
    if (built.exit !== 0) {
      process.stderr.write(`baselines: make:line failed (exit ${built.exit}), see ${join(dir, 'make-line.log')}\n`)
      process.exit(1)
    }
  }

  const state = readState()
  const taken = new Date().toISOString()
  process.stderr.write(`baselines: state ${state.commit}, ${state.dirty} uncommitted under deck/make, deck/make ${state.make}, line.js ${state.line}\n`)

  const runs: Run[] = []
  const gates = GATES.filter(gate => only === null || only.includes(gate.name))

  for (const gate of gates) {
    const logFile = join(dir, `${gate.name}.log`)
    process.stderr.write(`baselines: ${gate.name} ...\n`)
    const before = readState()
    const { exit, seconds } = await run(gate.cwd, gate.command, logFile, gate.minutes)
    const after = readState()
    // the first line is the command this run wrote, not the gate's output
    const log = readFileSync(logFile, 'utf8').split('\n').slice(1).join('\n')
    const moved = !same(before, state) || !same(after, state)

    const one: Run = {
      name: gate.name,
      label: gate.label,
      command: gate.command.join(' '),
      exit,
      seconds,
      number: gate.read(log, exit),
      moved,
      log: relative(REPO, logFile),
      tail: strip(log).split('\n').filter(Boolean).slice(-15),
    }

    runs.push(one)
    process.stderr.write(`  ${one.number}${moved ? '  MOVED' : ''} (${seconds}s)\n`)

    if (gate.name === 'board') {
      await attribute(log, dir, one)
    }
  }

  const summary = { taken, state, held: process.argv.includes('--held'), runs }
  writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)

  const day = taken.slice(0, 10)
  const table = [
    `State: commit ${state.commit}, ${state.dirty} uncommitted file(s) under deck/make, deck/make sha256 ${state.make}, host/line.js ${state.line}, taken ${taken}${summary.held ? ', under the line lock' : ''}.`,
    '',
    '| gate | baseline | as of |',
    '| --- | --- | --- |',
    ...runs.map(r => `| ${r.label} | ${r.number.replace(/\|/g, '/')}${r.moved ? ' (MOVED: the tree changed while it ran)' : ''} | ${day} |`),
  ].join('\n')

  writeFileSync(join(dir, 'summary.md'), `${table}\n`)
  console.log(table)
  console.log(`\nlogs and summary: ${relative(REPO, dir)}`)
  process.exitCode = runs.some(r => r.number === 'unparsed') ? 1 : 0
}

// every failing board suite run alone, two jobs
async function attribute(log: string, dir: string, board: Run): Promise<void> {
  const m = last(log, /failing: (.*)$/m)
  if (!m) return

  const names = m[1].split(',').map(name => name.trim()).filter(Boolean)
  const alone: string[] = []

  for (const [i, name] of names.entries()) {
    const file = join(dir, `board-alone-${i}.log`)
    process.stderr.write(`  alone: ${name}\n`)
    const { exit } = await run(REPO, [process.execPath, TSX, 'task/term/test.ts', '--only', name, '--jobs', '2'], file, 45)
    const text = readFileSync(file, 'utf8')
    const result = last(text, /term: (\d+) suites pass, (\d+) fail/)
    alone.push(`${name}: ${exit === 0 ? 'passes alone' : 'fails alone'}${result ? ` (${result[1]} pass, ${result[2]} fail)` : ''}`)
  }

  writeFileSync(join(dir, 'board-alone.txt'), `${alone.join('\n')}\n`)
  board.tail.push(...alone)
}

main().catch(error => {
  process.stderr.write(`baselines: ${error?.stack ?? error}\n`)
  process.exit(1)
})
