// The dev-server module graph (Tier 3, the Vite model). One node per compiled `.tree` module. The `importers` edge
// (who imports me) is what HMR walks upward to find a boundary. The graph is built as a side effect of compiling each
// module: after a module is compiled, its imports are recorded, which adds this module to each dep's importers.
// Pure data structure, no I/O, so it is unit-testable. See note/research/repo/vite/01-module-graph.md.

export interface ModuleNode {
  // the URL the browser requests this module by (the graph's primary key on the wire)
  url: string
  // the canonical id (absolute source path). Stable across URL variants (query strings).
  id: string
  // the source file on disk
  file: string
  // modules that import this one (the upward edge HMR walks)
  importers: Set<ModuleNode>
  // modules this one imports
  importedModules: Set<ModuleNode>
  // URLs this module explicitly accepts hot updates for (dep-accept). A parent zone accepting a child zone.
  acceptedHmrDeps: Set<string>
  // this module accepts updates to itself (a `zone` component is self-accepting)
  isSelfAccepting: boolean
  // the cached compiled JS, or undefined when never compiled / invalidated
  compiled: string | undefined
  // the last time this module was hot-updated (the `?t=` cache-buster the browser re-imports with)
  lastHmrTimestamp: number
  // whether the browser has actually fetched (and so the compiler has compiled) this module. A module known only as a
  // dependency but never loaded is not a valid HMR boundary.
  loaded: boolean
}

export class ModuleGraph {
  private readonly byId = new Map<string, ModuleNode>()
  private readonly byUrl = new Map<string, ModuleNode>()

  getById(id: string): ModuleNode | undefined {
    return this.byId.get(id)
  }

  getByUrl(url: string): ModuleNode | undefined {
    return this.byUrl.get(url)
  }

  // get or create the node for (id, url, file). Idempotent: the same id returns the same node.
  ensure(id: string, url: string, file: string): ModuleNode {
    const existing = this.byId.get(id)

    if (existing) {
      return existing
    }

    const node: ModuleNode = {
      url,
      id,
      file,
      importers: new Set(),
      importedModules: new Set(),
      acceptedHmrDeps: new Set(),
      isSelfAccepting: false,
      compiled: undefined,
      lastHmrTimestamp: 0,
      loaded: false,
    }

    this.byId.set(id, node)
    this.byUrl.set(url, node)

    return node
  }

  // record the imports of `node` (after compiling it). Updates importedModules + the reverse importers edges, and
  // returns any prior deps that lost their last importer (candidates to prune / dispose).
  setImports(node: ModuleNode, deps: ModuleNode[]): ModuleNode[] {
    const next = new Set(deps)
    const pruned: ModuleNode[] = []

    // drop edges to deps no longer imported
    for (const previous of node.importedModules) {
      if (!next.has(previous)) {
        previous.importers.delete(node)

        if (previous.importers.size === 0) {
          pruned.push(previous)
        }
      }
    }

    // add edges to current deps
    for (const dep of next) {
      dep.importers.add(node)
    }

    node.importedModules = next

    return pruned
  }

  // mark a module dirty: clear its compiled output and bump its HMR timestamp. The next request recompiles it, and the
  // new timestamp is the `?t=` the browser re-imports with.
  invalidate(node: ModuleNode, timestamp: number): void {
    node.compiled = undefined
    node.lastHmrTimestamp = timestamp
  }

  // every node, for diagnostics / tests
  nodes(): ModuleNode[] {
    return [...this.byId.values()]
  }
}
