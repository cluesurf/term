// Integer addition on the decided kernel (judge.ts). This is the hardest basic integer operation: add (pos a) and
// add (negSucc a) each case-split on the second integer, and the mixed signs rest on a signed subtraction of two
// naturals, intSub m n = m - n as an integer. intSub recurses on m with the motive (\ _. Nat -> Int) -- the motive
// RETURNS A FUNCTION TYPE, which is only in Type0 because the bottom universe is impredicative. So this operation is
// the sharpest demonstration that the impredicative universe earns its place. Everything type-checks and computes.
// Run: npx tsx test/check/integer-addition-judge.ts

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

// ===== naturals, with plus =====
const natStep = pi(
  'many',
  kc('Nat'),
  pi('many', app(v(2), v(0)), app(v(3), app(kc('succ'), v(1)))),
)
const natBody = pi(
  0,
  pi('many', kc('Nat'), ty(0)),
  pi('many', app(v(0), kc('zero')), pi('many', natStep, app(v(2), v(3)))),
)
const natTerm = self(natBody)
const zeroValue = lam(lam(lam(v(1))))
const succValue = lam(
  lam(lam(lam(app(app(v(0), v(3)), aps(v(3), v(2), v(1), v(0)))))),
)
const plusValue = lam(
  lam(aps(v(1), lam(kc('Nat')), v(0), lam(lam(app(kc('succ'), v(0)))))),
)

// ===== integers =====
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
const posValue = lam(lam(lam(lam(app(v(1), v(3))))))
const negSuccValue = lam(lam(lam(lam(app(v(0), v(3))))))

const intMotive = lam(kc('Int')) // \ _. Int
const natTerm_ = natTerm
const natToInt = pi('many', natTerm_, intTerm)
const intToInt = pi('many', intTerm, intTerm)
const natToNatToInt = pi('many', natTerm_, natToInt)
const natToNatToNat = pi('many', natTerm_, pi('many', natTerm_, natTerm_))

// ===== signed subtraction: intSub m n = m - n as an integer, by recursion on m with motive (\ _. Nat -> Int) =====
// base (m = 0):    \ n. n (\_.Int) (pos 0) (\ k _. negSucc k)    -- 0 - 0 = 0 ; 0 - (k+1) = negSucc k = -(k+1)
const intSubBase = lam(
  aps(
    v(0),
    intMotive,
    app(kc('pos'), kc('zero')),
    lam(lam(app(kc('negSucc'), v(1)))),
  ),
)
// step (m = succ m'): \ m' rec n. n (\_.Int) (pos (succ m')) (\ k _. rec k)
//   (succ m') - 0 = pos (succ m') ; (succ m') - (succ k) = m' - k = rec k
const intSubStep = lam(
  lam(
    lam(
      aps(
        v(0),
        intMotive,
        app(kc('pos'), app(kc('succ'), v(2))),
        lam(lam(app(v(3), v(1)))),
      ),
    ),
  ),
)
// intSub = \ m. m (\ _. Nat -> Int) base step
const intSubValue = lam(
  aps(v(0), lam(natToInt), kc('intSubBase'), kc('intSubStep')),
)

// ===== addition: add x y, by recursion on x with motive (\ _. Int -> Int) =====
// add (pos a) = \ y. y (\_.Int) (\ b. pos (a + b)) (\ b. intSub a (succ b))
const addPosCase = lam(
  lam(
    aps(
      v(0),
      intMotive,
      lam(app(kc('pos'), aps(kc('plus'), v(2), v(0)))),
      lam(aps(kc('intSub'), v(2), app(kc('succ'), v(0)))),
    ),
  ),
)
// add (negSucc a) = \ y. y (\_.Int) (\ b. intSub b (succ a)) (\ b. negSucc (succ (a + b)))
//   negSucc a + pos b = b - (a+1) = intSub b (succ a) ; negSucc a + negSucc b = -(a+b+2) = negSucc (succ (a+b))
const addNegCase = lam(
  lam(
    aps(
      v(0),
      intMotive,
      lam(aps(kc('intSub'), v(0), app(kc('succ'), v(2)))),
      lam(app(kc('negSucc'), app(kc('succ'), aps(kc('plus'), v(2), v(0))))),
    ),
  ),
)
// add = \ x. x (\ _. Int -> Int) addPosCase addNegCase
const addValue = lam(
  aps(v(0), lam(intToInt), kc('addPosCase'), kc('addNegCase')),
)

