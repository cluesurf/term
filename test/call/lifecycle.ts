// The project lifecycle verbs, each on a real project, each asserting what it actually DID.
//
// WHY THIS EXISTS. `term make` is exercised by every other gate and most of the rest of the CLI is exercised by
// nothing (task/term/cli-coverage.ts counts it). `test/call/bad-input.ts` covers every verb for ONE property, that
// bad input is answered in words, and that is deliberately not counted as per-verb coverage: it says nothing about
// whether a verb does its job.
//
// This is the happy path. `wake` a project in a temporary directory, then run the verbs that operate on one and
// check the OUTCOME rather than the exit code: a file that appeared, a file that went away, a name in the output.
// A verb that printed a cheerful message and did nothing fails here.
//
// Run: npx tsx test/call/lifecycle.ts

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { manifestValueOf } from '@term/call/code/manifest-name'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
// TERM_LINE points at another bundle, as in exit-codes.ts
const LINE = process.env.TERM_LINE ?? join(TERM, 'host/line.js')

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${info ? `  ${info.slice(0, 200)}` : ''}`)
  }
}

// BOTH streams, on success as well as failure. `execFileSync` returns only stdout when the process exits 0, and
// `term lint` prints its findings on stderr and its summary on stdout, so reading stdout alone saw `2 warnings` and
// none of the warnings. `spawnSync` hands back both either way.
// `wait` is for a verb that does not exit on its own (`boot` watches for changes): it is killed once it has had
// long enough to speak, and the output it produced up to that point is what gets checked.
function term(cwd: string, ...argv: string[]): string {
  return termFor(cwd, 120000, ...argv)
}

function termFor(cwd: string, wait: number, ...argv: string[]): string {
  const run = spawnSync('node', [LINE, ...argv], {
    cwd,
    encoding: 'utf8',
    timeout: wait,
  })

  return `${run.stdout ?? ''}${run.stderr ?? ''}`
}

const box = mkdtempSync(join(tmpdir(), 'term-lifecycle-'))

// `wake`: scaffolds a project
const woke = term(box, 'wake', 'demo')
const root = join(box, 'demo')

ok(
  '`wake` writes a manifest and an entry',
  existsSync(join(root, 'deck.tree')) && existsSync(join(root, 'code/boot.tree')),
  woke,
)

// read with the parser, not matched: one parser for `.tree` (note/term/one-parser.md), and manifestNameOf is the
// same function the resolver uses, so this cannot disagree with the build about what the manifest declares
ok(
  '`wake` names the package in the manifest it wrote',
  manifestValueOf(join(root, 'deck.tree'), 'deck') === 'demo',
  existsSync(join(root, 'deck.tree')) ? readFileSync(join(root, 'deck.tree'), 'utf8') : '',
)

// the scaffold is already in `term form`'s canonical layout. It was not: the formatter collapsed the manifest onto
// one line and rewrote the entry, so `form --check` failed on a project nobody had touched (2026-10-02)
const checkedForm = term(root, 'form', '--check')

ok('`form --check` passes on a freshly scaffolded project', /already formatted/.test(checkedForm), checkedForm)

// the scaffold starts at 0.0.1. Read through `show code`, which is the package manager's own reading of the manifest
const shownCode = term(root, 'show', 'code').trim()

ok('`wake` starts the version at 0.0.1', shownCode === '0.0.1', shownCode)

// `make`: compiles the .tree it scaffolded into host/
const made = term(root, 'make')

ok('`make` emits host/ from the scaffolded source', existsSync(join(root, 'host/code/boot.ts')), made)

// and ONLY the code. `wake` writes an unscoped `deck demo`, and `make` used to accept only `deck @scope/name` as a
// manifest, so it compiled deck.tree as code into host/deck.ts and said "Compiled 2 files" for a project of one
ok('`make` does not compile the unscoped manifest as code', !existsSync(join(root, 'host/deck.ts')), made)
// the closing item of the terminal output standard: `✓ make     1 file built`
ok('`make` counts one compiled file', /\b1 file built\b/.test(made), made)

// `time`: compiles the project THE WAY THE BUILD DOES, then reports what it found.
//
// It did not. `runBenchmarks` reached `compileToModule`, which called `compile` with NO RESOLVER, so the module
// graph was never collected and every imported name came back undefined: on a freshly scaffolded project this
// reported `the name "log" is not defined` for the very entry `term make` compiles without complaint. The resolver
// is threaded from the CLI now, and this is the assertion that keeps it: a project with no benchmarks says so,
// rather than blaming its imports.
const timed = term(root, 'time')

ok('`time` finds no benchmarks rather than failing to resolve', /There is no benchmark to run/.test(timed), timed)
ok('`time` does not report an imported name as undefined', !/unknown-name/.test(timed), timed)

// `show`: reports the version, and does not need a project to do it
const shown = term(root, 'show')

ok('`show` prints a version', /\d+\.\d+\.\d+/.test(shown), shown)
ok('`show` names the toolchain `term`, not `seed`', /term/.test(shown) && !/seed/.test(shown), shown)

// `look`: lists what a module holds
const looked = term(root, 'look', 'code/boot.tree')

ok('`look` names something the module defines', looked.trim().length > 0 && !/not found/i.test(looked), looked)

// `roll`: the build's exception roll, written beside the build
const rolled = term(root, 'roll', 'exception')

ok(
  '`roll` writes host/roll.json',
  existsSync(join(root, 'host/roll.json')),
  rolled,
)

// `form`: formats a file in place, and is idempotent on its own output
const ugly = join(root, 'code/ugly.tree')
writeFileSync(ugly, 'task a\n  call b\n    code 1\n    code 2\n')
term(root, 'form', 'code/ugly.tree')
const formattedOnce = readFileSync(ugly, 'utf8')
term(root, 'form', 'code/ugly.tree')

ok('`form` rewrites the file', formattedOnce.length > 0)
ok('`form` is idempotent on its own output', readFileSync(ugly, 'utf8') === formattedOnce, formattedOnce)

// `lint`: the SCAFFOLD ITSELF lints clean, and a real mistake is reported by rule name and code.
//
// The first half is the point of the second: `term wake` wrote a comment 87 characters long, so a brand new project
// failed its own linter on a line the scaffold had just written, and the entry imported `@term/base` rather than
// `@term/base`. Both are fixed in deck/call/code/wake.ts and this is what keeps them fixed.
const cleanLint = term(root, 'lint')

ok(
  '`lint` finds nothing wrong with a freshly scaffolded project',
  !/warning\[/.test(cleanLint),
  cleanLint,
)

writeFileSync(join(root, 'code/lintable.tree'), 'task a\n  save y\n    call add\n      read x\n      code 0\n')
const linted = term(root, 'lint')

// a ▲ Problem item whose facts line reads `prefer-host-for-constant L004`, the name and the code `# lint off` takes
ok(
  '`lint` reports a finding by rule name and code',
  /▲ check[\s\S]*?\b[a-z]+(-[a-z]+)+ L\d{3}\b/.test(linted),
  linted,
)

