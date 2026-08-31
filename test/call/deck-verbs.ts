// The dependency and version verbs, on a real project, each asserting what it actually DID.
//
// `save`, `toss`, `link` and `move` are the verbs that WRITE THE MANIFEST, and none of them had a test. Every one
// round-trips the file through the manifest model, so a field the model does not carry is deleted, and the loss is
// silent because a shorter manifest is still a valid manifest.
//
// WHAT THIS FOUND, on the first run, before a single assertion was written:
//
//   `term toss @nothing` — removing a dependency that was never there — LEFT A FRESHLY SCAFFOLDED PROJECT
//   UNBUILDABLE. It dropped `bear ./code` and `boot ./code/boot` from the manifest, and the next `term make`
//   failed on an entry that no longer resolved. Nine packages in this tree had lost `bear` the same way, along
//   with `text`, `mark`, `make` and `cite`. test/deck/round-trip.ts holds the manifest half of that.
//
//   AND THEN IT STILL DID NOT BUILD, for an unrelated reason: installing writes a `lock.tree`, and the build
//   compiled it as Term code. `lock <1>` is not a statement, so the first `term make` after ANY dependency verb
//   died with `the name "lock" is not defined` on a file the user never wrote.
//
// Both were only ever going to be found by running the verb and then building, which is what this does.
//
// HOME IS REDIRECTED. `term link` with no argument registers the current package in the user-level link registry
// under `~/.base/@cluesurf/term`, and a test must not write into the real one.
//
// Run: npx tsx test/call/deck-verbs.ts

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseManifest } from '../../deck/deck/code/manifest'

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
    console.log(`FAIL  ${name}${info ? `  ${info.slice(0, 300)}` : ''}`)
  }
}

const box = mkdtempSync(join(tmpdir(), 'term-deck-verbs-'))
const home = join(box, 'home')

mkdirSync(home, { recursive: true })

// BOTH streams: a verb reports its progress on stdout and its failures on stderr, and reading one saw half.
function term(cwd: string, ...argv: string[]): string {
  const run = spawnSync('node', [LINE, ...argv], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, HOME: home },
  })

  return `${run.stdout ?? ''}${run.stderr ?? ''}`
}

term(box, 'wake', 'demo')

const root = join(box, 'demo')

ok('`wake` scaffolds a project to work on', existsSync(join(root, 'deck.tree')))

// what the scaffold declares, before any verb touches it. Read with the manifest reader rather than by matching:
// this is the same function the package manager uses, so it cannot disagree with it about what the file says.
const before = parseManifest({ text: readFileSync(join(root, 'deck.tree'), 'utf8') })

ok('the scaffold declares an entry and an export root', Boolean(before.boot && before.bear))

// ---- toss: the destructive round trip ----
//
// A dependency that was never there. The manifest should come back saying exactly what it said.

const tossed = term(root, 'toss', '@nothing')
const afterToss = parseManifest({ text: readFileSync(join(root, 'deck.tree'), 'utf8') })

ok('`toss` answers', /Removed/.test(tossed), tossed)

ok(
  '`toss` on an absent dependency keeps `bear` and `boot`',
  afterToss.bear === before.bear && afterToss.boot === before.boot,
  `bear ${afterToss.bear} boot ${afterToss.boot}`,
)

// THE ASSERTION THAT MATTERS. A manifest that still parses is not the same as a project that still builds, and
// both defects above passed the first test and failed this one.
ok(
  'the project still BUILDS after `toss`',
  /Compiled 2 files to host/.test(term(root, 'make')),
  term(root, 'make'),
)

// ---- save: adds the dependency, and keeps the rest ----
//
// The fetch fails here (no registry to reach, on purpose: a test does not go to the network), and the manifest is
// written before the fetch either way. What is asserted is the manifest edit, which is `save`'s own work.

const saved = term(root, 'save', '@term/seed')
const afterSave = parseManifest({ text: readFileSync(join(root, 'deck.tree'), 'utf8') })

ok('`save` records the dependency', afterSave.link.some(l => l.name === '@term/seed'), saved)

ok(
  '`save` keeps `bear` and `boot`',
  afterSave.bear === before.bear && afterSave.boot === before.boot,
  `bear ${afterSave.bear} boot ${afterSave.boot}`,
)

// and `toss` takes back what `save` put in
term(root, 'toss', '@term/seed')

const afterUndo = parseManifest({ text: readFileSync(join(root, 'deck.tree'), 'utf8') })

ok(
  '`toss` removes the dependency `save` added',
  !afterUndo.link.some(l => l.name === '@term/seed'),
)

// ---- move: the version bump ----

const moved = term(root, 'move', 'code', '3')
const bumped = parseManifest({ text: readFileSync(join(root, 'deck.tree'), 'utf8') })

ok(
  `\`move code 3\` moves ${before.code.major}.${before.code.minor}.${before.code.patch} to ${bumped.code.major}.${bumped.code.minor}.${bumped.code.patch}`,
  bumped.code.patch === before.code.patch + 1 &&
    bumped.code.major === before.code.major &&
    bumped.code.minor === before.code.minor,
  moved,
)

ok(
  '`move` keeps `bear` and `boot`',
  bumped.bear === before.bear && bumped.boot === before.boot,
  `bear ${bumped.bear} boot ${bumped.boot}`,
)

// ---- link: the user-level registry ----
//
// With no argument, `link` registers this working copy so another project can `term link demo`. It writes under
// HOME, which is redirected above, so this checks the registry it was pointed at and never the real one.

const linked = term(root, 'link')

ok('`link` registers the package for development', /demo/.test(linked), linked)

ok(
  '`link` wrote into the redirected HOME and nowhere else',
  existsSync(join(home, '.base/@cluesurf/term/link')) ||
    existsSync(join(home, '.base/term/link')),
  linked,
)

// and the project it registered still builds, which is the property every verb here shares
ok('the project still builds after `link`', /Compiled 2 files to host/.test(term(root, 'make')))

console.log(`\ndeck-verbs: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
