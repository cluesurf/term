// The texts of the AST's types and literals: a type as a person reads it (`showType`), a type as a key (`typeKey`),
// and an integer literal as a backend writes it (`integerText`).
//
// Moved out of compile/node.ts on 2026-10-05, when node.ts became the AST's types alone, ported to Term as
// compile/node.tree. These read OPTIONAL fields (a named type's `args`, a function type's `effects`, a literal's
// `digits`), and Term has no settled reading of one yet: natively an absent `need false` field is its type's empty
// value, stored in the record, while on TypeScript it is `undefined` (note/term/self-host/log.md). They port once
// that is decided.

import type { Type } from '@term/make/code/compile/node'

// the text a backend writes for an integer literal: its exact digits past 2^53, else its number
export function integerText(node: { value: number; digits?: string }): string {
  return node.digits ?? String(node.value)
}

// A type as a person reads it, in Term's own words: `text`, `void`, `list, like number`, `hash, like text, like
// number`. Every diagnostic, `term roll`, `term look` and the language server print through this. It printed the
// checker's internal names until 2026-10-04 (`string`, `unit`, `number[]`, `map<string, number>`), which a reader
// had to translate back into what they wrote (guides: types, basics/tour, commands/roll).
//
// A type argument the checker has not solved is left off, the way `like list` with nothing after it leaves the
// element open, so a list built in the call itself prints `list`, not `?2[]`. Alone it is `an unsolved type`.
export function showType(type: Type): string {
  return type.kind === 'variable' ? 'an unsolved type' : spell(type)
}

// one type in a `like` chain. A compound argument inside a task's parentheses is wrapped again, so its commas
// cannot be read as the task's
function spell(type: Type): string {
  switch (type.kind) {
    case 'string':
      return 'text'
    case 'unit':
      return 'void'
    case 'array':
      return chain('list', [type.element])
    case 'map':
      return chain('hash', [type.key, type.value])
    case 'named':
      return chain(type.name, type.args ?? [])
    case 'function': {
      const params = type.params.map(p => {
        const written = spell(p)

        return written.includes(',') ? `(${written})` : written
      })
      const effects =
        type.effects && type.effects.length > 0
          ? ` !${type.effects.join(',')}`
          : ''

      return `task(${params.join(', ')}) -> ${spell(type.result)}${effects}`
    }
    case 'variable':
      return 'unknown'
    default:
      return typeKey(type)
  }
}

// `list, like text`: the head, then each SOLVED argument after a `like`
function chain(head: string, args: Type[]): string {
  const solved = args.every(a => a.kind !== 'variable') ? args : []

  return [head, ...solved.map(a => `like ${spell(a)}`)].join(', ')
}

// A type as a KEY: exact and structural, so two types print alike only when they are alike. An unsolved variable
// keeps its number here (`?3[]` and `?7[]` are two lists), which is what an overload's shape compares
// (check/overload.ts). Never shown to a person: that is showType.
export function typeKey(type: Type): string {
  switch (type.kind) {
    case 'number':
      return 'number'
    case 'float':
      return 'float'
    case 'dynamic':
      return 'dynamic'
    case 'bytes':
      return 'bytes'
    case 'boolean':
      return 'boolean'
    case 'string':
      return 'string'
    case 'unit':
      return 'unit'
    case 'unknown':
      return 'unknown'
    case 'array':
      return `${typeKey(type.element)}[]`
    case 'map':
      return `map<${typeKey(type.key)}, ${typeKey(type.value)}>`
    case 'named':
      return type.args && type.args.length > 0
        ? `${type.name}<${type.args.map(typeKey).join(', ')}>`
        : type.name

    case 'function': {
      const effects =
        type.effects && type.effects.length > 0
          ? ` !${type.effects.join(',')}`
          : ''

      return `(${type.params.map(typeKey).join(', ')}) -> ${typeKey(
        type.result,
      )}${effects}`
    }

    case 'variable':
      return `?${type.id}`
  }
}
