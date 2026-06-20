// Type schemes and the type environment (Hindley-Milner let-polymorphism). Extracted from the inference closure as a
// component of the modular checker. A `Scheme` is a type with some variables generalized (quantified); `Env` maps a
// name to its scheme. `instantiateScheme` freshens a scheme at a use site, `generalize` quantifies the variables free
// in a type but not in the environment (value-restricted), `freeTypeVars` collects a type's free variables.
// See note/seed/plan/compilation-performance.md (Tier 2).

import type { Expression, Type } from '@/code/compile/node'
import type { Substitution } from '@/code/check/substitution'

// a type with some inference variables generalized. Empty `vars` is a plain monomorphic type.
export type Scheme = { vars: Array<number>; type: Type }
// the type environment: a name to its scheme
export type Env = Map<string, Scheme>

// freshen a scheme's quantified variables, so a polymorphic binding can be used at several types
export function instantiateScheme(scheme: Scheme, sub: Substitution): Type {
  if (scheme.vars.length === 0) return scheme.type
  const map = new Map<number, Type>()
  for (const id of scheme.vars) map.set(id, sub.fresh())
  const go = (t: Type): Type => {
    const r = sub.resolve(t)
    if (r.kind === 'variable') return map.get(r.id) ?? r
    if (r.kind === 'array') return { kind: 'array', element: go(r.element) }
    if (r.kind === 'map')
      return { kind: 'map', key: go(r.key), value: go(r.value) }
    if (r.kind === 'function')
      return {
        kind: 'function',
        params: r.params.map(go),
        result: go(r.result),
        effects: r.effects,
      }
    return r
  }
  return go(scheme.type)
}

// collect the free (unbound) inference variables of a type
export function freeTypeVars(
  type: Type,
  into: Set<number>,
  sub: Substitution,
): void {
  const r = sub.resolve(type)
  if (r.kind === 'variable') into.add(r.id)
  else if (r.kind === 'array') freeTypeVars(r.element, into, sub)
  else if (r.kind === 'map') {
    freeTypeVars(r.key, into, sub)
    freeTypeVars(r.value, into, sub)
  } else if (r.kind === 'function') {
    r.params.forEach(p => freeTypeVars(p, into, sub))
    freeTypeVars(r.result, into, sub)
  }
}

// the variables free in `type` but not free anywhere in the environment: those may be generalized
export function generalize(
  type: Type,
  env: Env,
  sub: Substitution,
): Array<number> {
  const inType = new Set<number>()
  freeTypeVars(type, inType, sub)
  const inEnv = new Set<number>()
  for (const scheme of env.values()) {
    const seen = new Set<number>()
    freeTypeVars(scheme.type, seen, sub)
    for (const v of seen) if (!scheme.vars.includes(v)) inEnv.add(v)
  }
  return [...inType].filter(v => !inEnv.has(v))
}

// the value restriction: only a syntactic value may be generalized (so a mutable reference is never over-generalized)
export function isValueExpression(node: Expression): boolean {
  switch (node.form) {
    case 'integer':
    case 'float':
    case 'boolean':
    case 'string':
    case 'unit':
    case 'array':
    case 'map':
    case 'record':
    case 'variable':
    case 'closure':
    case 'hole':
      return true
    default:
      return false
  }
}
