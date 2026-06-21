// The pinch-point keystone proved STRUCTURALLY as a judge.ts proof term (not numerically via the refinement
// layer). The dimension is caught between the reversibility ceiling (dimension <= 8) and the one-substance floor
// (8 <= dimension), and antisymmetry of the order forces it to equal 8. The proof is antisymmetry applied to the
// two pressures: a real kernel proof term the sound kernel checks. Run: npx tsx test/check/pinch-judge.ts

import type { Term } from '@cluesurf/make/code/check/judge'
import {
  check,
  contextWithSignature,
  evaluate,
  litLevel,
} from '@cluesurf/make/code/check/judge'

const v = (index: number): Term => ({ tag: 'var', index })
const kc = (name: string): Term => ({ tag: 'const', name })
const ty = (n: number): Term => ({ tag: 'type', level: litLevel(n) })
const pi = (m: 0 | 1 | 'many', domain: Term, codomain: Term): Term => ({
  tag: 'pi',
  mult: m,
  domain,
  codomain,
})
const app = (fun: Term, arg: Term): Term => ({ tag: 'app', fun, arg })
const id = (type: Term, left: Term, right: Term): Term => ({
  tag: 'id',
  type,
  left,
  right,
})
const aps = (fun: Term, ...args: Array<Term>): Term =>
  args.reduce((f, a) => app(f, a), fun)

// Le a b  =  the order relation "a is at most b" on dimensions.
const le = (a: Term, b: Term): Term => aps(kc('Le'), a, b)

// antisymmetry: (a b : Dim) -> Le a b -> Le b a -> Id Dim a b
// de Bruijn, tracking the binders [a, b, (Le a b), (Le b a)].
const antisymType = pi(
  'many',
  kc('Dim'), // a
  pi(
    'many',
    kc('Dim'), // b   (a = v1, b = v0)
    pi(
      'many',
      le(v(1), v(0)), // Le a b
      pi(
        'many',
        le(v(1), v(2)), // Le b a   (a = v2, b = v1)
        id(kc('Dim'), v(3), v(2)), // Id Dim a b   (a = v3, b = v2)
      ),
    ),
  ),
)

const signature = [
  { name: 'Dim', type: ty(0) },
  {
    name: 'Le',
    type: pi('many', kc('Dim'), pi('many', kc('Dim'), ty(0))),
  },
  { name: 'antisym', type: antisymType },
  { name: 'dimension', type: kc('Dim') },
  { name: 'eight', type: kc('Dim') },
  // the reversibility ceiling: dimension <= 8
  { name: 'ceiling', type: le(kc('dimension'), kc('eight')) },
  // the one-substance floor: 8 <= dimension
  { name: 'floor', type: le(kc('eight'), kc('dimension')) },
]
const context = contextWithSignature(signature)

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
function rejects(name: string, run: () => void): void {
  try {
    run()
    fail++
    console.log(`FAIL  ${name} (should have been rejected)`)
  } catch {
    pass++
    console.log(`ok    ${name} (correctly rejected)`)
  }
}

// the pinch-point proof term: antisym dimension eight ceiling floor : Id Dim dimension eight.
const pinchProof = aps(
  kc('antisym'),
  kc('dimension'),
  kc('eight'),
  kc('ceiling'),
  kc('floor'),
)
const pinchGoal = id(kc('Dim'), kc('dimension'), kc('eight'))

ok(
  'the pinch-point: the dimension equals eight, proved structurally by antisymmetry',
  () => {
    check(context, pinchProof, evaluate([], pinchGoal))
  },
)

// soundness: the same proof does NOT establish a wrong conclusion (dimension equals something else).
rejects(
  'the proof does not establish a false equality (dimension = Le)',
  () => {
    check(
      context,
      pinchProof,
      evaluate([], id(kc('Dim'), kc('dimension'), kc('Dim'))),
    )
  },
)

// soundness: without the floor, antisymmetry cannot conclude (only the ceiling is not enough).
rejects(
  'only the ceiling, without the floor, does not force eight',
  () => {
    check(
      context,
      aps(
        kc('antisym'),
        kc('dimension'),
        kc('eight'),
        kc('ceiling'),
        kc('ceiling'),
      ),
      evaluate([], pinchGoal),
    )
  },
)

console.log(
  `\npinch-point (structural kernel proof): ${pass} pass, ${fail} fail`,
)
