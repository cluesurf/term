// `term note`: what a package says about itself, read from its deck.tree. Prints through the terminal output library
// (code/output.ts) the way the standard's Key-values card does: one `deck` item, the name as its subject and the
// version as a fact, the description as its message, license and authors as fields, and the dependencies as a list
// (section 14).

//
// `term note <deck>` reads the package the slot names (decision cli-in-term/017 part 2): found the way `load <deck>`
// finds it from the project root (the link dir, the in-tree packages, the stdlib, each through resolvePackagePath),
// then the nearest folder above the entry it answers whose deck.tree declares that name. Not the nearest deck.tree
// alone (findProjectRoot): the stdlib's code root holds a module named deck.tree, which is no manifest. Its card
// prints exactly as the root's does.

import { existsSync } from 'fs'
import path from 'path'
import { loadManifest, showCode } from '@cluesurf/deck.tree'
import { linkResolver, siblingResolver, stdlibResolver } from '@term/make/code/resolve'
import { closeRun, count, field, makeItem, openRun, report } from '@term/call/code/output'
import type { ItemField } from '@term/call/code/work/item/event'

// the full name a folder's deck.tree declares, undefined when it has none or it cannot be read as a manifest
async function manifestNameOf(dir: string): Promise<string | undefined> {
  if (!existsSync(path.join(dir, 'deck.tree'))) {
    return undefined
  }

  try {
    const manifest = await loadManifest({ dir })

    return manifest.host ? `@${manifest.host}/${manifest.name}` : manifest.name
  } catch {
    return undefined
  }
}

// the folder of the package a `load <deck>` from the project root reaches, undefined when it reaches none
async function packageDirOf(root: string, deck: string): Promise<string | undefined> {
  const from = path.join(root, 'deck.tree')
  const source = linkResolver(root)(deck, from) ?? siblingResolver()?.(deck, from) ?? stdlibResolver()?.(deck, from)

  if (!source) {
    return undefined
  }

  let dir = path.dirname(source.file)

  for (;;) {
    if ((await manifestNameOf(dir)) === deck) {
      return dir
    }

    const parent = path.dirname(dir)

    if (parent === dir) {
      return undefined
    }

    dir = parent
  }
}

export async function callNote(input: {
  root: string
  deck?: string
}): Promise<void> {
  openRun({ verb: 'note', root: input.root })

  try {
    let dir = input.root

    if (input.deck !== undefined) {
      const found = await packageDirOf(input.root, input.deck)

      if (found === undefined) {
        report({ glyph: 'failed', kind: 'problem', subject: `There is no package named ${input.deck} here` })
        closeRun({ verdict: 'No package to read', next: 'term note, for this package' })

        return
      }

      dir = found
    }

    const manifest = await loadManifest({ dir })
    const fullName = manifest.host
      ? `@${manifest.host}/${manifest.name}`
      : manifest.name

    const fields: ItemField[] = []

    if (manifest.lock) {
      fields.push(field('license', manifest.lock))
    }

    if (manifest.mind && manifest.mind.length > 0) {
      fields.push(field('authors', manifest.mind.map(f => f.name).join(', ')))
    }

    const item = makeItem({
      glyph: 'info',
      verb: 'deck',
      subject: fullName,
      facts: [showCode(manifest.mark)],
      message: manifest.head ? [manifest.head] : [],
      fields,
    })
    item.entries = manifest.link.map(dep => ({ label: dep.name, detail: '' }))
    report(item)

    closeRun({ verdict: `${fullName} read`, counts: [count(manifest.link.length, 'dependencies', 'dependency')] })
  } catch (err) {
    report({ glyph: 'failed', kind: 'problem', subject: err instanceof Error ? err.message : String(err) })
    closeRun({ verdict: 'No package to read', next: 'term wake, to make a package here' })
  }
}
