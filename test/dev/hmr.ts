// Dev HMR test: the module graph (importer edges, prune detection) and the propagation algorithm (self-accept,
// dep-accept, bubble-to-ancestor, dead-end full-reload, cycles). Pure, no server. Run: npx tsx test/dev/hmr.ts
//
// Both modules are Term since 2026-10-04 (deck/make/code/dev/module-graph.tree and hmr.tree). A node names its
// neighbours by id, and every change hands the graph back, so the test threads `g` through each step.

import {
  ensureModule,
  makeModuleGraph,
  moduleById,
  putModule,
  setImports,
} from '@term/make/code/dev/module-graph'
import type { ModuleGraph } from '@term/make/code/dev/module-graph'
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

// a node, loaded, optionally self-accepting. Its id and url are both `/<name>.tree`
function node(graph: ModuleGraph, name: string, selfAccepting = false): ModuleGraph {
  const id = `/${name}.tree`
  const g = ensureModule(graph, id, id, id)

  return putModule(g, { ...moduleById(g, id), loaded: true, isSelfAccepting: selfAccepting })
}

const id = (name: string): string => `/${name}.tree`

// ---- module graph ----
{
  let g = node(makeModuleGraph(), 'a')
  const before = moduleById(g, id('a'))
  g = ensureModule(g, id('a'), id('a'), id('a'))
  ok(
    'graph: ensure is idempotent',
    JSON.stringify(moduleById(g, id('a'))) === JSON.stringify(before),
  )

  g = node(g, 'helper')
  g = setImports(g, id('a'), [id('helper')]).graph
  ok(
    'graph: setImports adds the reverse importer edge',
    moduleById(g, id('helper')).importers.includes(id('a')),
  )
  ok(
    'graph: setImports records imported modules',
    moduleById(g, id('a')).importedModules.includes(id('helper')),
  )

  const change = setImports(g, id('a'), [])
  g = change.graph
  ok(
    'graph: dropping the last importer prunes the dep',
    change.pruned.length === 1 && change.pruned[0] === id('helper'),
  )
  ok(
    'graph: pruned dep has no importers left',
    moduleById(g, id('helper')).importers.length === 0,
  )
}

// ---- propagation ----

// root (plain) -> zone -> helper
function appGraph(): ModuleGraph {
  let g = makeModuleGraph()
  g = node(g, 'root')
  g = node(g, 'zone', true)
  g = node(g, 'helper')
  g = setImports(g, id('root'), [id('zone')]).graph

  return setImports(g, id('zone'), [id('helper')]).graph
}

{
  const r = propagateUpdate(appGraph(), id('zone'))
  ok(
    'hmr: editing a zone updates that zone (self-accept)',
    r.type === 'update' &&
      r.updates.length === 1 &&
      r.updates[0]!.boundary === id('zone') &&
      r.updates[0]!.accepted === id('zone'),
    JSON.stringify(r),
  )
}

{
  const r = propagateUpdate(appGraph(), id('helper'))
  ok(
    'hmr: editing a helper bubbles to the importing zone (re-import the zone)',
    r.type === 'update' &&
      r.updates.length === 1 &&
      r.updates[0]!.boundary === id('zone') &&
      r.updates[0]!.accepted === id('zone'),
    JSON.stringify(r),
  )
}

{
  // a helper imported only by a non-accepting root: no self-accepting ancestor -> full reload
  let g = node(makeModuleGraph(), 'root')
  g = node(g, 'orphan')
  g = setImports(g, id('root'), [id('orphan')]).graph

  const r = propagateUpdate(g, id('orphan'))
  ok(
    'hmr: a change with no accepting ancestor is a full reload',
    r.type === 'full-reload',
    JSON.stringify(r),
  )
}

{
  // dep-accept: the root explicitly accepts the dep -> boundary is the root, re-import the dep
  let g = node(makeModuleGraph(), 'root')
  g = node(g, 'dep')
  g = setImports(g, id('root'), [id('dep')]).graph
  const root = moduleById(g, id('root'))
  g = putModule(g, { ...root, acceptedHmrDeps: [...root.acceptedHmrDeps, id('dep')] })

  const r = propagateUpdate(g, id('dep'))
  ok(
    'hmr: dep-accept makes the accepting importer the boundary',
    r.type === 'update' &&
      r.updates.length === 1 &&
      r.updates[0]!.boundary === id('root') &&
      r.updates[0]!.accepted === id('dep'),
    JSON.stringify(r),
  )
}

{
  // a cycle of non-accepting modules -> full reload
  let g = node(makeModuleGraph(), 'a')
  g = node(g, 'b')
  g = setImports(g, id('a'), [id('b')]).graph
  g = setImports(g, id('b'), [id('a')]).graph

  const r = propagateUpdate(g, id('a'))
  ok(
    'hmr: a non-accepting cycle is a full reload',
    r.type === 'full-reload',
    JSON.stringify(r),
  )
}

{
  const g = ensureModule(makeModuleGraph(), id('a'), id('a'), id('a')) // not loaded
  const r = propagateUpdate(g, id('a'))
  ok(
    'hmr: a never-loaded module is a full reload',
    r.type === 'full-reload',
    JSON.stringify(r),
  )
}

{
  const r = propagateUpdate(makeModuleGraph(), id('nowhere'))
  ok(
    'hmr: a module the graph never met is a full reload',
    r.type === 'full-reload',
    JSON.stringify(r),
  )
}

{
  const affected = affectedModules(appGraph(), id('helper')).sort()
  ok(
    'hmr: affectedModules includes the change + all transitive importers',
    affected.join(',') ===
      [id('helper'), id('zone'), id('root')].sort().join(','),
    affected.join(','),
  )
}

console.log(`\ndev/hmr: ${pass} pass, ${fail} fail`)

if (fail > 0) {process.exit(1)}
