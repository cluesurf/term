/**
 * The terminal proof workflow (and the LSP hammer core). Run:
 *   npx tsx deck/test/code/demo-hammer.ts
 *
 * Simulates a proof session: state goals, hammer each, read the proof
 * state. A verify goal is proved or refuted (with a counterexample); a
 * synthesis goal is closed by finding a witness (emitted as Seed). This
 * is what the LSP `proof/hammer` returns and what a `seed prove` CLI
 * would print.
 *
 * Needs z3-solver (`pnpm install`).
 */

import { openSession, hammer, showState, type ProofGoal } from './hammer'
import { type Expr } from './synthesize'

const VAR = (i: number): Expr => ({ form: 'var', index: i })

async function main(): Promise<void> {
  let session
  try {
    session = await openSession()
  } catch {
    console.log('z3-solver not installed - run `pnpm install`, then re-run.')
    console.log('\nseed-verify hammer demo: skipped (no z3)')
    return
  }

  let pass = 0
  let fail = 0
  function ok(name: string, cond: boolean): void {
    if (cond) pass++; else fail++
  }

  const maxSym = (vars: any, out: any, z3: any) => {
    const [a, b] = vars
    return z3.And(out.ge(a), out.ge(b), z3.Or(out.eq(a), out.eq(b)))
  }

  const goals: ProofGoal[] = [
    // a verify goal that holds -> PROVED
    { kind: 'verify', name: 'max-correct', arity: 2, names: ['a', 'b'],
      expr: { form: 'max', left: VAR(0), right: VAR(1) }, symSpec: maxSym },
    // a verify goal that is false -> REFUTED with a counterexample
    { kind: 'verify', name: 'first-is-max', arity: 2, names: ['a', 'b'],
      expr: VAR(0), symSpec: maxSym },
    // a synthesis goal -> closed by finding a witness, emitted as Seed
    { kind: 'synthesize', name: 'find-max', varCount: 2, names: ['a', 'b'],
      jsSpec: ([a, b], out) => out >= a && out >= b && (out === a || out === b),
      symSpec: maxSym },
  ]

  console.log('=== proof session ===\n')
  for (const goal of goals) {
    const state = await hammer(goal, session)
    console.log(showState(state))
    if (goal.name === 'max-correct') ok('verify holds -> proved', state.status === 'proved')
    if (goal.name === 'first-is-max') ok('verify false -> refuted', state.status === 'refuted')
    if (goal.name === 'find-max') ok('synthesis -> proved with a witness', state.status === 'proved')
    if (state.status === 'proved' && state.seed) {
      console.log('    --- emitted witness (Seed) ---')
      console.log(state.seed.split('\n').map(l => '    ' + l).join('\n'))
    }
  }

  console.log(`\nseed-verify hammer demo: ${pass} pass, ${fail} fail`)
  if (fail > 0) process.exit(1)
}

main()
