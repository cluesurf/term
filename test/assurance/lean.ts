// MVP GATE 3: Lean re-checks every law of the notes demo with no axioms (note/project/term/assurance/mvp.md).
// Run: TERM_LEAN=/opt/homebrew/bin/lean npx tsx test/assurance/lean.ts [--write <dir>]
//
// The demo's laws are the claims of test/assurance/notes/code/law.tree, over the forms and tasks of model.tree, and
// for law 7 page.tree and @term/site's http/glyph.tree and http/html.tree. The
// exporter (deck/make/code/check/lean-export.ts, note/project/term/proof/lean-export/spec.md) writes every claim the
// kernel proved as Lean 4 source, and Lean decides. What it holds:
//   - without Lean: all 43 claims are proven by the kernel and exported, none refused, no constant written as an
//     axiom, every form a Lean inductive, and the recursive laws written through a recursor, never by name
//   - with Lean (TERM_LEAN names the binary): Lean accepts the file with no error and no warning, `#print axioms`
//     says every one of the 43 claims depends on no axiom, and a planted wrong proof of law 1 is refused on its own
//     line alone, law 1 of `replay` the one other claim resting on it
// With no Lean at TERM_LEAN or on the PATH the Lean step is reported as skipped, never as passed.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  exportLean,
  joinSources,
  plantLean,
} from '@term/make/code/check/lean-export'
import { findLean, runLean } from '@term/make/code/check/lean-run'

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
const SITE = new URL('../../deck/site/code/http/', import.meta.url)
  .pathname
// law 7 reads @term/site's glyphs and escapes (escape.tree's `escape-html` runs `escape-glyphs`) and its model of the
// node serializer, and the notes pages (page.tree)
const FILES = [
  { file: 'site/http/glyph.tree', path: join(SITE, 'glyph.tree') },
  { file: 'site/http/html.tree', path: join(SITE, 'html.tree') },
  { file: 'notes/model.tree', path: join(BASE, 'model.tree') },
  { file: 'notes/page.tree', path: join(BASE, 'page.tree') },
  { file: 'notes/law.tree', path: join(BASE, 'law.tree') },
]
// the demo's 43 claims: laws 1, 4, 5 and 7, their lemmas, the bridge from `view` to `shows`, and from `replay` to
// `replays`
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
  // the bridge from `step` and `replay` to `steps` and `replays`, and law 1 of `replay` itself
  'ownership-of-replay-own',
  'ownership-of-replay-may',
  'ownership-of-replay-aim',
  'ownership-of-replay-settle',
  'ownership-of-replay-cross',
  'ownership-of-replay-step',
  'ownership-of-replay-run',
  'ownership-of-replay',
  // law 7, safe text: escape-html keeps no `<`, `>`, `&`, `"` or `'` and reads back to its input, the serializer
  // escapes every text node and attribute value, and no notes page holds markup the asker wrote
  'safe-text-escape-glyph',
  'safe-text-escape',
  'safe-text-round-glyph',
  'safe-text-round-trip',
  'safe-text-escaped-text',
  'safe-text-text-glyph',
  'safe-text-text',
  'safe-text-attribute-glyph',
  'safe-text-attribute',
  'safe-text-attributes',
  'safe-text-serialize',
  'safe-text-of-view',
  'safe-text-of-refusal',
  'safe-text',
]
// the claims (and tasks) that call themselves, each of which must reach Lean through its form's recursor
const RECURSIVE = [
  'deleted-stays-gone',
  'isolation',
  'ownership',
  'ownership-cross',
  'view-same',
  'view-shows',
  'same',
  'view',
  'ownership-of-replay-cross',
  'ownership-of-replay-run',
  'cross',
  'replay',
  'safe-text-escape',
  'safe-text-round-trip',
  'safe-text-escaped-text',
  'safe-text-text',
  'safe-text-attribute',
  'safe-text-attributes',
  'safe-text-serialize',
  'escape-glyphs',
  'escape-text-glyphs',
  'escape-attr-glyphs',
  'unescape-glyphs',
  'serialize-attributes',
  'serialize',
]

const source = joinSources(
  FILES.map(({ file, path }) => ({
    file,
    text: readFileSync(path, 'utf8'),
  })),
)
const out = exportLean(source)

