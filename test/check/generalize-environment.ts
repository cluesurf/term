// generalize keeps a variable the environment holds inside a form's arguments (D10, D027 row 7). An environment
// binding typed `maybe ?a` (a form over the type variable a) mentions a, so a type that mentions a must leave a free:
// quantifying it would give every use a fresh copy that never reaches the `maybe`'s. The retired original gathered
// the environment with free-type-vars, which skips a form's arguments, and generalized a away (unsound).
// Run: npx tsx test/check/generalize-environment.ts
// Against another implementation: npx tsx test/check/generalize-environment.ts <module path>, such as
// ./tmp/retired/make/check/scheme.ts, which fails.

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { freshType, newSubstitution } from '@term/make/code/check/substitution'
import type { Type } from '@term/make/code/compile/node'

type Scheme = { vars: number[]; type: Type }
type Generalize = (type: Type, env: Map<string, Scheme>, sub: unknown) => number[]

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

async function main(): Promise<void> {
  const other = process.argv[2]
  const scheme = (
    other === undefined
      ? await import('@term/make/code/check/scheme')
      : await import(pathToFileURL(resolve(other)).href)
  ) as { generalize: Generalize }

  // the environment holds `maybe ?a`: a occurs only inside a form's arguments
  {
    const sub = newSubstitution()
    const a = freshType(sub) as Type & { id: number }
    const b = freshType(sub) as Type & { id: number }
    const env = new Map<string, Scheme>([['found', { vars: [], type: { kind: 'named', name: 'maybe', args: [a] } as Type }]])
    const given: Type = { kind: 'function', params: [a, b], result: a } as Type
    const out = scheme.generalize(given, env, sub)

    ok('a variable held in a form argument stays free', !out.includes(a.id), `generalized ${JSON.stringify(out)}`)
    ok('a variable the environment does not hold is generalized', out.includes(b.id), `generalized ${JSON.stringify(out)}`)
  }

  // deeper: the form's argument is itself a list of a function returning a
  {
    const sub = newSubstitution()
    const a = freshType(sub) as Type & { id: number }
    const inner: Type = { kind: 'array', element: { kind: 'function', params: [], result: a } } as Type
    const env = new Map<string, Scheme>([['found', { vars: [], type: { kind: 'named', name: 'pair', args: [{ kind: 'number' }, inner] } as Type }]])
    const out = scheme.generalize(a, env, sub)

    ok('a variable nested under a form argument stays free', out.length === 0, `generalized ${JSON.stringify(out)}`)
  }

  // a variable the binding's own scheme quantifies is not the environment's
  {
    const sub = newSubstitution()
    const a = freshType(sub) as Type & { id: number }
    const env = new Map<string, Scheme>([['id', { vars: [a.id], type: { kind: 'named', name: 'maybe', args: [a] } as Type }]])
    const out = scheme.generalize(a, env, sub)

    ok('a quantified variable in the environment does not hold', out.length === 1 && out[0] === a.id, `generalized ${JSON.stringify(out)}`)
  }

  console.log(`\ngeneralize-environment: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exitCode = 1
  }
}

void main()
