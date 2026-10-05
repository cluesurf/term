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
// A reference whose imports reach exactly one of them is that one. One that reaches NONE (unimported), or SEVERAL (an
// import whose `bear` chain re-exports two forms of the name), gets what the flat program gave it: the definition merged
// last, among those it reaches when it reaches any. So nothing that builds today stops building: the generated `bind`
// package names forms it never imports thousands of times, and imports `function` through a chain that reaches three
// (`pnpm term:scope-census`). The strict step (module-scope-0006) refuses both. A type parameter of the enclosing
// definition shadows a form of the same name. Runs before `extendForms`, which reads a form's base by name.

import type { Program, Statement } from '@term/make/code/compile/node'
import type { ImportScope } from '@term/make/code/compile/load'
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

// A FORM AND A VARIANT CASE OF ONE NAME. `make <name>` constructs either, and the flat program gave every such
// construction to whichever it met: a user's `case pair` was built by the stdlib's zip in place of its own `pair` form,
// and the user's own `make pair` was refused for missing the stdlib form's fields. So a form whose name is also some
// form's case takes a name of its own (`<name>__form`), unless it is the entry file's, and the case keeps its name,
// which reaches the output (a TypeScript tag, a printed record). Then each reference is bound: a named type, a raise, a
// method and a mask instance can only mean the form; a construction means the case where its file defines that case's
// form or imports it, the form where its file defines or imports the form, and otherwise whichever's fields the
// construction names, the case where that does not decide
function separateCaseNames(program: Program, scope: ImportScope | undefined, entry?: string): void {
  type Owner = { file: string; form: string; fields: string[] }
  const cases = new Map<string, Owner[]>()
  const forms = new Map<string, Defining[]>()

  for (const statement of program) {
    if (statement.form === 'record-type' && statement.span.file) {
      for (const v of statement.variants) {
        cases.set(v.name, [...(cases.get(v.name) ?? []), { file: statement.span.file, form: statement.name, fields: v.fields.map(f => f.name) }])
      }
    }

    if ((statement.form === 'record-type' || statement.form === 'mask') && statement.span.file) {
      forms.set(statement.name, [...(forms.get(statement.name) ?? []), statement])
    }
  }

  for (const [name, defining] of forms) {
    const owners = cases.get(name)

    if (!owners || defining.some(d => d.span.file === entry)) {
      continue
    }

    const renamed = `${name}__form`
    const formFiles = new Set(defining.map(d => d.span.file!))
    const formFields = new Set(defining.flatMap(d => (d.form === 'record-type' ? d.fields.map(f => f.name) : [])))
    const caseFiles = new Set(owners.map(o => o.file))
    const caseForms = new Set(owners.map(o => o.form))

    defining.forEach(d => (d.name = renamed))

    // what a file reaches through its imports of `of`
    const reaches = (file: string | undefined, of: string): Set<string> => {
      const reach = new Set<string>()

      for (const target of (file && scope?.get(file)?.finds.get(of)) || []) {
        exportedBy(scope, target, reach)
      }

      return reach
    }
    // whether a construction in `file` naming `fields` means the form
    const meansForm = (file: string | undefined, fields: string[]): boolean => {
      if (file && caseFiles.has(file)) return false
      if (file && formFiles.has(file)) return true
      if ([...caseForms].some(form => [...reaches(file, form)].some(f => caseFiles.has(f)))) return false
      if ([...reaches(file, name)].some(f => formFiles.has(f))) return true
      const caseFit = owners.some(o => fields.every(f => o.fields.includes(f)))
      const formFit = fields.every(f => formFields.has(f))

      return formFit && !caseFit
    }

    for (const statement of program) {
      const file = statement.span.file
      const shadowed = typeParameters(statement)

      if (shadowed.has(name)) {
        continue
      }

      if (statement.form === 'function' && statement.method?.form === name) {
        statement.method.form = renamed
        statement.name = `${renamed}_${statement.method.name}`
      }

      if (statement.form === 'instance') {
        if (statement.mask === name) statement.mask = renamed
        if (statement.target === name) statement.target = renamed
      }

      const visit = (node: unknown): void => {
        if (!node || typeof node !== 'object') return
        if (Array.isArray(node)) return node.forEach(visit)
        const record = node as Record<string, unknown>

        if (record.kind === 'named' && record.name === name) {
          record.name = renamed
        }

        if (record.form === 'record' && record.name === name && meansForm(file, ((record.fields as { name: string }[]) ?? []).map(f => f.name))) {
          record.name = renamed
        }

        if (record.form === 'throw' && record.raise === name) {
          record.raise = renamed
        }

        for (const [key, value] of Object.entries(record)) {
          if (key !== 'span') visit(value)
        }
      }

      visit(statement)
    }
  }
}

