// PRIVACY. `mark private` on a task makes it visible only inside the file that defines it.
//
// Names are package-global (every reachable module is merged into one program), so before 2026-10-02 the mark was
// read and held nobody to anything: another file could `call helper`, pass it as a value, or `load ./x / find
// helper`, and the TypeScript output exported it. This pass refuses each of those as `private-name`.
//
// It is EXACT, not name-based. A reference is judged by the binding the resolver gave it, so a parameter or a
// local in the calling file that happens to share a private task's name is a local and is never refused. A name
// with any definition the reference may mean that is public, or that lives in the referring file, is not a
// violation: an overload or an env shim that is public keeps the name reachable.
//
// ONE EXCEPTION, the tests. A file under its package's `test/` directory may reference a private task of the same
// package, because a test of an internal helper is how the helper is tested. The package is `deckOf`'s root when
// the build knows it, and otherwise the path before the file's last `/test/` segment.
//
// `note private` is the old spelling. It is still honored, and warned about as `note-private`.

import type { Expression, Program, Statement } from '@term/make/code/compile/node'
import { diagnose } from '@term/make/code/parser/diagnostic'
import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'

type Definition = Extract<Statement, { form: 'function' }>

// What the checks ask of the build, as data (check/private.tree takes the same): a file's import scope as a list, the
// deck each file belongs to as the list the build's `deckOf` would answer, and the overload groups, check/overload.ts's
// module state
export interface ScopeFind {
  name: string
  targets: string[]
  at?: Span
}

export interface FileScope {
  file: string
  finds: ScopeFind[]
  bears: string[]
}

export interface DeckHome {
  file: string
  root: string
}

export interface OverloadGroup {
  name: string
  members: string[]
}

type DeckOf = (file: string) => { root: string } | undefined

const deckOfList = (decks: DeckHome[]): DeckOf | undefined => {
  if (decks.length === 0) {
    return undefined
  }

  const table = new Map(decks.map(d => [d.file, { root: d.root }]))

  return file => table.get(file)
}

const short = (file: string): string => file.split('/').slice(-3).join('/')

// top-level tasks by name. A form's method is not a top-level name and has its own visibility story, so it is not
// a candidate here.
function tasksByName(program: Program): Map<string, Definition[]> {
  const byName = new Map<string, Definition[]>()

  for (const statement of program) {
    if (statement.form === 'function' && !statement.method) {
      const list = byName.get(statement.name) ?? []
      list.push(statement)
      byName.set(statement.name, list)
    }
  }

  return byName
}

// may `file` see `definition`: it is public, or in `file`, or `file` is a test of its package
function visible(definition: Definition, file: string | undefined, deckOf?: DeckOf): boolean {
  if (!definition.private) {
    return true
  }

  const home = definition.span.file

  if (!home || !file || home === file) {
    return true
  }

  return testOf(file, home, deckOf)
}

// is `file` a test file of the package that holds `home`
function testOf(file: string, home: string, deckOf?: DeckOf): boolean {
  const deck = deckOf?.(file)

  if (deck) {
    return file.startsWith(`${deck.root}/test/`) && deckOf?.(home)?.root === deck.root
  }

  const at = file.lastIndexOf('/test/')

  return at >= 0 && home.startsWith(`${file.slice(0, at)}/`)
}

function refusal(
  name: string,
  definitions: Definition[],
  file: string,
  span: Definition['span'],
  how: string,
): Diagnostic {
  const homes = [...new Set(definitions.map(d => d.span.file).filter((f): f is string => !!f))]
  const where = homes.map(short).join(', ')

  return diagnose('private-name', {
    file,
    span: { ...span, file },
    message: `"${name}" is \`mark private\` in ${where}, so ${short(file)} cannot ${how} it`,
    markers: [{ span: { ...span, file } }, ...definitions.map(d => ({ span: d.span, label: `private "${name}" here` }))],
    hint: `remove \`mark private\` from ${name} in ${where}, or call it only from that file`,
  })
}

