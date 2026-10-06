// THE SCOPE CENSUS (module-scope-0001). A Term name is meant to belong to the module that defines it and to reach
// another module only through `load ... / find`. The compiler merges every module into one flat program instead, so
// this counts, over a milled program and the import scope `collectModules` recorded, what that merge is relied on for:
//
//   collisions    a name defined in two or more files, in one namespace. Today their definitions merge: two tasks of
//                 different signatures become global overloads, two forms corrupt each other
//   unimported    a reference whose file neither defines the name nor imports a file that does (by `find`, or through
//                 that file's `bear` chain), so only the global merge resolves it
//
// Two namespaces, because a task and a form of one name are two things told apart by position:
//
//   value   tasks (not form methods), components (`view`), top-level `host` constants, dock aliases, binds. Referenced
//           by a variable: a call's callee, a task passed as a value, a component placed in a view
//   type    forms, masks, opaque dock types. Referenced by a named type (a `like`), a `make`, a `halt <form>`, a mask
//           instance, a method's form
//
// A name nothing in the program defines (an intrinsic like `add`, a local, a typo) is not counted: the census is about
// the merge, not about unknown names. Pure: reads the program, changes nothing.

import type { Program, Statement } from '@term/make/code/compile/node'
import type { ImportScope } from '@term/make/code/compile/load'
import { isHtmlTag } from '@term/make/code/compile/view-lower'

export type Namespace = 'value' | 'type'

export type Collision = { namespace: Namespace; name: string; files: string[] }

export type Unimported = { namespace: Namespace; name: string; file: string; definers: string[] }

// `shadowed`: an unimported reference whose name is ALSO a method of some form in the program, so it is most likely a
// receiver call (`call size, read items` dispatches to the list's own `size`), which needs no import, and which a
// top-level task of the same name from a module the file never imported can capture (native-dom-0036). Counted apart
// from `unimported`, because the fix is resolution by position (module-scope-0005), not a `find`.
export type ScopeCensus = { collisions: Collision[]; unimported: Unimported[]; shadowed: Unimported[] }

// every name a top-level statement defines, by namespace
function defined(statement: Statement): { namespace: Namespace; name: string } | undefined {
  switch (statement.form) {
    case 'function':
      // a form's method is reached through its form, and an abstract signature (no body: a contract an env's host
      // module fills, as native/db.tree's tasks are) is a declaration, not a second definition
      return statement.method || statement.stub || statement.claim || statement.body.length === 0
        ? undefined
        : { namespace: 'value', name: statement.name }
    case 'view':
    case 'let':
    case 'bind':
      return { namespace: 'value', name: statement.name }
    case 'native':
      return { namespace: statement.kind === 'type' ? 'type' : 'value', name: statement.alias }
    case 'record-type':
    case 'mask':
      return { namespace: 'type', name: statement.name }
    default:
      return undefined
  }
}

// the names bound locally anywhere in a statement: parameters (of the task, its closures and a view), lets and view
// saves, a walk's item and index, a case arm's renamed fields. A reference to one of these is a local, not an import
function locals(node: unknown, into = new Set<string>()): Set<string> {
  if (!node || typeof node !== 'object') {
    return into
  }

  if (Array.isArray(node)) {
    node.forEach(item => locals(item, into))

    return into
  }

  const record = node as Record<string, unknown>

  if ((record.form === 'let' || record.form === 'save') && typeof record.name === 'string') {
    into.add(record.name)
  }

  if (record.form === 'for-each' || record.form === 'walk') {
    for (const key of ['item', 'index']) {
      if (typeof record[key] === 'string') {
        into.add(record[key] as string)
      }
    }
  }

  for (const key of ['params', 'binds']) {
    const list = record[key]

    if (Array.isArray(list)) {
      for (const entry of list) {
        const name = typeof entry === 'string' ? entry : (entry as { name?: unknown })?.name

        if (typeof name === 'string') {
          into.add(name)
        }
      }
    }
  }

  if (record.form === 'guard' && record.catch && typeof (record.catch as { name?: unknown }).name === 'string') {
    into.add((record.catch as { name: string }).name)
  }

  for (const [key, value] of Object.entries(record)) {
    if (key !== 'span') {
      locals(value, into)
    }
  }

  return into
}

