// The cubical PATH reduction engine: the circle's path constructor `loop` COMPUTES. This is the piece the pre-cubical
// circle (`circle.ts`) lacked -- there the recursor's action on the loop held only PROPOSITIONALLY; here it holds
// DEFINITIONALLY, by reduction. The headline equation is `ap (circRec(b, l)) loop = l` (the recursor's path beta-rule):
// the action of the circle recursor on the loop reduces to the target loop `l`. We also check the point beta-rule, the
// loop endpoints, the non-triviality of the loop, cong-on-refl, and soundness (a different target gives a different
// result). Run: npx tsx test/check/cubical.ts

import {
  normalize,
  equal,
  ap,
  base,
  loop,
  cst,
  circRec,
  reflPath,
  type Term,
} from '@term/make/code/check/cubical'

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

const b = cst('b') // a target point
const l = cst('l') // unused opaque; we use real paths below
void l

// 1. the POINT beta-rule: circRec(b, target-loop) applied to `base` reduces to `b`.
ok(
  'point beta: circRec(b, l) base = b',
  equal({ t: 'app', fun: circRec(b, loop), arg: base }, b),
)

// 2. THE PATH BETA-RULE (the deliverable): the recursor's action on the loop reduces DEFINITIONALLY to the target loop.
// Identity recursor: circRec(base, loop) sends base->base and loop->loop, so ap of it on loop is loop.
ok(
  'PATH beta: ap (circRec(base, loop)) loop = loop  (computes definitionally)',
  equal(ap(circRec(base, loop), loop), loop),
)

// 3. the path beta-rule with a DIFFERENT target: circRec(base, refl base) sends loop to the constant path, so ap of it
// on loop reduces to `refl base`.
ok(
  'PATH beta: ap (circRec(base, refl base)) loop = refl base',
  equal(ap(circRec(base, reflPath(base)), loop), reflPath(base)),
)

// 4. SOUNDNESS: the two recursors above are genuinely different -- ap on loop gives `loop` for one and `refl base` for
// the other, and these are NOT equal. The path beta-rule is not collapsing everything.
ok(
  'soundness: ap (circRec(base, loop)) loop != refl base (targets are distinguished)',
  !equal(ap(circRec(base, loop), loop), reflPath(base)),
)

// 5. the LOOP ENDPOINTS: loop @ i0 = base and loop @ i1 = base.
ok(
  'loop @ i0 = base',
  equal({ t: 'papp', path: loop, at: { t: 'i0' } }, base),
)
ok(
  'loop @ i1 = base',
  equal({ t: 'papp', path: loop, at: { t: 'i1' } }, base),
)

// 6. NON-TRIVIALITY: the loop is not the reflexivity path at base. At an interval variable, `loop @ i` is a genuine
// loop-point, distinct from `(refl base) @ i = base`.
ok(
  'non-triviality: loop != refl base (loop @ i is a genuine loop-point, not base)',
  !equal(loop, reflPath(base)),
)

// 7. cong on REFL is refl: ap (circRec(base, loop)) (refl base) reduces to a constant (reflexivity) path. The recursor
// applied to the constant path `<i> base` gives `<i> circRec(...) base = <i> base = refl base`.
const reflBaseAp = ap(circRec(base, loop), reflPath(base))
ok(
  'cong on refl is refl: ap (circRec(base, loop)) (refl base) = refl base',
  equal(reflBaseAp, reflPath(base)),
)

// 8. the path beta-rule fires UNDER the action even for a recursor into an opaque target loop `p`: circRec(base, p) sends
// loop to p, so ap on loop is p.
const p: Term = { t: 'plam', body: { t: 'loopAt', at: { t: 'ivar', index: 0 } } } // <i> loop@i  (= loop by eta)
ok(
  'PATH beta with a built path target: ap (circRec(base, <i> loop@i)) loop = loop',
  equal(ap(circRec(base, p), loop), loop),
)

console.log(`\ncubical: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