const context = contextWithSignature([
  { name: 'Nat', type: ty(0) },
  { name: 'zero', type: kc('Nat') },
  { name: 'succ', type: pi('many', kc('Nat'), kc('Nat')) },
  { name: 'plus', type: natToNatToNat },
  { name: 'Int', type: ty(0) },
  { name: 'pos', type: pi('many', kc('Nat'), kc('Int')) },
  { name: 'negSucc', type: pi('many', kc('Nat'), kc('Int')) },
  { name: 'intSubBase', type: natToInt },
  { name: 'intSubStep', type: pi('many', natTerm_, pi('many', natToInt, natToInt)) },
  { name: 'intSub', type: natToNatToInt },
  { name: 'addPosCase', type: pi('many', natTerm_, intToInt) },
  { name: 'addNegCase', type: pi('many', natTerm_, intToInt) },
])
defineConstant('Nat', evaluate([], natTerm))
defineConstant('zero', evaluate([], zeroValue))
defineConstant('succ', evaluate([], succValue))
defineConstant('plus', evaluate([], plusValue))
defineConstant('Int', evaluate([], intTerm))
defineConstant('pos', evaluate([], posValue))
defineConstant('negSucc', evaluate([], negSuccValue))
defineConstant('intSubBase', evaluate([], intSubBase))
defineConstant('intSubStep', evaluate([], intSubStep))
defineConstant('intSub', evaluate([], intSubValue))
defineConstant('addPosCase', evaluate([], addPosCase))
defineConstant('addNegCase', evaluate([], addNegCase))
defineConstant('add', evaluate([], addValue))

// numerals
const nat = (k: number): Term =>
  k === 0 ? kc('zero') : app(kc('succ'), nat(k - 1))
const posN = (k: number): Term => app(kc('pos'), nat(k))
const negN = (k: number): Term => app(kc('negSucc'), nat(k - 1)) // negN(k) = -(k), i.e. negSucc (k-1)

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
    check(context, refl(kc('Int'), rhs), evaluate([], idt(kc('Int'), lhs, rhs)))
  })
}

ok('intSub : Nat -> Nat -> Int type-checks (motive returns a function type, impredicative)', () => {
  check(context, intSubValue, evaluate([], natToNatToInt))
})
computes('intSub 2 0 = pos 2', aps(kc('intSub'), nat(2), nat(0)), posN(2))
computes('intSub 2 2 = pos 0', aps(kc('intSub'), nat(2), nat(2)), posN(0))
computes('intSub 3 1 = pos 2', aps(kc('intSub'), nat(3), nat(1)), posN(2))
computes('intSub 0 2 = -2', aps(kc('intSub'), nat(0), nat(2)), negN(2))
computes('intSub 1 3 = -2', aps(kc('intSub'), nat(1), nat(3)), negN(2))

ok('add : Int -> Int -> Int type-checks', () => {
  check(context, addValue, evaluate([], pi('many', intTerm, intToInt)))
})
computes('add (pos 1) (pos 2) = pos 3', aps(kc('add'), posN(1), posN(2)), posN(3))
computes('add (pos 2) (-1) = pos 1', aps(kc('add'), posN(2), negN(1)), posN(1))
computes('add (-1) (-1) = -2', aps(kc('add'), negN(1), negN(1)), negN(2))
computes('add (pos 1) (-2) = -1', aps(kc('add'), posN(1), negN(2)), negN(1))
computes('add (-2) (pos 3) = pos 1', aps(kc('add'), negN(2), posN(3)), posN(1))
computes('add (pos 0) (pos 0) = pos 0', aps(kc('add'), posN(0), posN(0)), posN(0))

console.log(`\ninteger addition (decided kernel judge.ts): ${pass} pass, ${fail} fail`)
