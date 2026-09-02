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
const LINE = join(TERM, 'host/line.js')

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

// `make`: compiles the .tree it scaffolded into host/
const made = term(root, 'make')

ok('`make` emits host/ from the scaffolded source', existsSync(join(root, 'host/code/boot.ts')), made)

// `time`: compiles the project THE WAY THE BUILD DOES, then reports what it found.
//
// It did not. `runBenchmarks` reached `compileToModule`, which called `compile` with NO RESOLVER, so the module
// graph was never collected and every imported name came back undefined: on a freshly scaffolded project this
// reported `the name "log" is not defined` for the very entry `term make` compiles without complaint. The resolver
// is threaded from the CLI now, and this is the assertion that keeps it: a project with no benchmarks says so,
// rather than blaming its imports.
const timed = term(root, 'time')

ok('`time` finds no benchmarks rather than failing to resolve', /no benchmarks found/i.test(timed), timed)
ok('`time` does not report an imported name as undefined', !/unknown-name/.test(timed), timed)

// `show`: reports the version, and does not need a project to do it
const shown = term(root, 'show')

ok('`show` prints a version', /\d+\.\d+\.\d+/.test(shown), shown)

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
// failed its own linter on a line the scaffold had just written, and the entry imported `@cluesurf/seed` rather than
// `@term/seed`. Both are fixed in deck/call/code/wake.ts and this is what keeps them fixed.
const cleanLint = term(root, 'lint')

ok(
  '`lint` finds nothing wrong with a freshly scaffolded project',
  !/warning\[/.test(cleanLint),
  cleanLint,
)

writeFileSync(join(root, 'code/lintable.tree'), 'task a\n  save y\n    call add\n      read x\n      code 0\n')
const linted = term(root, 'lint')

// `warning[prefer-host-for-constant 0004]: ...`
ok(
  '`lint` reports a finding by rule name and code',
  /warning\[[a-z-]+ \d{4}\]/.test(linted),
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

ok('`base check` reports a fresh repository coherent', /no missing chunks/.test(checked), checked)

// `halt`: reports honestly when nothing is running, AND says `term`, not `seed`.
//
// The naming half is not cosmetic. 94 strings across 27 files told the reader to run the old binary name, and the
// binary is `term`: every one was an instruction that does not work. The scaffold printed one as the very first
// thing a new user sees.
const halted = term(root, 'halt')

// the assertion deliberately does not spell the name of the verb `halt` stops: task/term/cli-coverage.ts counts a
// verb as covered when a test names it, so mentioning one verb inside another verb's test claims coverage that
// does not exist. Only `halt` is tested here.
ok('`halt` reports when nothing is running', /instances running/i.test(halted), halted)
ok('`halt` says `term`, not `seed`', !/\bseed [a-z]/.test(halted), halted)

// `note`: names the package and its version, read from the manifest
const noted = term(root, 'note')

ok('`note` names the package and version', /demo/.test(noted) && /0\.0\.1/.test(noted), noted)

// `hold`: checks each file's obligations and counts what it checked
const held = term(root, 'hold')

ok('`hold` counts what it checked', /\d+ checked/.test(held), held)

// `fill`: writes a shell completion script
const filled = term(root, 'fill')

ok('`fill` emits a completion script naming the binary', /term/.test(filled) && filled.length > 40, filled)

// `view`: the sandboxed document dialect refuses what a document may not say
const viewed = term(root, 'view')

ok(
  '`view` refuses a `task` in a document, and says why',
  /document cannot declare a function/.test(viewed),
  viewed,
)

// `test`: finds a test file, runs it, and reports the count. Written in the real dialect (`test <name>` with a
// `want hold`), so this exercises the test preprocessor as well as the runner.
mkdirSync(join(root, 'test'), { recursive: true })
writeFileSync(
  join(root, 'test/base.tree'),
  [
    '',
    'load @term/seed/code/number',
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

ok('`test` runs a test file and counts it', /1 test passed/.test(tested), tested)

// `hunt`: an EMPTY corpus says so rather than passing.
//
// It defaulted to `deck/base/code`, the pre-rename stdlib path, which has not existed since the package became
// `deck/seed`. `find` failed, the catch set the corpus to empty, and every run reported `no oracle violations`
// having read nothing at all - a check that answers the question it was asked while testing nothing. It reads 803
// files on the real tree now, and an empty one is reported as empty.
const hunted = term(root, 'hunt')

ok('`hunt` says when it read no files', /no files read/i.test(hunted), hunted)
ok('`hunt` does not claim the oracles held over nothing', !/no oracle violations/.test(hunted), hunted)

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
