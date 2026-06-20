// A forward-chaining proof search over the decided kernel (judge.ts), the next step of the ATP tactic layer past
// the one-step `auto`. From the hypotheses it derives new terms by application, inferring each result type with
// the sound kernel, for a bounded number of rounds, and stops when a derived term checks against the goal. It is
// breadth-first and backtracking-free but multi-step, and every term it builds is kernel-typed, so a found proof
// is real. It auto-discovers the pinch-point proof (antisymmetry applied to the ceiling and the floor) and
// multi-step propositional chains. Run: npx tsx test/check/search-judge.ts

import type { Mult, Term } from '@/code/check/judge'
import {
  check,
  contextWithSignature,
  evaluate,
  infer,
  showTerm,
  litLevel,
} from '@/code/check/judge'

type Hyp = { name: string; type: Term }

const kc = (name: string): Term => ({ tag: 'const', name })
const ty = (n: number): Term => ({ tag: 'type', level: litLevel(n) })
const pi = (m: Mult, domain: Term, codomain: Term): Term => ({
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
const refl = (type: Term, value: Term): Term => ({
  tag: 'refl',
  type,
  value,
})
const aps = (fun: Term, ...args: Array<Term>): Term =>
  args.reduce((f, a) => app(f, a), fun)

// the forward-chaining search.
function search(hyps: Array<Hyp>, goal: Term, depth: number): Term | null {
  const context = contextWithSignature(hyps)
  const goalValue = evaluate([], goal)

  const proves = (term: Term): boolean => {
    try {
      check(context, term, goalValue)
      return true
    } catch {
      return false
    }
  }

  // reflexivity closes a reflexive Id goal outright.
  if (goal.tag === 'id') {
    const r = refl(goal.type, goal.left)
    if (proves(r)) return r
  }

  // the working set of kernel-typed terms, deduped by printed form.
  const seen = new Set<string>()
  let facts: Array<Term> = []
  for (const h of hyps) {
    const t = kc(h.name)
    facts.push(t)
    seen.add(showTerm(t))
  }

  for (let round = 0; round <= depth; round++) {
    for (const t of facts) if (proves(t)) return t
    const next: Array<Term> = [...facts]
    for (const f of facts) {
      for (const x of facts) {
        const candidate = app(f, x)
        const key = showTerm(candidate)
        if (seen.has(key)) continue
        try {
          infer(context, candidate) // only keep well-typed applications
          seen.add(key)
          next.push(candidate)
        } catch {
          // ill-typed application, discard
        }
      }
    }
    facts = next
  }
  for (const t of facts) if (proves(t)) return t
  return null
}

let pass = 0
let fail = 0
function ok(name: string, found: Term | null, expect?: string): void {
  if (found && (!expect || showTerm(found).includes(expect))) {
    pass++
    console.log(`ok    ${name}\n        found: ${showTerm(found)}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  (found: ${found ? showTerm(found) : 'nothing'})`)
  }
}

// multi-step propositional chain: prove C from f : A -> B, g : B -> C, a : A. needs g (f a).
ok(
  'search finds a two-step chain g (f a) : C',
  search(
    [
      { name: 'A', type: ty(0) },
      { name: 'B', type: ty(0) },
      { name: 'C', type: ty(0) },
      { name: 'f', type: pi('many', kc('A'), kc('B')) },
      { name: 'g', type: pi('many', kc('B'), kc('C')) },
      { name: 'a', type: kc('A') },
    ],
    kc('C'),
    3,
  ),
)

// the pinch-point, AUTO-DISCOVERED: from the ceiling and the floor, antisymmetry forces the dimension to eight.
const le = (a: Term, b: Term): Term => aps(kc('Le'), a, b)
const antisymType = pi(
  'many',
  kc('Dim'),
  pi(
    'many',
    kc('Dim'),
    pi(
      'many',
      le(({ tag: 'var', index: 1 } as Term), { tag: 'var', index: 0 } as Term),
      pi(
        'many',
        le({ tag: 'var', index: 1 } as Term, { tag: 'var', index: 2 } as Term),
        id(kc('Dim'), { tag: 'var', index: 3 } as Term, { tag: 'var', index: 2 } as Term),
      ),
    ),
  ),
)
ok(
  'search auto-discovers the pinch-point proof (antisym applied to ceiling and floor)',
  search(
    [
      { name: 'Dim', type: ty(0) },
      { name: 'Le', type: pi('many', kc('Dim'), pi('many', kc('Dim'), ty(0))) },
      { name: 'antisym', type: antisymType },
      { name: 'dimension', type: kc('Dim') },
      { name: 'eight', type: kc('Dim') },
      { name: 'ceiling', type: le(kc('dimension'), kc('eight')) },
      { name: 'floor', type: le(kc('eight'), kc('dimension')) },
    ],
    id(kc('Dim'), kc('dimension'), kc('eight')),
    5,
  ),
  'antisym',
)

console.log(`\nsearch (kernel forward-chaining ATP): ${pass} pass, ${fail} fail`)
