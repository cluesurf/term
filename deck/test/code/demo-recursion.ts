/**
 * Map and filter recursion schemes. Run:
 *   npx tsx deck/test/code/demo-recursion.ts
 *
 * Synthesizes list->list functions from behavior alone: a map (the
 * element transform) and a filter (the keep-predicate). With the fold
 * from ir-synth.ts, synthesis now covers the three core recursion
 * schemes over lists. Deterministic.
 */

import { synthesizeMap, synthesizeFilter, showExpr, showPred } from './recursion'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
  else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
}

// --- map ---
const incrementAll = synthesizeMap({ spec: list => list.map(x => x + 1) })
ok('synthesized increment-all (map)', incrementAll.ok,
  incrementAll.ok ? `=> map(elem -> ${showExpr(incrementAll.transform, ['elem'])})` : incrementAll.reason)

const doubleAll = synthesizeMap({ spec: list => list.map(x => x + x) })
ok('synthesized double-all (map)', doubleAll.ok,
  doubleAll.ok ? `=> map(elem -> ${showExpr(doubleAll.transform, ['elem'])})` : doubleAll.reason)

// --- filter ---
const keepNonneg = synthesizeFilter({ spec: list => list.filter(x => x >= 0) })
ok('synthesized keep-nonneg (filter)', keepNonneg.ok,
  keepNonneg.ok ? `=> filter(elem -> ${showPred(keepNonneg.keep, ['elem'])})` : keepNonneg.reason)

const dropZeros = synthesizeFilter({ spec: list => list.filter(x => x !== 0) })
ok('synthesized drop-zeros (filter)', dropZeros.ok,
  dropZeros.ok ? `=> filter(elem -> ${showPred(dropZeros.keep, ['elem'])})` : dropZeros.reason)

console.log(`\nseed-verify recursion demo: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
