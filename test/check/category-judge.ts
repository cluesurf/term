// The category laws on the decided kernel (judge.ts): function composition is associative and the identity
// function is a left and right unit. These are foundational (the category of types and functions), and they
// exercise the kernel's computation (beta) and its observational equality (eta / funext): the composites reduce
// to the same normal form, and the unit laws hold because a function equals its eta-expansion. Composition and
// identity are transparent definitions so the proofs are reflexivity. Run: npx tsx test/check/category-judge.ts

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
const id = (type: Term, left: Term, right: Term): Term => ({
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

const aps = (fun: Term, ...args: Term[]): Term =>
  args.reduce((f, a) => app(f, a), fun)

const arrow = (a: Term, b: Term): Term => pi('many', a, b)

// compose : (0 X Y Z : Type) -> (Y -> Z) -> (X -> Y) -> (X -> Z)
const composeType = pi(
  0,
  ty(0), // X
  pi(
    0,
    ty(0), // Y
    pi(
      0,
      ty(0), // Z
      pi(
        'many',
        pi('many', v(1), v(1)), // Y -> Z
        pi(
          'many',
          pi('many', v(3), v(3)), // X -> Y
          pi('many', v(4), v(3)), // X -> Z
        ),
      ),
    ),
  ),
)

// compose = \ X Y Z g f x. g (f x)
const composeValue = lam(
  lam(lam(lam(lam(lam(app(v(2), app(v(1), v(0)))))))),
)

// identity : (0 X : Type) -> X -> X = \ X x. x
const identityType = pi(0, ty(0), pi('many', v(0), v(1)))
const identityValue = lam(lam(v(0)))

const signature = [
  { name: 'A', type: ty(0) },
  { name: 'B', type: ty(0) },
  { name: 'C', type: ty(0) },
  { name: 'D', type: ty(0) },
  { name: 'f', type: arrow(kc('A'), kc('B')) },
  { name: 'g', type: arrow(kc('B'), kc('C')) },
  { name: 'h', type: arrow(kc('C'), kc('D')) },
  { name: 'compose', type: composeType },
  { name: 'identity', type: identityType },
]

const context = contextWithSignature(signature)
defineConstant('compose', evaluate([], composeValue))
defineConstant('identity', evaluate([], identityValue))

// composition shorthands.
const comp = (X: Term, Y: Term, Z: Term, g: Term, f: Term): Term =>
  aps(kc('compose'), X, Y, Z, g, f)

const idAt = (X: Term): Term => app(kc('identity'), X)

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

// associativity: (h . g) . f  =  h . (g . f), both reduce to \ x. h (g (f x)).
const A = kc('A')
const B = kc('B')
const C = kc('C')
const D = kc('D')
const f = kc('f')
const g = kc('g')
const h = kc('h')

// Id between functions computes (funext) to the pointwise (x : domain) -> Id codomain (lhs x) (rhs x), so the
// proof is the pointwise lambda \ x. refl codomain (lhs x): each side reduces to the same value at every point.
ok('composition is associative ((h . g) . f = h . (g . f))', () => {
  const left = comp(A, B, D, comp(B, C, D, h, g), f)
  const right = comp(A, C, D, h, comp(A, B, C, g, f))
  const proof = lam(refl(D, app(left, v(0)))) // \ x. refl D (((h . g) . f) x)
  check(context, proof, evaluate([], id(arrow(A, D), left, right)))
})

ok('left identity (id . f = f), by funext', () => {
  const left = comp(A, B, B, idAt(B), f)
  const proof = lam(refl(B, app(left, v(0))))
  check(context, proof, evaluate([], id(arrow(A, B), left, f)))
})

ok('right identity (f . id = f), by funext', () => {
  const left = comp(A, A, B, f, idAt(A))
  const proof = lam(refl(B, app(left, v(0))))
  check(context, proof, evaluate([], id(arrow(A, B), left, f)))
})

console.log(
  `\ncategory laws (decided kernel): ${pass} pass, ${fail} fail`,
)