// `mind`: remembers a fact and recalls it
term(root, 'mind', 'the demo is a scaffold')
const recalled = term(root, 'mind')

ok('`mind` recalls the fact it was given', /scaffold/.test(recalled), recalled)

// `mold`: reshapes Term data. A data file in, JSON out, with the keys and the types intact.
writeFileSync(join(root, 'data.tree'), 'host name, <ada>\nhost age, 36\n')
const molded = term(root, 'mold', 'data.tree', '--json')

ok(
  '`mold` converts a data file to JSON, keeping the types',
  /"name"\s*:\s*"ada"/.test(molded) && /"age"\s*:\s*36/.test(molded),
  molded,
)

// `base`: makes a repository and reports it coherent
const repo = mkdtempSync(join(tmpdir(), 'term-base-'))
const inited = term(repo, 'base', 'init')

ok('`base init` creates a repository', existsSync(join(repo, '.base')), inited)

const checked = term(repo, 'base', 'check')

ok('`base check` reports a fresh repository coherent', /No missing chunks/.test(checked), checked)

// `halt`: reports honestly when nothing is running, AND says `term`, not `seed`.
//
// The naming half is not cosmetic. 94 strings across 27 files told the reader to run the old binary name, and the
// binary is `term`: every one was an instruction that does not work. The scaffold printed one as the very first
// thing a new user sees.
const halted = term(root, 'halt')

// the assertion deliberately does not spell the name of the verb `halt` stops: task/term/cli-coverage.ts counts a
// verb as covered when a test names it, so mentioning one verb inside another verb's test claims coverage that
// does not exist. Only `halt` is tested here.
// in a project it asks only about that project's boots (guides: commands/halt, 2026-10-04)
ok('`halt` reports when nothing is running', /No term boot of this project is running/.test(halted), halted)
ok('`halt` says `term`, not `seed`', !/\bseed [a-z]/.test(halted), halted)

// `note`: names the package and its version, read from the manifest
const noted = term(root, 'note')

// the scaffold starts at 0.0.1 (deck/call/code/wake.ts, 2026-10-03)
ok('`note` names the package and version', /demo/.test(noted) && /0\.0\.1/.test(noted), noted)

// `hold`: the gate. One line counting the files and the tier-0 obligations it proved
const held = term(root, 'hold')

ok(
  '`hold` counts what it checked',
  // the closing item's facts: `0/0 obligations proven · 0 in the baseline`
  /\b\d+\/\d+ obligations? proven\b/.test(held),
  held,
)

// `fill`: writes a shell completion script
const filled = term(root, 'fill')

ok('`fill` emits a completion script naming the binary', /term/.test(filled) && filled.length > 40, filled)

