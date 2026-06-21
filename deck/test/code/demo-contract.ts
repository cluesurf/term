/**
 * The full loop: contracts (refinement-typed pre/post) verified by
 * proof, and the system writing a contract's body automatically.
 * Run: npx tsx deck/test/code/demo-contract.ts
 *
 *   A. refinement reasoning: a body correct only UNDER its
 *      precondition verifies with it and fails without it.
 *   B. contract verification: a correct body is proven, a buggy one is
 *      rejected with the exact admitted counterexample.
 *   C. spec -> verified code: from a contract alone, the system writes
 *      the body and the prover certifies it. The whole vision, running.
 *   D. synthesis under a precondition: the precondition admits a body
 *      that would be wrong in general.
 *
 * Pure node + tsx, deterministic.
 */

import {
  verifyContract,
  synthesizeContract,
  type Contract,
} from './contract'
import { showRepair } from './gap'
import { evalExpr, type Expr } from './synthesize'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
  else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
}

const VAR = (index: number): Expr => ({ form: 'var', index })
const ZERO: Expr = { form: 'const', value: 0 }

// ============================================================
// A. refinement reasoning: the precondition carries the proof
// ============================================================
console.log('--- A. refinement (precondition) reasoning ---')

// "negate", correct only when a < 0: result is positive and equals -a.
const negBody: Expr = { form: 'sub', left: ZERO, right: VAR(0) } // 0 - a

// with the refinement a < 0, the body is provably correct
const refined: Contract = {
  name: 'negate-negative',
  params: [{ name: 'a', refine: a => a < 0 }],
  post: ([a], out) => out > 0 && out === -a,
}
ok('body verifies under its refinement', verifyContract(negBody, refined).ok)

// drop the refinement and the SAME body is unprovable - a=0 breaks it
const unrefined: Contract = {
  name: 'negate-any',
  params: [{ name: 'a' }],
  post: ([a], out) => out > 0 && out === -a,
}
const unrefinedResult = verifyContract(negBody, unrefined)
ok('same body fails without the refinement', !unrefinedResult.ok,
  !unrefinedResult.ok ? `counterexample a=${unrefinedResult.counterexample[0]}` : '')

// ============================================================
// B. contract verification: correct proven, buggy rejected
// ============================================================
console.log('\n--- B. contract verification ---')

const maxContract: Contract = {
  name: 'max',
  params: [{ name: 'a' }, { name: 'b' }],
  post: ([a, b], out) => out >= a && out >= b && (out === a || out === b),
}

const goodMax: Expr = { form: 'max', left: VAR(0), right: VAR(1) }
ok('correct max body proven over bound', verifyContract(goodMax, maxContract).ok)

const buggyMax: Expr = VAR(0) // "return a"
const buggyResult = verifyContract(buggyMax, maxContract)
ok('buggy max body rejected', !buggyResult.ok,
  !buggyResult.ok ? `counterexample [a,b]=${JSON.stringify(buggyResult.counterexample)}` : '')

// ============================================================
// C. spec -> verified code (the full loop)
// ============================================================
console.log('\n--- C. spec -> verified code ---')

// from the max contract alone, write the body and prove it
const maxSynth = synthesizeContract(maxContract)
ok('max body synthesized from contract', maxSynth.ok, showRepair(maxSynth, ['a', 'b']))
if (maxSynth.ok) {
  // independently re-verify the synthesized body against the contract
  ok('synthesized max re-verifies against the contract',
    verifyContract(maxSynth.expr, maxContract).ok)
}

// A WEAK spec exposed: "out >= 0 and (out is a or 0)" is satisfied by
// the constant 0 for every input (0 === 0 is always true). The
// synthesizer finds that trivial body - and in doing so reveals the
// spec is under-specified. This is the system finding a SPEC bug, the
// deepest kind of hole (finding-holes.md: "the spec was wrong").
const weakClamp: Contract = {
  name: 'clamp-low-weak',
  params: [{ name: 'a' }],
  post: ([a], out) => out >= 0 && (out === a || out === 0),
}
const weakSynth = synthesizeContract(weakClamp)
ok('weak spec admits the trivial body (spec bug exposed)',
  weakSynth.ok && weakSynth.expr.form === 'const' && weakSynth.expr.value === 0,
  weakSynth.ok ? `=> ${showRepair(weakSynth, ['a'])}` : '')

// Tighten it: also require out >= a. Now 0 is illegal for a > 0, and
// the only body that works is max(a, 0) - the real clamp.
const clampContract: Contract = {
  name: 'clamp-low',
  params: [{ name: 'a' }],
  post: ([a], out) => out >= 0 && out >= a && (out === a || out === 0),
}
const clampSynth = synthesizeContract(clampContract)
ok('tightened spec forces the real clamp max(a, 0)',
  clampSynth.ok, showRepair(clampSynth, ['a']))

// ============================================================
// D. synthesis under a precondition
// ============================================================
console.log('\n--- D. synthesis under a precondition ---')

// with a >= b guaranteed, the max is just a. The synthesizer should
// find the simplest body the precondition admits.
const orderedMax: Contract = {
  name: 'max-when-ordered',
  params: [{ name: 'a' }, { name: 'b' }],
  pre: ([a, b]) => a >= b,
  post: ([a, b], out) => out >= a && out >= b && (out === a || out === b),
}
const orderedSynth = synthesizeContract(orderedMax, { maxSize: 3 })
ok('synthesized body under precondition', orderedSynth.ok, showRepair(orderedSynth, ['a', 'b']))
if (orderedSynth.ok) {
  // the body must hold on admitted inputs; "a" suffices because a>=b
  ok('precondition-restricted body verifies',
    verifyContract(orderedSynth.expr, orderedMax).ok)
}

console.log(`\nseed-verify contract demo: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
