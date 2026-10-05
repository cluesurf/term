// Phase 2 of note/term/gaps/plan.md, "Exit codes that tell the truth": a command that failed at what it was asked
// exits non-zero, and a command that wrote nothing does not say it wrote something. Each case is the run a term.surf
// guide made, against the built CLI.
//
// Run: npx tsx test/call/exit-codes.ts (after `pnpm run make:line`)

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const LINE = join(HERE, '../../host/line.js')

let pass = 0
let fail = 0

function ok(name: string, good: boolean, detail = ''): void {
  if (good) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `  ${detail}` : ''}`)
  }
}

function term(cwd: string, ...args: string[]): { status: number | null; out: string } {
  const run = spawnSync('node', [LINE, ...args], { cwd, encoding: 'utf8', timeout: 240_000, env: { ...process.env, NO_COLOR: '1' } })

  return { status: run.status, out: `${run.stdout}${run.stderr}` }
}

// a project with one benchmark and one test file, which is what `term time` walks
const project = mkdtempSync(join(tmpdir(), 'term-exit-codes-'))
mkdirSync(join(project, 'code'))
mkdirSync(join(project, 'test'))
writeFileSync(join(project, 'deck.tree'), 'deck @probe/exit\nhead <Probe>\nmark <0.0.2>\nlink @term/base, mark <0.0.x>\n')
writeFileSync(
  join(project, 'code/base.tree'),
  `task time-sum
  like number
  send back
    call add
      code 1
      code 2
`,
)
writeFileSync(
  join(project, 'test/sum.tree'),
  `test sum-adds
  want hold
    call is-equal
      call add
        code 1
        code 2
      code 3
`,
)

// ---- commands/show: outside a project ----
{
  const empty = mkdtempSync(join(tmpdir(), 'term-exit-empty-'))
  const run = term(empty, 'show', 'mark')

  ok('`term show mark` outside a project exits non-zero', run.status !== 0, run.out)

  // from the project's own `code/` folder, the nearest deck.tree above it
  const shown = mkdtempSync(join(tmpdir(), 'term-show-'))
  mkdirSync(join(shown, 'code'))
  writeFileSync(join(shown, 'deck.tree'), 'deck @probe/show\n  mark <0.0.2>\n')

  const nested = term(join(shown, 'code'), 'show', 'mark')

  ok('`term show mark` from `code/` reads the deck.tree above it', nested.status === 0 && nested.out.trim() === '0.0.2', nested.out)

  const json = term(shown, 'show', 'mark', '--back', 'json')

  ok('`--back json` prints the version as JSON', json.out.trim() === '{"mark":"0.0.2"}', json.out)

  const toolchain = term(empty, 'show', '--back', 'json')
  const parsed = (() => {
    try {
      return JSON.parse(toolchain.out) as Record<string, string>
    } catch {
      return {}
    }
  })()

  ok('and the toolchain as JSON', typeof parsed.term === 'string' && typeof parsed.node === 'string', toolchain.out)

  const block = term(empty, 'show')

  ok('the toolchain block has no blank line before or after it', block.out.startsWith('term ') && !block.out.endsWith('\n\n'), JSON.stringify(block.out))

  const unknown = term(empty, 'show', 'nope')

  ok('`term show nope` is refused, exit 2', unknown.status === 2 && /nothing named nope to show/.test(unknown.out), unknown.out)

  const broken = mkdtempSync(join(tmpdir(), 'term-show-broken-'))
  writeFileSync(join(broken, 'deck.tree'), 'deck @probe/broken\n  mark <not a version>\n')

  const unread = term(broken, 'show', 'mark')

  ok('a deck.tree that cannot be read says so, not that there is none', unread.status !== 0 && /could not be read/.test(unread.out), unread.out)
}

// ---- commands/time, tests/benchmarks: a baseline that does not exist ----
{
  const run = term(project, 'time', '--compare', 'nope', '--fail-on-regression', '5')

  ok('`term time --compare` with no such baseline exits 1', run.status === 1, run.out)
  // a ✗ item naming the baseline, with the path it looked for in a `looked` field
  ok('naming the file it looked for', /There is no baseline named nope[\s\S]*?looked\s+\S*nope\.json/.test(run.out), run.out)
  ok('before any benchmark ran', !/time-sum/.test(run.out), run.out)
}

// ---- commands/time: the walk is the build's, and a test file is rewritten ----
{
  const run = term(project, 'time')

  ok('`term time` runs the benchmark', run.status === 0 && /time-sum/.test(run.out), run.out)
  ok('and compiles neither the manifest nor a raw test file as code', !/unknown-name|deck\.tree: /.test(run.out), run.out)
}

// ---- commands/form: `--list` writes nothing and says so ----
{
  const file = join(project, 'code/loose.tree')
  const written = 'task two\n  like number\n  send back\n    call add\n      code 1\n      code 2\n\n\n\n'

  writeFileSync(file, written)

  const run = term(project, 'form', '--list', 'code/loose.tree')

  ok('`term form --list` leaves the file as it was', readFileSync(file, 'utf8') === written)
  ok('and does not say it formatted anything', !/Formatted \d+ file/.test(run.out), run.out)
  ok('it says it printed the file and wrote nothing', /Printed .*nothing (was )?written/i.test(run.out), run.out)
}

// ---- commands/test, tests/writing: a failing test says which `want` failed ----
{
  const tests = mkdtempSync(join(tmpdir(), 'term-want-'))
  mkdirSync(join(tests, 'test'))
  writeFileSync(join(tests, 'deck.tree'), 'deck @probe/want\nhead <Probe>\nmark <0.0.2>\nlink @term/base, mark <0.0.x>\n')
  writeFileSync(
    join(tests, 'test/double.tree'),
    `task double
  take n, like number
  like number
  send back
    call multiply
      read n
      code 2

