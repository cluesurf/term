// The resolved dependency graph, read from the lockfile (`lock.tree`) plus the manifest (`deck.tree`). The lockfile
// pins one exact version per package and records each package's own dependency edges (`link`), so we can walk the
// full direct-plus-transitive set, mark which are direct, and record the shortest path from the root to each node
// (for reporting "you depend on X because A -> B -> X"). This is the graph the advisory matcher runs over.

import type { DependencyNode } from './form'
import {
  loadLockfile,
  loadManifest,
  showCode,
  toRegistryName,
  toTreeName,
} from '@cluesurf/deck.tree'

// read the graph for the project rooted at `root`. Returns an empty list when there is no lockfile (nothing pinned
// to audit). Direct dependencies come from the manifest's `link`; transitive edges come from each lock entry's
// `link`. A missing manifest is tolerated (every locked package is then treated as potentially direct).
export async function readDependencyGraph(
  root: string,
): Promise<DependencyNode[]> {
  const lockfile = await loadLockfile({ dir: root })

  if (!lockfile || lockfile.decks.length === 0) {
    return []
  }

  const manifest = await loadManifest({ dir: root }).catch(() => undefined)

  // exact version per locked package, by tree name
  const versionOf = new Map<string, string>()
  // dependency edges per package (tree names), from the lockfile
  const edgesOf = new Map<string, string[]>()

  for (const entry of lockfile.decks) {
    const treeName = toTreeName({ name: entry.name })
    versionOf.set(treeName, showCode(entry.code))
    edgesOf.set(
      treeName,
      entry.link.map(l => toTreeName({ name: l.name })),
    )
  }

  const directNames = new Set<string>(
    (manifest?.link ?? []).map(l => toTreeName({ name: l.name })),
  )

  // BFS from the direct dependencies, recording the shortest path to each node
  const roots = manifest
    ? [...directNames]
    : // no manifest: seed from every locked package so nothing is missed
      [...versionOf.keys()]

  const pathOf = new Map<string, string[]>()
  const queue: string[] = []

  for (const name of roots) {
    if (versionOf.has(name) && !pathOf.has(name)) {
      pathOf.set(name, [name])
      queue.push(name)
    }
  }

  while (queue.length > 0) {
    const name = queue.shift()!
    const here = pathOf.get(name)!

    for (const dep of edgesOf.get(name) ?? []) {
      if (versionOf.has(dep) && !pathOf.has(dep)) {
        pathOf.set(dep, [...here, dep])
        queue.push(dep)
      }
    }
  }

  const nodes: DependencyNode[] = []

  for (const [name, version] of versionOf) {
    const nodePath = pathOf.get(name) ?? [name]

    nodes.push({
      name,
      registryName: toRegistryName({ name }),
      version,
      direct: directNames.has(name) || !manifest,
      path: nodePath,
    })
  }

  return nodes
}
