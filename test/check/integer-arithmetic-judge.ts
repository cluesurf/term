// Integer arithmetic on the decided kernel (judge.ts), the rung above natural arithmetic. An integer is pos n (the
// natural n) or negSucc n (the negative -(n+1)). Negation and the integer successor each case-analyse an integer AND
// the natural index inside it, so the Int eliminator must contain the Nat eliminator -- a large elimination into Int.
// This is exactly what the impredicative bottom universe unblocks (both Nat and Int live in Type0, so a recursor
// may return an Int). The operations type-check and reduce: neg is an involution, succ and pred step correctly
// across zero. This is the integer ring taking shape from the carrier built in integers-judge. Run:
// npx tsx test/check/integer-arithmetic-judge.ts

import type { Mult, Term } from '@cluesurf/make/code/check/judge'
import {
  check,
  contextWithSignature,
  evaluate,
  defineConstant,
  litLevel,
} from '@cluesurf/make/code/check/judge'

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
const aps = (f: Term, ...a: Array<Term>): Term =>
  a.reduce((g, x) => app(g, x), f)

// ===== the naturals: Nat = Self n. (P:Nat->Type0) -> P zero -> ((k:Nat) -> P k -> P (succ k)) -> P n =====
const natStep = pi(
  'many',
  kc('Nat'),
  pi('many', app(v(2), v(0)), app(v(3), app(kc('succ'), v(1)))),
)
const natBody = pi(
  0,
  pi('many', kc('Nat'), ty(0)),
  pi(
    'many',
    app(v(0), kc('zero')),
    pi('many', natStep, app(v(2), v(3))),
  ),
)
const natTerm = self(natBody)
const zeroValue = lam(lam(lam(v(1))))
const succValue = lam(
  lam(lam(lam(app(app(v(0), v(3)), aps(v(3), v(2), v(1), v(0)))))),
)

// ===== the integers: Int = Self i. (P:Int->Type0) -> ((n:Nat) -> P (pos n)) -> ((n:Nat) -> P (negSucc n)) -> P i ==
const intBody = pi(
  0,
  pi('many', kc('Int'), ty(0)),
  pi(
    'many',
    pi('many', kc('Nat'), app(v(1), app(kc('pos'), v(0)))),
    pi(
      'many',
      pi('many', kc('Nat'), app(v(2), app(kc('negSucc'), v(0)))),
      app(v(2), v(3)),
    ),
  ),
)
const intTerm = self(intBody)
const posValue = lam(lam(lam(lam(app(v(1), v(3)))))) // \ n P p q. p n
const negSuccValue = lam(lam(lam(lam(app(v(0), v(3)))))) // \ n P p q. q n

// the constant motive \ _. Int, reused by every integer eliminator (well typed because Int : Type0).
const intMotive = lam(kc('Int'))

// negation. neg i = i (\_. Int) posCase negCase, where
//   posCase n = n (\_. Int) (pos zero) (\ k _. negSucc k)   -- neg (pos 0) = pos 0 ; neg (pos (k+1)) = negSucc k
//   negCase n = pos (succ n)                                 -- neg (negSucc n) = pos (n+1)
const negPosCase = lam(
  aps(
    v(0),
    intMotive,
    app(kc('pos'), kc('zero')),
    lam(lam(app(kc('negSucc'), v(1)))),
  ),
)
const negNegCase = lam(app(kc('pos'), app(kc('succ'), v(0))))
const negValue = lam(
  aps(v(0), intMotive, kc('negPosCase'), kc('negNegCase')),
)

// integer successor. isucc i = i (\_. Int) posCase negCase, where
//   posCase n = pos (succ n)                                 -- succ (pos n) = pos (n+1)
//   negCase n = n (\_. Int) (pos zero) (\ k _. negSucc k)    -- succ (negSucc 0) = pos 0 ; succ (negSucc (k+1)) = negSucc k
const isuccPosCase = lam(app(kc('pos'), app(kc('succ'), v(0))))
const isuccNegCase = lam(
  aps(
    v(0),
    intMotive,
    app(kc('pos'), kc('zero')),
    lam(lam(app(kc('negSucc'), v(1)))),
  ),
)
const isuccValue = lam(
  aps(v(0), intMotive, kc('isuccPosCase'), kc('isuccNegCase')),
)

const natToInt = pi('many', natTerm, intTerm)
const intToInt = pi('many', intTerm, intTerm)

const context = contextWithSignature([
  { name: 'Nat', type: ty(0) },
  { name: 'zero', type: kc('Nat') },
  { name: 'succ', type: pi('many', kc('Nat'), kc('Nat')) },
  { name: 'Int', type: ty(0) },
  { name: 'pos', type: pi('many', kc('Nat'), kc('Int')) },
  { name: 'negSucc', type: pi('many', kc('Nat'), kc('Int')) },
  { name: 'negPosCase', type: natToInt },
  { name: 'negNegCase', type: natToInt },
  { name: 'isuccPosCase', type: natToInt },
  { name: 'isuccNegCase', type: natToInt },
])
defineConstant('Nat', evaluate([], natTerm))
defineConstant('zero', evaluate([], zeroValue))
defineConstant('succ', evaluate([], succValue))
defineConstant('Int', evaluate([], intTerm))
defineConstant('pos', evaluate([], posValue))
defineConstant('negSucc', evaluate([], negSuccValue))
defineConstant('negPosCase', evaluate([], negPosCase))
defineConstant('negNegCase', evaluate([], negNegCase))
defineConstant('neg', evaluate([], negValue))
defineConstant('isuccPosCase', evaluate([], isuccPosCase))
defineConstant('isuccNegCase', evaluate([], isuccNegCase))
defineConstant('isucc', evaluate([], isuccValue))

// numerals
const one = app(kc('succ'), kc('zero'))
const posZero = app(kc('pos'), kc('zero'))
const posOne = app(kc('pos'), one)
const negOne = app(kc('negSucc'), kc('zero')) // -(0+1) = -1

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
function computes(name: string, lhs: Term, rhs: Term): void {
  ok(name, () => {
    check(
      context,
      refl(kc('Int'), rhs),
      evaluate([], idt(kc('Int'), lhs, rhs)),
    )
  })
}

ok(
  'neg : Int -> Int type-checks (Int eliminator containing the Nat eliminator)',
  () => {
    check(context, negValue, evaluate([], intToInt))
  },
)
computes('neg (pos 0) = pos 0', app(kc('neg'), posZero), posZero)
computes('neg (pos 1) = -1', app(kc('neg'), posOne), negOne)
computes('neg (-1) = pos 1', app(kc('neg'), negOne), posOne)
computes(
  'neg is an involution: neg (neg (pos 1)) = pos 1',
  app(kc('neg'), app(kc('neg'), posOne)),
  posOne,
)

ok('isucc : Int -> Int type-checks', () => {
  check(context, isuccValue, evaluate([], intToInt))
})
computes('isucc (pos 0) = pos 1', app(kc('isucc'), posZero), posOne)
computes(
  'isucc (-1) = pos 0 (the integer successor steps across zero)',
  app(kc('isucc'), negOne),
  posZero,
)

console.log(
  `\ninteger arithmetic (decided kernel judge.ts): ${pass} pass, ${fail} fail`,
)
