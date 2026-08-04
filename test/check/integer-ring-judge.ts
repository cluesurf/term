// The integer ring completed on the decided kernel (judge.ts): multiplication (all four sign cases) and the
// decidable order, both computing. Multiplication is a fold of natural multiplication with sign bookkeeping; the
// order leb (a <= b) is a decision returning Bool. Each rests on Nat operations lifted through the Int eliminator,
// and several motives return function types (Nat -> Bool, Int -> Bool), in Type0 only because the bottom universe is
// impredicative. With addition (integer-addition-judge) this is the ordered ring Z, built and reducing in the
// kernel, the arrow keystone's one-way order now a computation over the construction. Run:
// npx tsx test/check/integer-ring-judge.ts

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

// ===== naturals: zero, succ, plus, times =====
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

const plusValue = lam(
  lam(aps(v(1), lam(kc('Nat')), v(0), lam(lam(app(kc('succ'), v(0)))))),
)

// times a b = a (\_. Nat) zero (\ _ r. plus b r)
const timesValue = lam(
  lam(
    aps(
      v(1),
      lam(kc('Nat')),
      kc('zero'),
      lam(lam(aps(kc('plus'), v(2), v(0)))),
    ),
  ),
)

// ===== integers: pos, negSucc =====
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

const intMotive = lam(kc('Int'))
const boolMotive = lam(kc('Bool'))
const natToInt = pi('many', natTerm, intTerm)
const intToInt = pi('many', intTerm, intTerm)
const natToBool = pi('many', natTerm, kc('Bool'))
const intToBool = pi('many', intTerm, kc('Bool'))
const natToNatToNat = pi('many', natTerm, pi('many', natTerm, natTerm))

// ===== negation (for the mixed-sign multiplication cases) =====
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

// ===== multiplication =====
// mult (pos a) = \ y. y (\_.Int) (\ b. pos (a*b)) (\ b. neg (pos (a*(b+1))))
const mulPos = lam(
  lam(
    aps(
      v(0),
      intMotive,
      lam(app(kc('pos'), aps(kc('times'), v(2), v(0)))),
      lam(
        app(
          kc('neg'),
          app(kc('pos'), aps(kc('times'), v(2), app(kc('succ'), v(0)))),
        ),
      ),
    ),
  ),
)

// mult (negSucc a) = \ y. y (\_.Int) (\ b. neg (pos ((a+1)*b))) (\ b. pos ((a+1)*(b+1)))
const mulNeg = lam(
  lam(
    aps(
      v(0),
      intMotive,
      lam(
        app(
          kc('neg'),
          app(kc('pos'), aps(kc('times'), app(kc('succ'), v(2)), v(0))),
        ),
      ),
      lam(
        app(
          kc('pos'),
          aps(
            kc('times'),
            app(kc('succ'), v(2)),
            app(kc('succ'), v(0)),
          ),
        ),
      ),
    ),
  ),
)

const multValue = lam(
  aps(v(0), lam(intToInt), kc('mulPos'), kc('mulNeg')),
)

// ===== the order: lebNat (m <= n) then lebInt (a <= b), both returning Bool =====
// lebNat = \ m. m (\ _. Nat -> Bool) (\ n. true) (\ m' rec n. n (\_.Bool) false (\ k _. rec k))
const lebNatBase = lam(kc('true'))
const lebNatStep = lam(
  lam(
    lam(aps(v(0), boolMotive, kc('false'), lam(lam(app(v(3), v(1)))))),
  ),
)

const lebNatValue = lam(
  aps(v(0), lam(natToBool), kc('lebNatBase'), kc('lebNatStep')),
)

// lebInt (pos x) = \ b. b (\_.Bool) (\ y. lebNat x y) (\ y. false)        -- pos x <= pos y ; pos x <= neg = false
// lebInt (negSucc x) = \ b. b (\_.Bool) (\ y. true) (\ y. lebNat y x)     -- neg <= pos = true ; -(x+1) <= -(y+1) iff y<=x
const lebIntPos = lam(
  lam(
    aps(
      v(0),
      boolMotive,
      lam(aps(kc('lebNat'), v(2), v(0))),
      lam(kc('false')),
    ),
  ),
)

const lebIntNeg = lam(
  lam(
    aps(
      v(0),
      boolMotive,
      lam(kc('true')),
      lam(aps(kc('lebNat'), v(0), v(2))),
    ),
  ),
)

const lebIntValue = lam(
  aps(v(0), lam(intToBool), kc('lebIntPos'), kc('lebIntNeg')),
)

