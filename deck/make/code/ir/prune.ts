// Tree-shaking the merged program: keep only the definitions reachable from
// the entry's roots, so a tiny entry that pulls in a huge `load`/`bear`
// closure (the whole stdlib) does not pay to type-check every imported
// definition it never uses. Runs after `resolve` (names are bound) and before
// the expensive `check`/`elaborate` passes.
//
// SOUNDNESS by over-approximation: references are collected by deep-walking
// each kept statement and taking EVERY name it mentions (variable reads, call
// targets, and `kind: 'named'` type references - and, harmlessly, incidental
// param / field names). Over-approximating can only KEEP more, never drop a
// real reference. Trait instances are selected implicitly (no name in source),
// so all `mask` / `instance` statements are kept and seed the search; the same
// for `native` / `bind` / `dock` / `zone` (platform surface + side effects).
// Only `function` and `record-type` definitions are ever pruned.
//
// This pass is OPT-IN and must be validated by a differential harness (compile
// with and without it; the entry's emitted code must be identical) before it
// is trusted - see note/seed/tree-streaming-and-perf.md.

import type {
  Program,
  Statement,
} from '@cluesurf/make/code/compile/node'

// every name mentioned anywhere inside a node (deep, generic, over-approximate)
function collectNames(node: unknown, out: Set<string>): void {
  if (node === null || typeof node !== 'object') {return}

  if (Array.isArray(node)) {
    for (const item of node) {collectNames(item, out)}

    return
  }

  const obj = node as Record<string, unknown>

  // any `name: string` is a potential reference (variable, call target, named
  // type, generic bound). Over-approximation: incidental names cost only extra
  // kept definitions, never a missed dependency.
  if (typeof obj.name === 'string') {out.add(obj.name)}

  for (const key in obj) {
    if (key === 'span') {continue} // spans carry only positions, never names

    collectNames(obj[key], out)
  }
}

const PRUNABLE = new Set(['function', 'record-type'])

/**
 * Return a program containing only the reachable `function` / `record-type`
 * definitions (plus every non-prunable statement), starting from `roots`.
 */
export function pruneToReachable(
  program: Program,
  roots: Set<string>,
): Program {
  // index prunable definitions by name (a name may have several: overloads)
  const defsByName = new Map<string, Statement[]>()

  for (const statement of program) {
    if (PRUNABLE.has(statement.form)) {
      const name = (statement as { name: string }).name
      const list = defsByName.get(name)

      if (list) {list.push(statement)}
      else {defsByName.set(name, [statement])}
    }
  }

  const reachable = new Set<string>()
  const queue: string[] = [...roots]

  // seed from every non-prunable statement (traits/instances/native/bind/dock/
  // zone): they are always kept and may reference prunable definitions.
  for (const statement of program) {
    if (!PRUNABLE.has(statement.form)) {
      const names = new Set<string>()
      collectNames(statement, names)

      for (const name of names) {queue.push(name)}
    }
  }

  while (queue.length > 0) {
    const name = queue.pop()!

    if (reachable.has(name)) {continue}

    reachable.add(name)

    for (const def of defsByName.get(name) ?? []) {
      const names = new Set<string>()
      collectNames(def, names)

      for (const n of names) {
        if (!reachable.has(n)) {queue.push(n)}
      }
    }
  }

  return program.filter(statement => {
    if (!PRUNABLE.has(statement.form)) {return true}

    const name = (statement as { name: string }).name

    return reachable.has(name) || roots.has(name)
  })
}
