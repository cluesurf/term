// MVP GATE 3: Lean re-checks every law of the notes demo with no axioms (note/project/term/assurance/mvp.md).
// Run: TERM_LEAN=/opt/homebrew/bin/lean npx tsx test/assurance/lean.ts [--write <dir>]
//
// The demo's laws are the claims of test/assurance/notes/code/law.tree, over the forms and tasks of model.tree. The
// exporter (deck/make/code/check/lean-export.ts, note/project/term/proof/lean-export/spec.md) writes every claim the
// kernel proved as Lean 4 source, and Lean decides. What it holds:
//   - without Lean: all 21 claims are proven by the kernel and exported, none refused, no constant written as an
//     axiom, every form a Lean inductive, and the recursive laws written through a recursor, never by name
//   - with Lean (TERM_LEAN names the binary): Lean accepts the file with no error and no warning, `#print axioms`
//     says every one of the 21 claims depends on no axiom, and a planted wrong proof of law 1 is refused on its own
//     line alone
// With no Lean at TERM_LEAN or on the PATH the Lean step is reported as skipped, never as passed.

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { exportLean, joinSources, plantLean } from '@term/make/code/check/lean-export'

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

const BASE = new URL('./notes/code/', import.meta.url).pathname
const FILES = ['model.tree', 'law.tree']
// the demo's 21 claims: laws 1, 4 and 5, their lemmas, and the bridge from `view` to the `shows` relation
const CLAIMS = [
  'deleted-stays-gone',
  'isolation',
  'ownership',
  'ownership-carry',
  'ownership-step',
  'ownership-cross',
  'ownership-join',
  'ownership-split',
  'ownership-build',
  'ownership-apply',
  'ownership-settle',
  'view-same-lift',
  'view-same',
  'view-same-zero',
  'view-same-succ',
  'view-pick-by',
  'view-pick-live',
  'view-pick',
  'view-shows',
  'deleted-stays-gone-of-view',
  'isolation-of-view',
]
// the claims (and tasks) that call themselves, each of which must reach Lean through its form's recursor
const RECURSIVE = ['deleted-stays-gone', 'isolation', 'ownership', 'ownership-cross', 'view-same', 'view-shows', 'same', 'view']

const source = joinSources(FILES.map(file => ({ file: `notes/${file}`, text: readFileSync(join(BASE, file), 'utf8') })))
const out = exportLean(source)

ok('the kernel reports no error on the demo', out.kernel.diagnostics.length === 0, out.kernel.diagnostics.slice(0, 5).join('; '))
ok(
  'the claims read are the demo\'s 21',
  CLAIMS.every(c => out.claims.includes(c)) && out.claims.length === CLAIMS.length,
  out.claims.join(','),
)
ok('every claim is proven by the kernel', CLAIMS.every(c => out.kernel.proven.includes(c)), CLAIMS.filter(c => !out.kernel.proven.includes(c)).join(','))
ok(
  'every claim is exported',
  CLAIMS.every(c => out.exported.some(e => e.name === c && e.claim)),
  CLAIMS.filter(c => !out.exported.some(e => e.name === c)).join(','),
)
ok('nothing is refused', out.refused.length === 0, JSON.stringify(out.refused))
ok('no constant is written as an axiom', out.axioms.length === 0 && !/^axiom /m.test(out.lean), out.axioms.join(','))
ok('no claim rests on an axiom', out.exported.every(e => e.axioms.length === 0), JSON.stringify(out.exported.filter(e => e.axioms.length > 0)))
ok(
  'a record and the unit type are Lean inductives',
  out.lean.includes('inductive TermExport.«person» : Type where\n  | «make» :') && out.lean.includes('inductive TermExport.«Unit» : Type where\n  | «unitValue» :'),
)
ok('no sorry, no partial, no termination clause in the file', !/\bsorry\b|\bpartial\b|decreasing_by|termination_by/.test(out.lean))

// each recursive definition is written by its recursor: its body names `T.rec` and never the definition itself
const bodyOf = (name: string): string => {
  const head = `def TermExport.«${name}» `
  const start = out.lean.indexOf(head)
  return start < 0 ? '' : out.lean.slice(out.lean.indexOf(':=\n', start), out.lean.indexOf('\n\n', start))
}

