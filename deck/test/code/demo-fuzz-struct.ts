/**
 * Structure-aware fuzzing over typed Seed values. Run:
 *   npx tsx deck/test/code/demo-fuzz-struct.ts
 *
 * The fuzzer mutates a typed value (a record, a list) per its SeedType,
 * so it reaches a structural bug a flat byte fuzzer would not: a list
 * that contains two equal adjacent elements past length 3. The fuzzer
 * grows the list and tunes elements (structure-aware) until it triggers.
 *
 * Deterministic.
 */

import { fuzzStruct, type StructTarget } from './fuzz-struct'
import { tList, tInt, tRecord, type SeedType } from './type'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
  else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
}

// --- A. a structural bug over a list ---
// crashes on a list of length >= 4 with two equal adjacent elements.
// requires both the right SHAPE (length) and the right CONTENT.
const listType: SeedType = tList(tInt)
const listBug: StructTarget = (value, sink) => {
  const list = value as number[]
  sink.edge(1)
  if (list.length >= 4) {
    sink.edge(2)
    for (let i = 1; i < list.length; i++) {
      if (list[i] === list[i - 1]) {
        sink.edge(3)
        throw new Error('adjacent duplicates in a long list')
      }
    }
  }
}
const r1 = fuzzStruct({ target: listBug, type: listType, iterations: 100_000, seed: 1 })
ok('structure-aware fuzzer finds the list bug', !!r1.crash,
  r1.crash ? `crash=${JSON.stringify(r1.crash)} in ${r1.execs} execs` : `(no crash in ${r1.execs})`)
if (r1.crash) {
  const list = r1.crash as number[]
  ok('crash satisfies the structural condition',
    list.length >= 4 && list.some((v, i) => i > 0 && v === list[i - 1]))
}

// --- B. a record-field bug ---
// a {count, limit} record that must have count > limit AND limit > 0.
const recType: SeedType = tRecord([
  { name: 'count', type: tInt },
  { name: 'limit', type: tInt },
])
const recBug: StructTarget = (value, sink) => {
  const r = value as { count: number; limit: number }
  sink.cmp(r.count, r.limit)
  sink.cmp(r.limit, 0)
  if (r.limit > 0 && r.count > r.limit && r.count - r.limit > 50) {
    throw new Error('count exceeds limit by too much')
  }
}
const r2 = fuzzStruct({ target: recBug, type: recType, iterations: 100_000, seed: 2 })
ok('structure-aware fuzzer finds the record bug', !!r2.crash,
  r2.crash ? `crash=${JSON.stringify(r2.crash)}` : '')

console.log(`\nseed-verify struct-fuzz demo: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
