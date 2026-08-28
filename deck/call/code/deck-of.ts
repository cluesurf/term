// The deck a source file belongs to: the nearest `deck.tree` up from it, and the `deck <name>` line inside. This is
// what names the `host` of every raise and every roll entry, so the build, the roll and the tests must all use it,
// or the same exception would be `@local/x` in one place and `@term/site/x` in another. Cached per directory,
// because a build asks for every statement of every file.

import { existsSync, readFileSync } from 'fs'
import path from 'path'
import type { DeckOf } from '@term/make/code/compile/roll'

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
        try {
          const manifest = readFileSync(manifestPath, 'utf8')
          const match = /^\s*deck\s+(@[^\s]+)/m.exec(manifest)

          if (match && match[1]) {
            found = { name: match[1], root: at }
            break
          }
        } catch {
          // unreadable: keep walking
        }
      }

      const parent = path.dirname(at)
      at = parent === at ? undefined : parent
    }

    byDir.set(dir, found)

    return found
  }
}