for (const name of RECURSIVE) {
  const body = bodyOf(name)
  ok(`${name} recurses through the recursor, not by name`, /\.rec /.test(body) && !body.includes(`TermExport.«${name}»`) && !body.includes(`TermExport.${name} `), body.slice(0, 300))
}

// THE PLANTED TWIN: law 1 "proved" by the empty shelf's evidence, which has type `fair-shelf bare`, not `fair-shelf s`
const planted = plantLean(out.lean, 'ownership', '@TermExport.«fair-shelf».«clean»')
const changed = out.lean.split('\n').filter((line, i) => planted.split('\n')[i] !== line)
ok('the plant changes exactly one line, the body of ownership', changed.length === 1 && planted !== out.lean, `${changed.length} lines`)

const writeAt = process.argv.indexOf('--write')

if (writeAt > 0) {
  const dir = process.argv[writeAt + 1]!
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'notes.lean'), out.lean)
  writeFileSync(join(dir, 'notes-planted.lean'), planted)
  console.log(`wrote ${join(dir, 'notes.lean')} and ${join(dir, 'notes-planted.lean')}`)
}

// LEAN ITSELF, at TERM_LEAN or else the `lean` on the PATH, as test/check/lean-export.ts finds it
const lean = process.env.TERM_LEAN ?? spawnSync('which', ['lean'], { encoding: 'utf8' }).stdout.trim()

if (lean && existsSync(lean)) {
  const dir = new URL('../../tmp/lean-export/run/', import.meta.url).pathname
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'notes.lean'), out.lean)
  writeFileSync(join(dir, 'notes-planted.lean'), planted)

  const good = spawnSync(lean, [join(dir, 'notes.lean')], { encoding: 'utf8' })
  const said = `${good.stdout}${good.stderr}`
  ok('lean checks the export', good.status === 0 && !/error:/.test(said), said.slice(0, 3000))
  ok('lean prints no warning on the export', !/warning:/.test(said), said.slice(0, 2000))

  // `#print axioms` per claim: Lean quotes a name with a dash as «name» and a plain one bare
  const leanName = (name: string): string => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `«${name}»`)

  for (const claim of CLAIMS) {
    ok(`lean: ${claim} depends on no axiom`, said.includes(`'TermExport.${leanName(claim)}' does not depend on any axioms`), said.split('\n').filter(line => line.includes(leanName(claim))).join(' | '))
  }

  const reported = [...good.stdout.matchAll(/'TermExport\.(\S+)' (does not depend|depends)/g)].length
  ok('lean reports exactly one axiom line per claim', reported === CLAIMS.length, `${reported} lines`)

  const bad = spawnSync(lean, [join(dir, 'notes-planted.lean')], { encoding: 'utf8' })
  const badSaid = `${bad.stdout}${bad.stderr}`
  ok('lean refuses the planted proof', bad.status !== 0, badSaid.slice(0, 2000))
  const plantedLine = out.lean.split('\n').findIndex((line, i) => planted.split('\n')[i] !== line) + 1
  const errorLines = [...badSaid.matchAll(/notes-planted\.lean:(\d+):\d+: error/g)].map(m => Number(m[1]))
  const sorried = [...bad.stdout.matchAll(/'TermExport\.(\S+)' depends on axioms: \[sorryAx\]/g)].map(m => m[1])
  ok(
    'lean refuses the planted body alone, and only law 1 rests on it',
    errorLines.length === 1 && errorLines[0] === plantedLine && sorried.join() === 'ownership',
    `errors at ${errorLines.join(', ')}, planted line ${plantedLine}, sorry in ${sorried.join(', ')}`,
  )
} else {
  console.log(
    `skip  the Lean re-check did not run: TERM_LEAN is ${lean ? `${lean}, which does not exist` : 'unset'}. ` +
      'Set it to a Lean 4 binary (TERM_LEAN=/opt/homebrew/bin/lean) to hold MVP gate 3',
  )
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
