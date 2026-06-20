// The natural numbers as a self-typed inductive on the DECIDED kernel (judge.ts), WITH arithmetic that computes.
// Nat = Self n. (P : Nat -> Type0) -> P zero -> ((k:Nat) -> P k -> P (succ k)) -> P n. zero and succ are the
// constructors; the self type carries its own induction principle. Because the bottom universe is impredicative, the
// self-encoded Nat lives in Type0 (its own motive's universe), so the recursor can eliminate INTO Nat -- addition
// and multiplication, which return Nat, type-check and reduce. Run: npx tsx test/check/naturals-judge.ts

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
const idt = (type: Term, left: Term, right: Term): Term => ({
  tag: 'id',
  type,
  left,
  right,
})
const refl = (type: Term, value: Term): Term => ({
  tag: 'refl',
  type,
  value,
})
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
// plus = \ a. \ b. a (\_. Nat) b (\_. \ r. succ r)   -- recurse on a, base b, step succ
const plusTerm = lam(
  lam(aps(v(1), lam(kc('Nat')), v(0), lam(lam(app(kc('succ'), v(0)))))),
)
// times = \ a. \ b. a (\_. Nat) zero (\_. \ r. plus b r)   -- recurse on a, base zero, step (add b)
const timesTerm = lam(
  lam(
    aps(
      v(1),
      lam(kc('Nat')),
      kc('zero'),
      lam(lam(aps(kc('plus'), v(2), v(0)))),
    ),
  ),
)

const natValue = evaluate([], natTerm) // the self type as a value, the form the kernel introduces against
const natToNat = pi('many', natTerm, natTerm)
const natToNatToNat = pi('many', natTerm, natToNat)

// signature gives the types; defineConstant gives the values (transparent, so reduction fires). The bottom universe
// is impredicative, so the self-encoded Nat lives in Type0 (not one level above its motive), and the constant Nat is
// typed at ty(0). This is what makes plus and times -- which return Nat -- well typed. plus is in the signature so
// that times, whose body names it, type-checks.
const signature = [
  { name: 'Nat', type: ty(0) },
  { name: 'zero', type: kc('Nat') },
  { name: 'succ', type: pi('many', kc('Nat'), kc('Nat')) },
  { name: 'plus', type: natToNatToNat },
  { name: 'times', type: natToNatToNat },
]
const context = contextWithSignature(signature)

defineConstant('Nat', natValue)
defineConstant('zero', evaluate([], zeroTerm))
defineConstant('succ', evaluate([], succTerm))
defineConstant('plus', evaluate([], plusTerm))
defineConstant('times', evaluate([], timesTerm))

// numerals, for the computation checks
const one = app(kc('succ'), kc('zero'))
const two = app(kc('succ'), one)
const three = app(kc('succ'), two)
const four = app(kc('succ'), three)

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
// a definitional-equality check: the named term reduces to the expected value, witnessed by refl.
function computes(name: string, type: Term, lhs: Term, rhs: Term): void {
  ok(name, () => {
    check(context, refl(type, rhs), evaluate([], idt(type, lhs, rhs)))
  })
}

ok('Nat is a self type in Type 0 (impredicative bottom universe)', () => {
  check(context, natTerm, evaluate([], ty(0)))
})
ok('zero : Nat (self introduction against the self type)', () => {
  check(context, zeroTerm, natValue)
})
ok('succ : Nat -> Nat (a generic recursive constructor)', () => {
  check(context, succTerm, evaluate([], natToNat))
})
ok('one = succ zero : Nat', () => {
  check(context, one, evaluate([], kc('Nat')))
})

// addition: it type-checks (it returns Nat, the large recursion the impredicative universe unblocks) and it reduces.
ok('plus : Nat -> Nat -> Nat type-checks (large recursion, returns Nat)', () => {
  check(context, plusTerm, evaluate([], natToNatToNat))
})
computes('plus zero one = one', kc('Nat'), aps(kc('plus'), kc('zero'), one), one)
computes('plus one one = two', kc('Nat'), aps(kc('plus'), one, one), two)
computes('plus two one = three', kc('Nat'), aps(kc('plus'), two, one), three)

// multiplication, defined in terms of plus: also type-checks and reduces.
ok('times : Nat -> Nat -> Nat type-checks', () => {
  check(context, timesTerm, evaluate([], natToNatToNat))
})
computes('times two two = four', kc('Nat'), aps(kc('times'), two, two), four)

console.log(`\nnaturals with arithmetic (decided kernel judge.ts): ${pass} pass, ${fail} fail`)
