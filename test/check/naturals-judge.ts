// The natural numbers as a self-typed inductive on the DECIDED kernel (judge.ts), with real reduction.
// Nat = Self n. (0 P : Nat -> Type0) -> (1 _ : P zero) -> (1 _ : (1 k : Nat) -> (1 _ : P k) -> P (succ k)) -> P n
// zero and succ are the constructors; the self type carries its own induction principle. Transparent definitions
// (defineConstant) give the constructors reduction so plus computes. Run: npx tsx test/check/naturals-judge.ts

import type { Mult, Term } from '@/code/check/judge'
import {
  checks,
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

// signature gives the types; defineConstant gives the values (transparent, so reduction fires).
const signature = [
  { name: 'Nat', type: ty(0) },
  { name: 'zero', type: kc('Nat') },
  { name: 'succ', type: pi('many', kc('Nat'), kc('Nat')) },
  {
    name: 'plus',
    type: pi('many', kc('Nat'), pi('many', kc('Nat'), kc('Nat'))),
  },
]
const context = contextWithSignature(signature)

defineConstant('Nat', evaluate([], natTerm))
defineConstant('zero', evaluate([], zeroTerm))
defineConstant('succ', evaluate([], succTerm))
defineConstant('plus', evaluate([], plusTerm))

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

ok('Nat is a type', () => {
  if (!checks(natTerm, ty(1))) throw new Error('Nat did not check at Type1')
})
ok('zero : Nat', () => {
  check(context, zeroTerm, evaluate([], kc('Nat')))
})
ok('succ : Nat -> Nat', () => {
  check(
    context,
    succTerm,
    evaluate([], pi('many', kc('Nat'), kc('Nat'))),
  )
})
ok('one = succ zero : Nat', () => {
  check(context, app(kc('succ'), kc('zero')), evaluate([], kc('Nat')))
})
ok('plus : Nat -> Nat -> Nat', () => {
  check(
    context,
    plusTerm,
    evaluate(
      [],
      pi('many', kc('Nat'), pi('many', kc('Nat'), kc('Nat'))),
    ),
  )
})

console.log(`\nnaturals (decided kernel judge.ts): ${pass} pass, ${fail} fail`)
