// A RAISE TERM CODE CAUGHT ENDS THE RUN THROUGH THE PRINTER'S fail-raised-run (term/compiler decision 021 points 10 and
// 10a, item term-self-host-001-1478). A probe program catches one raise (`halt take`) and hands it to fail-raised-run
// with the working folder as its root, and a twin hands the same raise to node's fail-run (printer-input.tree), the
// answer node gives today. Each is built and run by this checkout's CLI (`term make --emit <target> --run`), once per
// raise: a Term failure, a Term defect, a file failure (a folder read as a file, node's words on every backend), and on
// node a host Error (node's ENOENT) and a host TypeError, which the TypeScript catch reads as a failure and a defect.
// On node fail-raised-run's exit, stdout and stderr equal fail-run's, the time and the crash log's stamp masked. On Rust
// (when cargo is installed) they equal node's for the raises a Rust program can meet. A defect and a TypeError are a
// bug in Term: exit 70, the crash item, one crash log under the root, fail-raised-run's holding the Term stack.
// Run: npx tsx test/call/printer-raised.ts

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' }
for (const name of ['TERM_DEPTH', 'TERM_LINE_NAME', 'TERM_LINE_LOCK', 'TERM_LINE_LOCK_BY', 'TERM_ROOT', 'TERM_STDLIB', 'FORCE_COLOR', 'CI'])
  delete env[name]

const out = mkdtempSync(join(tmpdir(), 'term-printer-raised-'))

// each raise as the body of the probe's `raise` task, and whether a Rust program can meet it
const RAISES: Record<string, { body: string; rust: boolean }> = {
  failure: { body: '  halt <probe failure>\n', rust: true },
  defect: { body: '  halt defect\n    bind thing, <probe>\n', rust: true },
  folder: { body: '  call read-file\n    text <code>\n', rust: true },
  host: { body: '  call host-read\n    text </no/such/term-1478>\n', rust: false },
  type: { body: '  call type-read\n    text <abc>\n', rust: false },
}

// the node binds that throw a host value, loaded only by the node-only raises
const HOST_BINDS = `
bind host-read
  take path, like text
  like text
  case node
    text <String((globalThis as any).process.getBuiltinModule("fs").readFileSync($path))>

bind type-read
  take thing, like dynamic
  like text
  case node
    text <String(($thing).missing.deeper)>
`

// a probe program: raise, catch, end the run through `reporter`
function program(kind: string, reporter: 'fail-raised-run' | 'fail-run'): string {
  const raise = RAISES[kind]!
  const from = reporter === 'fail-run' ? '@term/call/work/output/printer-input' : '@term/call/work/output/printer'
  return `load ${from}
  find ${reporter}

load @term/base/environment
  find current-directory

load @term/base/file/blocking
  find read, name read-file

load @term/base/exception
  find defect
${raise.rust ? '' : HOST_BINDS}
task raise
  like text
${raise.body}  send back, text <none>

task boot
  fork
    mark unsafe
    save got
      call raise
  halt take
    take raised
    save code
      call ${reporter}
        read raised
        call current-directory
`
}

// one project per run, so each crash log is its own; the opening item names the root, so every project of one raise
// shares one path: run it, read its output, then clear .term before the next
const root = join(out, 'probe')
mkdirSync(join(root, 'code'), { recursive: true })
mkdirSync(join(root, 'link', '@term'), { recursive: true })
writeFileSync(join(root, 'deck.tree'), 'deck @probe/raised\n  mark <0.0.2>\n')
for (const one of ['base', 'call']) symlinkSync(join(TERM, 'deck', one), join(root, 'link', '@term', one))

type Ran = { status: number | null; stdout: string; stderr: string; logs: string[] }

function run(kind: string, reporter: 'fail-raised-run' | 'fail-run', target: string): Ran {
  const file = `${reporter === 'fail-run' ? 'run' : 'raised'}-${kind}.tree`
  writeFileSync(join(root, 'code', file), program(kind, reporter))
  rmSync(join(root, '.term'), { recursive: true, force: true })
  const made = spawnSync('node', [LINE, 'make', '--emit', target, `code/${file}`, '--run'], { cwd: root, encoding: 'utf8', env, maxBuffer: 1 << 26 })
  const folder = join(root, '.term')
  const logs = existsSync(folder) ? readdirSync(folder).filter(f => /^crash-.*\.log$/.test(f)).map(f => readFileSync(join(folder, f), 'utf8')) : []
  return { status: made.status, stdout: made.stdout ?? '', stderr: made.stderr ?? '', logs }
}

