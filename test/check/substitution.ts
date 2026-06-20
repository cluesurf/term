// Substitution unit test (Tier 2 modular checker). The unifier extracted from the inference closure, now testable on
// its own: fresh variables, path-compressed resolve, the occurs check, and structural unification. Run: npx tsx test/check/substitution.ts

import { Substitution } from '@/code/check/substitution'
import type { Type } from '@/code/compile/node'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}`) } else { fail++; console.log(`FAIL  ${name}  ${info}`) }
}

const NUMBER: Type = { kind: 'number' }
const STRING: Type = { kind: 'string' }

// fresh mints distinct variables
{
  const s = new Substitution()
  const a = s.fresh()
  const b = s.fresh()
  ok('fresh variables are distinct', a.kind === 'variable' && b.kind === 'variable' && a.id !== b.id)
}

// a variable unifies with a concrete type, then resolves to it
{
  const s = new Substitution()
  const v = s.fresh()
  ok('unify a variable with a concrete type', s.unify(v, NUMBER))
  ok('resolve follows the binding', s.resolve(v).kind === 'number')
}

// unknown is gradual: unifies with anything, binds nothing
{
  const s = new Substitution()
  ok('unknown unifies with a concrete type', s.unify({ kind: 'unknown' }, NUMBER))
}

// mismatched concretes do not unify
{
  const s = new Substitution()
  ok('number does not unify with string', !s.unify(NUMBER, STRING))
}

// structural unification: arrays, functions, maps
{
  const s = new Substitution()
  const v = s.fresh()
  ok('arrays unify element-wise', s.unify({ kind: 'array', element: v }, { kind: 'array', element: NUMBER }) && s.resolve(v).kind === 'number')
}
{
  const s = new Substitution()
  const v = s.fresh()
  const f1: Type = { kind: 'function', params: [v], result: STRING }
  const f2: Type = { kind: 'function', params: [NUMBER], result: STRING }
  ok('functions unify param + result', s.unify(f1, f2) && s.resolve(v).kind === 'number')
  ok('functions of different arity do not unify', !s.unify({ kind: 'function', params: [], result: STRING }, f2))
}

// the occurs check prevents an infinite type
{
  const s = new Substitution()
  const v = s.fresh()
  ok('occurs check rejects a self-referential binding', !s.unify(v, { kind: 'array', element: v }))
}

// origin records where a variable was solved (for diagnostics / hover)
{
  const s = new Substitution()
  const v = s.fresh()
  const span = { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } }
  s.unify(v, NUMBER, span)
  ok('origin records the solving span', s.origin.get((v as { id: number }).id)?.type.kind === 'number')
}

console.log(`\nsubstitution: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
