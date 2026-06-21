/**
 * The proof-IDE server protocol, end to end. Run:
 *   npx tsx deck/test/code/demo-proof-lsp.ts
 *
 * Simulates the LSP request cycle a proof IDE makes: open a document
 * with proof obligations, request `proof/state` (the InfoView's
 * initial render - all goals open), then `proof/hammer` each goal and
 * re-render. This is exactly what deck/flow would serve and the
 * InfoView webview would draw. Only the webview client is absent.
 *
 * Needs z3-solver (`pnpm install`).
 */

import { openSession } from './hammer'
import { proofState, proofHammer, renderInfoView, type ProofDocument } from './proof-lsp'
import { type ProofState } from './hammer'
import { type Expr } from './synthesize'

const VAR = (i: number): Expr => ({ form: 'var', index: i })

async function main(): Promise<void> {
  let session
  try {
    session = await openSession()
  } catch {
    console.log('z3-solver not installed - run `pnpm install`, then re-run.')
    console.log('\nseed-verify proof-lsp demo: skipped (no z3)')
    return
  }

  let pass = 0
  let fail = 0
  function ok(name: string, cond: boolean): void {
    if (cond) pass++; else fail++
    console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  }

  const maxSym = (vars: any, out: any, z3: any) => {
    const [a, b] = vars
    return z3.And(out.ge(a), out.ge(b), z3.Or(out.eq(a), out.eq(b)))
  }

  // a document with three proof obligations
  const doc: ProofDocument = {
    uri: 'math.tree',
    goals: [
      { kind: 'verify', name: 'max-correct', arity: 2, names: ['a', 'b'],
        expr: { form: 'max', left: VAR(0), right: VAR(1) }, symSpec: maxSym },
      { kind: 'verify', name: 'first-is-max', arity: 2, names: ['a', 'b'],
        expr: VAR(0), symSpec: maxSym },
      { kind: 'synthesize', name: 'find-max', varCount: 2, names: ['a', 'b'],
        jsSpec: ([a, b], out) => out >= a && out >= b && (out === a || out === b),
        symSpec: maxSym },
    ],
  }

  const results = new Map<string, ProofState>()

  // proof/state - initial render: everything open
  let view = proofState(doc, results)
  console.log('\n--- proof/state (initial) ---\n' + renderInfoView(view))
  ok('initial state: all goals open', view.solved === 0 && view.total === 3 && !view.done)

  // proof/hammer each goal, folding the result back
  for (const goal of doc.goals) {
    const state = await proofHammer(doc, goal.name, session)
    results.set(goal.name, state)
  }

  // proof/state - after hammering
  view = proofState(doc, results)
  console.log('\n--- proof/state (after hammer) ---\n' + renderInfoView(view))

  const byName = new Map(view.goals.map(g => [g.name, g]))
  ok('max-correct proved', byName.get('max-correct')?.status === 'proved')
  ok('first-is-max refuted with a counterexample',
    byName.get('first-is-max')?.status === 'refuted' && !!byName.get('first-is-max')?.counterexample)
  ok('find-max proved (synthesized witness)', byName.get('find-max')?.status === 'proved')
  ok('aggregate: 2 of 3 solved (1 genuinely false)', view.solved === 2)

  console.log(`\nseed-verify proof-lsp demo: ${pass} pass, ${fail} fail`)
  if (fail > 0) process.exit(1)
}

main()