test <double of three is six>
  want hold
    call is-equal
      call double
        code 3
      code 6

test <double of zero is zero>
  want hold
    call is-equal
      call double
        code 0
      code 1
`,
  )

  const run = term(tests, 'test')

  ok('a failing test fails the run', run.status === 1, run.out)
  ok('naming the line of the `want` that did not hold', /line 17 did not hold: want hold/.test(run.out), run.out)
}

// ---- parsers/grammars: a grammar builds and rolls as its reader, and a miss says where and what ----
{
  const grammar = mkdtempSync(join(tmpdir(), 'term-grammar-'))
  mkdirSync(join(grammar, 'code/version'), { recursive: true })
  writeFileSync(join(grammar, 'deck.tree'), 'deck @probe/grammar\nhead <Probe>\nmark <0.0.2>\nlink @term/base, mark <0.0.x>\nlink @term/feed, mark <0.0.x>\n')
  writeFileSync(
    join(grammar, 'code/version/mine.tree'),
    `mine version
  mine form, form digits
    send major
  mine char, <.>
  mine form, form digits
    send minor

mine digits
  mine list
    mine range
      bind base, <0>
      bind head, <9>
`,
  )

  const made = term(grammar, 'make')

  ok('a grammar builds', made.status === 0, made.out)
  ok('with no warning about the reader it generated', !/never used/.test(made.out), made.out)

  const rolled = term(grammar, 'roll', 'task', '--host', '@probe/grammar')

  ok('`term roll` reads the grammar as the build does, not as plain Term', rolled.status === 0 && !/unknown-name/.test(rolled.out), rolled.out)
  ok('and a miss raises `failure`', /task @probe\/grammar\/read-version[\s\S]*?halt failure/.test(rolled.out), rolled.out)

  writeFileSync(
    join(grammar, 'probe.ts'),
    `import { readVersion } from './host/code/version/mine.ts'
