// Substitution unit test (Tier 2 modular checker). The unifier extracted from the inference closure, now testable on
// its own: fresh variables, path-compressed resolve, the occurs check, and structural unification. Run: npx tsx test/check/substitution.ts

import { freshType, newSubstitution, resolveType, unifyTypes, unifyTypesAt } from '@term/make/code/check/substitution'
import type { Type } from '@term/make/code/compile/node'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

const NUMBER: Type = { kind: 'number' }
const STRING: Type = { kind: 'string' }

// fresh mints distinct variables
{
  const s = newSubstitution()
  const a = freshType(s)
  const b = freshType(s)
  ok(
    'fresh variables are distinct',
    a.kind === 'variable' && b.kind === 'variable' && a.id !== b.id,
  )
}

// a variable unifies with a concrete type, then resolves to it
{
  const s = newSubstitution()
  const v = freshType(s)
  ok('unify a variable with a concrete type', unifyTypes(s, v, NUMBER))
  ok('resolve follows the binding', resolveType(s, v).kind === 'number')
}

// unknown is gradual: unifies with anything, binds nothing
{
  const s = newSubstitution()
  ok(
    'unknown unifies with a concrete type',
    unifyTypes(s, { kind: 'unknown' }, NUMBER),
  )
}

// mismatched concretes do not unify
{
  const s = newSubstitution()
  ok('number does not unify with string', !unifyTypes(s, NUMBER, STRING))
}

// structural unification: arrays, functions, maps
{
  const s = newSubstitution()
  const v = freshType(s)
  ok(
    'arrays unify element-wise',
    unifyTypes(
      s,
      { kind: 'array', element: v },
      { kind: 'array', element: NUMBER },
    ) && resolveType(s, v).kind === 'number',
  )
}

{
  const s = newSubstitution()
  const v = freshType(s)
  const f1: Type = { kind: 'function', params: [v], result: STRING }
  const f2: Type = {
    kind: 'function',
    params: [NUMBER],
    result: STRING,
  }

  ok(
    'functions unify param + result',
    unifyTypes(s, f1, f2) && resolveType(s, v).kind === 'number',
  )
  ok(
    'functions of different arity do not unify',
    !unifyTypes(s, { kind: 'function', params: [], result: STRING }, f2),
  )
}

// the occurs check prevents an infinite type
{
  const s = newSubstitution()
  const v = freshType(s)
  ok(
    'occurs check rejects a self-referential binding',
    !unifyTypes(s, v, { kind: 'array', element: v }),
  )
}

// origin records where a variable was solved (for diagnostics / hover)
{
  const s = newSubstitution()
  const v = freshType(s)
  const span = {
    start: { line: 1, column: 0 },
    end: { line: 1, column: 1 },
  }

  unifyTypesAt(s, v, NUMBER, span)
  ok(
    'origin records the solving span',
    s.origin.get((v as { id: number }).id)?.type.kind === 'number',
  )
}

console.log(`\nsubstitution: ${pass} pass, ${fail} fail`)

if (fail > 0) {process.exit(1)}