const context = contextWithSignature([
  { name: 'Nat', type: ty(0) },
  { name: 'zero', type: kc('Nat') },
  { name: 'succ', type: pi('many', kc('Nat'), kc('Nat')) },
  { name: 'plus', type: natToNatToNat },
  { name: 'times', type: natToNatToNat },
  { name: 'Int', type: ty(0) },
  { name: 'pos', type: pi('many', kc('Nat'), kc('Int')) },
  { name: 'negSucc', type: pi('many', kc('Nat'), kc('Int')) },
  { name: 'Bool', type: ty(0) },
  { name: 'true', type: kc('Bool') },
  { name: 'false', type: kc('Bool') },
  { name: 'negPosCase', type: natToInt },
  { name: 'negNegCase', type: natToInt },
  { name: 'neg', type: intToInt },
  { name: 'mulPos', type: pi('many', natTerm, intToInt) },
  { name: 'mulNeg', type: pi('many', natTerm, intToInt) },
  { name: 'lebNatBase', type: natToBool },
  {
    name: 'lebNatStep',
    type: pi('many', natTerm, pi('many', natToBool, natToBool)),
  },
  { name: 'lebNat', type: pi('many', natTerm, natToBool) },
  { name: 'lebIntPos', type: pi('many', natTerm, intToBool) },
  { name: 'lebIntNeg', type: pi('many', natTerm, intToBool) },
])

const def = (n: string, t: Term): void =>
  defineConstant(n, evaluate([], t))

def('Nat', natTerm)
def('zero', zeroValue)
def('succ', succValue)
def('plus', plusValue)
def('times', timesValue)
def('Int', intTerm)
def('pos', posValue)
def('negSucc', negSuccValue)
def('negPosCase', negPosCase)
def('negNegCase', negNegCase)
def('neg', negValue)
def('mulPos', mulPos)
def('mulNeg', mulNeg)
def('mult', multValue)
def('lebNatBase', lebNatBase)
def('lebNatStep', lebNatStep)
def('lebNat', lebNatValue)
def('lebIntPos', lebIntPos)
def('lebIntNeg', lebIntNeg)
def('lebInt', lebIntValue)

const nat = (k: number): Term =>
  k === 0 ? kc('zero') : app(kc('succ'), nat(k - 1))

const posN = (k: number): Term => app(kc('pos'), nat(k))
const negN = (k: number): Term => app(kc('negSucc'), nat(k - 1)) // -(k)

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

function computesInt(name: string, lhs: Term, rhs: Term): void {
  ok(name, () => {
    check(
      context,
      refl(kc('Int'), rhs),
      evaluate([], idt(kc('Int'), lhs, rhs)),
    )
  })
}

function order(name: string, lhs: Term, rhs: Term): void {
  ok(name, () => {
    check(
      context,
      refl(kc('Bool'), rhs),
      evaluate([], idt(kc('Bool'), lhs, rhs)),
    )
  })
}

// multiplication, all four sign cases plus the absorbing zero and unit.
ok('mult : Int -> Int -> Int type-checks', () => {
  check(context, multValue, evaluate([], pi('many', intTerm, intToInt)))
})
computesInt(
  'mult (pos 2) (pos 3) = pos 6',
  aps(kc('mult'), posN(2), posN(3)),
  posN(6),
)
computesInt(
  'mult (-2) (pos 3) = -6',
  aps(kc('mult'), negN(2), posN(3)),
  negN(6),
)
computesInt(
  'mult (pos 2) (-3) = -6',
  aps(kc('mult'), posN(2), negN(3)),
  negN(6),
)
computesInt(
  'mult (-2) (-3) = pos 6',
  aps(kc('mult'), negN(2), negN(3)),
  posN(6),
)
computesInt(
  'mult (pos 0) (pos 5) = pos 0',
  aps(kc('mult'), posN(0), posN(5)),
  posN(0),
)
computesInt(
  'mult (pos 1) (pos 5) = pos 5',
  aps(kc('mult'), posN(1), posN(5)),
  posN(5),
)

// the decidable order, the arrow's one-way order as a computation over the integers.
ok('lebInt : Int -> Int -> Bool type-checks', () => {
  check(
    context,
    lebIntValue,
    evaluate([], pi('many', intTerm, intToBool)),
  )
})
order('2 <= 5 is true', aps(kc('lebInt'), posN(2), posN(5)), kc('true'))
order(
  '5 <= 2 is false (one-way)',
  aps(kc('lebInt'), posN(5), posN(2)),
  kc('false'),
)
order(
  '-3 <= -1 is true',
  aps(kc('lebInt'), negN(3), negN(1)),
  kc('true'),
)
order(
  '-1 <= -3 is false',
  aps(kc('lebInt'), negN(1), negN(3)),
  kc('false'),
)
order(
  '-1 <= pos 2 is true (negatives below non-negatives)',
  aps(kc('lebInt'), negN(1), posN(2)),
  kc('true'),
)
order(
  'pos 2 <= -1 is false',
  aps(kc('lebInt'), posN(2), negN(1)),
  kc('false'),
)
order(
  'pos 0 <= pos 0 is true (reflexive at a point)',
  aps(kc('lebInt'), posN(0), posN(0)),
  kc('true'),
)

console.log(
  `\ninteger ring with order (decided kernel judge.ts): ${pass} pass, ${fail} fail`,
)
