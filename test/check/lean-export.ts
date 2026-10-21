// The Lean 4 export of the stdlib's claims (check/lean-export.ts, note/project/term/proof/lean-export/spec.md).
// Run: npx tsx test/check/lean-export.ts [--write <dir>]
//
// What it holds, without Lean:
//   - every claim of deck/base/code/proof/ is proven by the kernel and exported, none refused, none on an axiom
//   - each exported term is the term the kernel checked: Term's own judge re-checks it against the exported type
//   - a planted wrong proof (symmetry proved by `refl x`, claiming `equal a y x`) is refused by Term's judge, and the
//     planted Lean file differs from the export in that one body only
// And with Lean on the PATH (or at TERM_LEAN), it runs `lean` on both files: the export must check, the plant must not.
// Without Lean that part is reported as skipped, never as passed.

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { exportLean, joinSources, plantLean } from '@term/make/code/check/lean-export'
import { check, contextWithSignature, evaluate } from '@term/make/code/check/judge'
import type { Term } from '@term/make/code/check/judge'

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

const BASE = new URL('../../deck/base/code/proof/', import.meta.url).pathname
const FILES = [
  'equal.tree',
  'equal/refl.tree',
  'equal/symmetry.tree',
  'equal/transitivity.tree',
  'equal/congruence.tree',
  'equal/substitution.tree',
  'absurd.tree',
]
const CLAIMS = ['refl', 'symmetry', 'transitivity', 'congruence', 'substitution', 'absurd']

const source = joinSources(FILES.map(file => ({ file: `proof/${file}`, text: readFileSync(join(BASE, file), 'utf8') })))
const out = exportLean(source)

ok('the kernel reports no error on the stdlib proofs', out.kernel.diagnostics.length === 0, out.kernel.diagnostics.join('; '))
ok('the claims read are the six of proof/', CLAIMS.every(c => out.claims.includes(c)) && out.claims.length === CLAIMS.length, out.claims.join(','))
ok('every claim is proven by the kernel', CLAIMS.every(c => out.kernel.proven.includes(c)), out.kernel.proven.join(','))
ok('every claim is exported', CLAIMS.every(c => out.exported.some(e => e.name === c && e.claim)), out.exported.map(e => e.name).join(','))
ok('nothing is refused', out.refused.length === 0, JSON.stringify(out.refused))
ok('no claim rests on an axiom', out.axioms.length === 0 && out.exported.every(e => e.axioms.length === 0), out.axioms.join(','))
ok('every form is a Lean inductive', /inductive TermExport\.«equal» \(\w+ : Type\)/.test(out.lean) && out.lean.includes('inductive TermExport.«never» : Type where'))
ok('the eliminator is defined by casesOn', out.lean.includes('@TermExport.«equal».casesOn'))
ok('absurd recurses through the recursor, not by name', out.lean.includes('@TermExport.«never».rec') && !/def TermExport\.«absurd»[^\n]*\n[^\n]*TermExport\.«absurd»/.test(out.lean))
ok('no sorry, no partial, no axiom in the file', !/\bsorry\b|\bpartial\b|^axiom /m.test(out.lean))
ok('a definition comes after everything it names', out.lean.indexOf('def TermExport.«chain»') < out.lean.indexOf('def TermExport.«transitivity»') && out.lean.indexOf('inductive TermExport.«equal»') < out.lean.indexOf('def TermExport.«refl»'))

// QUANTITIES FORGOTTEN, as Lean reads a term: every binder `many`. The kept term is the zonked one, and a contextual
// metavariable `?m a` (elaborating-terms.tree `contextual-type-meta`) used an erased generic `a` at 0 before it was
// solved and at `many` after, so symmetry and congruence fail the usage check as quoted though the kernel accepted them
// as elaborated (logged in the project, 2026-10-20). Types are what Lean re-checks, so types are what this compares
function forgetUsage(term: Term): Term {
  switch (term.tag) {
    case 'pi':
    case 'sigma':
      return { ...term, mult: 'many', domain: forgetUsage(term.domain), codomain: forgetUsage(term.codomain) }
    case 'lam':
      return { ...term, body: forgetUsage(term.body) }
    case 'app':
      return { ...term, fun: forgetUsage(term.fun), arg: forgetUsage(term.arg) }
    case 'ann':
      return { ...term, term: forgetUsage(term.term), type: forgetUsage(term.type) }
    default:
      return term
  }
}

