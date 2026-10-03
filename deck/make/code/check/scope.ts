// MODULE SCOPE FOR FORMS (module-scope-0003). A form belongs to the module that defines it and reaches another module
// only through `load ... / find` (note/term/project/module-scope.md). The build merges every module into one flat
// program, so two forms of one name from two files met in it and the one merged last took the other's place: a field
// read off the wrong record, a variant matched against the wrong enum, with the error surfacing in a third file.
//
// So every form (and mask) name defined in two or more files is split BY FILE before anything reads a form by name:
// each file's takes a name of its own (`<name>__in<g>_<k>`), the entry file's keeping the original, and with it its
// methods (`<form>_<method>` functions, whose `method.form` names it). Then every reference in a file is bound by WHAT
// THAT FILE IMPORTED: its own form, else the one its `find` reached (or that file's `bear` chain). A reference is any
// place a form is named:
//
//   a named type      a `like` on a parameter, a result, a field, a let, a closure, an `extend` base, an alias
//   a construction    `make <form>`
//   a raise           `halt <form>`
//   a method          the form a method belongs to
//   a mask instance   the mask, and the form it is worn on
//
// A reference whose imports reach more than one of them is refused, naming the files: unlike a call, a type has no
// arity to tell two forms apart by. A reference that reaches NONE (unimported) gets what the flat program gave it, the
// definition merged last, so nothing that builds today stops building: the generated `bind` package names forms it
// never imports thousands of times (`pnpm term:scope-census`). The strict step (module-scope-0006) refuses those. A
// type parameter of the enclosing definition shadows a form of the same name. Runs before `extendForms`, which reads a
// form's base by name.

import type { Program, Statement } from '@term/make/code/compile/node'
import type { ImportScope } from '@term/make/code/compile/load'
import { diagnose } from '@term/make/code/parser/diagnostic'
import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'

type Defining = Extract<Statement, { form: 'record-type' | 'mask' }>

// `last` is the file of the definition merged last, the one the flat program let win, for an unimported reference
type Group = { name: string; files: string[]; byFile: Map<string, Defining[]>; renamed: Map<string, string>; last: string }

// a file and every file its `bear` chain re-exports
function exportedBy(scope: ImportScope | undefined, file: string, into = new Set<string>()): Set<string> {
  if (into.has(file)) {
    return into
  }

  into.add(file)
  scope?.get(file)?.bears.forEach(next => exportedBy(scope, next, into))

  return into
}

// the type parameters a top-level statement declares, which shadow every form of the same name inside it
function typeParameters(statement: Statement): Set<string> {
  if (statement.form === 'function') {
    return new Set(statement.generics.map(g => g.name))
  }

  if (statement.form === 'record-type') {
    return new Set(statement.params)
  }

  return new Set()
}