// A `find` of a private name in a `load` block. Run BEFORE overload disambiguation renames definitions, so a found
// name is compared with the name as written.
export function checkPrivateFinds(program: Program, scopes: FileScope[], decks: DeckHome[]): Diagnostic[] {
  if (scopes.length === 0) {
    return []
  }

  const deckOf = deckOfList(decks)
  const scope = new Map(scopes.map(own => [own.file, own]))
  const byName = tasksByName(program)

  if (![...byName.values()].some(list => list.some(d => d.private))) {
    return []
  }

  // a file and everything it re-exports with `bear`, transitively
  const exported = (file: string, into = new Set<string>()): Set<string> => {
    if (into.has(file)) {
      return into
    }

    into.add(file)

    for (const next of scope.get(file)?.bears ?? []) {
      exported(next, into)
    }

    return into
  }

  const diagnostics: Diagnostic[] = []

  for (const own of scopes) {
    const file = own.file

    for (const { name, targets, at } of own.finds) {
      const definitions = byName.get(name)

      if (!definitions?.some(d => d.private)) {
        continue
      }

      const reach = new Set<string>()

      for (const target of targets) {
        exported(target, reach)
      }

      const reached = definitions.filter(d => d.span.file !== undefined && reach.has(d.span.file))

      if (reached.length === 0 || reached.some(d => visible(d, file, deckOf))) {
        continue
      }

      const span = at ?? { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } }
      diagnostics.push(refusal(name, reached, file, span, 'find'))
    }
  }

  return diagnostics
}

// every variable under a node with the statement-level file it sits in. Generic over the tree so no statement or
// expression form is missed; types, spans and signatures hold no references a definition could be named by.
// Each object is visited once: a lowered program SHARES subtrees (a fallback cloned into many calls, a template's
// expansion), and a walk that re-enters them is exponential in the nesting.
function eachReference(
  node: unknown,
  visit: (variable: Extract<Expression, { form: 'variable' }>) => void,
  seen: WeakSet<object> = new WeakSet(),
): void {
  if (!node || typeof node !== 'object' || seen.has(node)) {
    return
  }

  seen.add(node)

  if (Array.isArray(node)) {
    for (const item of node) {
      eachReference(item, visit, seen)
    }

    return
  }

  const record = node as Record<string, unknown>

  if (record.form === 'variable' && typeof record.name === 'string') {
    visit(record as Extract<Expression, { form: 'variable' }>)
  }

  for (const [key, value] of Object.entries(record)) {
    if (
      key !== 'span' &&
      key !== 'type' &&
      key !== 'result' &&
      key !== 'declared' &&
      key !== 'generics' &&
      key !== 'binding' &&
      key !== 'privateNote'
    ) {
      eachReference(value, visit, seen)
    }
  }
}

// A call to, or a reference as a value of, a private task from another file. Run AFTER the resolver, so only a
// name the resolver bound to a top-level task counts (a parameter or a local of the same name is bound to itself),
// and after overload disambiguation, so an arity or file overload is judged by the definition it was bound to.
export function checkPrivateReferences(program: Program, file: string, groups: OverloadGroup[], decks: DeckHome[]): Diagnostic[] {
  const byName = tasksByName(program)

  if (![...byName.values()].some(list => list.some(d => d.private))) {
    return []
  }

  const deckOf = deckOfList(decks)
  // a same-arity typed overload group is bound to its first member until the checker picks one by argument type,
  // so a reference to the group may mean any member
  const candidates = (name: string): Definition[] => {
    const members = groups.find(group => group.name === name)?.members

    return members ? members.flatMap(member => byName.get(member) ?? []) : (byName.get(name) ?? [])
  }

  const diagnostics: Diagnostic[] = []
  const told = new Set<string>()

  for (const top of program) {
    const from = top.span.file ?? file

    eachReference(top, variable => {
      if (variable.binding?.kind !== 'function') {
        return
      }

      const definitions = candidates(variable.name)

      if (definitions.length === 0 || definitions.some(d => visible(d, from, deckOf))) {
        return
      }

      const key = `${from}\u0000${variable.name}`

      if (told.has(key)) {
        return
      }

      told.add(key)
      // an overload is renamed `name__<arity>`; the message names it as written
      const written = variable.name.replace(/__.*$/, '')
      diagnostics.push(refusal(written, definitions, from, variable.span, 'use'))
    })
  }

  return diagnostics
}

// `note private` on a task in this compile's own file: the old spelling, honored and warned about
export function warnPrivateNotes(program: Program, file: string): Diagnostic[] {
  const stamped = program.some(s => s.span.file !== undefined)

  return program
    .filter(
      (s): s is Definition =>
        s.form === 'function' && s.privateNote !== undefined && (stamped ? s.span.file === file : true),
    )
    .map(s =>
      diagnose('note-private', {
        file,
        span: { ...s.privateNote!, file },
        message: `\`note private\` on "${s.name.replace(/__.*$/, '')}" is the old spelling of \`mark private\``,
        hint: 'write `mark private`: privacy is a mark the compiler enforces, and a `note` is documentation',
      }),
    )
}
