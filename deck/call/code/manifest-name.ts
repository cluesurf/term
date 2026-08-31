// The package name a `deck.tree` declares, read with the real parser.
//
// There is ONE parser for `.tree` in this codebase. This used to be a regex anchored on a `deck` line, in two places, which is
// a second, worse implementation of the grammar: it reads a `deck` line inside a comment or a text literal as the
// declaration, it cannot see a name written with an interpolation, and it silently disagrees with the compiler about
// what the file says. That is the same shape of bug that made `deck/make/code/compile/load.ts` drop a file's imports
// when a comment held one bare `<`.
//
// A `deck.tree` is a MANIFEST when a top-level `deck` head carries an `@scope/name`. The stdlib also has a code
// module called deck.tree (`form deck`, the manifest's own shape), which has no such statement and correctly reads
// as undefined here.

import { readFileSync } from 'node:fs'
import { parse, renderHead } from '@term/make/code/parser/tree'
import type { GroupNode } from '@term/make/code/parser/tree'

function headName(group: GroupNode): string | undefined {
  const first = group.nodes[0]

  return first?.kind === 'name' ? renderHead(first) : undefined
}

// the first argument of a manifest's `<head>` statement (`deck @term/site` -> `@term/site`, `role ./roles` ->
// `./roles`), or undefined when the manifest has none.
//
// A manifest head sits in one of TWO places, which is the whole reason this is not a one-liner: at the top level
// (`boot ./hook/blog` in deck/site/test/site/deck.tree), or as a CHILD of the `deck` statement, which is where
// `head`, `code`, `lock`, `bear` and `role` are written. The regex this replaced was anchored `^\s*`, so it happened
// to find both and nobody had to think about it; a reader that walked only the top level silently stopped finding
// `role ./roles` and a project's role file went unread. test/compile/host-tools.ts holds that case.
export function manifestValue(
  text: string,
  file: string,
  head: string,
): string | undefined {
  const parsed = parse({ file, text })

  if (!parsed.ok) {
    return undefined
  }

  const argumentOf = (group: GroupNode): string | undefined => {
    const first = group.nodes[1]

    return first?.kind === 'group' ? headName(first) : undefined
  }

  const groups = parsed.tree.nodes.filter(
    (node): node is GroupNode => node.kind === 'group',
  )

  // the `deck` statement's children, then the top level, so the manifest's own block wins when both spell a head
  const deck = groups.find(group => headName(group) === 'deck')
  const nested = deck
    ? deck.nodes
        .slice(1)
        .filter((node): node is GroupNode => node.kind === 'group')
    : []

  for (const group of [...nested, ...groups]) {
    if (headName(group) === head) {
      const value = argumentOf(group)

      if (value !== undefined) {
        return value
      }
    }
  }

  return undefined
}

// the same, read from a file. Unreadable or unparseable is undefined, the way a missing manifest is.
export function manifestValueOf(
  file: string,
  head: string,
): string | undefined {
  try {
    return manifestValue(readFileSync(file, 'utf8'), file, head)
  } catch {
    return undefined
  }
}

// the `@scope/name` a manifest declares. A `deck.tree` is a MANIFEST only when its `deck` head carries an
// `@scope/name`: the stdlib's own deck.tree is a code module (`form deck`, the manifest's shape) and correctly
// reads as undefined.
export function manifestNameOf(file: string): string | undefined {
  const name = manifestValueOf(file, 'deck')

  return name?.startsWith('@') ? name : undefined
}
