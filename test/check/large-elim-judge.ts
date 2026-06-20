// Is large recursion (an operation that returns the inductive type itself, like plus : Nat -> Nat -> Nat) definable
// by a predicative self-encoded recursor? This test answers no, and shows WHY it is structural rather than a bad
// choice of universe level. A self-encoded Nat whose motive targets Type_k lives at Type_(k+1) -- one level above
// its own motive. So the motive (\ _. Nat) that addition needs returns a Type_(k+1) value where the recursor wants
// a Type_k one, and the gap is exactly one level FOR EVERY k. Raising the motive's universe raises the carrier with
// it: the cap moves, it never closes. We check this at k = 0 and k = 1, so it is a structural boundary, not an
// artifact. Lifting it needs impredicativity (the CoC / Cedille route the self-type encoding actually assumes) or
// primitive inductives (the CIC route). Run: npx tsx test/check/large-elim-judge.ts

import type { Mult, Term } from '@/code/check/judge'
import {
  check,
  contextWithSignature,
  evaluate,
  defineConstant,
  litLevel,
} from '@/code/check/judge'

const v = (i: number): Term => ({ tag: 'var', index: i })
const kc = (n: string): Term => ({ tag: 'const', name: n })
const ty = (n: number): Term => ({ tag: 'type', level: litLevel(n) })
const pi = (m: Mult, domain: Term, codomain: Term): Term => ({
  tag: 'pi',
  mult: m,
  domain,
  codomain,
})
const lam = (body: Term): Term => ({ tag: 'lam', body })
const app = (fun: Term, arg: Term): Term => ({ tag: 'app', fun, arg })
const self = (body: Term): Term => ({ tag: 'self', body })
const aps = (f: Term, ...a: Array<Term>): Term =>
  a.reduce((g, x) => app(g, x), f)

let pass = 0
let fail = 0
function ok(name: string, run: () => void): void {
  try {
    run()
    pass++
    console.log(`ok    ${name}`)
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

// build a self-encoded Nat whose motive targets Type_k, with level-suffixed constant names to avoid clashes.
function buildNatAtMotiveLevel(k: number): void {
  const Nat = `Nat${k}`
  const zero = `zero${k}`
  const succ = `succ${k}`
  // step case: (j : Nat) -> P j -> P (succ j)
  const stepType = pi(
    'many',
    kc(Nat),
    pi('many', app(v(2), v(0)), app(v(3), app(kc(succ), v(1)))),
  )
  // Nat = Self n. (P : Nat -> Type_k) -> P zero -> ((j:Nat) -> P j -> P (succ j)) -> P n
  const natBody = pi(
    0,
    pi('many', kc(Nat), ty(k)),
    pi('many', app(v(0), kc(zero)), pi('many', stepType, app(v(2), v(3)))),
  )
  const natTerm = self(natBody)
  const zeroTerm = lam(lam(lam(v(1))))
  const succTerm = lam(
    lam(lam(lam(app(app(v(0), v(3)), aps(v(3), v(2), v(1), v(0)))))),
  )
  // plus = \ a b. a (\ _. Nat) b (\ _ r. succ r)   -- eliminates a INTO Nat, the large recursion
  const plusTerm = lam(
    lam(aps(v(1), lam(kc(Nat)), v(0), lam(lam(app(kc(succ), v(0)))))),
  )

  const context = contextWithSignature([
    { name: Nat, type: ty(k + 1) }, // the carrier lives ONE level above its motive
    { name: zero, type: kc(Nat) },
    { name: succ, type: pi('many', kc(Nat), kc(Nat)) },
  ])
  const natValue = evaluate([], natTerm)
  defineConstant(Nat, natValue)
  defineConstant(zero, evaluate([], zeroTerm))
  defineConstant(succ, evaluate([], succTerm))

  ok(`Nat${k} : Type ${k + 1} (motive into Type ${k}, carrier one level up)`, () => {
    check(context, natTerm, evaluate([], ty(k + 1)))
  })
  ok(`zero${k} : Nat${k} (small introduction works at every level)`, () => {
    check(context, zeroTerm, natValue)
  })
  rejects(
    `plus${k} : Nat${k} -> Nat${k} -> Nat${k} is rejected (the motive sits one level too high)`,
    () => {
      check(
        context,
        plusTerm,
        evaluate([], pi('many', natTerm, pi('many', natTerm, natTerm))),
      )
    },
  )
}

// the same obstruction at two different motive universes: the gap is exactly one level, both times.
buildNatAtMotiveLevel(0)
buildNatAtMotiveLevel(1)

console.log(
  `\nlarge recursion is not predicatively self-encodable (judge.ts): ${pass} pass, ${fail} fail`,
)
