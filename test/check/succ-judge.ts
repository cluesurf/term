// A GENERIC recursive constructor on the decided kernel (judge.ts), the payoff of self-introduction and
// self-elimination now firing automatically. Earlier the self-typed naturals could only state `succ` as an opaque
// postulate, because a constructor lambda whose codomain is a self type failed the pi check, and a recursive
// argument could not be applied without a hand-written annotation. With both rules in the kernel, the real
// successor -- succ m = \ P z s. s m (m P z s) -- type-checks against Nat -> Nat and its eliminator computes,
// with no manual coercions anywhere. This is the sugar gap closed at the root. Run: npx tsx test/check/succ-judge.ts

import type { Mult, Term } from '@term/make/code/check/judge'
import {
  check,
  contextWithSignature,
  evaluate,
  defineConstant,
  litLevel,
} from '@term/make/code/check/judge'

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

const aps = (f: Term, ...a: Term[]): Term =>
  a.reduce((g, x) => app(g, x), f)

// the step case inside the Nat body: (k : Nat) -> P k -> P (succ k)
const stepInBody = pi(
  'many',
  kc('Nat'),
  pi('many', app(v(2), v(0)), app(v(3), app(kc('succ'), v(1)))),
)

// Nat = Self n. (P : Nat -> Type0) -> P zero -> ((k:Nat) -> P k -> P (succ k)) -> P n
const natBody = pi(
  0,
  pi('many', kc('Nat'), ty(0)),
  pi(
    'many',
    app(v(0), kc('zero')),
    pi('many', stepInBody, app(v(2), v(3))),
  ),
)

const natTerm = self(natBody)

// zero = \ P z s. z      and the REAL successor   succ = \ m P z s. s m (m P z s)
const zeroTerm = lam(lam(lam(v(1))))
const succTerm = lam(
  lam(lam(lam(app(app(v(0), v(3)), aps(v(3), v(2), v(1), v(0)))))),
)

const signature = [
  { name: 'Nat', type: ty(1) },
  { name: 'zero', type: kc('Nat') },
  { name: 'succ', type: pi('many', kc('Nat'), kc('Nat')) },
  { name: 'M', type: pi('many', kc('Nat'), ty(0)) }, // a motive
  { name: 'base', type: app(kc('M'), kc('zero')) },
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
defineConstant('Nat', evaluate([], natTerm))
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

// the intro checks present the self type as a value (natTerm), the form the kernel introduces against. The named
// constant Nat is its alias, reconciled by conversion everywhere the name is used (in succ zero and the eliminator).
ok(
  'zero : Nat (self introduction fires directly against the self type)',
  () => {
    check(context, zeroTerm, evaluate([], natTerm))
  },
)

ok(
  'succ : Nat -> Nat (a GENERIC recursive constructor type-checks)',
  () => {
    check(context, succTerm, evaluate([], pi('many', natTerm, natTerm)))
  },
)

ok('succ zero : Nat', () => {
  check(context, app(kc('succ'), kc('zero')), evaluate([], kc('Nat')))
})

ok(
  "the successor's eliminator computes: (succ zero) M base step = step zero base",
  () => {
    const one = app(kc('succ'), kc('zero'))
    const elim = aps(one, kc('M'), kc('base'), kc('step'))
    const stepZeroBase = app(app(kc('step'), kc('zero')), kc('base'))
    const T = app(kc('M'), one)
    check(
      context,
      refl(T, stepZeroBase),
      evaluate([], idt(T, elim, stepZeroBase)),
    )
  },
)

console.log(
  `\ngeneric recursive constructor (judge.ts): ${pass} pass, ${fail} fail`,
)
