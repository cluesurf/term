// Soundness of the impredicative bottom universe. Making Type0 impredicative is what unblocks large recursion (an
// operation that returns the inductive type itself, like plus : Nat -> Nat -> Nat -- see naturals-judge), because a
// self-encoded Nat then lives in Type0, the universe of its own motive, instead of floating one level above it. But
// impredicativity is the rule that, combined the wrong way, gives Girard / Coquand paradoxes. This test pins down
// that the change is the bounded, consistent fragment (the impredicative-Set discipline, as in Coq), not Type : Type:
//   - the bottom IS impredicative: a Pi into Type0 stays in Type0 regardless of the domain's universe.
//   - everything ABOVE stays predicative: a Pi into Type1 takes the max, it does not collapse.
//   - the universe is still stratified: Type0 : Type1, and Type0 : Type0 is rejected (no Type : Type).
//   - Sigma stays predicative: there are no impredicative strong sums (those reintroduce the paradox).
// Run: npx tsx test/check/large-elim-judge.ts

import type { Mult, Term } from '@term/make/code/check/judge'
import {
  infer,
  contextWithSignature,
  evaluate,
  litLevel,
} from '@term/make/code/check/judge'

const kc = (n: string): Term => ({ tag: 'const', name: n })
const ty = (n: number): Term => ({ tag: 'type', level: litLevel(n) })
const pi = (m: Mult, domain: Term, codomain: Term): Term => ({
  tag: 'pi',
  mult: m,
  domain,
  codomain,
})

const sigma = (m: Mult, domain: Term, codomain: Term): Term => ({
  tag: 'sigma',
  mult: m,
  domain,
  codomain,
})

// postulated types dwelling at known universes, used as Pi codomains. "Into Type k" means the codomain is a type
// that LIVES in Type k (like A : Type0, the universe a self-encoded Nat dwells in), not the universe Type k itself.
const context = contextWithSignature([
  { name: 'A', type: ty(0) }, // A : Type0
  { name: 'B', type: ty(1) }, // B : Type1
  { name: 'C', type: ty(2) }, // C : Type2
])

let pass = 0
let fail = 0

function expectLevel(name: string, typeTerm: Term, want: number): void {
  try {
    const universe = infer(context, typeTerm).type

    if (
      universe.v === 'type' &&
      universe.level.constant === want &&
      universe.level.vars.size === 0
    ) {
      pass++
      console.log(`ok    ${name} (Type ${want})`)
    } else {
      fail++

      const got =
        universe.v === 'type'
          ? `Type ${universe.level.constant}`
          : universe.v

      console.log(`FAIL  ${name} (wanted Type ${want}, got ${got})`)
    }
  } catch (error) {
    fail++
    console.log(
      `FAIL  ${name}\n  ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function rejects(name: string, run: () => void): void {
  try {
    run()
    fail++
    console.log(`FAIL  ${name} (expected a rejection, but it checked)`)
  } catch {
    pass++
    console.log(`ok    ${name} (rejected, as it must be)`)
  }
}

// the bottom is impredicative: a Pi whose codomain dwells in Type0 (here A) stays in Type0, even when its domain is
// a HIGH universe. This is exactly the rule that keeps a self-encoded Nat in Type0.
expectLevel(
  'a Pi into A:Type0 stays in Type 0 even from a B:Type1 domain (impredicative)',
  pi('many', kc('B'), kc('A')),
  0,
)
expectLevel(
  'a Pi into A:Type0 stays in Type 0 from a C:Type2 domain (impredicative)',
  pi('many', kc('C'), kc('A')),
  0,
)

// above the bottom it is predicative: a Pi into B:Type1 takes the max, it does NOT collapse.
expectLevel(
  'a Pi into B:Type1 from a C:Type2 domain takes the max, Type 2 (predicative above)',
  pi('many', kc('C'), kc('B')),
  2,
)
expectLevel(
  'a Pi into B:Type1 from an A:Type0 domain is Type 1 (predicative above)',
  pi('many', kc('A'), kc('B')),
  1,
)

// the hierarchy is still stratified, so this is impredicative-Set, not Type : Type.
expectLevel(
  'Type 0 : Type 1 (the bottom universe is itself one level up)',
  ty(0),
  1,
)
rejects(
  'Type 0 : Type 0 is rejected (no Type : Type, the inconsistent collapse)',
  () => {
    // a value of type Type0 whose own type is Type0 would be Type : Type. Type0 has type Type1, so checking it AT
    // Type0 must fail.
    const universe = infer(context, ty(0)).type

    if (!(universe.v === 'type' && universe.level.constant === 0))
      {throw new Error('Type 0 is not in Type 0')}
  },
)

// Sigma stays predicative: a strong sum into Type0 from a Type1 domain does NOT collapse to Type0. Impredicative
// strong sums are exactly what reintroduce Girard's paradox, so they must remain at the max.
expectLevel(
  'Sigma into A:Type0 from a B:Type1 domain is Type 1, not Type 0 (no impredicative strong sums)',
  sigma('many', kc('B'), kc('A')),
  1,
)

console.log(
  `\nimpredicative bottom universe is sound and bounded (judge.ts): ${pass} pass, ${fail} fail`,
)
