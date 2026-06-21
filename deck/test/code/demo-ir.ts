/**
 * End-to-end integration with the live compiler. Run:
 *   npx tsx deck/test/code/demo-ir.ts
 *
 * Compiles a REAL Seed `.tree` program, pulls a real `form`'s type out
 * of the compiler's IR, derives a property-test generator from it, and
 * checks a property over the generated values. This is the
 * "read the compiler's real type IR in genForType" step: the
 * verification engine now consumes the actual Seed type system, not a
 * hand-written description.
 *
 * Pure node + tsx, deterministic.
 */

import { compile } from '@cluesurf/make/code/compile/compile'
import type { Type } from '@cluesurf/make/code/compile/node'
import { genFromIR, irToSeedType, type RecordTable } from './ir-gen'
import { check } from './property'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
  else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
}

// A real Seed program: a record, and a record that nests it.
const SOURCE = `form point
  link a, like number
  link b, like number

form line
  link head, like point
  link size, like number
`

// Build the table of record types from the compiled program's IR.
function recordTable(program: unknown): RecordTable {
  const table: RecordTable = new Map()
  const statements = program as { form?: string; name?: string; fields?: { name: string; type: Type }[] }[]
  for (const statement of statements) {
    if (statement?.form === 'record-type' && statement.name && statement.fields) {
      table.set(statement.name, statement.fields)
    }
  }
  return table
}

const result = compile({ file: 'shapes.tree', text: SOURCE }, { resolve: () => undefined })
ok('real .tree program compiles', result.ok)

const records = recordTable(result.program)
ok('extracted record types from the compiler IR', records.has('point') && records.has('line'))

// --- derive a generator from the REAL `point` type ---
const pointType: Type = { kind: 'named', name: 'point' }
const seedShape = irToSeedType(pointType, records)
ok('point translated to a record SeedType',
  seedShape.form === 'record' && seedShape.fields.length === 2)

const genPoint = genFromIR(pointType, records)
const pointProp = check(
  genPoint,
  (p: any) => typeof p.a === 'number' && typeof p.b === 'number',
  { runs: 100 },
)
ok('generator derived from the real point type produces valid points', pointProp.ok)

// --- the nested `line` type: the derivation recurses through `point` ---
const lineType: Type = { kind: 'named', name: 'line' }
const genLine = genFromIR(lineType, records)
const lineProp = check(
  genLine,
  (l: any) =>
    typeof l.size === 'number' &&
    l.head &&
    typeof l.head.a === 'number' &&
    typeof l.head.b === 'number',
  { runs: 100 },
)
ok('generator for the nested line type recurses through point', lineProp.ok)

// --- a property that FAILS gets a real shrunk counterexample over the
// derived type, proving the verifier works on compiler types ---
const buggyProp = check(
  genPoint,
  (p: any) => p.a === p.b, // false in general
  { runs: 200 },
)
ok('verifier finds a counterexample over the derived type', !buggyProp.ok,
  !buggyProp.ok ? `counterexample ${JSON.stringify(buggyProp.counterexample)}` : '')

console.log(`\nseed-verify IR demo: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
