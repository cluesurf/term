// `term show name <name>`: one name of the project with what a reader needs around it, sized to a token budget. An
// agent asks this instead of searching and reading whole files: the definition and its doc comment, the forms its
// signature names, every place in the project that uses it, and the heads of what it calls, in that order, each part
// taken while the budget lasts and what did not fit counted.
//
// Everything is read with the one parser and the mill (make/code/analyze.ts), the doc comment from the parse tree's
// own comments, as hover reads it. Each file is milled alone, which is all a definition and a use need: no build, no
// cache, and a file that does not compile still answers for the parts that mill.
//
// What a definition shows, which expressions use a name, what a task calls, the budget and the text are Term since
// 2026-10-06, call/code/context-slice.tree. This face reads and mills the files, follows the loads, reads a doc
// comment off the parse tree, and sorts the uses by the host's collation, `localeCompare`, which Term has no word for.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { analyze } from '@term/make/code/analyze'
import type { Program, Statement } from '@term/make/code/compile/node'
import { importFindsOf, makeParseMemo } from '@term/make/code/compile/load'
import { spanOfNode } from '@term/make/code/compile/mill-run'
import { withNativeEnv } from '@term/make/code/compile/native'
import { groupsOf } from '@term/make/code/parser/narrow'
import { parseTolerant } from '@term/make/code/parser/tree'
import { findModulesExporting } from '@term/make/code/resolve'
import { projectDeckOf } from '@term/call/code/deck-of'
import { findTreeFiles, projectResolver } from '@term/call/code/make'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'
import { closeRun, field, openRun, printData, report } from '@term/call/code/output'
import * as port from '@term/call/code/context-slice'

const DEFAULT_BUDGET = 4000

type Milled = { file: string; text: string; lines: string[]; program: Program }

type Definition = port.Definition

type Use = { in: string; place: string; line: number }

export async function showContext(input: { root: string; query?: string; json: boolean; budget?: number }): Promise<void> {
  if (!input.query) {
    openRun({ verb: 'show', root: input.root })
    report({ glyph: 'failed', kind: 'problem', subject: 'Which name? term show name <task, form or mask>' })
    closeRun({ verdict: 'Nothing shown', failure: 'usage' })

    return
  }

  const budget = input.budget && input.budget > 0 ? Math.floor(input.budget) : DEFAULT_BUDGET
  const slice = contextOf(input.root, input.query, budget)

  if (!slice.definitions.length) {
    if (input.json) {
      printData(`${JSON.stringify({ error: 'not-found', name: input.query })}\n`)
      process.exitCode = 1

      return
    }

    openRun({ verb: 'show', root: input.root })
    report({ glyph: 'failed', kind: 'problem', subject: `No task, form or mask is named ${input.query} here or in what the project can load`, fields: [field('looked', 'every .tree file of the project, the standard library and link/')] })
    closeRun({ verdict: 'Nothing shown' })

    return
  }

  printData(input.json ? `${JSON.stringify(slice)}\n` : port.renderContext(slice))
}

export type ContextSlice = {
  name: string
  budget: number
  // the tokens the answer takes, by the same measure as the budget
  used: number
  // each definition with what of it is shown: the whole text, the head (its signature lines), or its place alone
  definitions: (Shown & { shown: 'whole' | 'head' | 'place' })[]
  // the forms its signature names, whole
  forms: Shown[]
  uses: Use[]
  // the tasks it calls, each by its head
  calls: Shown[]
  // the tasks it calls that nothing the file reaches defines
  unresolved: string[]
  // what the budget left out, counted by part
  omitted: { forms: number; uses: number; calls: number; bodies: number }
}

