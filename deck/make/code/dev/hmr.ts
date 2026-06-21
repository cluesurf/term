// HMR propagation (Tier 3, the Vite algorithm). Given a changed module, walk importers upward to find the **boundary**
// modules that can accept the update. A `zone` is self-accepting (handles its own change). A module that explicitly
// accepts a dep (dep-accept) is a boundary for that dep. If any path reaches the top without an accepting module, the
// update cannot be applied in place and the page must full-reload. Pure: takes a graph, returns a decision.
// See note/research/repo/vite/03-hmr-propagation.md and 08-lessons-for-seed.md.

import type {
  ModuleGraph,
  ModuleNode,
} from '@cluesurf/make/code/dev/module-graph'

// one hot update: re-import `accepted` (the changed module's URL) and run the accept callback registered at `boundary`
export interface HmrUpdate {
  boundary: string
  accepted: string
}

export type HmrResult =
  | { type: 'update'; updates: Array<HmrUpdate> }
  | { type: 'full-reload' }

// decide how to apply a change to `changedId`. Returns the set of boundaries to update, or a full reload if any path
// dead-ends. Mirrors Vite's `propagateUpdate`: a self-accepting module is its own boundary, a dep-accepting importer is
// a boundary for the dep, a circular path or a top-level non-accepting module forces a full reload.
export function propagateUpdate(
  graph: ModuleGraph,
  changedId: string,
): HmrResult {
  const changed = graph.getById(changedId)
  // an unknown or never-loaded module cannot be hot-updated in place
  if (!changed || !changed.loaded) return { type: 'full-reload' }

  const boundaries: Array<HmrUpdate> = []
  // returns true if this path is a DEAD END (no accepting boundary found -> full reload)
  const deadEnd = (node: ModuleNode, chain: Array<string>): boolean => {
    if (node.isSelfAccepting) {
      boundaries.push({ boundary: node.url, accepted: node.url })
      return false
    }
    // a non-accepting module with no importers is the top of a path: nothing accepts the change
    if (node.importers.size === 0) return true
    for (const importer of node.importers) {
      // the importer explicitly accepts this dep: it is the boundary for this path
      if (importer.acceptedHmrDeps.has(node.url)) {
        boundaries.push({ boundary: importer.url, accepted: node.url })
        continue
      }
      // a cycle back to a module already on this path cannot be resolved by accept: full reload
      if (chain.includes(importer.id)) return true
      if (deadEnd(importer, [...chain, importer.id])) return true
    }
    return false
  }

  if (deadEnd(changed, [changed.id])) return { type: 'full-reload' }
  // dedupe boundaries (the same boundary can be reached by multiple paths)
  const seen = new Set<string>()
  const updates = boundaries.filter(u => {
    const key = `${u.boundary}\n${u.accepted}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { type: 'update', updates }
}

// the set of modules to invalidate for a change: the changed module plus every module that transitively imports it.
// The dev server clears each one's compiled output so the next request recompiles. Returns ids in no particular order.
export function affectedModules(
  graph: ModuleGraph,
  changedId: string,
): Array<string> {
  const changed = graph.getById(changedId)
  if (!changed) return []
  const affected = new Set<string>([changed.id])
  const stack: Array<ModuleNode> = [changed]
  while (stack.length) {
    const node = stack.pop()!
    for (const importer of node.importers) {
      if (!affected.has(importer.id)) {
        affected.add(importer.id)
        stack.push(importer)
      }
    }
  }
  return [...affected]
}
