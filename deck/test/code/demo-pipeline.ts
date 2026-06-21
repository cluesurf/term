/**
 * The whole system in one loop, with the AI proposer in place. Run
 * from the seed install root:
 *   npx tsx deck/test/code/demo-pipeline.ts
 *
 * `autocomplete` takes a contract and returns proven, compiling Seed
 * code. Here the AI plug point (a `hintProposer` standing in for a
 * model) proposes first, CEGIS is the net, and EVERY proposal - AI or
 * CEGIS - is proven over the bound AND compiled by the live Seed
 * compiler before acceptance. A wrong AI hint is rejected and CEGIS
 * recovers, so the output is always sound.
 *
 * This is the complete vision running: spec in, verified Seed out, with
 * the AI proposing under the verifier's certification.
 */

import { projectResolver } from '@cluesurf/call/code/make'
import { autocomplete, isSound } from './pipeline'
import { hintProposer } from './gap'
import { type Contract } from './contract'
import { type Expr } from './synthesize'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
  else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
}

const ROOT = process.cwd()
const resolve = projectResolver(ROOT, 'node', ROOT)

const VAR = (index: number): Expr => ({ form: 'var', index })

const maxContract: Contract = {
  name: 'max',
  params: [{ name: 'a' }, { name: 'b' }],
  post: ([a, b], out) => out >= a && out >= b && (out === a || out === b),
}

// --- A. the AI proposes correctly; the loop certifies and emits Seed ---
const goodHint: Record<string, Expr> = {
  max: { form: 'max', left: VAR(0), right: VAR(1) },
}
const aiDriven = autocomplete({
  taskName: 'find-max',
  contract: maxContract,
  resolve,
  proposers: [hintProposer(goodHint)],
})
ok('AI proposal -> proven -> compiles', isSound(aiDriven) && aiDriven.ok && aiDriven.proposer === 'ai-hint')
if (aiDriven.ok) {
  console.log('\n  --- AI-proposed, verified, compiling Seed ---')
  console.log(aiDriven.source.split('\n').map(l => '  ' + l).join('\n'))
}

// --- B. a WRONG AI proposal is rejected by proof+compile; CEGIS recovers ---
const badHint: Record<string, Expr> = {
  max: VAR(0), // "return a" - wrong
}
const recovered = autocomplete({
  taskName: 'find-max',
  contract: maxContract,
  resolve,
  proposers: [hintProposer(badHint)],
})
ok('wrong AI proposal rejected, CEGIS recovers, still sound',
  isSound(recovered) && recovered.ok && recovered.proposer === 'cegis')

// --- C. CEGIS-only completion for several contracts, all sound ---
const others: { taskName: string; contract: Contract }[] = [
  {
    taskName: 'find-min',
    contract: {
      name: 'min',
      params: [{ name: 'a' }, { name: 'b' }],
      post: ([a, b], out) => out <= a && out <= b && (out === a || out === b),
    },
  },
  {
    taskName: 'find-abs',
    contract: {
      name: 'abs',
      params: [{ name: 'a' }],
      post: ([a], out) => out >= 0 && (out === a || out === -a),
    },
  },
]
for (const { taskName, contract } of others) {
  const result = autocomplete({ taskName, contract, resolve })
  ok(`${taskName}: synthesized -> proven -> emitted -> compiles`, isSound(result))
}

console.log(`\nseed-verify pipeline demo: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
