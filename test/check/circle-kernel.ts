// The circle higher-inductive type, WIRED INTO THE KERNEL. The circle's beta-rules are realized as reductions in the
// kernel's evaluator (`judge.ts` applyValue / reduceCircle), so they hold DEFINITIONALLY -- a `refl` proof type-checks
// exactly when the two sides reduce to the same normal form. This is the cubical layer reaching the kernel: the engine
// in `cubical.ts` validates that these are the correct consequences of the interval + path reduction, and the kernel
// implements them as rewrites on the reserved circle constants.
//   POINT beta:  circleRec A b l circleBase  ==  b
//   PATH beta:   circleApLoop A b l           ==  l     (the action of the recursor on the loop is the target loop)
// Both are checked DEFINITIONALLY (through `check` on a `refl`), with soundness controls (a different target is NOT
// accepted). Run: npx tsx test/check/circle-kernel.ts

import type { Term } from '@cluesurf/make/code/check/judge'
import {
  check,
  contextWithSignature,
  evaluate,
  litLevel,
  resetDefinitions,
  resetMetas,
} from '@cluesurf/make/code/check/judge'
import type { Mult } from '@cluesurf/make/code/check/judge'

let pass = 0
let fail = 0

function ok(name: string, run: () => void): void {
  try {
    run()
    pass++
    console.log(`ok    ${name}`)
  } catch (error) {
    fail++
    console.log(`FAIL  ${name}  ${error instanceof Error ? error.message : String(error)}`)
  }
}

function rejects(name: string, run: () => void): void {
  try {
    run()
    fail++
    console.log(`FAIL  ${name}  (expected a type error, but it checked)`)
  } catch {
    pass++
    console.log(`ok    ${name}`)
  }
}

const v = (index: number): Term => ({ tag: 'var', index })
const kconst = (name: string): Term => ({ tag: 'const', name })
const ty = (n: number): Term => ({ tag: 'type', level: litLevel(n) })
const pi = (mult: Mult, domain: Term, codomain: Term): Term => ({ tag: 'pi', mult, domain, codomain })
const app = (fun: Term, arg: Term): Term => ({ tag: 'app', fun, arg })
const id = (type: Term, left: Term, right: Term): Term => ({ tag: 'id', type, left, right })
const refl = (type: Term, value: Term): Term => ({ tag: 'refl', type, value })
const apps = (fun: Term, ...args: Term[]): Term => args.reduce(app, fun)

// the circle signature: the type, its point and recursor, the loop-action, and a concrete target A0 with a point b0 and
// two distinct postulated loops l0, l1 in A0.
const sig = [
  { name: 'circle', type: ty(0) },
  { name: 'circleBase', type: kconst('circle') },
  // circleRec : (A : Type0) (b : A) (l : Id A b b) (c : circle) -> A
  {
    name: 'circleRec',
    type: pi(
      'many',
      ty(0),
      pi('many', v(0), pi('many', id(v(1), v(0), v(0)), pi('many', kconst('circle'), v(3)))),
    ),
  },
  // circleApLoop : (A : Type0) (b : A) (l : Id A b b) -> Id A b b   (the recursor's action on the loop)
  {
    name: 'circleApLoop',
    type: pi('many', ty(0), pi('many', v(0), pi('many', id(v(1), v(0), v(0)), id(v(2), v(1), v(1))))),
  },
  { name: 'A0', type: ty(0) },
  { name: 'b0', type: kconst('A0') },
  { name: 'c0', type: kconst('A0') }, // another point of A0 (for the soundness control)
  { name: 'l0', type: id(kconst('A0'), kconst('b0'), kconst('b0')) },
  { name: 'l1', type: id(kconst('A0'), kconst('b0'), kconst('b0')) }, // a DIFFERENT loop
]

function context() {
  resetMetas()
  resetDefinitions()
  return contextWithSignature(sig)
}

const recBase: Term = apps(kconst('circleRec'), kconst('A0'), kconst('b0'), kconst('l0'), kconst('circleBase'))
const apLoop: Term = apps(kconst('circleApLoop'), kconst('A0'), kconst('b0'), kconst('l0'))
const A0Path = id(kconst('A0'), kconst('b0'), kconst('b0'))

// 1. POINT beta: circleRec A0 b0 l0 circleBase reduces to b0. refl proves Id A0 (circleRec ... circleBase) b0 only if
// the two sides are definitionally equal.
ok('point beta: circleRec A0 b0 l0 circleBase == b0', () => {
  check(context(), refl(kconst('A0'), kconst('b0')), evaluate([], id(kconst('A0'), recBase, kconst('b0'))))
})

// 2. SOUNDNESS: the recursor on base is b0, NOT the other point c0 -- must be rejected.
rejects('soundness: circleRec A0 b0 l0 circleBase != c0', () => {
  check(context(), refl(kconst('A0'), kconst('b0')), evaluate([], id(kconst('A0'), recBase, kconst('c0'))))
})

// 3. PATH beta (the deliverable): the action of the recursor on the loop reduces to the target loop l0. refl proves
// Id (Id A0 b0 b0) (circleApLoop A0 b0 l0) l0 only if the path beta-rule holds definitionally.
ok('PATH beta: circleApLoop A0 b0 l0 == l0  (ap (circRec) loop computes to the target loop)', () => {
  check(context(), refl(A0Path, kconst('l0')), evaluate([], id(A0Path, apLoop, kconst('l0'))))
})

// 4. SOUNDNESS: the action on the loop is l0, NOT the different loop l1 -- must be rejected (the path beta-rule does not
// collapse distinct targets).
rejects('soundness: circleApLoop A0 b0 l0 != l1 (distinct loops stay distinct)', () => {
  check(context(), refl(A0Path, kconst('l0')), evaluate([], id(A0Path, apLoop, kconst('l1'))))
})

// 5. the recursor stays STUCK on a neutral (non-base) circle element: with `x : circle` a variable, circleRec A0 b0 l0 x
// does NOT reduce to b0, so refl does not prove them equal -- rejected. (The reduction fires only on the constructor.)
rejects('recursor is stuck on a neutral scrutinee: circleRec A0 b0 l0 x != b0', () => {
  const ctx = contextWithSignature([...sig, { name: 'x', type: kconst('circle') }])
  resetMetas()
  resetDefinitions()
  const recX = apps(kconst('circleRec'), kconst('A0'), kconst('b0'), kconst('l0'), kconst('x'))
  check(ctx, refl(kconst('A0'), kconst('b0')), evaluate([], id(kconst('A0'), recX, kconst('b0'))))
})

console.log(`\ncircle-kernel: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
