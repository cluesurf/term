// The deck a source file belongs to: the nearest `deck.tree` up from it, and the `deck <name>` line inside. This is
// what names the `host` of every raise and every roll entry, so the build, the roll and the tests must all use it,
// or the same exception would be `@local/x` in one place and `@term/site/x` in another. Cached per directory,
// because a build asks for every statement of every file.
//
// It also carries the manifest's `mark`, the version a console the compiler lowers answers `--version` with, read by
// the one mark reader a booted console reads through (work/small/manifest-mark.tree, item term-self-host-001-1173).
// The mark is read from the text the name was read from, and only when a reader asks for it: only a console's
// lowering does.

import { existsSync, readFileSync } from 'fs'
import path from 'path'
import type { DeckOf } from '@term/make/code/compile/roll'
import { manifestName } from '@term/call/code/manifest-name'
import { manifestMark } from '@term/call/code/work/small/manifest-mark'

type Deck = { name: string; root: string; readonly mark: string }

// a manifest's deck, its mark read on first ask and kept
function deckOfManifest(name: string, root: string, text: string): Deck {
  let mark: string | undefined

  return {
    name,
    root,
    get mark() {
      mark ??= manifestMark(text)

      return mark
    },
  }
}

// a manifest's text and the name it declares, or undefined when it cannot be read or declares none (as
// manifest-name.ts `manifestNameOf` answers)
function manifestAt(file: string): { name: string; text: string } | undefined {
  try {
    const text = readFileSync(file, 'utf8')
    const name = manifestName(text, file)

    return name ? { name, text } : undefined
  } catch {
    return undefined
  }
}

export function projectDeckOf(): DeckOf {
  const byDir = new Map<string, Deck | undefined>()

  return file => {
    const dir = path.dirname(file)

    if (byDir.has(dir)) {
      return byDir.get(dir)
    }

    // walk up. A `deck.tree` that is a MANIFEST has a top-level `deck <name>` (scoped or not); the stdlib also has a code module
    // named deck.tree (`form deck`, the manifest's own shape), which is skipped because it has no such line.
    let found: Deck | undefined
    let at: string | undefined = dir

    while (at) {
      const manifestPath = path.join(at, 'deck.tree')

      if (existsSync(manifestPath)) {
        const manifest = manifestAt(manifestPath)

        if (manifest) {
          found = deckOfManifest(manifest.name, at, manifest.text)
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
