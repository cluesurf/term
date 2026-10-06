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
// It is ON by default for the optimized merged build (compile.ts `treeShake`)
// and off in per-module and editor builds, held by test/compile/shake-differential.ts
// (compile with and without it, the entry's emitted code identical). Every layer
// of shaking what a program ships is in note/term/compiler/runtime-shaking.md.

import type {
  Program,
  Statement,
} from '@term/make/code/compile/node'

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

  // a match arm names its case by `label`
  if (typeof obj.label === 'string') {out.add(obj.label)}

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
  rootList: Iterable<string>,
): Program {
  // a list, as ir/prune.tree takes them; read into a set once
  const roots = new Set(rootList)

  // index prunable definitions by name (a name may have several: overloads)
  const defsByName = new Map<string, Statement[]>()

  const index = (name: string, statement: Statement): void => {
    const list = defsByName.get(name)

    if (list) {list.push(statement)}
    else {defsByName.set(name, [statement])}
  }

  for (const statement of program) {
    if (PRUNABLE.has(statement.form)) {
      index((statement as { name: string }).name, statement)

      // a form's method is DEFINED under its mangled name (`<form>_<method>`) but CALLED bare (`call get / ...`)
      // until the checker's receiver dispatch runs -- which is AFTER this prune. So a reached bare method name must
      // keep every form's method of that name: (1) the used implementation survives, and (2) the checker's
      // "exactly one form owns this method" dispatch heuristic sees the same owner set as the unpruned program,
      // so shaking never changes how a call resolves.
      const method = (statement as { method?: { name: string } }).method

      if (method) {
        index(method.name, statement)
      }

      // a form is reached through its CASES too: `make one` and `case one` name the case, never the form, so a task
      // that builds and matches a variant without writing the form's name lost the whole form, and every backend then
      // wrote the cases as records nothing declared
      for (const variant of (statement as { variants?: { name: string }[] }).variants ?? []) {
        index(variant.name, statement)
      }
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
