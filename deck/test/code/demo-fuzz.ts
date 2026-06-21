/**
 * Coverage-guided fuzzing, and why feedback beats randomness. Run:
 *   npx tsx deck/test/code/demo-fuzz.ts
 *
 * The classic demonstration (AFL's whole reason to exist): a bug behind
 * nested guards `a==7 && b==13 && c==42`. Blind random almost never hits
 * all three at once. The coverage-guided fuzzer keeps each input that
 * passes one more guard (new edge), and mutates toward the next - so it
 * walks into the deep state. Then a property-fuzz finds a spec violation.
 *
 * Deterministic.
 */

import { fuzz, type Target } from './fuzz'
import { makeRng } from './property'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
  else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
}

// --- A. the deep, nested bug ---
// instrumented: cover(edge) at each branch passed
const deepBug: Target = (input, cover) => {
  const [a, b, c] = input
  cover(1)
  if (a === 7) {
    cover(2)
    if (b === 13) {
      cover(3)
      if (c === 42) {
        cover(4)
        throw new Error('deep bug reached')
      }
    }
  }
}

const guided = fuzz({ target: deepBug, arity: 3, iterations: 200_000, seed: 1 })
ok('coverage-guided fuzzer reaches the deep bug', !!guided.crash,
  guided.crash ? `crash=${JSON.stringify(guided.crash)} in ${guided.execs} execs, ${guided.edgesFound} edges` : `(no crash in ${guided.execs})`)
if (guided.crash) {
  ok('minimized crash is the exact trigger', JSON.stringify(guided.crash) === JSON.stringify([7, 13, 42]))
}

// --- B. blind random (no coverage feedback) struggles on the same bug ---
// same execution budget, but ignore coverage: just sample uniformly.
function blindRandom(target: Target, arity: number, iterations: number): boolean {
  const rng = makeRng(2)
  for (let i = 0; i < iterations; i++) {
    const input = Array.from({ length: arity }, () => Math.floor(rng.next() * 256) - 8)
    try { target(input, () => {}) } catch { return true }
  }
  return false
}
const randomFound = blindRandom(deepBug, 3, guided.execs)
ok('blind random does NOT find it in the same budget (feedback wins)', !randomFound)

// --- C. property fuzzing: find a spec violation ---
// a buggy "clamp to [0,10]" that forgets the upper bound. The oracle
// throws when the result leaves the range; the fuzzer finds an input.
const buggyClamp: Target = (input, cover) => {
  const [x] = input
  cover(1)
  const result = x < 0 ? 0 : x // BUG: no upper clamp
  cover(result <= 10 ? 2 : 3)
  if (!(result >= 0 && result <= 10)) {
    throw new Error(`clamp escaped: ${result}`)
  }
}
const propFuzz = fuzz({ target: buggyClamp, arity: 1, iterations: 50_000, seed: 3 })
ok('property fuzzing finds the spec violation', !!propFuzz.crash,
  propFuzz.crash ? `input=${JSON.stringify(propFuzz.crash)}` : '')

console.log(`\nseed-verify fuzz demo: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
