// The deck a source file belongs to: the nearest `deck.tree` up from it, and the `deck <name>` line inside. This is
// what names the `host` of every raise and every roll entry, so the build, the roll and the tests must all use it,
// or the same exception would be `@local/x` in one place and `@term/site/x` in another. Cached per directory,
// because a build asks for every statement of every file.

import { existsSync, readFileSync } from 'fs'
import path from 'path'
import type { DeckOf } from '@term/make/code/compile/roll'
import { manifestNameOf } from '@term/call/code/manifest-name'

export function projectDeckOf(): DeckOf {
  const byDir = new Map<string, { name: string; root: string } | undefined>()

  return file => {
    const dir = path.dirname(file)

    if (byDir.has(dir)) {
      return byDir.get(dir)
    }

    // walk up. A `deck.tree` that is a MANIFEST opens with `deck @scope/name`; the stdlib also has a code module
    // named deck.tree (`form deck`, the manifest's own shape), which is skipped because it has no such line.
    let found: { name: string; root: string } | undefined
    let at: string | undefined = dir

    while (at) {
      const manifestPath = path.join(at, 'deck.tree')

      if (existsSync(manifestPath)) {
        const name = manifestNameOf(manifestPath)

        if (name) {
          found = { name, root: at }
          break
        }
      }

      const parent = path.dirname(at)
      at = parent === at ? undefined : parent
    }

    byDir.set(dir, found)

    return found
  }
}