// every reference under a node, by namespace
function references(node: unknown, visit: (namespace: Namespace, name: string) => void): void {
  if (!node || typeof node !== 'object') {
    return
  }

  if (Array.isArray(node)) {
    node.forEach(item => references(item, visit))

    return
  }

  const record = node as Record<string, unknown>

  // a value: a variable (a call's callee is one), and a component a view places (an `element` node by its name). A
  // standard HTML tag is always an element, never a component, whatever a module defines (view-lower.ts HTML_TAGS),
  // so `view button` inside a component is a <button>, not face's `button`
  if (record.form === 'variable' && typeof record.name === 'string') {
    visit('value', record.name)
  }

  if (record.form === 'element' && typeof record.name === 'string' && !isHtmlTag(record.name) && !record.forced) {
    visit('value', record.name)
  }

  // a type: a named type, a construction, a raise, a mask instance
  if (record.kind === 'named' && typeof record.name === 'string') {
    visit('type', record.name)
  }

  if (record.form === 'record' && typeof record.name === 'string') {
    visit('type', record.name)
  }

  if (record.form === 'throw' && typeof record.raise === 'string') {
    visit('type', record.raise)
  }

  if (record.form === 'instance') {
    if (typeof record.mask === 'string') {
      visit('type', record.mask)
    }

    if (typeof record.target === 'string') {
      visit('type', record.target)
    }
  }

  for (const [key, value] of Object.entries(record)) {
    if (key !== 'span') {
      references(value, visit)
    }
  }
}

export function scopeCensus(program: Program, scope: ImportScope, skip?: (file: string) => boolean): ScopeCensus {
  // namespace -> name -> the files defining it
  const definers: Record<Namespace, Map<string, Set<string>>> = { value: new Map(), type: new Map() }
  // the native module each dock alias names, by namespace and alias: one module docked under one alias in two files
  // (a host's dom and its page both docking `<global:html>` as `doc`) is the same handle twice, not two definitions
  const docked = new Map<string, Set<string>>()

  for (const statement of program) {
    const def = defined(statement)
    const file = statement.span.file

    if (!def || !file) {
      continue
    }

    const files = definers[def.namespace].get(def.name) ?? new Set<string>()
    files.add(file)
    definers[def.namespace].set(def.name, files)

    if (statement.form === 'native') {
      const key = `${def.namespace}\u0000${def.name}`
      docked.set(key, (docked.get(key) ?? new Set<string>()).add(statement.module))
    }
  }

  // a file and every file its `bear` chain re-exports
  const exported = (file: string, into = new Set<string>()): Set<string> => {
    if (into.has(file)) {
      return into
    }

    into.add(file)
    scope.get(file)?.bears.forEach(next => exported(next, into))

    return into
  }

  const collisions: Collision[] = []

  for (const namespace of ['value', 'type'] as const) {
    for (const [name, files] of definers[namespace]) {
      const modules = docked.get(`${namespace}\u0000${name}`)
      const sameDock = modules !== undefined && modules.size === 1

      if (files.size > 1 && !sameDock) {
        collisions.push({ namespace, name, files: [...files].sort() })
      }
    }
  }

  const unimported: Unimported[] = []
  const shadowed: Unimported[] = []
  const seen = new Set<string>()
  // every form method's bare name
  const methods = new Set(program.flatMap(s => (s.form === 'function' && s.method ? [s.method.name] : [])))

  for (const statement of program) {
    const file = statement.span.file

    if (!file || skip?.(file)) {
      continue
    }

    const local = locals(statement)

    references(statement, (namespace, name) => {
      const files = definers[namespace].get(name)

      if (!files || files.has(file) || (namespace === 'value' && local.has(name))) {
        return
      }

      const reach = new Set<string>()
      scope.get(file)?.finds.get(name)?.forEach(target => exported(target, reach))

      if ([...files].some(definer => reach.has(definer))) {
        return
      }

      const key = `${file}\u0000${namespace}\u0000${name}`

      if (!seen.has(key)) {
        seen.add(key)
        const found = { namespace, name, file, definers: [...files].sort() }
        ;(namespace === 'value' && methods.has(name) ? shadowed : unimported).push(found)
      }
    })
  }

  return { collisions, unimported, shadowed }
}
