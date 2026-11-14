// The deck a source file belongs to: the nearest `deck.tree` up from it, and the `deck <name>` line inside. This is
// what names the `host` of every raise and every roll entry, so the build, the roll and the tests must all use it,
// or the same exception would be `@local/x` in one place and `@term/site/x` in another. Cached per directory,
// because a build asks for every statement of every file.
//
// It also carries the manifest's `mark`, the version a console the compiler lowers answers `--version` with, read by
// the one mark reader a booted console reads through (work/small/manifest-mark.tree, item term-self-host-001-1173).
// The mark is read only when a reader asks for it: only a console's lowering does. It is the mark of the nearest deck
// whose manifest's `line` names the file's directory, else the deck's own (term/compiler decision 018).

import { existsSync, readFileSync } from 'fs'
import path from 'path'
import type { DeckOf } from '@term/make/code/compile/roll'
import { manifestName } from '@term/call/code/manifest-name'
import { manifestLineOf, manifestMark } from '@term/call/code/work/small/manifest-mark'

type Deck = { name: string; root: string; readonly mark: string }

// THE MARK A CONSOLE LOWERED FROM `dir` SHOWS (term/compiler decision 018, as work/build/deck-finding.tree
// console-mark-at answers it): the mark of the nearest deck at or above `dir` whose manifest's `line` names `dir`,
// undefined when none does (then the directory's own deck's mark stands)
function lineMarkOf(dir: string, lines: Map<string, string>): string | undefined {
  const target = path.resolve(dir)
  let at: string | undefined = target

  while (at) {
    let named = lines.get(at)

    if (named === undefined) {
      const manifestPath = path.join(at, 'deck.tree')
      const written = existsSync(manifestPath) ? manifestLineOf(manifestPath) : ''
      named = written ? path.resolve(at, written) : ''
      lines.set(at, named)
    }

    if (named === target) {
      try {
        return manifestMark(readFileSync(path.join(at, 'deck.tree'), 'utf8'))
      } catch {
        return ''
      }
    }

    const parent = path.dirname(at)
    at = parent === at ? undefined : parent
  }

  return undefined
}

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
  const lines = new Map<string, string>()

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
          const own = deckOfManifest(manifest.name, at, manifest.text)
          let mark: string | undefined

          // this directory's answer: the deck's name and root, and the mark a console lowered from here shows, read
          // on first ask
          found = {
            name: own.name,
            root: own.root,
            get mark() {
              mark ??= lineMarkOf(dir, lines) ?? own.mark

              return mark
            },
          }
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
