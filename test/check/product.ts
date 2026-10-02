// The product prover (check/product.ts): nonlinear goals from nonlinear hypotheses by products of the facts, with a
// certificate the replay checker recomputes. Run: npx tsx test/check/product.ts
//
// It must prove the ordered-field steps a squared inequality needs, refuse their false neighbors, and its checker
// must refuse a certificate that is not one.

import {
  productProves,
  rational,
  refute,
  replay,
} from '@term/make/code/check/product'
import type { Fact, Polynomial } from '@term/make/code/check/product'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}`)
  }
}

// a polynomial from monomials written with a space, stored NUL-joined the way holds.ts keys them
const p = (terms: Record<string, number>): Polynomial =>
  new Map(
    Object.entries(terms).map(([k, c]) => [
      k.split(' ').filter(Boolean).sort().join('\u0000'),
      rational(BigInt(c)),
    ]),
  )

const at = (poly: Polynomial, relation: Fact['relation'] = 'nonnegative'): Fact => ({ polynomial: poly, relation })

// y >= 0 and x^2 <= y^2 give x <= y
const root = [at(p({ y: 1 })), at(p({ 'y y': 1, 'x x': -1 }))]

ok('the square-root step', productProves(root, p({ y: 1, x: -1 }), false))
ok('refuses it strict (x = y)', !productProves(root, p({ y: 1, x: -1 }), true))
ok('refuses it without y >= 0 (x = 1, y = -1)', !productProves([root[1]!], p({ y: 1, x: -1 }), false))

ok('a product of non-negatives', productProves([at(p({ a: 1 })), at(p({ b: 1 }))], p({ 'a b': 1 }), false))
ok(
  'opposite signs give a negative product',
  productProves([at(p({ a: 1 }), 'positive'), at(p({ b: -1 }), 'positive')], p({ 'a b': -1 }), true),
)
ok(
  'the sign of a factor',
  productProves([at(p({ 'a b': 1 }), 'positive'), at(p({ a: 1 }), 'positive')], p({ b: 1 }), true),
)
ok('refuses a b >= 0 gives a >= 0', !productProves([at(p({ 'a b': 1 }))], p({ a: 1 }), false))

// an equation used as a fact: x y = 1 and x > 0 give y > 0
ok(
  'an equation as a fact',
  productProves([at(p({ 'x y': 1, '': -1 }), 'zero'), at(p({ x: 1 }), 'positive')], p({ y: 1 }), true),
)

// AM-GM in two variables, no hypotheses: a^2 + b^2 >= 2 a b
ok('a square of a difference', productProves([], p({ 'a a': 1, 'b b': 1, 'a b': -2 }), false))

// a sinh written as S with S^2 = p^2 - 1 (p a cosh): the equation alone gives p^2 >= 1
ok(
  'p^2 - 1 = S^2 gives p^2 >= 1',
  productProves([at(p({ 'p p': 1, '': -1, 'S S': -1 }), 'zero')], p({ 'p p': 1, '': -1 }), false),
)

// THE TRIANGLE INEQUALITY'S LAST STEP. With p, q the cosh and s, t the sinh of two sides, the Gram bound is
// (r - p q)^2 <= (s t)^2, and the third side's cosh r lies between cosh(a - b) = p q - s t and cosh(a + b) = p q + s t.
const gram = [at(p({ s: 1 })), at(p({ t: 1 })), at(p({ 's s t t': 1, 'r r': -1, 'p q r': 2, 'p p q q': -1 }))]

ok('r <= p q + s t, cosh of the sum', productProves(gram, p({ 'p q': 1, 's t': 1, r: -1 }), false))
ok('r >= p q - s t, cosh of the difference', productProves(gram, p({ r: 1, 'p q': -1, 's t': 1 }), false))
ok('refuses r <= p q', !productProves(gram, p({ 'p q': 1, r: -1 }), false))

// the same step from the form metric.tree proves, the Gram determinant (p^2 - 1)(q^2 - 1) - (r - p q)^2 >= 0, with
// the sinh given by its equation s^2 = p^2 - 1: the equations enter multiplied by monomials
const sinh = [
  at(p({ s: 1 })),
  at(p({ t: 1 })),
  at(p({ 's s': 1, 'p p': -1, '': 1 }), 'zero'),
  at(p({ 't t': 1, 'q q': -1, '': 1 }), 'zero'),
  // (p^2 - 1)(q^2 - 1) - (r - p q)^2, whose p^2 q^2 terms cancel
  at(p({ '': 1, 'p p': -1, 'q q': -1, 'r r': -1, 'p q r': 2 })),
]
ok('cosh of the sum, from the Gram determinant', productProves(sinh, p({ 'p q': 1, 's t': 1, r: -1 }), false))
ok('cosh of the difference, from the Gram determinant', productProves(sinh, p({ r: 1, 'p q': -1, 's t': 1 }), false))
ok('refuses the strict bound (a degenerate triangle meets it)', !productProves(sinh, p({ 'p q': 1, 's t': 1, r: -1 }), true))

// PASCH'S SIGN STEP, not both: u v < 0 (the line crosses a b) and w^2 > 0 (c is off it) with u w < 0 would force
// v w > 0, so `u w < 0` and `v w < 0` together give u v > 0, against the hypothesis
ok(
  'the line cannot cross both other sides',
  productProves(
    [at(p({ 'u w': -1 }), 'positive'), at(p({ 'v w': -1 }), 'positive'), at(p({ 'w w': 1 }), 'positive')],
    p({ 'u v': 1 }),
    true,
  ),
)
// and at least one: u v < 0, w^2 > 0 and u w >= 0 give v w < 0
ok(
  'the line crosses one of the other sides',
  productProves(
    [at(p({ 'u v': -1 }), 'positive'), at(p({ 'w w': 1 }), 'positive'), at(p({ 'u w': 1 }))],
    p({ 'v w': -1 }),
    true,
  ),
)

// LINE-CIRCLE CONTINUITY in the Klein disk, circle about the origin of Klein radius^2 m: a line through a with
// direction v meets it when the quarter discriminant m |v|^2 - (a1 v2 - a2 v1)^2 is >= 0, which holds whenever a is
// inside (m - |a|^2 >= 0), through d = a . v (Lagrange: |a|^2 |v|^2 = d^2 + cross^2)
const klein = [
  at(p({ m: 1, 'a1 a1': -1, 'a2 a2': -1 })),
  at(p({ d: 1, 'a1 v1': -1, 'a2 v2': -1 }), 'zero'),
]
ok(
  'a line through an inside point meets the circle',
  productProves(klein, p({ 'm v1 v1': 1, 'm v2 v2': 1, 'a1 a1 v2 v2': -1, 'a1 a2 v1 v2': 2, 'a2 a2 v1 v1': -1 }), false),
)
ok(
  'refuses it for a point outside',
  !productProves([klein[1]!], p({ 'm v1 v1': 1, 'm v2 v2': 1, 'a1 a1 v2 v2': -1, 'a1 a2 v1 v2': 2, 'a2 a2 v1 v1': -1 }), false),
)

// an equation is never multiplied by a monomial unless it IS an equation
ok(
  'a non-negative fact times a monomial is refused by the checker',
  !replay([at(p({ x: 1 }))], { rows: [{ fact: 0, times: 'x' }], multipliers: [rational(1n)] }),
)

// ---- the checker refuses what is not a certificate ----

const facts = [at(p({ y: 1 })), at(p({ 'y y': 1, 'x x': -1 })), at(p({ x: 1, y: -1 }), 'positive')]
const found = refute(facts)

ok('a certificate is found', found !== undefined)
ok('and it replays', found !== undefined && replay(facts, found))

if (found) {
  const negated = { ...found, multipliers: found.multipliers.map(k => rational(-k.n, k.d)) }
  ok('a negated multiplier on an inequality row is refused', !replay(facts, negated))

  const zeroed = { ...found, multipliers: found.multipliers.map(() => rational(0n)) }
  ok('all-zero multipliers are refused', !replay(facts, zeroed))

  // drop a row the certificate actually leans on
  const used = found.multipliers.findIndex(k => k.n !== 0n)
  const shortened = {
    rows: found.rows.filter((_, i) => i !== used),
    multipliers: found.multipliers.filter((_, i) => i !== used),
  }
  ok('dropping a row it uses breaks the identity', !replay(facts, shortened))

  const forged = { ...found, rows: found.rows.map(() => ({ fact: 99 })) }
  ok('a row naming no fact is refused', !replay(facts, forged))
}

// a satisfiable set has no certificate: x >= 0, y >= 0, x y <= 1
ok(
  'no certificate for a satisfiable set',
  refute([at(p({ x: 1 })), at(p({ y: 1 })), at(p({ '': 1, 'x y': -1 }))]) === undefined,
)

console.log(`\n${pass} passed, ${fail} failed`)

if (fail > 0) {
  process.exit(1)
}
