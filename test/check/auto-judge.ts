// A minimal automated proof-search tactic over the decided kernel (judge.ts): the kernel-side ATP layer.
// `auto` is given a context of named hypotheses and a goal type, and searches for a proof term that the kernel
// accepts, trying, in order: assumption (a hypothesis whose type is the goal), reflexivity (for an Id goal whose
// sides are convertible), and one-step application (a function hypothesis applied to another hypothesis). It is a
// small bounded search whose every candidate is verified by the sound kernel, so a found proof is a real proof.
// Run: npx tsx test/check/auto-judge.ts

import type { Term } from '@cluesurf/make/code/check/judge'
import {
  check,
  contextWithSignature,
  evaluate,
  litLevel,
} from '@cluesurf/make/code/check/judge'

type Hyp = { name: string; type: Term }

const kc = (name: string): Term => ({ tag: 'const', name })
const ty = (n: number): Term => ({ tag: 'type', level: litLevel(n) })
const pi = (
  mult: 0 | 1 | 'many',
  domain: Term,
  codomain: Term,
): Term => ({
  tag: 'pi',
  mult,
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
const refl = (type: Term, value: Term): Term => ({
  tag: 'refl',
  type,
  value,
})

// the oracle: does this candidate proof term check against the goal in the given context?
function holds(
  context: ReturnType<typeof contextWithSignature>,
  term: Term,
  goal: Term,
): boolean {
  try {
    check(context, term, evaluate([], goal))
    return true
  } catch {
    return false
  }
}

// the tactic: search for a proof term for `goal` from the hypotheses.
function auto(hyps: Array<Hyp>, goal: Term): Term | null {
  const context = contextWithSignature(hyps)

  // 1. assumption: a hypothesis whose type is the goal.
  for (const h of hyps) {
    if (holds(context, kc(h.name), goal)) return kc(h.name)
  }

  // 2. reflexivity: an Id goal whose two sides are convertible.
  if (goal.tag === 'id') {
    const candidate = refl(goal.type, goal.left)
    if (holds(context, candidate, goal)) return candidate
  }

  // 3. one-step application: a function hypothesis applied to another hypothesis.
  for (const f of hyps) {
    for (const x of hyps) {
      const candidate = app(kc(f.name), kc(x.name))
      if (holds(context, candidate, goal)) return candidate
    }
  }

  return null
}

let pass = 0
let fail = 0
function ok(name: string, found: Term | null): void {
  if (found) {
    pass++
    console.log(`ok    ${name}  (proof found)`)
  } else {
    fail++
    console.log(`FAIL  ${name}  (no proof found)`)
  }
}
function none(name: string, found: Term | null): void {
  if (!found) {
    pass++
    console.log(`ok    ${name}  (correctly found no proof)`)
  } else {
    fail++
    console.log(`FAIL  ${name}  (found a proof it should not have)`)
  }
}

// assumption: prove Id A x y when p : Id A x y is a hypothesis.
ok(
  'auto closes a goal by assumption',
  auto(
    [
      { name: 'A', type: ty(0) },
      { name: 'x', type: kc('A') },
      { name: 'y', type: kc('A') },
      { name: 'p', type: id(kc('A'), kc('x'), kc('y')) },
    ],
    id(kc('A'), kc('x'), kc('y')),
  ),
)

// reflexivity: prove Id A x x with no equality hypothesis, by refl.
ok(
  'auto closes a reflexive Id goal by refl',
  auto(
    [
      { name: 'A', type: ty(0) },
      { name: 'x', type: kc('A') },
    ],
    id(kc('A'), kc('x'), kc('x')),
  ),
)

// application (modus ponens): prove B from f : A -> B and a : A.
ok(
  'auto closes a goal by one-step application (modus ponens)',
  auto(
    [
      { name: 'A', type: ty(0) },
      { name: 'B', type: ty(0) },
      { name: 'f', type: pi('many', kc('A'), kc('B')) },
      { name: 'a', type: kc('A') },
    ],
    kc('B'),
  ),
)

// negative: with no way to reach the goal, auto must report no proof (it does not hallucinate one).
none(
  'auto finds no proof when the goal is unreachable',
  auto(
    [
      { name: 'A', type: ty(0) },
      { name: 'B', type: ty(0) },
      { name: 'a', type: kc('A') },
    ],
    kc('B'),
  ),
)

console.log(`\nauto (kernel proof search): ${pass} pass, ${fail} fail`)
