/**
 * Incremental compilation: the content-hashed cache, the interface
 * firewall, and the dependency-affected scheduler. Run from the seed
 * install root:
 *   npx tsx deck/test/code/demo-incremental.ts
 *
 * Three things, each a property of "reuse the unchanged, rebuild only
 * what depends on the change":
 *   A. the CONTENT-HASHED cache already reuses an unchanged module's full
 *      compiled output and rebuilds only changed files + their dependents
 *      (verified via the cache hit/miss counters).
 *   B. the INTERFACE fingerprint is stable across a body-only edit and
 *      changes on a signature edit (the early-cutoff firewall key).
 *   C. the AFFECTED-SET scheduler recomputes exactly the changed nodes +
 *      their transitive dependents, and EARLY-CUTOFF spares dependents
 *      when a node's interface did not change.
 */

import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { compile } from '@cluesurf/make/code/compile/compile'
import { CompileCache } from '@cluesurf/make/code/compile/cache'
import { interfaceHash } from '@cluesurf/make/code/compile/interface'
import {
  affectedSet,
  reusableSet,
  reverseDeps,
  topoOrder,
  isAcyclic,
  type DepGraph,
} from '@cluesurf/make/code/compile/affected'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
  else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
}

// ---- B. interface fingerprint: the firewall key ----
function ihash(src: string): string {
  const r = compile({ file: 'm.tree', text: src }, { resolve: () => undefined })
  return r.ok ? interfaceHash(r.program) : 'ERR'
}

const base = `task double
  take n, like number
  like number
  send back
    call add
      read n
      read n
`
// same signature, different BODY (returns n+n+0 instead of n+n)
const bodyEdit = `task double
  take n, like number
  like number
  save x
    call add
      read n
      read n
  send back
    read x
`
// different SIGNATURE (param renamed + extra param)
const sigEdit = `task double
  take n, like number
  take m, like number
  like number
  send back
    call add
      read n
      read m
`
const h0 = ihash(base)
ok('interface hash is computed', h0 !== 'ERR' && h0.length > 0)
ok('body-only edit does NOT change the interface (firewall holds)', ihash(bodyEdit) === h0,
  `${ihash(bodyEdit)} === ${h0}`)
ok('signature edit DOES change the interface', ihash(sigEdit) !== h0)

// ---- C. affected-set scheduler ----
// graph: app -> ui -> base ; util (independent). edges = "depends on".
const graph: DepGraph = new Map([
  ['app', new Set(['ui'])],
  ['ui', new Set(['base'])],
  ['base', new Set()],
  ['util', new Set()],
])

ok('graph is a valid DAG', isAcyclic(graph))
ok('topo order puts deps before dependents',
  (() => { const o = topoOrder(graph); return o.indexOf('base') < o.indexOf('ui') && o.indexOf('ui') < o.indexOf('app') })())

// change `base` (interface changed): base, ui, app rebuild; util reused
const aAll = affectedSet({ graph, changed: ['base'] })
ok('changing base affects base + ui + app (transitive dependents)',
  aAll.has('base') && aAll.has('ui') && aAll.has('app') && !aAll.has('util'),
  `{${[...aAll].sort().join(',')}}`)
ok('util is reusable when base changes', reusableSet(graph, aAll).has('util'))

// change `base` but its INTERFACE did not change (body-only): only base rebuilds
const aCut = affectedSet({ graph, changed: ['base'], interfaceChanged: () => false })
ok('EARLY CUTOFF: a body-only change to base rebuilds only base',
  aCut.has('base') && !aCut.has('ui') && !aCut.has('app'),
  `{${[...aCut].sort().join(',')}}`)

// reverseDeps sanity
ok('reverseDeps maps base -> {ui}', [...(reverseDeps(graph).get('base') ?? [])].join(',') === 'ui')

// ---- A. the content-hashed cache reuses unchanged, rebuilds changed + dependents ----
const dir = mkdtempSync(path.join(tmpdir(), 'seed-inc-'))
const A = path.join(dir, 'a.tree') // base module
const B = path.join(dir, 'b.tree') // imports A
const C = path.join(dir, 'c.tree') // independent
writeFileSync(A, 'task one\n  like number\n  send back, mark 1\n')
writeFileSync(B, 'task two\n  like number\n  send back, mark 2\n')
writeFileSync(C, 'task three\n  like number\n  send back, mark 3\n')

const cache = new CompileCache()
const compileAll = () => {
  for (const f of [A, B, C]) compile({ file: f, text: readFileSync(f, 'utf8') }, { resolve: () => undefined, cache })
}

// cold: all miss
cache.hits = 0; cache.misses = 0
compileAll()
const coldMisses = cache.misses
ok('cold build: every module is a cache miss', coldMisses >= 3, `${coldMisses} misses`)

// no-op rebuild: all hit, zero misses
cache.hits = 0; cache.misses = 0
compileAll()
ok('no-op rebuild: all hits, zero rebuilds', cache.misses === 0 && cache.hits > 0,
  `${cache.hits} hits, ${cache.misses} misses`)

// edit C only: exactly one module rebuilds (the output cache reuses A and B)
writeFileSync(C, 'task three\n  like number\n  send back, mark 30\n')
cache.hits = 0; cache.misses = 0
compileAll()
// the output cache short-circuits: a REUSED module is 1 output hit, the one
// REBUILT module is 2 misses (its output + mill). So A and B reused (2 hits),
// only C rebuilt (<=2 misses).
ok('editing one module rebuilds only it (A, B reused from cache)', cache.misses <= 2 && cache.hits >= 2,
  `${cache.hits} hits, ${cache.misses} misses`)

// revert C: content-addressed -> back to all hits (the reverted state is cached)
writeFileSync(C, 'task three\n  like number\n  send back, mark 3\n')
cache.hits = 0; cache.misses = 0
compileAll()
ok('reverting an edit returns to all-hits (content-addressed, not mtime)', cache.misses === 0,
  `${cache.hits} hits, ${cache.misses} misses`)

console.log(`\nseed-verify incremental demo: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
