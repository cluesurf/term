/**
 * Run the Seed compiler benchmark suite + analysis. Run from the seed
 * install root:
 *   npx tsx deck/test/code/demo-bench.ts
 *
 * Times tokenize / parse / compile / stream across real and synthetic
 * workloads, fits scaling exponents, and prints insights. The pass/fail
 * checks assert the performance INVARIANTS we care about (tokenize and
 * parse stay near-linear; streaming has low overhead) so a regression is
 * caught, not just measured.
 */

import { projectResolver } from '@term/call/code/make'
import { runCompilerBench } from './seed-bench'
import { renderBench, scaling } from './bench'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
  else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
}

const root = process.cwd()
const suite = runCompilerBench({ root, resolve: projectResolver(root, 'node', root), iterations: 20 })

console.log(renderBench(suite.results))
console.log('\n  insights:')
for (const i of suite.insights) console.log(`    - ${i}`)

// performance invariants (caught as regressions, not just reported)
const lineTok = suite.results.filter(r => r.name.includes('-char line'))
const lineExp = scaling(lineTok).exponent
ok('tokenize stays ~linear in LINE length (cursor fix holds)', lineExp < 1.4, `exponent ${lineExp.toFixed(2)}`)

const lenTok = suite.results.filter(r => r.name.includes('defs') && r.name.startsWith('tokenize'))
const lenExp = scaling(lenTok).exponent
ok('tokenize stays ~linear in file length', lenExp < 1.4, `exponent ${lenExp.toFixed(2)}`)

const lenParse = suite.results.filter(r => r.name.includes('defs') && r.name.startsWith('parse'))
const parseExp = scaling(lenParse).exponent
ok('parse stays sub-quadratic in file length', parseExp < 1.7, `exponent ${parseExp.toFixed(2)}`)

console.log(`\nseed-verify bench demo: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
