// The self-typed naturals WITH computation on the decided kernel (judge.ts). The earlier attempt failed because
// applying a self-typed value needs self-elimination, which judge.ts does not auto-insert in `infer`. But the
// elimination is available explicitly via an annotation (`ann`) that coerces the value to its unfolded type. With
// that coercion the eliminator computes: zero's eliminator reduces to the base case. So the self-typed inductive
// is NOT fundamentally blocked, only its implicit-coercion sugar is. Run: npx tsx test/check/naturals2-judge.ts

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
const ann = (term: Term, type: Term): Term => ({ tag: 'ann', term, type })
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
const aps = (f: Term, ...a: Array<Term>): Term =>
  a.reduce((g, x) => app(g, x), f)

// inside `self n. body`, the self value n is v(0); after binding P, the zero-case, and the step, indices shift.
// the step case: (k : Nat) -> P k -> P (succ k)
const stepInBody = pi(
  'many',
  kc('Nat'),
  pi(
    'many',
    app(v(2), v(0)), // P k
    app(v(3), app(kc('succ'), v(1))), // P (succ k)
  ),
)

// Nat body, with the self value n referenced in the conclusion P n.
const natBody = pi(
  0,
  pi('many', kc('Nat'), ty(0)), // P : Nat -> Type0
  pi(
    'many',
    app(v(0), kc('zero')), // P zero
    pi('many', stepInBody, app(v(2), v(3))), // P n   (P = v2, n = v3)
  ),
)
const natTerm = self(natBody)

// Nat body with the self value replaced by zero (the unfolded type of zero), used as the coercion target.
const unfoldZero = pi(
  0,
  pi('many', kc('Nat'), ty(0)),
  pi(
    'many',
    app(v(0), kc('zero')),
    pi('many', stepInBody, app(v(2), kc('zero'))), // P zero
  ),
)

// zero = \ P. \ z. \ s. z
const zeroTerm = lam(lam(lam(v(1))))

const signature = [
  { name: 'Nat', type: ty(1) },
  { name: 'zero', type: kc('Nat') },
  { name: 'succ', type: pi('many', kc('Nat'), kc('Nat')) },
  { name: 'M', type: pi('many', kc('Nat'), ty(0)) }, // a motive
  { name: 'base', type: app(kc('M'), kc('zero')) }, // the base case
  {
    name: 'step',
    type: pi(
      'many',
      kc('Nat'),
      pi(
        'many',
        app(kc('M'), v(0)),
        app(kc('M'), app(kc('succ'), v(1))),
      ),
    ),
  },
]
const context = contextWithSignature(signature)
// alias the constant Nat to the self type itself, so the self value and the constant Nat are convertible.
defineConstant('Nat', evaluate([], natTerm))
defineConstant('zero', evaluate([], zeroTerm))

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

// Nat is a type.
ok('Nat is a self type at Type 1', () => {
  check(context, natTerm, evaluate([], ty(1)))
})

// zero : Nat, by self introduction. A lambda is checked against the unfolded type Nat[self := zero] directly
// (the explicit form of self introduction, since the lambda case precedes the self case in the checker).
ok('zero : Nat (self introduction, explicit)', () => {
  check(context, zeroTerm, evaluate([], unfoldZero))
})

// the eliminator computes: (coerce zero to its unfolded type) applied to motive, base, step reduces to base.
// so Id (M zero) (elim) base holds by reflexivity, the computation rule for zero firing.
ok('zero\'s eliminator computes to the base case', () => {
  const elim = aps(ann(kc('zero'), unfoldZero), kc('M'), kc('base'), kc('step'))
  const T = app(kc('M'), kc('zero'))
  check(context, refl(T, kc('base')), evaluate([], idt(T, elim, kc('base'))))
})

console.log(`\nself-typed naturals + computation (judge.ts): ${pass} pass, ${fail} fail`)
