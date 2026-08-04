/**
 * Codegen from verification, end to end. Run from the seed install root:
 *   npx tsx deck/test/code/demo-emit.ts
 *
 * For each contract: synthesize a verified body, emit it as REAL Seed
 * `.tree` source, and COMPILE that source to prove the system produced
 * valid Seed code. Spec in -> verified, compilable Seed function out.
 * This is the codegen system the verification results feed.
 *
 * Needs the install resolver (the emitted code loads @cluesurf/seed/
 * code/math), so run from the seed install dir.
 */

import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'
import { synthesizeContract, verifyContract, type Contract } from './contract'
import { emitSeed } from './emit'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
  else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
}

const ROOT = process.cwd() // the seed install dir, holding link/
const resolve = projectResolver(ROOT, 'node', ROOT)

const contracts: { contract: Contract; taskName: string; show?: boolean }[] = [
  {
    taskName: 'find-max',
    show: true,
    contract: {
      name: 'max',
      params: [{ name: 'a' }, { name: 'b' }],
      post: ([a, b], out) => out >= a && out >= b && (out === a || out === b),
    },
  },
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
    show: true,
    contract: {
      name: 'abs',
      params: [{ name: 'a' }],
      post: ([a], out) => out >= 0 && (out === a || out === -a),
    },
  },
  {
    taskName: 'clamp-low',
    contract: {
      name: 'clamp-low',
      params: [{ name: 'a' }],
      post: ([a], out) => out >= 0 && out >= a && (out === a || out === 0),
    },
  },
]

for (const { contract, taskName, show } of contracts) {
  // 1. synthesize a verified body from the spec
  const synth = synthesizeContract(contract)
  if (!synth.ok) {
    ok(`${taskName}: synthesized`, false, synth.reason)
    continue
  }

  // 2. confirm it satisfies the contract (proof over the bound)
  const verified = verifyContract(synth.expr, contract).ok

  // 3. emit it as real Seed source
  const source = emitSeed({
    name: taskName,
    params: contract.params.map(p => p.name),
    body: synth.expr,
  })

  // 4. compile the emitted source - is it valid Seed?
  const compiled = compile({ file: `${taskName}.tree`, text: source }, { resolve })

  ok(
    `${taskName}: spec -> verified -> emitted Seed -> compiles`,
    verified && compiled.ok,
    compiled.ok ? '' : (compiled.diagnostics || []).slice(0, 1).map(d => `${d.name}: ${d.message}`).join(''),
  )

  if (show && compiled.ok) {
    console.log('\n  --- emitted Seed for ' + taskName + ' ---')
    console.log(source.split('\n').map(l => '  ' + l).join('\n'))
  }
}

console.log(`\nseed-verify codegen demo: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
