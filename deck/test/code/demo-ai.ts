/**
 * The AI proposer in the loop, async and proof-gated. Run:
 *   npx tsx deck/test/code/demo-ai.ts
 *
 * `modelProposer(ask)` plugs a language model into synthesis. Here
 * `ask` is an async stand-in for the model (it awaits, then returns a
 * candidate from the prompt); in production it calls a real API. The
 * loop proves every proposal, so:
 *   - a correct model answer is accepted (and proven),
 *   - a wrong model answer is rejected by the proof and CEGIS recovers.
 * The only thing the sandbox cannot do is the real network call; the
 * async interface, the prompt, the proof-gating, and the fallback are
 * all built and runnable.
 */

import { modelProposer, asyncCegis, repairAsync } from './ai-proposer'
import { showExpr, type Expr, type Spec } from './synthesize'
import { type GapReport } from './gap'

const VAR = (i: number): Expr => ({ form: 'var', index: i })

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
  else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
}

const maxSpec: Spec = ([a, b], out) => out >= a && out >= b && (out === a || out === b)
const gap: GapReport = { goal: 'max', varCount: 2, spec: maxSpec, counterexamples: [], bound: 8 }

async function main(): Promise<void> {
  // A. the model answers correctly (async stand-in for the API call)
  const goodModel = async (_prompt: string): Promise<Expr | null> => {
    await Promise.resolve() // the awaited model round-trip
    return { form: 'max', left: VAR(0), right: VAR(1) }
  }
  const a = await repairAsync(gap, [modelProposer(goodModel), asyncCegis()])
  ok('async model proposal -> proven', a.ok && a.proposer === 'model',
    a.ok ? `=> ${showExpr(a.expr, ['a', 'b'])} via ${a.proposer}` : '')

  // B. the model answers WRONG; the proof rejects it, CEGIS recovers
  const wrongModel = async (_prompt: string): Promise<Expr | null> => {
    await Promise.resolve()
    return VAR(0) // "return a" - wrong
  }
  const b = await repairAsync(gap, [modelProposer(wrongModel), asyncCegis()])
  ok('wrong model proposal rejected by proof, CEGIS recovers',
    b.ok && b.proposer === 'cegis',
    b.ok ? `=> ${showExpr(b.expr, ['a', 'b'])} via ${b.proposer}` : '')

  // C. the model declines (null); CEGIS handles it alone
  const silentModel = async (): Promise<Expr | null> => null
  const c = await repairAsync(gap, [modelProposer(silentModel), asyncCegis()])
  ok('model declines -> CEGIS handles it', c.ok && c.proposer === 'cegis')

  console.log(`\nseed-verify ai demo: ${pass} pass, ${fail} fail`)
  if (fail > 0) process.exit(1)
}

main()
