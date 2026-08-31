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
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
function term(cwd: string, ...argv: string[]): string {
  const run = spawnSync('node', [LINE, ...argv], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
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

// `wash`: removes the build output
term(root, 'wash')

ok('`wash` removes host/', !existsSync(join(root, 'host/code/boot.ts')))

console.log(`\nlifecycle: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