export function bindFormsByImport(program: Program, scope: ImportScope | undefined, entry?: string): Diagnostic[] {
  separateCaseNames(program, scope, entry)

  const byName = new Map<string, Map<string, Defining[]>>()

  for (const statement of program) {
    if ((statement.form === 'record-type' || statement.form === 'mask') && statement.span.file) {
      const byFile = byName.get(statement.name) ?? new Map<string, Defining[]>()
      byFile.set(statement.span.file, [...(byFile.get(statement.span.file) ?? []), statement])
      byName.set(statement.name, byFile)
    }
  }

  const groups = new Map<string, Group>()

  // the file each name was defined in LAST, in program order, and each file's place in that order
  const lastFile = new Map<string, string>()
  const order = new Map<string, number>()

  program.forEach((statement, index) => {
    if (statement.span.file) {
      order.set(statement.span.file, index)
    }

    if ((statement.form === 'record-type' || statement.form === 'mask') && statement.span.file) {
      lastFile.set(statement.name, statement.span.file)
    }
  })

  for (const [name, byFile] of byName) {
    if (byFile.size > 1) {
      groups.set(name, { name, files: [...byFile.keys()].sort(), byFile, renamed: new Map(), last: lastFile.get(name)! })
    }
  }

  if (groups.size === 0) {
    // nothing to bind, and the aliases a `make` or a `like` carries are dropped all the same
    program.forEach(statement => rewrite(statement, statement.span, () => undefined))
    bindSharedCases(program, scope)

    return []
  }

  ;[...groups.values()].forEach((group, g) =>
    group.files.forEach((file, k) => {
      const renamed = file === entry ? group.name : `${group.name}__in${g}_${k}`
      group.renamed.set(file, renamed)
      group.byFile.get(file)!.forEach(d => (d.name = renamed))
    }),
  )

  // nothing is refused yet (see the header): the strict step fills this
  const diagnostics: Diagnostic[] = []

  // the name a reference to `group` in `file` binds to. A reference written through an alias (`make chart-element`,
  // with `find element, name chart-element`) reaches the files ITS find named, and a bare one the plain finds only, as
  // a task's does (overload.ts `reached`). Both read every find of the name until 2026-10-04, so a file that loaded
  // `element` from one module and aliased another's bound both spellings to the form merged last (guides:
  // language/modules)
  const bind = (group: Group, file: string | undefined, _span: Span, alias?: string): string | undefined => {
    if (file && group.byFile.has(file) && alias === undefined) {
      return group.renamed.get(file)
    }

    const reach = new Set<string>()
    const entry = file ? scope?.get(file) : undefined
    const targets =
      (alias !== undefined ? entry?.aliases?.get(alias) : entry?.plain?.get(group.name)) ?? entry?.finds.get(group.name) ?? []

    for (const target of targets) {
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

    // several reached: the one of them merged last, which is the one the flat program let win among them
    const latest = hits.reduce((a, b) => ((order.get(b) ?? -1) > (order.get(a) ?? -1) ? b : a))

    return group.renamed.get(latest)
  }

  for (const statement of program) {
    const file = statement.span.file
    const shadowed = typeParameters(statement)
    const rebind = (name: string, span: Span, alias?: string): string | undefined => {
      const group = groups.get(name)

      return group && !shadowed.has(name) ? bind(group, file, span, alias) : undefined
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

  bindSharedCases(program, scope)

  return diagnostics
}

// A CASE NAME TWO MODULES' FORMS SHARE. `make number` in node.tree, which builds its own `type`'s case, built
// surface.tree's `primitive` case of the same name once both were in one program: node.tree imports nothing from
// surface.tree, but a field-less case fits every owner, so the checker left the construction's type open and the last
// form merged won it (found porting compile/surface, 2026-10-05, test/check/shared-case.ts). Renaming the case per file,
// as forms are separated, would change what the output carries, since a case's tag IS its name. So the construction
// is told its owner instead (`owner`, which the checker reads first, as it does for `make expression/integer`): the
// owner its own file defines, else the one owner its file's imports reach. Neither leaves it to the checker's own
// choice by fields, as before
function bindSharedCases(program: Program, scope: ImportScope | undefined): void {
  type Owner = { file: string; form: string }
  const owners = new Map<string, Owner[]>()

  for (const statement of program) {
    if (statement.form === 'record-type' && statement.span.file) {
      for (const variant of statement.variants) {
        owners.set(variant.name, [...(owners.get(variant.name) ?? []), { file: statement.span.file, form: statement.name }])
      }
    }
  }

  const shared = new Map([...owners].filter(([, list]) => new Set(list.map(o => o.file)).size > 1))

  if (shared.size === 0) {
    return
  }

  // ONLY where nothing else could be meant: the construction's file defines one owner and imports no other owner's
  // form. Anything wider is a guess, and both wider rules guessed wrong in @term/host: scan.tree defines `token` and
  // builds node.tree's `scan-node` cases of the same names, which it imports, and read.tree reaches both
  // (`compile/host-native` on Kotlin, 2026-10-05). The checker's own choice, by the type the construction flows into,
  // stays for those, as before
  const ownerFor = (name: string, file: string | undefined): string | undefined => {
    if (!file) {
      return undefined
    }

    const list = shared.get(name)!
    const own = list.filter(o => o.file === file)
    const imported = scope?.get(file)?.finds
    const importsAnother = list.some(o => o.file !== file && imported?.has(o.form))

    return own.length === 1 && !importsAnother ? own[0]!.form : undefined
  }

  const visit = (node: unknown, file: string | undefined): void => {
    if (!node || typeof node !== 'object') {
      return
    }

    if (Array.isArray(node)) {
      node.forEach(item => visit(item, file))

      return
    }

    const record = node as Record<string, unknown>

    if (record.form === 'record' && typeof record.name === 'string' && shared.has(record.name) && record.owner === undefined) {
      const owner = ownerFor(record.name, file)

      if (owner) {
        record.owner = owner
      }
    }

    for (const [key, value] of Object.entries(record)) {
      if (key !== 'span' && key !== 'type') {
        visit(value, file)
      }
    }
  }

  for (const statement of program) {
    visit(statement, statement.span.file)
  }
}

// every named type, construction and raise under a node, renamed where `rebind` says. Generic over the tree, so no
// statement or expression shape that carries a type is missed; a span is the nearest one above, for the diagnostic
function rewrite(node: unknown, span: Span, rebind: (name: string, span: Span, alias?: string) => string | undefined): void {
  if (!node || typeof node !== 'object') {
    return
  }

  if (Array.isArray(node)) {
    node.forEach(item => rewrite(item, span, rebind))

    return
  }

  const record = node as Record<string, unknown>
  const here = (record.span as Span | undefined) ?? span
  // the alias a `like` or a `make` was written with (mint-bridge.ts `applyAliases`): read here, then dropped, so a type
  // compared field by field later carries nothing binding was the only reader of
  const alias = typeof record.alias === 'string' && (record.kind === 'named' || record.form === 'record') ? record.alias : undefined

  if (alias !== undefined) {
    delete record.alias
  }

  if (record.kind === 'named' && typeof record.name === 'string') {
    record.name = rebind(record.name, here, alias) ?? record.name
  }

  if (record.form === 'record' && typeof record.name === 'string') {
    record.name = rebind(record.name, here, alias) ?? record.name
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
