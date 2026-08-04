/**
 * The checker -> gap report integration. Run:
 *   npx tsx deck/test/code/demo-gap.ts
 *
 * Compiles real Seed programs and turns the live checker's diagnostics
 * into structured `CheckerGap`s - the actionable, AI-readable hole
 * reports that drive the synthesis/repair loop (synthesis.md Phase A).
 * A clean program yields zero gaps; a broken one yields a gap with the
 * exact location, kind, message, and source excerpt.
 *
 * Pure node + tsx, deterministic.
 */

import { compile } from '@term/make/code/compile/compile'
import { gapsFromDiagnostics, showGap } from './checker-gap'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
  else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
}

function gapsFor(file: string, source: string) {
  const r = compile({ file, text: source }, { resolve: () => undefined })
  return { ok: r.ok, gaps: gapsFromDiagnostics(source, r.diagnostics) }
}

// --- a clean program yields no gaps ---
const clean = gapsFor(
  'clean.tree',
  `task add-one\n  take n, like number\n  like number\n  send back\n    call add\n      read n\n      mark 1\n`,
)
ok('clean program: compiles, zero gaps', clean.ok && clean.gaps.length === 0)

// --- a type error becomes a structured gap ---
const typeBad = gapsFor(
  'type-bad.tree',
  `task add-one\n  take n, like number\n  like number\n  send back\n    call add\n      read n\n      text <oops>\n`,
)
ok('type error: a gap is emitted', typeBad.gaps.length >= 1)
if (typeBad.gaps.length) {
  const gap = typeBad.gaps[0]
  ok('gap has the kind', gap.kind === 'type-mismatch', `(${gap.kind})`)
  ok('gap has a precise location', /type-bad\.tree:\d+:\d+/.test(gap.location), `(${gap.location})`)
  ok('gap has the obligation message', gap.message.includes('expected number'))
  ok('gap has a source excerpt with a caret', gap.excerpt.includes('^'))
  console.log('\n' + showGap(gap) + '\n')
}

// --- an undefined reference becomes a structured gap ---
const refBad = gapsFor(
  'ref-bad.tree',
  `task greet\n  like number\n  send back\n    read missing-variable\n`,
)
ok('undefined reference: a gap is emitted', refBad.gaps.length >= 1,
  refBad.gaps.length ? `(${refBad.gaps[0].kind})` : '')

console.log(`\nseed-verify checker-gap demo: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