// the terms are the kernel's: Term's own judge checks each against its type again, in the signature elaboration used
const context = contextWithSignature(out.signature.map(entry => ({ name: entry.name, type: forgetUsage(entry.type) })))

for (const [name, { type, value }] of out.terms) {
  let checked = true
  let error = ''

  try {
    check(context, forgetUsage(value), evaluate([], forgetUsage(type)))
  } catch (raised) {
    checked = false
    error = raised instanceof Error ? raised.message : String(raised)
  }

  ok(`the judge re-checks the exported term of ${name}`, checked, error)
}

// THE PLANTED TWIN: symmetry "proved" by `refl a x`, which has type `equal a x x`, not `equal a y x`
const symmetry = out.terms.get('symmetry')!
const app = (fun: Term, arg: Term): Term => ({ tag: 'app', fun, arg })
const lam = (body: Term): Term => ({ tag: 'lam', body })
// under the four binders a, x, y, proof: a is #3, x is #2
const wrong = lam(lam(lam(lam(app(app({ tag: 'const', name: 'equal__refl' }, { tag: 'var', index: 3 }), { tag: 'var', index: 2 }))))) as Term
let refused = false

try {
  check(context, wrong, evaluate([], forgetUsage(symmetry.type)))
} catch {
  refused = true
}

ok('the judge refuses the planted proof', refused)

const header = out.lean.split('\n').find(line => line.startsWith('def TermExport.«symmetry»'))!
const [typeName, xName] = [...header.matchAll(/\((\w+) : /g)].map(m => m[1]!)
const planted = plantLean(out.lean, 'symmetry', `(@TermExport.«equal».«refl» ${typeName} ${xName})`)
const changed = out.lean.split('\n').filter((line, i) => planted.split('\n')[i] !== line)
ok('the plant changes exactly one line, the body of symmetry', changed.length === 1 && planted !== out.lean, `${changed.length} lines`)

// write the files for a Lean run by hand
const writeAt = process.argv.indexOf('--write')

if (writeAt > 0) {
  const dir = process.argv[writeAt + 1]!
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'stdlib.lean'), out.lean)
  writeFileSync(join(dir, 'planted.lean'), planted)
  console.log(`wrote ${join(dir, 'stdlib.lean')} and ${join(dir, 'planted.lean')}`)
}

// LEAN ITSELF, when it is here
const lean = process.env.TERM_LEAN ?? spawnSync('which', ['lean'], { encoding: 'utf8' }).stdout.trim()

if (lean && existsSync(lean)) {
  const dir = new URL('../../tmp/lean-export/run/', import.meta.url).pathname
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'stdlib.lean'), out.lean)
  writeFileSync(join(dir, 'planted.lean'), planted)
  const good = spawnSync(lean, [join(dir, 'stdlib.lean')], { encoding: 'utf8' })
  ok('lean checks the export', good.status === 0, `${good.stdout}${good.stderr}`.slice(0, 2000))
  const axiomFree = CLAIMS.every(c => new RegExp(`'TermExport\\.${c}' does not depend on any axioms`).test(good.stdout))
  ok('lean reports every claim free of axioms', axiomFree, good.stdout.slice(0, 2000))
  const bad = spawnSync(lean, [join(dir, 'planted.lean')], { encoding: 'utf8' })
  ok('lean refuses the planted proof', bad.status !== 0, `${bad.stdout}${bad.stderr}`.slice(0, 2000))
} else {
  console.log('skip  lean is not installed: the Lean re-check did not run (see note/project/term/proof/lean-export/spec.md)')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
