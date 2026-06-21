/**
 * Runnable proof of the next verification layers. Run:
 *   npx tsx code/demo-loop.ts
 *
 * Three things, each a step toward the full system:
 *   A. type-derived generators: a generator built from a Seed type
 *      alone, no hand-writing (Layer 3 integration).
 *   B. exhaustive proof: the verifier decides a claim over a whole
 *      bounded domain, not just samples (concepts.md "decide up to B").
 *   C. the unified repair loop: a GapReport flows through layered
 *      proposers (an AI-hint plug point, then CEGIS), each candidate
 *      PROVEN before acceptance (synthesis.md Phases A-C).
 *
 * Pure node + tsx, deterministic.
 */

import { check } from './property'
import {
  genForType,
  tRecord,
  tInt,
  tList,
  tWhole,
  type SeedType,
} from './type'
import { prove } from './prove'
import { repair, cegisProposer, hintProposer, showRepair, type GapReport } from './gap'
import { evalExpr, type Spec, type Expr } from './synthesize'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
  else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
}

// ============================================================
// A. type-derived generators
// ============================================================
console.log('--- A. generators derived from Seed types ---')

// a record type {a: int, b: int} - the generator is folded from it
const pointType: SeedType = tRecord([
  { name: 'a', type: tInt },
  { name: 'b', type: tInt },
])
const genPoint = genForType(pointType)
const pointProp = check(
  genPoint,
  (p: any) => typeof p.a === 'number' && typeof p.b === 'number',
  { runs: 100 },
)
ok('record generator derived from type', pointProp.ok)

// a nested type: list of {n: whole} - derivation recurses
const rowsType: SeedType = tList(tRecord([{ name: 'n', type: tWhole }]))
const genRows = genForType(rowsType)
const rowsProp = check(
  genRows,
  (rows: any) => Array.isArray(rows) && rows.every(r => r.n >= 0),
  { runs: 100 },
)
ok('nested list-of-record generator derived', rowsProp.ok)

// ============================================================
// B. exhaustive proof vs sampling
// ============================================================
console.log('\n--- B. proving over a bounded domain ---')

// prove a true fact over all |x| <= 8: max(a,b) >= a always
const trueFact = prove({
  arity: 2,
  claim: ([a, b]) => Math.max(a, b) >= a,
  bound: 8,
})
ok('true fact proven over bound', trueFact.ok, trueFact.ok ? `(${trueFact.checked} cases)` : '')

// a fact that holds on most samples but fails at one point: a*a != 6
// (true over integers, but show prove finds an exact boundary failure
// for a deliberately wrong claim: a + 1 > a only fails never; use a
// real hole: "a < 5" is false at a=5)
const boundedHole = prove({
  arity: 1,
  claim: ([a]) => a < 5,
  bound: 8,
})
ok('exhaustive proof finds the exact boundary hole', !boundedHole.ok,
  !boundedHole.ok ? `counterexample a=${boundedHole.counterexample[0]}` : '')

// ============================================================
// C. the unified repair loop (proposers + proof)
// ============================================================
console.log('\n--- C. the repair loop: gap -> proposers -> proof ---')

const maxSpec: Spec = ([a, b], out) =>
  out >= a && out >= b && (out === a || out === b)

// the gap, as the checker would emit it
const maxGap: GapReport = {
  goal: 'max(a, b)',
  varCount: 2,
  spec: maxSpec,
  counterexamples: [],
  bound: 8,
}

// CEGIS alone closes it, and the result is PROVEN over the bound
const cegisOnly = repair(maxGap, [cegisProposer()])
ok('repair loop synthesizes + proves max', cegisOnly.ok,
  showRepair(cegisOnly, ['a', 'b']))

// the layered case: an AI-hint proposer answers first for a goal it
// "knows" (the plug point), and the SAME loop proves its proposal. If
// the hint were wrong, the proof would reject it and CEGIS would take
// over - the safety net.
const aiHint: Record<string, Expr> = {
  // a correct hint, as a model would (ideally) propose
  'max(a, b)': { form: 'max', left: { form: 'var', index: 0 }, right: { form: 'var', index: 1 } },
}
const layered = repair(maxGap, [hintProposer(aiHint), cegisProposer()])
ok('layered proposers: AI-hint proposes, loop proves it', layered.ok && layered.proposer === 'ai-hint',
  showRepair(layered, ['a', 'b']))

// a WRONG hint must be caught by the proof and fall back to CEGIS
const badHint: Record<string, Expr> = {
  'max(a, b)': { form: 'var', index: 0 }, // "return a" - wrong
}
const recovered = repair(maxGap, [hintProposer(badHint), cegisProposer()])
ok('wrong AI-hint is rejected by proof, CEGIS recovers',
  recovered.ok && recovered.proposer === 'cegis',
  recovered.ok ? `recovered => ${showRepair(recovered, ['a', 'b'])}` : '')

console.log(`\nseed-verify loop demo: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
