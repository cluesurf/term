// `term show name <name>`: one name of the project with what a reader needs around it, sized to a token budget. An
// agent asks this instead of searching and reading whole files: the definition and its doc comment, the forms its
// signature names, every place in the project that uses it, and the heads of what it calls, in that order, each part
// taken while the budget lasts and what did not fit counted.
//
// Everything is read with the one parser and the mill (make/code/analyze.ts), the doc comment from the parse tree's
// own comments, as hover reads it. Each file is milled alone, which is all a definition and a use need: no build, no
// cache, and a file that does not compile still answers for the parts that mill.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { analyze } from '@term/make/code/analyze'
import type { Expression, Program, Statement, Type } from '@term/make/code/compile/node'
import { importFindsOf, makeParseMemo } from '@term/make/code/compile/load'
import { spanOfNode } from '@term/make/code/compile/mill-run'
import { withNativeEnv } from '@term/make/code/compile/native'
import { isBinaryBuiltin, isUnaryBuiltin } from '@term/make/code/compile/surface'
import { groupsOf } from '@term/make/code/parser/narrow'
import { parseTolerant } from '@term/make/code/parser/tree'
import { findModulesExporting } from '@term/make/code/resolve'
import { forEachCall, forEachExpression, writtenName } from '@term/flow/code/symbols'
import { projectDeckOf } from '@term/call/code/deck-of'
import { findTreeFiles, projectResolver } from '@term/call/code/make'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'
import { closeRun, field, openRun, printData, report } from '@term/call/code/output'

// what one token is taken to be, in characters: the usual measure for English and code
const CHARACTERS_PER_TOKEN = 4
const DEFAULT_BUDGET = 4000

// a definition's kind as the source writes it
const KINDS: Partial<Record<Statement['form'], string>> = {
  function: 'task',
  'record-type': 'form',
  mask: 'mask',
  bind: 'bind',
  view: 'view',
}

type Milled = { file: string; text: string; lines: string[]; program: Program }

type Definition = {
  name: string
  kind: string
  // where it is: a path under the project, or the import path of the module that holds it
  place: string
  line: number
  doc?: string
  head: string
  text: string
}

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

  printData(input.json ? `${JSON.stringify(slice)}\n` : renderContext(slice))
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
      const use = (line: number): void => {
        const key = `${file}:${line}:${owner}`

        if (!seen.has(key)) {
          seen.add(key)
          uses.push({ in: owner, place: placeOf(file), line: line + 1 })
        }
      }

      // a form named in a task's signature (`like post`) is a use of the form, at the task
      if (statement.form === 'function' && statementName(statement) !== query) {
        const named = new Set<string>()

        statement.params.forEach(param => typeNames(param.type, named))
        typeNames(statement.result, named)

        if (named.has(query)) {
          use(statement.span.start.line)
        }
      }

      forEachExpression([statement], node => {
        if (names(node, query)) {
          use(node.span.start.line)
        }
      })
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
    const named = new Set<string>()

    if (mainStatement.form === 'function') {
      for (const param of mainStatement.params) {
        typeNames(param.type, named)
      }

      typeNames(mainStatement.result, named)
    }

    for (const name of named) {
      const found = name === query ? undefined : lookup(name, mainMilled)

      if (found && found.kind === 'form') {
        forms.push(found)
      }
    }

    const called = new Set<string>()

    forEachCall([mainStatement], call => {
      if (call.callee.form === 'variable') {
        const name = writtenName(call.callee.name)

        if (name !== query && !isBinaryBuiltin(name) && !isUnaryBuiltin(name)) {
          called.add(name)
        }
      }
    })

    for (const name of called) {
      const found = lookup(name, mainMilled)

      if (found) {
        calls.push(found)
      } else {
        unresolved.push(name)
      }
    }
  }

  return fit({ name: query, budget, definitions, forms, uses, calls, unresolved })
}

// ---- the budget ----

// a definition as the answer carries it: where it is, its doc comment, and the text shown
type Shown = { name: string; kind: string; place: string; line: number; doc?: string; text: string }

function shownOf(one: Definition, text: string): Shown {
  return { name: one.name, kind: one.kind, place: one.place, line: one.line, ...(one.doc ? { doc: one.doc } : {}), text }
}

// take each part in order while it fits: every definition (whole when it takes no more than half the budget, else its
// head, else its place alone), then the forms, the uses and the heads of the calls. A part that does not fit is counted,
// never cut mid-way. A definition is always named, so a small budget never reads as a name that does not exist
function fit(input: {
  name: string
  budget: number
  definitions: Definition[]
  forms: Definition[]
  uses: Use[]
  calls: Definition[]
  unresolved: string[]
}): ContextSlice {
  const limit = input.budget * CHARACTERS_PER_TOKEN
  let used = 0
  const omitted = { forms: 0, uses: 0, calls: 0, bodies: 0 }
  const take = (size: number): boolean => {
    if (used + size > limit) {
      return false
    }

    used += size

    return true
  }

  const definitions: ContextSlice['definitions'] = []

  for (const one of input.definitions) {
    const around = (one.doc?.length ?? 0) + one.place.length + 32

    if (one.text.length + around <= limit / 2 && take(one.text.length + around)) {
      definitions.push({ ...shownOf(one, one.text), shown: 'whole' })
    } else if (take(one.head.length + around)) {
      omitted.bodies += 1
      definitions.push({ ...shownOf(one, one.head), shown: 'head' })
    } else {
      omitted.bodies += 1
      used += one.place.length + 32
      definitions.push({ name: one.name, kind: one.kind, place: one.place, line: one.line, text: '', shown: 'place' })
    }
  }

  const keep = <T>(items: T[], size: (item: T) => number, part: 'forms' | 'uses' | 'calls'): T[] => {
    const kept: T[] = []

    for (const item of items) {
      if (take(size(item))) {
        kept.push(item)
      } else {
        omitted[part] += 1
      }
    }

    return kept
  }

  const forms = keep(input.forms, form => form.text.length + form.place.length + 32, 'forms').map(form => shownOf(form, form.text))
  const uses = keep(input.uses, use => use.in.length + use.place.length + 12, 'uses')
  const calls = keep(input.calls, call => call.head.length + call.place.length + 32, 'calls').map(call => shownOf(call, call.head))

  used += input.unresolved.join(', ').length

  return {
    name: input.name,
    budget: input.budget,
    used: Math.ceil(used / CHARACTERS_PER_TOKEN),
    definitions,
    forms,
    uses,
    calls,
    unresolved: input.unresolved,
    omitted,
  }
}

