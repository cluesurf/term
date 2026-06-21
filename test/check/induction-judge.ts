// Induction on the decided kernel (judge.ts): proving a universal statement over the naturals by the induction
// principle, as a real kernel proof term, and having the forward-chaining search auto-discover it. The naturals
// here carry their induction principle as a postulate (the self-typed computational encoding is blocked on the
// seed compiler's inductive elaboration, which would auto-insert self-eliminations; the induction PRINCIPLE,
// however, is exactly the dependent eliminator, and proving by it is the induction tactic). Run:
// npx tsx test/check/induction-judge.ts

import type { Mult, Term } from '@cluesurf/make/code/check/judge'
import {
  check,
  contextWithSignature,
  evaluate,
  infer,
  showTerm,
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
const app = (fun: Term, arg: Term): Term => ({ tag: 'app', fun, arg })
const aps = (fun: Term, ...args: Array<Term>): Term =>
  args.reduce((f, a) => app(f, a), fun)

// stepType (inside natInd, context [P, base]): forall (k:Nat). P k -> P (succ k)
const stepType = pi(
  'many',
  kc('Nat'),
  pi(
    'many',
    app(v(2), v(0)), // P k
    app(v(3), app(kc('succ'), v(1))), // P (succ k)
  ),
)

// natInd : forall (P : Nat -> Type0). P zero
//            -> (forall (k:Nat). P k -> P (succ k)) -> forall (n:Nat). P n
const natIndType = pi(
  'many',
  pi('many', kc('Nat'), ty(0)), // P
  pi(
    'many',
    app(v(0), kc('zero')), // P zero
    pi(
      'many',
      stepType,
      pi('many', kc('Nat'), app(v(3), v(0))), // forall n. P n
    ),
  ),
)

// a concrete predicate Q over the naturals, with a base case and a step case in the signature.
const signature = [
  { name: 'Nat', type: ty(0) },
  { name: 'zero', type: kc('Nat') },
  { name: 'succ', type: pi('many', kc('Nat'), kc('Nat')) },
  { name: 'natInd', type: natIndType },
  { name: 'Q', type: pi('many', kc('Nat'), ty(0)) },
  { name: 'qbase', type: app(kc('Q'), kc('zero')) },
  {
    name: 'qstep',
    type: pi(
      'many',
      kc('Nat'),
      pi(
        'many',
        app(kc('Q'), v(0)), // Q k
        app(kc('Q'), app(kc('succ'), v(1))), // Q (succ k), k is one binder up
      ),
    ),
  },
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

// the universal goal: forall (n:Nat). Q n
const goal = pi('many', kc('Nat'), app(kc('Q'), v(0)))
// the proof by induction: natInd Q qbase qstep
const proofByInduction = aps(
  kc('natInd'),
  kc('Q'),
  kc('qbase'),
  kc('qstep'),
)

ok('forall n. Q n, proved by induction (natInd Q qbase qstep)', () => {
  check(context, proofByInduction, evaluate([], goal))
})

// forward-chaining search auto-discovers the induction proof.
function search(goalTerm: Term, depth: number): Term | null {
  const goalValue = evaluate([], goalTerm)
  const proves = (t: Term): boolean => {
    try {
      check(context, t, goalValue)
      return true
    } catch {
      return false
    }
  }
  const seen = new Set<string>()
  let facts: Array<Term> = signature.map(s => kc(s.name))
  facts.forEach(t => seen.add(showTerm(t)))
  for (let round = 0; round <= depth; round++) {
    for (const t of facts) if (proves(t)) return t
    const next = [...facts]
    for (const f of facts) {
      for (const x of facts) {
        const c = app(f, x)
        const k = showTerm(c)
        if (seen.has(k)) continue
        try {
          infer(context, c)
          seen.add(k)
          next.push(c)
        } catch {
          /* ill-typed */
        }
      }
    }
    facts = next
  }
  return null
}

ok('the search auto-discovers the induction proof', () => {
  const found = search(goal, 4)
  if (!found || !showTerm(found).includes('natInd')) {
    throw new Error(
      `search did not find the induction proof (got ${found ? showTerm(found) : 'nothing'})`,
    )
  }
  console.log(`        found: ${showTerm(found)}`)
})

console.log(`\ninduction (kernel): ${pass} pass, ${fail} fail`)
