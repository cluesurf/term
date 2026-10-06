// TRANSPARENT ALIASES: a form with nothing of its own but a `like`, which IS the type it names. `form assignment / like
// task / take n, like natural / like flag` is a task from naturals to flags, called as one, and `form set / head a /
// like task / take x, like a / like flag` is the same for every type `a`, so `like set natural` is a task from naturals.
//
// Two readers see through them, and both read them here so they cannot disagree: the checker when it unifies and calls
// (check/infer.ts `unfoldAlias`) and the kernel when it reads a type (check/elaborate.ts `kernelTypeAt`).

import type { Program, Type } from '@term/make/code/compile/node'

export type TypeAlias = {
  // the type parameters, `head a`, in order
  params: string[]
  type: Type
}

// every transparent alias the program declares, by name
export function transparentAliases(program: Program): Map<string, TypeAlias> {
  const aliases = new Map<string, TypeAlias>()

  for (const statement of program) {
    if (
      statement.form === 'record-type' &&
      statement.alias &&
      statement.fields.length === 0 &&
      statement.variants.length === 0 &&
      !statement.indices?.length
    ) {
      aliases.set(statement.name, { params: statement.params, type: statement.alias })
    }
  }

  return aliases
}

// what a use of an alias stands for: `found` false, and the type as written, when it is no alias
export type AliasFound = {
  found: boolean
  type: Type
}

// the type a use of an alias stands for, its parameters replaced by the arguments written (`set natural`), or not
// found when the type is no alias or is applied to the wrong number of arguments
export function throughAlias(type: Type, aliases: ReadonlyMap<string, TypeAlias>): AliasFound {
  const missing = { found: false, type }

  if (type.kind !== 'named' || type.valueArgs?.length) {
    return missing
  }

  const alias = aliases.get(type.name)
  const args = type.args ?? []

  if (!alias || args.length !== alias.params.length) {
    return missing
  }

  const given = new Map(alias.params.map((param, at) => [param, args[at]!]))

  return { found: true, type: given.size === 0 ? alias.type : (replaced(alias.type, given) as Type) }
}

// a type with each named parameter replaced by its argument, everywhere it stands
function replaced(node: unknown, given: ReadonlyMap<string, Type>): unknown {
  if (Array.isArray(node)) {
    return node.map(item => replaced(item, given))
  }

  if (node === null || typeof node !== 'object') {
    return node
  }

  const record = node as Record<string, unknown>

  if (record.kind === 'named' && typeof record.name === 'string' && given.has(record.name) && !(record.args as unknown[] | undefined)?.length) {
    return given.get(record.name)
  }

  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, key === 'span' ? value : replaced(value, given)]))
}
