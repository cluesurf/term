// Propositional truncation / hProp (proof irrelevance): a truncation constructor `squash : (0 A) -> A -> Squash A` makes
// `Squash A` a "mere proposition" -- any two inhabitants are equal regardless of the proof. The kernel's `convert` now
// equates two applications of a registered truncation constructor on all spine elements EXCEPT the proof (the last), so
// `squash A x` and `squash A y` are convertible. This is "mere existence" without leaking a witness. Soundness: a
// NON-truncation constructor stays proof-relevant, and a different TYPE argument is not equated.
// Run: npx tsx test/check/hprop.ts

import type { Term } from '@term/make/code/check/judge'
import {
  areConvertible,
  evaluate,
  registerTruncation,
  resetDefinitions,
} from '@term/make/code/check/judge'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}`)
  }
}

const kconst = (name: string): Term => ({ tag: 'const', name })

const app = (fun: Term, ...args: Term[]): Term =>
  args.reduce<Term>((f, a) => ({ tag: 'app', fun: f, arg: a }), fun)

resetDefinitions()
registerTruncation('squash')

// squash A x  and  squash A y  -- same type, different proofs
const sx = evaluate([], app(kconst('squash'), kconst('A'), kconst('x')))
const sy = evaluate([], app(kconst('squash'), kconst('A'), kconst('y')))

ok('proof irrelevance: squash A x == squash A y', areConvertible(0, sx, sy))

// squash A x  vs  squash B x  -- DIFFERENT type argument must NOT be equated (the type is not the proof)
const sbx = evaluate([], app(kconst('squash'), kconst('B'), kconst('x')))

ok(
  'different type argument is not equated',
  !areConvertible(0, sx, sbx),
)

// SOUNDNESS CONTROL: a non-truncation constructor stays proof-relevant
const px = evaluate([], app(kconst('pair'), kconst('x')))
const py = evaluate([], app(kconst('pair'), kconst('y')))

ok(
  'non-truncation constructor is proof-relevant',
  !areConvertible(0, px, py),
)

console.log(`\nhprop (proof irrelevance): ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