// the program's own run: from its opening item (`● term <root>`) on, past `term make`'s own build items, which name the
// probe's file and target. In it the time an item shows and a crash log's stamp are the only bytes two runs of one
// raise may differ by
const own = (text: string): string => {
  const at = text.lastIndexOf('● term ')
  return at < 0 ? text : text.slice(at)
}
const mask = (text: string): string =>
  own(text).replace(/\b\d+(?:\.\d+)?m?s\b/g, 'ELAPSED').replace(/crash-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.log/g, 'crash-STAMP.log')

const show = (r: Ran): string => JSON.stringify({ status: r.status, stdout: r.stdout.slice(0, 600), stderr: r.stderr.slice(0, 900) })

const BUGS = new Set(['defect', 'type'])
const SAID: Record<string, RegExp> = {
  failure: /✗ term probe failure\n✗ term Failed\n/,
  defect: /✗ term Term stopped on an internal error: Invalid\n/,
  folder: /✗ term EISDIR: illegal operation on a directory, read\n✗ term Failed\n/,
  host: /✗ term ENOENT: no such file or directory, open '\/no\/such\/term-1478'\n✗ term Failed\n/,
  type: /✗ term Term stopped on an internal error: Cannot read properties of undefined\s+\(reading 'deeper'\)\n/,
}

const nodeRaised: Record<string, Ran> = {}
for (const kind of Object.keys(RAISES)) {
  const raised = run(kind, 'fail-raised-run', 'node')
  const before = run(kind, 'fail-run', 'node')
  nodeRaised[kind] = raised
  const bug = BUGS.has(kind)
  ok(`node ${kind}: fail-raised-run exits ${bug ? 70 : 1}`, raised.status === (bug ? 70 : 1), show(raised))
  ok(`node ${kind}: fail-raised-run says what node's fail-run says`, SAID[kind]!.test(`${raised.stdout}${raised.stderr}`), show(raised))
  ok(`node ${kind}: fail-raised-run's exit, stdout and stderr equal fail-run's`, raised.status === before.status && mask(raised.stdout) === mask(before.stdout) && mask(raised.stderr) === mask(before.stderr), `raised ${show(raised)}\n        fail-run ${show(before)}`)
  ok(`node ${kind}: ${bug ? 'one crash log' : 'no crash log'}, as fail-run`, raised.logs.length === (bug ? 1 : 0) && before.logs.length === raised.logs.length, `${raised.logs.length} and ${before.logs.length}`)
  if (bug) {
    const form = kind === 'defect' ? 'defect: Invalid' : "defect: Cannot read properties of undefined (reading 'deeper')"
    ok(`node ${kind}: the crash log holds the Term stack`, (raised.logs[0] ?? '').startsWith(`${form}\n  at `), JSON.stringify((raised.logs[0] ?? '').slice(0, 300)))
  }
}

const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8' })
if (cargo.status !== 0) {
  console.log('skip  the Rust runs  (cargo not installed)')
} else {
  for (const kind of Object.keys(RAISES).filter(one => RAISES[one]!.rust)) {
    const raised = run(kind, 'fail-raised-run', 'rust')
    const node = nodeRaised[kind]!
    const bug = BUGS.has(kind)
    ok(`rust ${kind}: fail-raised-run exits ${bug ? 70 : 1}`, raised.status === (bug ? 70 : 1), show(raised))
    ok(`rust ${kind}: exit, stdout and stderr equal node's`, raised.status === node.status && mask(raised.stdout) === mask(node.stdout) && mask(raised.stderr) === mask(node.stderr), `rust ${show(raised)}\n        node ${show(node)}`)
    ok(`rust ${kind}: ${bug ? 'one crash log' : 'no crash log'}`, raised.logs.length === (bug ? 1 : 0), String(raised.logs.length))
    if (bug) ok(`rust ${kind}: the crash log holds the Term stack`, (raised.logs[0] ?? '').startsWith('defect: Invalid\n  at '), JSON.stringify((raised.logs[0] ?? '').slice(0, 300)))
  }
}

rmSync(out, { recursive: true, force: true })

console.log(`\nprinter-raised: ${pass} pass, ${fail} fail`)

if (fail > 0 || pass === 0) {
  process.exitCode = 1
}
