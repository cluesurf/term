// Dev HMR test: the module graph (importer edges, prune detection) and the propagation algorithm (self-accept,
// dep-accept, bubble-to-ancestor, dead-end full-reload, cycles). Pure, no server. Run: npx tsx test/dev/hmr.ts

import { ModuleGraph } from '@term/make/code/dev/module-graph'
import type { ModuleNode } from '@term/make/code/dev/module-graph'
import {
  propagateUpdate,
  affectedModules,
} from '@term/make/code/dev/hmr'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

// a node, loaded, optionally a self-accepting zone
function node(
  graph: ModuleGraph,
  name: string,
  view = false,
): ModuleNode {
  const n = graph.ensure(
    `/${name}.tree`,
    `/${name}.tree`,
    `/${name}.tree`,
  )

  n.loaded = true
  n.isSelfAccepting = zone

  return n
}

// ---- module graph ----
{
  const g = new ModuleGraph()
  const a = node(g, 'a')
  ok(
    'graph: ensure is idempotent',
    g.ensure('/a.tree', '/a.tree', '/a.tree') === a,
  )

  const helper = node(g, 'helper')
  g.setImports(a, [helper])
  ok(
    'graph: setImports adds the reverse importer edge',
    helper.importers.has(a),
  )
  ok(
    'graph: setImports records imported modules',
    a.importedModules.has(helper),
  )

  const pruned = g.setImports(a, [])
  ok(
    'graph: dropping the last importer prunes the dep',
    pruned.length === 1 && pruned[0] === helper,
  )
  ok(
    'graph: pruned dep has no importers left',
    helper.importers.size === 0,
  )
}

// ---- propagation ----

// root (plain) -> zone -> helper
function appGraph(): {
  g: ModuleGraph
  root: ModuleNode
  zone: ModuleNode
  helper: ModuleNode
} {
  const g = new ModuleGraph()
  const root = node(g, 'root')
  const zone = node(g, 'zone', true)
  const helper = node(g, 'helper')
  g.setImports(root, [zone])
  g.setImports(zone, [helper])

  return { g, root, zone, helper }
}

{
  const { g, zone } = appGraph()
  const r = propagateUpdate(g, zone.id)
  ok(
    'hmr: editing a zone updates that zone (self-accept)',
    r.type === 'update' &&
      r.updates.length === 1 &&
      r.updates[0]!.boundary === zone.url &&
      r.updates[0]!.accepted === zone.url,
    JSON.stringify(r),
  )
}

{
  const { g, zone, helper } = appGraph()
  const r = propagateUpdate(g, helper.id)
  ok(
    'hmr: editing a helper bubbles to the importing zone (re-import the zone)',
    r.type === 'update' &&
      r.updates.length === 1 &&
      r.updates[0]!.boundary === zone.url &&
      r.updates[0]!.accepted === zone.url,
    JSON.stringify(r),
  )
}

{
  // a helper imported only by a non-accepting root: no self-accepting ancestor -> full reload
  const g = new ModuleGraph()
  const root = node(g, 'root')
  const orphan = node(g, 'orphan')
  g.setImports(root, [orphan])

  const r = propagateUpdate(g, orphan.id)
  ok(
    'hmr: a change with no accepting ancestor is a full reload',
    r.type === 'full-reload',
    JSON.stringify(r),
  )
}

{
  // dep-accept: the root explicitly accepts the dep -> boundary is the root, re-import the dep
  const g = new ModuleGraph()
  const root = node(g, 'root')
  const dep = node(g, 'dep')
  g.setImports(root, [dep])
  root.acceptedHmrDeps.add(dep.url)

  const r = propagateUpdate(g, dep.id)
  ok(
    'hmr: dep-accept makes the accepting importer the boundary',
    r.type === 'update' &&
      r.updates.length === 1 &&
      r.updates[0]!.boundary === root.url &&
      r.updates[0]!.accepted === dep.url,
    JSON.stringify(r),
  )
}

{
  // a cycle of non-accepting modules -> full reload
  const g = new ModuleGraph()
  const a = node(g, 'a')
  const b = node(g, 'b')
  g.setImports(a, [b])
  g.setImports(b, [a])

  const r = propagateUpdate(g, a.id)
  ok(
    'hmr: a non-accepting cycle is a full reload',
    r.type === 'full-reload',
    JSON.stringify(r),
  )
}

{
  const g = new ModuleGraph()
  const a = g.ensure('/a.tree', '/a.tree', '/a.tree') // not loaded
  const r = propagateUpdate(g, a.id)
  ok(
    'hmr: a never-loaded module is a full reload',
    r.type === 'full-reload',
    JSON.stringify(r),
  )
}

{
  const { g, root, zone, helper } = appGraph()
  const affected = affectedModules(g, helper.id).sort()
  ok(
    'hmr: affectedModules includes the change + all transitive importers',
    affected.join(',') ===
      [helper.id, zone.id, root.id].sort().join(','),
    affected.join(','),
  )
}

console.log(`\ndev/hmr: ${pass} pass, ${fail} fail`)

if (fail > 0) {process.exit(1)}