// ---- reading a definition ----

function statementName(statement: Statement): string | undefined {
  const name = (statement as { name?: unknown }).name

  return typeof name === 'string' ? writtenName(name) : undefined
}

// the definition a statement makes of `name`, with its doc comment, its head and its whole text, or undefined
function definitionOf(one: Milled, statement: Statement, name: string, place: string): Definition | undefined {
  const kind = KINDS[statement.form]

  if (!kind || statementName(statement) !== name) {
    return undefined
  }

  const span = statement.span
  const text = trimEnd(one.lines.slice(span.start.line, span.end.line + 1))
  const body = statement.form === 'function' ? statement.body : []
  const bodyLine = body.length ? Math.min(...body.map(each => each.span.start.line)) : undefined
  const head = bodyLine !== undefined && bodyLine > span.start.line ? trimEnd(one.lines.slice(span.start.line, bodyLine)) : text

  return { name, kind, place, line: span.start.line + 1, doc: docAt(one, span.start.line), head, text }
}

// the doc comment of the top-level definition on a line: the `#` lines the parser keeps on its group, the `#` and one
// space taken off each, as hover reads it (flow/code/server.ts `docCommentAt`)
function docAt(one: Milled, line: number): string | undefined {
  const group = groupsOf(parseTolerant({ file: one.file, text: one.text }).tree.nodes).find(node => spanOfNode(node)?.start.line === line)
  const note = (group?.comments ?? [])
    .map(comment => comment.text.replace(/^#\s?/, '').trim())
    .filter(Boolean)
    .join(' ')

  return note || undefined
}

function trimEnd(lines: string[]): string {
  const kept = [...lines]

  while (kept.length && kept[kept.length - 1]!.trim() === '') {
    kept.pop()
  }

  return kept.join('\n')
}

// whether an expression names `name`: a call of it, a read of it as a value, a `make` of it
function names(node: Expression, name: string): boolean {
  if (node.form === 'call') {
    return node.callee.form === 'variable' && writtenName(node.callee.name) === name
  }

  if (node.form === 'variable') {
    return writtenName(node.name) === name
  }

  return node.form === 'record' && node.name === name
}

// every form name a type mentions, its arguments included
function typeNames(type: Type | undefined, out: Set<string>): void {
  if (!type) {
    return
  }

  switch (type.kind) {
    case 'named':
      out.add(type.name)
      type.args?.forEach(arg => typeNames(arg, out))
      break
    case 'array':
      typeNames(type.element, out)
      break
    case 'map':
      typeNames(type.key, out)
      typeNames(type.value, out)
      break
    case 'function':
      type.params.forEach(param => typeNames(param, out))
      typeNames(type.result, out)
      break
    default:
      break
  }
}

// ---- the human view ----

function renderContext(slice: ContextSlice): string {
  const out: string[] = []

  for (const one of slice.definitions) {
    out.push(`${one.kind} ${one.name}, ${one.place}:${one.line}`)

    if (one.doc) {
      out.push(`# ${one.doc}`)
    }

    if (one.text) {
      out.push(one.text)
    }

    if (one.shown !== 'whole') {
      out.push(one.shown === 'head' ? '  (its body did not fit the budget)' : '  (its text did not fit the budget)')
    }

    out.push('')
  }

  if (slice.forms.length) {
    out.push(`forms its signature names: ${slice.forms.length}`)

    for (const form of slice.forms) {
      out.push(`${form.place}:${form.line}`, form.text, '')
    }
  }

  out.push(`used by: ${slice.uses.length}${slice.omitted.uses ? ` shown, ${slice.omitted.uses} more` : ''}`)

  for (const use of slice.uses) {
    out.push(`  ${use.in}  ${use.place}:${use.line}`)
  }

  out.push('')

  if (slice.calls.length) {
    out.push(`calls: ${slice.calls.length}`)

    for (const call of slice.calls) {
      out.push(`${call.place}:${call.line}`, call.text, '')
    }
  }

  if (slice.unresolved.length) {
    out.push(`calls that nothing it loads defines: ${slice.unresolved.join(', ')}`, '')
  }

  const left = Object.entries(slice.omitted).filter(([, count]) => count > 0)

  out.push(
    `${slice.used} of ${slice.budget} tokens` +
      (left.length ? `, left out: ${left.map(([part, count]) => `${count} ${part === 'bodies' ? (count === 1 ? 'body' : 'bodies') : part}`).join(', ')}` : ''),
  )

  return `${out.join('\n')}\n`
}
