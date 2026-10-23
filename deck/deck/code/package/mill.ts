// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): the exports deck/deck/code/mill.ts had, with
// their shapes, answered by deck/deck/code/package/grammar-reading.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
import type { DeckManifest, Lockfile, RoleConfig } from '@term/deck/code/form'
import * as grammarReading from '@term/deck/code/package/grammar-reading'
import { GRAMMARS, refusedNow } from './grammars'
import { code, fromPort } from './manifest'

export function parseManifestMill(input: { text: string }): DeckManifest {
  return fromPort(refusedNow(() => grammarReading.parseManifestMill(input.text, GRAMMARS)) as never)
}

export function parseRoleMill(input: { text: string; root: string; expand: (pattern: string, root: string) => string }): RoleConfig {
  return refusedNow(() => grammarReading.parseRoleMill(input.text, input.root, input.expand, GRAMMARS)) as never
}

export function parseLockfileMill(input: { text: string }): Lockfile {
  const lock = refusedNow(() => grammarReading.parseLockfileMill(input.text, GRAMMARS)) as never as Lockfile

  return {
    ...lock,
    decks: lock.decks.map(entry => ({ ...entry, code: code(entry.code as never) })),
    ...(lock.need ? { need: { ...lock.need, code: code(lock.need.code as never) } } : {}),
  }
}
