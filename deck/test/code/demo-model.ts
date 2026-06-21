/**
 * The real model integration, proven end to end except the network
 * call. Run:
 *   npx tsx deck/test/code/demo-model.ts
 *
 * `parseExpr` turns a model's TEXT reply into an Expr; the repair loop
 * proves it. Here `ask` returns realistic model-style text (with code
 * fences, prose, etc.) which is parsed and proof-gated - exactly what
 * `askModel` does after the HTTP call. With SEED_MODEL_ENDPOINT and
 * SEED_MODEL_KEY set, `realModelProposer` calls the actual API instead.
 *
 * Deterministic.
 */

import { parseExpr } from './model'
import { modelProposer, asyncCegis, repairAsync, type AsyncProposer } from './ai-proposer'
import { showExpr, evalExpr, type Expr, type Spec } from './synthesize'
import { type GapReport } from './gap'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
  else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
}

// --- A. the reply parser handles real model output ---
const names = ['a', 'b']
const cases: [string, string][] = [
  ['max(a, b)', 'max(a, b)'],
  ['```\nmax(a, b)\n```', 'max(a, b)'],         // code fences
  ['The answer is max(a, b).', 'max(a, b)'],     // prose around it
  ['(0 - a)', '(0 - a)'],
  ['min(a, 1)', 'min(a, 1)'],
  ['(a + b)', '(a + b)'],
]
for (const [reply, expected] of cases) {
  const expr = parseExpr(reply, names)
  ok(`parses "${reply.replace(/\n/g, ' ')}"`, !!expr && showExpr(expr, names) === expected,
    expr ? `=> ${showExpr(expr, names)}` : '(failed)')
}

// --- B. the loop with a model whose ask returns TEXT (parsed) ---
const maxSpec: Spec = ([a, b], out) => out >= a && out >= b && (out === a || out === b)
const gap: GapReport = { goal: 'max', varCount: 2, spec: maxSpec, counterexamples: [], bound: 8 }

// a "model" that replies with text (as a real API would); parseExpr
// turns it into the candidate. This is askModel minus the fetch().
function textModel(replyText: string): AsyncProposer {
  return modelProposer(async () => parseExpr(replyText, names))
}

async function main(): Promise<void> {
  // correct textual reply -> proven
  const good = await repairAsync(gap, [textModel('```\nmax(a, b)\n```'), asyncCegis()])
  ok('model TEXT reply -> parsed -> proven', good.ok && good.proposer === 'model',
    good.ok ? `=> ${showExpr(good.expr, names)}` : '')

  // wrong textual reply -> rejected by proof, CEGIS recovers
  const bad = await repairAsync(gap, [textModel('a'), asyncCegis()])
  ok('wrong model reply rejected, CEGIS recovers', bad.ok && bad.proposer === 'cegis')

  // unparseable reply -> treated as a decline, CEGIS handles it
  const junk = await repairAsync(gap, [textModel('I am not sure, sorry!'), asyncCegis()])
  ok('unparseable reply -> CEGIS handles it', junk.ok && junk.proposer === 'cegis')

  console.log(`\nseed-verify model demo: ${pass} pass, ${fail} fail`)
  if (fail > 0) process.exit(1)
}

main()