// `view`: the sandboxed document dialect refuses what a document may not say. A path given is checked as a document
// whatever its role, so the scaffold's own code, which declares a `task`, is the refusal
const viewed = term(root, 'view', 'code/boot.tree')

ok(
  '`view` refuses a `task` in a document, and says why',
  // the item's subject wraps at the body column, so the words may stand on two lines
  /document\s+cannot\s+declare\s+a\s+function/.test(viewed),
  viewed,
)

// and with no path it checks only the files `role.tree` gives the view role, of which the scaffold has none. It used
// to check the code as a document (guides: commands/view, 2026-10-04)
const unviewed = term(root, 'view')

ok('`view` with no path leaves the code alone', /No document here/.test(unviewed) && !/cannot\s+declare/.test(unviewed), unviewed)

// `test`: finds a test file, runs it, and reports the count. Written in the real dialect (`test <name>` with a
// `want hold`), so this exercises the test preprocessor as well as the runner.
mkdirSync(join(root, 'test'), { recursive: true })
writeFileSync(
  join(root, 'test/base.tree'),
  [
    '',
    'load @term/base/code/number',
    '  find number',
    '',
    'test one-plus-one',
    '  want hold',
    '    call is-equal',
    '      call add',
    '        code 1',
    '        code 1',
    '      code 2',
    '',
  ].join('\n'),
)

const tested = term(root, 'test')

// the closing item, `✓ test     Tests passed`, its facts `1 test · 1 passed`
ok('`test` runs a test file and counts it', /Tests passed[\s\S]*?\b1 test\b[\s\S]*?\b1 passed\b/.test(tested), tested)

// `hunt`: reads THIS project's files, really fuzzes, and an empty corpus FAILS rather than passing.
//
// It defaulted to `deck/base/code`, the compiler's own stdlib, which a user project does not have: it read nothing
// and said CLEAN with exit 0. Its fuzzing half spawned `npx tsx host/fuzz-campaign.ts`, a file that exists only in
// source, so from host/line.js no fuzz input ever ran and the report still said `no crashes, no hangs`.
const hunt = (...argv: string[]) =>
  spawnSync('node', [LINE, 'hunt', ...argv], { cwd: root, encoding: 'utf8', timeout: 300000 })

const hunted = hunt('--runs', '20', '--seeds', '1')
const huntedText = `${hunted.stdout ?? ''}${hunted.stderr ?? ''}`

// the `check` and `fuzz` items of the terminal output standard, each with its counts on its facts line
ok('`hunt` reads the project\'s own files by default', /Corpus oracles[\s\S]*?\b[1-9]\d* files?\b/.test(huntedText), huntedText)
ok('`hunt` runs the fuzz campaign from the built CLI', /Structure-aware fuzzing under a watchdog[\s\S]*?\b20 runs\b[\s\S]*?\b1\/1 seeds?\b/.test(huntedText), huntedText)

mkdirSync(join(root, 'empty'), { recursive: true })
const huntedEmpty = hunt('empty', '--runs', '20', '--seeds', '1')
const huntedEmptyText = `${huntedEmpty.stdout ?? ''}${huntedEmpty.stderr ?? ''}`

ok('`hunt` over no files exits non-zero', huntedEmpty.status === 1, huntedEmptyText)
ok('`hunt` over no files never says CLEAN', !/CLEAN/.test(huntedEmptyText) && /no files read/i.test(huntedEmptyText), huntedEmptyText)

// `seek`: reports what a project is missing
const sought = term(root, 'seek')

ok('`seek` reports a missing dependency by name', /missing|not found/i.test(sought), sought)

// `boot`: compiles the entry and RUNS it, so the scaffold's own greeting reaches the output.
//
// It does not exit on its own (it watches for hot reload), so this kills it once it has spoken. A timeout kill is
// the expected end here, not a failure: what is being checked is that the app ran at all.
const booted = termFor(root, 25000, 'boot')

ok(
  '`boot` compiles and runs the entry',
  /hello from term/.test(booted),
  booted,
)

// `wash`: removes the build output
term(root, 'wash')

ok('`wash` removes host/', !existsSync(join(root, 'host/code/boot.ts')))

// ---- `term view` takes an absolute path ----
//
// The verb joined its path argument onto the project root (join('/a', '/b') is '/a/b'), so an absolute path —
// which is what a temp file is — was reported `no such path` while sitting right there. Found by word.surf's
// guide save gate, the first caller to hand the verb one.
{
  const absDir = mkdtempSync(join(tmpdir(), 'term-view-abs-'))

  writeFileSync(
    join(absDir, 'doc.tree'),
    'view page\n  view text\n    text <hi>\n',
  )

  const viewed = term(absDir, 'view', join(absDir, 'doc.tree'))

  ok(
    '`term view </absolute/path>` reads the file',
    /view\s+text/.test(viewed) && !/no such path/.test(viewed),
    viewed,
  )
}

console.log(`\nlifecycle: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