export function bindFormsByImport(program: Program, scope: ImportScope | undefined, entry?: string): Diagnostic[] {
  const byName = new Map<string, Map<string, Defining[]>>()

  for (const statement of program) {
    if ((statement.form === 'record-type' || statement.form === 'mask') && statement.span.file) {
      const byFile = byName.get(statement.name) ?? new Map<string, Defining[]>()
      byFile.set(statement.span.file, [...(byFile.get(statement.span.file) ?? []), statement])
      byName.set(statement.name, byFile)
    }
  }

  const groups = new Map<string, Group>()

  // the file each name was defined in LAST, in program order
  const lastFile = new Map<string, string>()

  for (const statement of program) {
    if ((statement.form === 'record-type' || statement.form === 'mask') && statement.span.file) {
      lastFile.set(statement.name, statement.span.file)
    }
  }

  for (const [name, byFile] of byName) {
    if (byFile.size > 1) {
      groups.set(name, { name, files: [...byFile.keys()].sort(), byFile, renamed: new Map(), last: lastFile.get(name)! })
    }
  }

  if (groups.size === 0) {
    return []
  }

  ;[...groups.values()].forEach((group, g) =>
    group.files.forEach((file, k) => {
      const renamed = file === entry ? group.name : `${group.name}__in${g}_${k}`
      group.renamed.set(file, renamed)
      group.byFile.get(file)!.forEach(d => (d.name = renamed))
    }),
  )

  const diagnostics: Diagnostic[] = []
  const told = new Set<string>()
  const short = (file: string) => file.split('/').slice(-3).join('/')

  // the name a reference to `group` in `file` binds to, or undefined (refused) when its imports cannot tell
  const bind = (group: Group, file: string | undefined, span: Span): string | undefined => {
    if (file && group.byFile.has(file)) {
      return group.renamed.get(file)
    }

    const reach = new Set<string>()

    for (const target of (file && scope?.get(file)?.finds.get(group.name)) || []) {
      exportedBy(scope, target, reach)
    }

    const hits = group.files.filter(f => reach.has(f))

    if (hits.length === 1) {
      return group.renamed.get(hits[0]!)
    }

    // unimported: the definition the flat program let win, until the strict step refuses it
    if (hits.length === 0) {
      return group.renamed.get(group.last)
    }

    const key = `${file}\u0000${group.name}`

    if (!told.has(key)) {
      told.add(key)
      const here = file ? short(file) : 'this file'
      diagnostics.push(
        diagnose('duplicate-definition', {
          file,
          span,
          message: `${here} imports the form "${group.name}" from more than one file that defines it (${hits.map(short).join(', ')}), so the reference cannot tell which it means`,
          markers: [
            { span },
            ...hits.flatMap(f => group.byFile.get(f)!.map(d => ({ span: d.span, label: `a "${group.name}" here` }))),
          ],
          hint: `add \`find ${group.name}\` under the \`load\` of the one ${here} means. A form belongs to the module that defines it`,
        }),
      )
    }

    return undefined
  }

  for (const statement of program) {
    const file = statement.span.file
    const shadowed = typeParameters(statement)
    const rebind = (name: string, span: Span): string | undefined => {
      const group = groups.get(name)

      return group && !shadowed.has(name) ? bind(group, file, span) : undefined
    }

    // a method, by the form it belongs to: the function's own name follows (`<form>_<method>`)
    if (statement.form === 'function' && statement.method) {
      const renamed = rebind(statement.method.form, statement.span)

      if (renamed) {
        statement.method.form = renamed
        statement.name = `${renamed}_${statement.method.name}`
      }
    }

    // a mask instance: the mask, and the form it is worn on
    if (statement.form === 'instance') {
      statement.mask = rebind(statement.mask, statement.span) ?? statement.mask
      statement.target = rebind(statement.target, statement.span) ?? statement.target
    }

    rewrite(statement, statement.span, rebind)
  }

  return diagnostics
}

// every named type, construction and raise under a node, renamed where `rebind` says. Generic over the tree, so no
// statement or expression shape that carries a type is missed; a span is the nearest one above, for the diagnostic
function rewrite(node: unknown, span: Span, rebind: (name: string, span: Span) => string | undefined): void {
  if (!node || typeof node !== 'object') {
    return
  }

  if (Array.isArray(node)) {
    node.forEach(item => rewrite(item, span, rebind))

    return
  }

  const record = node as Record<string, unknown>
  const here = (record.span as Span | undefined) ?? span

  if (record.kind === 'named' && typeof record.name === 'string') {
    record.name = rebind(record.name, here) ?? record.name
  }

  if (record.form === 'record' && typeof record.name === 'string') {
    record.name = rebind(record.name, here) ?? record.name
  }

  if (record.form === 'throw' && typeof record.raise === 'string') {
    record.raise = rebind(record.raise, here) ?? record.raise
  }

  for (const [key, value] of Object.entries(record)) {
    if (key !== 'span') {
      rewrite(value, here, rebind)
    }
  }
}
