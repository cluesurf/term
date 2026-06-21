// Dependency-driven incremental scheduling: given a dependency graph and the
// set of nodes that changed, compute exactly which nodes must be rebuilt /
// rechecked (the changed nodes plus everything that transitively depends on
// them) and which can be REUSED from cache. This is the "only recheck what
// depends on what changed" engine.
//
// It is generic over the node id, so it works at any granularity:
//   - PACKAGE level: nodes are packages. Because cross-package dependencies are
//     a DAG (no cross-package cycles - only modules WITHIN a package may be
//     circular), a package is a clean firewall unit, like a Rust crate: a fully
//     compiled package is reused until its own sources or a dependency's
//     INTERFACE change.
//   - MODULE / DEFINITION level: finer-grained early cutoff inside a package.
//
// Pure and deterministic. The graph maps each node to the nodes it DEPENDS ON.

export type DepGraph = Map<string, Set<string>>

/** Invert a dependency graph: node -> the nodes that depend ON it (its dependents). */
export function reverseDeps(graph: DepGraph): DepGraph {
  const reverse: DepGraph = new Map()
  for (const node of graph.keys()) {
    if (!reverse.has(node)) reverse.set(node, new Set())
  }
  for (const [node, deps] of graph) {
    for (const dep of deps) {
      let set = reverse.get(dep)
      if (!set) {
        set = new Set()
        reverse.set(dep, set)
      }
      set.add(node)
    }
  }
  return reverse
}

/**
 * The set that must be rebuilt: every changed node plus everything that
 * transitively depends on it. With EARLY CUTOFF, a dependent is only included
 * if the thing it depends on changed in a way the dependent can observe - pass
 * `interfaceChanged` to stop propagation when a node's INTERFACE is unchanged
 * (a body-only edit), so its dependents are spared.
 */
export function affectedSet(input: {
  graph: DepGraph
  changed: Iterable<string>
  // returns true if `node`'s observable interface changed (so its dependents
  // must recheck). Default: always true (no early cutoff - conservative).
  interfaceChanged?: (node: string) => boolean
}): Set<string> {
  const reverse = reverseDeps(input.graph)
  const interfaceChanged = input.interfaceChanged ?? (() => true)

  const affected = new Set<string>()
  const queue: string[] = []

  // every changed node is itself rebuilt
  for (const node of input.changed) {
    if (!affected.has(node)) {
      affected.add(node)
      queue.push(node)
    }
  }

  while (queue.length > 0) {
    const node = queue.pop()!
    // propagate to dependents ONLY if this node's interface changed (early
    // cutoff). A changed node always rebuilds; its dependents rebuild only if
    // the change is observable across the boundary.
    if (!interfaceChanged(node)) continue
    for (const dependent of reverse.get(node) ?? []) {
      if (!affected.has(dependent)) {
        affected.add(dependent)
        queue.push(dependent)
      }
    }
  }

  return affected
}

/** The nodes that can be REUSED from cache (everything not affected). */
export function reusableSet(graph: DepGraph, affected: Set<string>): Set<string> {
  const reuse = new Set<string>()
  for (const node of graph.keys()) {
    if (!affected.has(node)) reuse.add(node)
  }
  return reuse
}

/**
 * A topological build order (dependencies before dependents). Throws on a
 * cycle - cross-package edges must be acyclic, so a cycle here is a real error
 * (a package depending on something that depends back on it).
 */
export function topoOrder(graph: DepGraph): string[] {
  const order: string[] = []
  const state = new Map<string, 'visiting' | 'done'>()

  const visit = (node: string, trail: string[]): void => {
    const s = state.get(node)
    if (s === 'done') return
    if (s === 'visiting') {
      throw new Error(`dependency cycle: ${[...trail, node].join(' -> ')}`)
    }
    state.set(node, 'visiting')
    for (const dep of graph.get(node) ?? []) visit(dep, [...trail, node])
    state.set(node, 'done')
    order.push(node)
  }

  for (const node of graph.keys()) visit(node, [])
  return order
}

/** Whether the graph is acyclic (a valid cross-package DAG). */
export function isAcyclic(graph: DepGraph): boolean {
  try {
    topoOrder(graph)
    return true
  } catch {
    return false
  }
}