ok(
  'the kernel reports no error on the demo',
  out.kernel.diagnostics.length === 0,
  out.kernel.diagnostics.slice(0, 5).join('; '),
)
ok(
  `the claims read are the demo's ${CLAIMS.length}`,
  CLAIMS.every(c => out.claims.includes(c)) &&
    out.claims.length === CLAIMS.length,
  out.claims.join(','),
)
ok(
  'every claim is proven by the kernel',
  CLAIMS.every(c => out.kernel.proven.includes(c)),
  CLAIMS.filter(c => !out.kernel.proven.includes(c)).join(','),
)
ok(
  'every claim is exported',
  CLAIMS.every(c => out.exported.some(e => e.name === c && e.claim)),
  CLAIMS.filter(c => !out.exported.some(e => e.name === c)).join(','),
)
ok(
  'nothing is refused',
  out.refused.length === 0,
  JSON.stringify(out.refused),
)
ok(
  'no constant is written as an axiom',
  out.axioms.length === 0 && !/^axiom /m.test(out.lean),
  out.axioms.join(','),
)
ok(
  'no claim rests on an axiom',
  out.exported.every(e => e.axioms.length === 0),
  JSON.stringify(out.exported.filter(e => e.axioms.length > 0)),
)
ok(
  'a record and the unit type are Lean inductives',
  out.lean.includes(
    'inductive TermExport.«person» : Type where\n  | «make» :',
  ) &&
    out.lean.includes(
      'inductive TermExport.«Unit» : Type where\n  | «unitValue» :',
    ),
)
ok(
  'no sorry, no partial, no termination clause in the file',
  !/\bsorry\b|\bpartial\b|decreasing_by|termination_by/.test(out.lean),
)

// each recursive definition is written by its recursor: its body names `T.rec` and never the definition itself
const bodyOf = (name: string): string => {
  const head = `def TermExport.«${name}» `
  const start = out.lean.indexOf(head)
  return start < 0
    ? ''
    : out.lean.slice(
        out.lean.indexOf(':=\n', start),
        out.lean.indexOf('\n\n', start),
      )
}

for (const name of RECURSIVE) {
  const body = bodyOf(name)
  ok(
    `${name} recurses through the recursor, not by name`,
    /\.rec /.test(body) &&
      !body.includes(`TermExport.«${name}»`) &&
      !body.includes(`TermExport.${name} `),
    body.slice(0, 300),
  )
}

// THE PLANTED TWIN: law 1 "proved" by the empty shelf's evidence, which has type `fair-shelf bare`, not `fair-shelf s`
const planted = plantLean(
  out.lean,
  'ownership',
  '@TermExport.«fair-shelf».«clean»',
)
const changed = out.lean
  .split('\n')
  .filter((line, i) => planted.split('\n')[i] !== line)
ok(
  'the plant changes exactly one line, the body of ownership',
  changed.length === 1 && planted !== out.lean,
  `${changed.length} lines`,
)

const writeAt = process.argv.indexOf('--write')

if (writeAt > 0) {
  const dir = process.argv[writeAt + 1]!
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'notes.lean'), out.lean)
  writeFileSync(join(dir, 'notes-planted.lean'), planted)
  console.log(
    `wrote ${join(dir, 'notes.lean')} and ${join(dir, 'notes-planted.lean')}`,
  )
}

// LEAN ITSELF, at TERM_LEAN or else the `lean` on the PATH, found and read by the driver `term hold --lean` uses
const lean = findLean()

if (lean) {
  const dir = new URL('../../tmp/lean-export/run/', import.meta.url)
    .pathname
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'notes.lean'), out.lean)
  writeFileSync(join(dir, 'notes-planted.lean'), planted)

  const good = await runLean({
    lean,
    file: join(dir, 'notes.lean'),
    source: out.lean,
    claims: CLAIMS,
  })
  ok(
    'lean checks the export',
    good.status === 0 && good.errors.length === 0,
    good.output.slice(0, 3000),
  )
  ok(
    'lean prints no warning on the export',
    good.warnings === 0,
    good.output.slice(0, 2000),
  )

  for (const claim of good.claims) {
    ok(
      `lean: ${claim.name} depends on no axiom`,
      claim.verdict === 'checked',
      JSON.stringify(claim),
    )
  }

  const reported = [
    ...good.output.matchAll(
      /^'TermExport\.(\S+)' (does not depend|depends)/gm,
    ),
  ].length
  ok(
    'lean reports exactly one axiom line per claim',
    reported === CLAIMS.length,
    `${reported} lines`,
  )

  const bad = await runLean({
    lean,
    file: join(dir, 'notes-planted.lean'),
    source: planted,
    claims: CLAIMS,
  })
  ok(
    'lean refuses the planted proof',
    bad.status !== 0,
    bad.output.slice(0, 2000),
  )
  const plantedLine =
    out.lean
      .split('\n')
      .findIndex((line, i) => planted.split('\n')[i] !== line) + 1
  const refused = bad.claims
    .filter(claim => claim.verdict === 'refused')
    .map(claim => claim.name)
  ok(
    'lean refuses the planted body alone, and only law 1 and law 1 of replay rest on it',
    bad.errors.length === 1 &&
      bad.errors[0]!.line === plantedLine &&
      bad.errors[0]!.definition === 'ownership' &&
      refused.join() === 'ownership,ownership-of-replay',
    `errors at ${bad.errors.map(e => `${e.line} in ${e.definition}`).join(', ')}, planted line ${plantedLine}, refused ${refused.join(', ')}`,
  )
} else {
  console.log(
    `skip  the Lean re-check did not run: no Lean at TERM_LEAN (${process.env.TERM_LEAN ?? 'unset'}) or on the PATH. ` +
      'Set it to a Lean 4 binary (TERM_LEAN=/opt/homebrew/bin/lean) to hold MVP gate 3',
  )
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
