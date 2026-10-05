import fsp from 'fs/promises'
import path from 'path'
import { DeckManifest } from './form'
import { loadManifest } from './manifest'

// each deck under the project's `deck/` folder by its name, with the folder that holds it
export type Workspace = DeckManifest & { dir: string }

/**
 * The decks a project resolves from the folder it is in, rather than from a registry: the WORKSPACE.
 *
 * A workspace is a folder holding a `deck.tree` and a `deck/` folder of member decks, each with its own `deck.tree`:
 * the Term repository is one, `deck/term/deck/term/` with `deck/base`, `deck/make` and the rest. Two places count:
 *
 *   1  the project's own `deck/` folder, when it is a workspace root (`term load` run at the top)
 *   2  the nearest workspace the project is a MEMBER of, found walking up (`term load` run inside `deck/face`), so a
 *      member's `link` to a sibling installs the sibling's source, as it builds, and never fetches a version of it
 *      the registry may not even hold yet
 *
 * The project's own decks win over the enclosing workspace's on a name both hold. A member found here is still
 * resolved only when its `mark` satisfies the `link` (resolve.ts), so a sibling at the wrong version is fetched.
 */
export async function findWorkspaces(input: {
  root: string
}): Promise<Map<string, Workspace>> {
  const workspaces = new Map<string, Workspace>()
  const enclosing = await enclosingWorkspace(input.root)

  if (enclosing) {
    await scanForDecks({ dir: path.join(enclosing, 'deck'), workspaces })
  }

  const own = path.join(input.root, 'deck')

  try {
    await fsp.access(own)
    await scanForDecks({ dir: own, workspaces })
  } catch {
    // no `deck/` folder of its own
  }

  return workspaces
}

// The nearest folder above `root` that holds a `deck.tree` and whose `deck/` folder contains `root`
async function enclosingWorkspace(root: string): Promise<string | undefined> {
  let current = path.resolve(root)

  while (true) {
    const parent = path.dirname(current)

    if (parent === current) {
      return undefined
    }

    if (path.basename(current) === 'deck') {
      try {
        await fsp.access(path.join(parent, 'deck.tree'))

        return parent
      } catch {
        // a `deck/` folder of something that is not a workspace: keep walking
      }
    }

    current = parent
  }
}

async function scanForDecks(input: {
  dir: string
  workspaces: Map<string, Workspace>
}): Promise<void> {
  const entries = await fsp.readdir(input.dir, {
    withFileTypes: true,
  })

  for (const entry of entries) {
    if (!entry.isDirectory()) {continue}

    if (entry.name === 'node_modules' || entry.name === 'link') {continue}

    if (entry.name.startsWith('.')) {continue}

    const subDir = path.join(input.dir, entry.name)
    const deckFile = path.join(subDir, 'deck.tree')

    try {
      await fsp.access(deckFile)

      const manifest = await loadManifest({ dir: subDir })
      const fullName = manifest.host
        ? `@${manifest.host}/${manifest.name}`
        : manifest.name

      input.workspaces.set(fullName, { ...manifest, dir: subDir })
    } catch {
      // no deck.tree, scan deeper
      await scanForDecks({ dir: subDir, workspaces: input.workspaces })
    }
  }
}

export async function findProjectRoot(input: {
  dir: string
}): Promise<string | undefined> {
  let current = input.dir

  while (true) {
    const deckFile = path.join(current, 'deck.tree')

    try {
      await fsp.access(deckFile)

      return current
    } catch {
      const parent = path.dirname(current)

      if (parent === current) {return undefined}

      current = parent
    }
  }
}

export function topologicalSort(input: {
  workspaces: Map<string, DeckManifest>
}): string[] {
  const graph = new Map<string, Set<string>>()
  const allNames = new Set(input.workspaces.keys())

  for (const [name, manifest] of input.workspaces) {
    const deps = new Set<string>()

    for (const link of manifest.link) {
      if (allNames.has(link.name)) {
        deps.add(link.name)
      }
    }

    graph.set(name, deps)
  }

  const sorted: string[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>()

  function visit(name: string): void {
    if (visited.has(name)) {return}

    if (visiting.has(name)) {
      console.warn(`Circular dependency detected: ${name}`)

      return
    }

    visiting.add(name)

    const deps = graph.get(name)

    if (deps) {
      for (const dep of deps) {
        visit(dep)
      }
    }

    visiting.delete(name)
    visited.add(name)
    sorted.push(name)
  }

  for (const name of allNames) {
    visit(name)
  }

  return sorted
}
