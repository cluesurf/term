// The natural numbers as a self-typed inductive on the DECIDED kernel (judge.ts), with real reduction.
// Nat = Self n. (0 P : Nat -> Type0) -> (1 _ : P zero) -> (1 _ : (1 k : Nat) -> (1 _ : P k) -> P (succ k)) -> P n
// zero and succ are the constructors; the self type carries its own induction principle. Transparent definitions
// (defineConstant) give the constructors reduction so plus computes. Run: npx tsx test/check/naturals-judge.ts

import type { Mult, Term } from '@/code/check/judge'
import {
  contextWithSignature,
  check,
  evaluate,
  defineConstant,
  litLevel,
} from '@/code/check/judge'

const v = (index: number): Term => ({ tag: 'var', index })
const kc = (name: string): Term => ({ tag: 'const', name })
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
const aps = (fun: Term, ...args: Array<Term>): Term =>
  args.reduce((f, a) => app(f, a), fun)

// inside `self n. body`, the self value n is v(0). Then P binds (v0=P, v1=n), the zero-case binds
// (v0=zc, v1=P, v2=n), the step binds (v0=sc, v1=zc, v2=P, v3=n).
const stepType = pi(
  'many',
  kc('Nat'), // k : Nat
  pi(
    'many',
    app(v(2), v(0)), // P k    (in [n,P,zc,k]: P=v2, k=v0)
    app(v(3), app(kc('succ'), v(1))), // P (succ k)   (in [n,P,zc,k,_]: P=v3, k=v1)
  ),
)

const natBody = pi(
  0,
  pi('many', kc('Nat'), ty(0)), // P : Nat -> Type0
  pi(
    'many',
    app(v(0), kc('zero')), // P zero   (P=v0)
    pi(
      'many',
      stepType, // the step case
      app(v(2), v(3)), // P n   (in [n,P,zc,sc]: P=v2, n=v3)
    ),
  ),
)
const natTerm = self(natBody)

// zero = \ P. \ z. \ s. z
const zeroTerm = lam(lam(lam(v(1))))
// succ = \ n. \ P. \ z. \ s. (s n (n P z s))   (n=v3, P=v2, z=v1, s=v0)
const succTerm = lam(
  lam(lam(lam(aps(v(0), v(3), aps(v(3), v(2), v(1), v(0)))))),
)
// plus = \ a. \ b. a (\_. Nat) b (\_. \ r. succ r)
const plusTerm = lam(
  lam(
    aps(
      v(1),
      lam(kc('Nat')),
      v(0),
      lam(lam(app(kc('succ'), v(0)))),
    ),
  ),
)

// signature gives the types; defineConstant gives the values (transparent, so reduction fires). The self-encoded
// Nat lives at Type1 (its motive quantifies P : Nat -> Type0), so the constant Nat is typed at ty(1).
const signature = [
  { name: 'Nat', type: ty(1) },
  { name: 'zero', type: kc('Nat') },
  { name: 'succ', type: pi('many', kc('Nat'), kc('Nat')) },
]
const context = contextWithSignature(signature)

const natValue = evaluate([], natTerm) // the self type as a value, the form the kernel introduces against
defineConstant('Nat', natValue)
defineConstant('zero', evaluate([], zeroTerm))
defineConstant('succ', evaluate([], succTerm))

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
// a check that MUST fail: the test passes when the kernel rejects the term, recording a real boundary.
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

ok('Nat is a self type at Type 1', () => {
  check(context, natTerm, evaluate([], ty(1)))
})
ok('zero : Nat (self introduction against the self type)', () => {
  check(context, zeroTerm, natValue)
})
ok('succ : Nat -> Nat (a generic recursive constructor)', () => {
  check(context, succTerm, evaluate([], pi('many', natTerm, natTerm)))
})
ok('one = succ zero : Nat', () => {
  check(context, app(kc('succ'), kc('zero')), evaluate([], kc('Nat')))
})

// The predicativity boundary. Addition returns Nat, so it must be defined by the recursor eliminating INTO Nat.
// But the recursor's motive is P : Nat -> Type0, and this self-encoded Nat lives at Type1, so the motive (\ _. Nat)
// would need Nat : Type0, which is false. Large recursion (returning the inductive type itself: plus, times) is not
// available from the predicative recursor. It needs universe polymorphism in the motive or a primitive inductive.
// Small folds (into a Type0 target) and dependent induction (motives into Type0, for proofs) are unaffected, and
// are what `naturals2-judge` and `succ-judge` exercise. So this is a precise boundary, not a defect.
rejects(
  'plus : Nat -> Nat -> Nat is NOT definable by the predicative recursor (large recursion needs a higher motive)',
  () => {
    check(
      context,
      plusTerm,
      evaluate([], pi('many', natTerm, pi('many', natTerm, natTerm))),
    )
  },
)

console.log(`\nnaturals (decided kernel judge.ts): ${pass} pass, ${fail} fail`)