export function contextOf(root: string, query: string, budget: number): ContextSlice {
  const roleOf = projectRoleOf(root)
  const leanOf = projectLeanOf(root)
  // `{platform}` filled for node, as `term make` fills it, so a load of a platform module reaches its node file
  const resolve = withNativeEnv('node', projectResolver(root, 'node', root))
  const parsed = makeParseMemo()
  const milled = new Map<string, Milled | undefined>()

  const mill = (file: string, given?: string): Milled | undefined => {
    if (!milled.has(file)) {
      let text = given

      try {
        text ??= readFileSync(file, 'utf8')
      } catch {
        text = undefined
      }

      const program = text === undefined ? null : analyze({ file, text }, { role: roleOf(file), lean: leanOf(file) ?? false }).program

      milled.set(file, text !== undefined && program ? { file, text, lines: text.split('\n'), program } : undefined)
    }

    return milled.get(file)
  }

  // a file's place as a reader names it: its path under the project, else its deck and its path in the deck
  // (`@term/base/code/text/string.tree`), which names the file a line number counts in on every machine
  const deckOf = projectDeckOf()
  const placeOf = (file: string): string => {
    const rel = path.relative(root, file)

    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return rel
    }

    const deck = deckOf(file)

    return deck ? `${deck.name}/${path.relative(deck.root, file).split(path.sep).join('/')}` : file
  }

  const files = findTreeFiles(root).filter(file => file.endsWith('.tree'))
  const holding = files.filter(file => {
    try {
      return readFileSync(file, 'utf8').includes(query)
    } catch {
      return false
    }
  })

  // the file each definition was read from, kept beside it rather than in it: what is printed names a place a reader
  // can follow (a path under the project, or the module path a `load` names), never a machine path
  const fileOf = new WeakMap<Definition, string>()

  const define = (one: Milled, name: string): Definition | undefined => {
    for (const statement of one.program) {
      const found = definitionOf(one, statement, name, placeOf(one.file))

      if (found) {
        fileOf.set(found, one.file)

        return found
      }
    }

    return undefined
  }

  // the definition a module answers for under `name`, as a `load` of it reaches it: its own, else one its `bear`
  // chain passes on
  const inModule = (importPath: string, from: string, name: string, depth = 0): Definition | undefined => {
    const source = resolve(importPath, from)
    const one = source ? mill(source.file, source.text) : undefined

    if (!one || depth > 16) {
      return undefined
    }

    const own = define(one, name)

    if (own) {
      return own
    }

    for (const find of importFindsOf({ file: one.file, text: one.text }, parsed)) {
      const passed = find.bear ? inModule(find.path, one.file, name, depth + 1) : undefined

      if (passed) {
        return passed
      }
    }

    return undefined
  }

  // a name as the file that uses it would reach it: its own definition, then the module its `find` names, then any file
  // of the project that defines it
  const lookup = (name: string, from: Milled): Definition | undefined => {
    const own = define(from, name)

    if (own) {
      return own
    }

    for (const find of importFindsOf({ file: from.file, text: from.text }, parsed)) {
      // by the alias it was found under, or by its own name, which is what the mill writes an aliased call as
      const at = find.names.findIndex((found, index) => (find.aliases[index] ?? found) === name || found === name)
      const found = at < 0 ? undefined : inModule(find.path, from.file, find.names[at]!)

      if (found) {
        return found
      }
    }

    for (const file of files) {
      let text: string

      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }

      const one = text.includes(name) ? mill(file, text) : undefined
      const found = one ? define(one, name) : undefined

      if (found) {
        return found
      }
    }

    return undefined
  }

  // ---- the definitions: in the project, else where the project's own loads reach, else any module that exports it ----

  const definitions: Definition[] = []

  for (const file of holding) {
    const one = mill(file)

    for (const statement of one?.program ?? []) {
      const found = one ? definitionOf(one, statement, query, placeOf(file)) : undefined

      if (found) {
        fileOf.set(found, file)
        definitions.push(found)
      }
    }
  }

  for (const file of definitions.length ? [] : holding) {
    const one = mill(file)
    const found = one ? lookup(query, one) : undefined

    if (found) {
      definitions.push(found)
      break
    }
  }

  for (const home of definitions.length ? [] : findModulesExporting(root, query)) {
    const found = inModule(home.importPath, path.join(root, 'term-show.tree'), query)

    if (found) {
      definitions.push(found)
      break
    }
  }

  // ---- the uses: every call of it, every read of it as a value, every `make` of it, across the project ----

  const uses: Use[] = []
  const seen = new Set<string>()

  for (const file of holding) {
    const one = mill(file)

    for (const statement of one?.program ?? []) {
      const owner = statementName(statement) ?? '(top level)'

      for (const line of port.useLines(statement, query)) {
        const key = `${file}:${line}:${owner}`

        if (!seen.has(key)) {
          seen.add(key)
          uses.push({ in: owner, place: placeOf(file), line: line + 1 })
        }
      }
    }
  }

  uses.sort((a, b) => a.place.localeCompare(b.place) || a.line - b.line)

  // ---- what the first definition reaches: the forms its signature names, and the tasks it calls ----

  const main = definitions[0]
  const mainFile = main ? fileOf.get(main) : undefined
  const mainMilled = mainFile ? mill(mainFile) : undefined
  const mainStatement = mainMilled?.program.find(statement => main && statementName(statement) === main.name && statement.span.start.line + 1 === main.line)

  const forms: Definition[] = []
  const calls: Definition[] = []
  // a task it calls that nothing the file can reach defines: a load that names it from a module without it, or a name
  // no module has. Listed rather than left out, since it is the first thing to fix
  const unresolved: string[] = []

  if (mainStatement && mainMilled) {
    for (const name of port.signatureNames(mainStatement)) {
      const found = name === query ? undefined : lookup(name, mainMilled)

      if (found && found.kind === 'form') {
        forms.push(found)
      }
    }

    for (const name of port.calledNames(mainStatement, query)) {
      const found = lookup(name, mainMilled)

      if (found) {
        calls.push(found)
      } else {
        unresolved.push(name)
      }
    }
  }

  return port.fit(query, budget, definitions, forms, uses, calls, unresolved) as ContextSlice
}

// a definition as the answer carries it: where it is, its doc comment, and the text shown
type Shown = { name: string; kind: string; place: string; line: number; doc?: string; text: string }

// ---- reading a definition ----

function statementName(statement: Statement): string | undefined {
  const name = (statement as { name?: unknown }).name

  return typeof name === 'string' ? port.writtenName(name) : undefined
}

// the definition a statement makes of `name`, with its doc comment, its head and its whole text, or undefined
function definitionOf(one: Milled, statement: Statement, name: string, place: string): Definition | undefined {
  const found = port.definitionOf(one.lines, statement, name, place, line => docAt(one, line) ?? '')

  return found.form === 'some' ? found.value : undefined
}

// the doc comment of the top-level definition on a line: the `#` lines the parser keeps on its group, read as hover
// reads them (flow/code/server.ts `docCommentAt`)
function docAt(one: Milled, line: number): string | undefined {
  const group = groupsOf(parseTolerant({ file: one.file, text: one.text }).tree.nodes).find(node => spanOfNode(node)?.start.line === line)
  const note = port.docText((group?.comments ?? []).map(comment => comment.text))

  return note || undefined
}
