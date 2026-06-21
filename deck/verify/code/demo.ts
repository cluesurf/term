/**
 * Runnable proof that the Seed verification + synthesis loop works.
 * Run: npx tsx code/demo.ts
 *
 * Two halves:
 *   A. the property engine FINDS a hole (returns the minimal input
 *      that breaks a buggy function) and confirms a correct one.
 *   B. CEGIS SYNTHESIZES correct code from a spec alone, using the
 *      verifier's counterexamples to converge. This is "the verifier
 *      figures out what code to add," demonstrated.
 *
 * Nothing external: pure node + tsx. Deterministic.
 */

import { check, genTuple, genInt, genList } from './property'
import { synthesize, showExpr, evalExpr, type Spec } from './synthesize'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}${info ? '  ' + info : ''}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${info ? '  ' + info : ''}`)
  }
}

// ============================================================
// A. the property engine finds holes
// ============================================================
console.log('--- A. finding holes ---')

// a correct property holds: reversing twice is identity
const reverseTwice = check(
  genList(genInt),
  list => {
    const r = list.slice().reverse().reverse()
    return JSON.stringify(r) === JSON.stringify(list)
  },
  { runs: 300 },
)
ok('correct property passes', reverseTwice.ok, `(${reverseTwice.ok ? reverseTwice.runs + ' runs' : ''})`)

// a buggy "max": returns the first arg. the verifier must find a
// counterexample where b > a, shrunk to a minimal case.
function buggyMax(a: number, b: number): number {
  return a
}
const buggyResult = check(
  genTuple(genInt, genInt),
  ([a, b]) => {
    const m = buggyMax(a, b)
    return m >= a && m >= b
  },
  { runs: 300 },
)
ok(
  'buggy max: hole found',
  !buggyResult.ok,
  !buggyResult.ok
    ? `counterexample [a,b]=${JSON.stringify(buggyResult.counterexample)} (shrunk ${buggyResult.shrinks}x)`
    : '',
)
// the minimized counterexample should be tiny (the smallest a<b)
if (!buggyResult.ok) {
  const [a, b] = buggyResult.counterexample
  ok('counterexample is minimal', b > a && Math.abs(a) <= 1 && Math.abs(b) <= 1)
}

// ============================================================
// B. CEGIS synthesizes correct code from a spec
// ============================================================
console.log('\n--- B. synthesizing code from specs ---')

// spec for max(a, b): the result is >= both and equals one of them.
// note: the spec never says HOW. the loop derives the code.
const maxSpec: Spec = ([a, b], out) =>
  out >= a && out >= b && (out === a || out === b)

const maxSynth = synthesize({ varCount: 2, spec: maxSpec, maxSize: 6 })
ok(
  'synthesized max from spec',
  maxSynth.ok,
  maxSynth.ok
    ? `=> ${showExpr(maxSynth.expr, ['a', 'b'])}  (${maxSynth.counterexamples.length} counterexamples, ${maxSynth.candidatesTried} candidates)`
    : maxSynth.reason,
)
// independently re-verify the synthesized program
if (maxSynth.ok) {
  const reverify = check(
    genTuple(genInt, genInt),
    ([a, b]) => maxSpec([a, b], evalExpr(maxSynth.expr, [a, b])),
    { runs: 500, seed: 99 },
  )
  ok('synthesized max re-verifies', reverify.ok)
}

// spec for abs(a): non-negative, and equals a or -a.
const absSpec: Spec = ([a], out) => out >= 0 && (out === a || out === -a)
const absSynth = synthesize({ varCount: 1, spec: absSpec, maxSize: 6 })
ok(
  'synthesized abs from spec',
  absSynth.ok,
  absSynth.ok
    ? `=> ${showExpr(absSynth.expr, ['a'])}  (${absSynth.counterexamples.length} counterexamples)`
    : absSynth.reason,
)

// spec for min(a, b): <= both and equals one of them.
const minSpec: Spec = ([a, b], out) =>
  out <= a && out <= b && (out === a || out === b)
const minSynth = synthesize({ varCount: 2, spec: minSpec, maxSize: 6 })
ok(
  'synthesized min from spec',
  minSynth.ok,
  minSynth.ok ? `=> ${showExpr(minSynth.expr, ['a', 'b'])}` : minSynth.reason,
)

// an unsatisfiable spec must fail honestly (no program is > every input
// AND < every input). proves the loop does not lie.
const impossibleSpec: Spec = ([a], out) => out > a && out < a
const impossibleSynth = synthesize({ varCount: 1, spec: impossibleSpec, maxSize: 4 })
ok('unsatisfiable spec reported as unsynthesizable', !impossibleSynth.ok)

console.log(`\nseed-verify demo: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
