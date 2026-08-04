// Type resolution helpers ("zonking"): deeply follow a type's inference variables to its final form. Extracted from
// the inference closure as a component of the modular checker. `zonk` resolves to concrete types; `zonkGeneric` maps
// a function's still-unsolved variables back to their declared generic names (so a generic emits `<T>(x: T): T`);
// `substGenerics` substitutes a form's generic names with concrete types (pure, no substitution needed).
// See note/seed/plan/compilation-performance.md (Tier 2).

import type { Type } from '@term/make/code/compile/node'
import type { Substitution } from '@term/make/code/check/substitution'

// deeply resolve a type (so array<var> becomes array<concrete> for nice output)
export function zonk(type: Type, sub: Substitution): Type {
  const t = sub.resolve(type)

  if (t.kind === 'array') {
    return { kind: 'array', element: zonk(t.element, sub) }
  }

  if (t.kind === 'map') {
    return {
      kind: 'map',
      key: zonk(t.key, sub),
      value: zonk(t.value, sub),
    }
  }

  if (t.kind === 'function') {
    return {
      kind: 'function',
      params: t.params.map(p => zonk(p, sub)),
      result: zonk(t.result, sub),
      effects: t.effects,
      paramNames: t.paramNames,
    }
  }

  if (t.kind === 'named' && (t.args || t.valueArgs)) {
    return {
      kind: 'named',
      name: t.name,
      ...(t.args ? { args: t.args.map(a => zonk(a, sub)) } : {}),
      // value-index arguments (an indexed family `vec a n`) are kept verbatim: they are expressions, not types, so the
      // type substitution does not touch them.
      ...(t.valueArgs ? { valueArgs: t.valueArgs } : {}),
    }
  }

  return t
}

// deeply resolve, mapping a function's still-unsolved generic variables back to their declared names
export function zonkGeneric(
  type: Type,
  names: Map<number, string>,
  sub: Substitution,
): Type {
  const r = sub.resolve(type)

  if (r.kind === 'variable') {
    const name = names.get(r.id)

    return name ? { kind: 'named', name } : r
  }

  if (r.kind === 'array') {
    return {
      kind: 'array',
      element: zonkGeneric(r.element, names, sub),
    }
  }

  if (r.kind === 'map') {
    return {
      kind: 'map',
      key: zonkGeneric(r.key, names, sub),
      value: zonkGeneric(r.value, names, sub),
    }
  }

  if (r.kind === 'function') {
    return {
      kind: 'function',
      params: r.params.map(t => zonkGeneric(t, names, sub)),
      result: zonkGeneric(r.result, names, sub),
      effects: r.effects,
      paramNames: r.paramNames,
    }
  }

  if (r.kind === 'named' && (r.args || r.valueArgs)) {
    return {
      kind: 'named',
      name: r.name,
      ...(r.args
        ? { args: r.args.map(t => zonkGeneric(t, names, sub)) }
        : {}),
      ...(r.valueArgs ? { valueArgs: r.valueArgs } : {}),
    }
  }

  return r
}

// substitute a form's generic names with concrete types (e.g. maybe's `t` -> the subject's element type). Pure.
export function substGenerics(
  type: Type,
  map: Map<string, Type>,
): Type {
  if (type.kind === 'named') {
    const direct = map.get(type.name)

    if (direct && (!type.args || type.args.length === 0)) {
      return direct
    }

    return {
      kind: 'named',
      name: type.name,
      args: type.args?.map(a => substGenerics(a, map)),
    }
  }

  if (type.kind === 'array') {
    return { kind: 'array', element: substGenerics(type.element, map) }
  }

  if (type.kind === 'map') {
    return {
      kind: 'map',
      key: substGenerics(type.key, map),
      value: substGenerics(type.value, map),
    }
  }

  if (type.kind === 'function') {
    return {
      kind: 'function',
      params: type.params.map(p => substGenerics(p, map)),
      result: substGenerics(type.result, map),
      effects: type.effects,
      paramNames: type.paramNames,
    }
  }

  return type
}
