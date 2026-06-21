import fsp from 'fs/promises'
import path from 'path'
import { DeckManifest } from './form'
import { loadManifest } from './manifest'

export async function findWorkspaces(input: {
  root: string
}): Promise<Map<string, DeckManifest>> {
  const workspaces = new Map<string, DeckManifest>()

  const deckDir = path.join(input.root, 'deck')
  try {
    await fsp.access(deckDir)
  } catch {
    return workspaces
  }

  await scanForDecks({ dir: deckDir, workspaces })

  return workspaces
}

async function scanForDecks(input: {
  dir: string
  workspaces: Map<string, DeckManifest>
}): Promise<void> {
  const entries = await fsp.readdir(input.dir, {
    withFileTypes: true,
  })

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === 'node_modules' || entry.name === 'link') continue
    if (entry.name.startsWith('.')) continue

    const subDir = path.join(input.dir, entry.name)
    const deckFile = path.join(subDir, 'deck.tree')

    try {
      await fsp.access(deckFile)
      const manifest = await loadManifest({ dir: subDir })
      const fullName = manifest.host
        ? `@${manifest.host}/${manifest.name}`
        : manifest.name
      input.workspaces.set(fullName, manifest)
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
      if (parent === current) return undefined
      current = parent
    }
  }
}

export function topologicalSort(input: {
  workspaces: Map<string, DeckManifest>
}): Array<string> {
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

  const sorted: Array<string> = []
  const visited = new Set<string>()
  const visiting = new Set<string>()

  function visit(name: string): void {
    if (visited.has(name)) return
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
