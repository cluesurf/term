// The integers as a self-typed inductive on the decided kernel (judge.ts), the rung above the naturals. An integer
// is either pos n (the natural n) or negSucc n (the negative -(n+1)), the standard two-constructor encoding. Int is
// a self type carrying its eliminator; a concrete integer types as Int and its eliminator computes to the matching
// case. With the self-typed naturals already working, this is the integers built, not postulated. Run:
// npx tsx test/check/integers-judge.ts

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

// Int = Self i. (P : Int -> Type0) -> ((n:Nat) -> P (pos n)) -> ((n:Nat) -> P (negSucc n)) -> P i
const intBody = pi(
  0,
  pi('many', kc('Int'), ty(0)), // P : Int -> Type0
  pi(
    'many',
    pi('many', kc('Nat'), app(v(1), app(kc('pos'), v(0)))), // (n:Nat) -> P (pos n)
    pi(
      'many',
      pi('many', kc('Nat'), app(v(2), app(kc('negSucc'), v(0)))), // (n:Nat) -> P (negSucc n)
      app(v(2), v(3)), // P i   (P = v2, i = v3)
    ),
  ),
)
const intTerm = self(intBody)

// the unfolded type of (pos nn): Int body with the self value replaced by (pos nn).
const unfoldPosNN = pi(
  0,
  pi('many', kc('Int'), ty(0)),
  pi(
    'many',
    pi('many', kc('Nat'), app(v(1), app(kc('pos'), v(0)))),
    pi(
      'many',
      pi('many', kc('Nat'), app(v(2), app(kc('negSucc'), v(0)))),
      app(v(2), app(kc('pos'), kc('nn'))), // P (pos nn)
    ),
  ),
)

// the unfolded type of (negSucc nn): Int body with the self value replaced by (negSucc nn).
const unfoldNegSuccNN = pi(
  0,
  pi('many', kc('Int'), ty(0)),
  pi(
    'many',
    pi('many', kc('Nat'), app(v(1), app(kc('pos'), v(0)))),
    pi(
      'many',
      pi('many', kc('Nat'), app(v(2), app(kc('negSucc'), v(0)))),
      app(v(2), app(kc('negSucc'), kc('nn'))), // P (negSucc nn)
    ),
  ),
)

// pos = \ n P p q. p n   ;   negSucc = \ n P p q. q n
const posValue = lam(lam(lam(lam(app(v(1), v(3))))))
const negSuccValue = lam(lam(lam(lam(app(v(0), v(3))))))

const signature = [
  { name: 'Int', type: ty(1) },
  { name: 'Nat', type: ty(0) },
  { name: 'nn', type: kc('Nat') }, // a concrete natural, to form a concrete integer
  { name: 'pos', type: pi('many', kc('Nat'), kc('Int')) },
  { name: 'negSucc', type: pi('many', kc('Nat'), kc('Int')) },
  { name: 'M', type: pi('many', kc('Int'), ty(0)) }, // a motive
  {
    name: 'pcase',
    type: pi('many', kc('Nat'), app(kc('M'), app(kc('pos'), v(0)))),
  },
  {
    name: 'qcase',
    type: pi('many', kc('Nat'), app(kc('M'), app(kc('negSucc'), v(0)))),
  },
  { name: 'Bool', type: ty(0) }, // a target type for a non-dependent fold (the sign function)
  { name: 'tru', type: kc('Bool') },
  { name: 'fls', type: kc('Bool') },
]
const context = contextWithSignature(signature)
defineConstant('Int', evaluate([], intTerm))
defineConstant('pos', evaluate([], posValue))
defineConstant('negSucc', evaluate([], negSuccValue))

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

ok('Int is a self type at Type 1', () => {
  check(context, intTerm, evaluate([], ty(1)))
})

ok('pos nn : Int (a concrete integer types as Int)', () => {
  check(context, app(kc('pos'), kc('nn')), evaluate([], kc('Int')))
})

ok('negSucc nn : Int (a concrete negative integer types as Int)', () => {
  check(context, app(kc('negSucc'), kc('nn')), evaluate([], kc('Int')))
})

ok("the eliminator on (pos nn) computes to the pos case (pcase nn)", () => {
  const elim = aps(
    ann(app(kc('pos'), kc('nn')), unfoldPosNN),
    kc('M'),
    kc('pcase'),
    kc('qcase'),
  )
  const T = app(kc('M'), app(kc('pos'), kc('nn')))
  check(
    context,
    refl(T, app(kc('pcase'), kc('nn'))),
    evaluate([], idt(T, elim, app(kc('pcase'), kc('nn')))),
  )
})

// A non-dependent fold is the recursor with a constant motive: it defines a total recursive function over the
// integers by giving one value per constructor. The sign map sends every non-negative (pos n) to true and every
// negative (negSucc n) to false. It must compute distinctly on the two constructors -- this is the recursor doing
// the work every integer operation (negation, addition, comparison) is built from. signMotive = \ i. Bool.
const signMotive = lam(kc('Bool')) // \ i. Bool   (the constant motive)
const signPos = lam(kc('tru')) // \ n. true     (the pos case)
const signNeg = lam(kc('fls')) // \ n. false    (the negSucc case)

ok('sign (pos nn) computes to true (the fold on a non-negative)', () => {
  const elim = aps(
    ann(app(kc('pos'), kc('nn')), unfoldPosNN),
    signMotive,
    signPos,
    signNeg,
  )
  check(
    context,
    refl(kc('Bool'), kc('tru')),
    evaluate([], idt(kc('Bool'), elim, kc('tru'))),
  )
})

ok('sign (negSucc nn) computes to false (the fold on a negative)', () => {
  const elim = aps(
    ann(app(kc('negSucc'), kc('nn')), unfoldNegSuccNN),
    signMotive,
    signPos,
    signNeg,
  )
  check(
    context,
    refl(kc('Bool'), kc('fls')),
    evaluate([], idt(kc('Bool'), elim, kc('fls'))),
  )
})

console.log(`\nintegers as a self-typed inductive (judge.ts): ${pass} pass, ${fail} fail`)