const cursor = (text: string) => ({ text: [text], position: [0], length: [Array.from(text).length], pull: { form: 'none' as const }, exhausted: [true] })
try {
  readVersion(cursor('12-4'))
} catch (e) {
  console.log((e as { note?: string }).note)
}
`,
  )

  const probe = spawnSync('npx', ['tsx', 'probe.ts'], { cwd: grammar, encoding: 'utf8', timeout: 120_000 })

  ok('a miss names what it expected, where reading stopped, and what was there', /expected "\." at position 2, found "-"/.test(probe.stdout), `${probe.stdout}${probe.stderr}`)
}

// ---- a `mine.tree` under the `mill` role is a mill grammar, checked as itself, never read as a feed grammar ----
{
  const mills = mkdtempSync(join(tmpdir(), 'term-mill-'))
  mkdirSync(join(mills, 'code/text'), { recursive: true })
  writeFileSync(join(mills, 'deck.tree'), 'deck @probe/mill\nhead <Probe>\nmark <0.0.2>\nlink @term/base, mark <0.0.x>\n')
  writeFileSync(join(mills, 'role.tree'), 'role mill\n  take @/code/**/*.tree\n')
  writeFileSync(
    join(mills, 'code/text/mine.tree'),
    `mine text
  mine list
    mine form, like text-def
      site text

mine text-def
  mine term, term text
    mine term
      site name
    mine text
      site text
`,
  )

  const made = term(mills, 'make')

  ok('a mill grammar builds under the `mill` role', made.status === 0 && !/cannot tell whether this grammar reads/.test(made.out), made.out)
}

// ---- packages/versions: `term move mark rc` starts and moves a pre-release, and a bad level is refused ----
{
  const moved = mkdtempSync(join(tmpdir(), 'term-move-'))
  writeFileSync(join(moved, 'deck.tree'), 'deck @probe/move\n  mark <1.4.2>\n')

  const versions = ['rc', 'rc', '3'].map(level => {
    term(moved, 'move', 'mark', level)

    return /mark <([^>]+)>/.exec(readFileSync(join(moved, 'deck.tree'), 'utf8'))?.[1]
  })

  ok('`term move mark rc` goes 1.4.3-rc.1, 1.4.3-rc.2, and `3` releases 1.4.3', versions.join(' ') === '1.4.3-rc.1 1.4.3-rc.2 1.4.3', versions.join(' '))

  const bad = term(moved, 'move', 'mark', '4')

  ok('`term move mark 4` is refused with exit 2, and moves nothing', bad.status === 2 && /4 is not a part of the version/.test(bad.out) && readFileSync(join(moved, 'deck.tree'), 'utf8').includes('<1.4.3>'), bad.out)
}

// ---- packages/versions: `term save` takes the versions a link accepts ----
{
  const saved = mkdtempSync(join(tmpdir(), 'term-save-'))
  writeFileSync(join(saved, 'deck.tree'), 'deck @probe/save\n  mark <0.0.1>\n')

  // the install after it has no registry to reach here, so only the manifest is read
  term(saved, 'save', '@probe/none', '^1.2.0')
  const written = readFileSync(join(saved, 'deck.tree'), 'utf8')

  ok('`term save @probe/none ^1.2.0` writes the range it means', /link @probe\/none, mark <1\.2\.0\.\.2\.0\.0>/.test(written), written)

  const bad = term(saved, 'save', '@probe/other', 'nope')

  ok('`term save` with a version that is none is refused, and writes nothing', bad.status !== 0 && !readFileSync(join(saved, 'deck.tree'), 'utf8').includes('@probe/other'), bad.out)
}

// ---- commands/wake: a file already in the folder is kept ----
{
  const woken = mkdtempSync(join(tmpdir(), 'term-wake-'))
  writeFileSync(join(woken, 'readme.md'), '# mine\n')
  writeFileSync(join(woken, '.gitignore'), 'secrets\n')

  const run = term(woken, 'wake')

  ok('`term wake` keeps a readme.md and a .gitignore already there', run.status === 0 && readFileSync(join(woken, 'readme.md'), 'utf8') === '# mine\n' && readFileSync(join(woken, '.gitignore'), 'utf8') === 'secrets\n', run.out)
  ok('and writes the rest, saying which it kept', readFileSync(join(woken, 'deck.tree'), 'utf8').startsWith('deck ') && /keep\s+readme\.md/.test(run.out) && /2 files/.test(run.out), run.out)
}

console.log(`\nexit-codes: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
