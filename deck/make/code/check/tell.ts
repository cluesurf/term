// The app's `tell` decisions, checked. A `tell @deck/form` must name an exception this program can raise from one
// of its own tasks or routes (a stale or misspelled entry is the failure the mesh table had), each `link` must be a
// prop that exception declares, one exception is told once, and two told exceptions may not share a wire name.
// See note/term/hive/06-tell.md. Pure over the program.

import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import type { Program, Statement } from '@term/make/code/compile/node'
import { raiseSets } from '@term/make/code/check/effects'
import { EXCEPTION_FORM } from '@term/make/code/check/extend'
import { deckFromPath } from '@term/make/code/compile/roll'

export function checkTells(
  program: Program,
  file: string,
  deckOf?: (file: string) => { name: string; root: string } | undefined,
): Diagnostic[] {
  const tells = program.filter(
    (s): s is Extract<Statement, { form: 'tell' }> => s.form === 'tell',
  )

  if (tells.length === 0) {
    return []
  }

  const diagnostics: Diagnostic[] = []
  const fileOf = (s: Statement): string => s.span.file ?? file
  const hostOf = (s: Statement): string =>
    deckOf?.(fileOf(s))?.name ?? deckFromPath(fileOf(s))

  type RecordType = Extract<Statement, { form: 'record-type' }>
  const types = new Map<string, RecordType>()
  const exceptions = new Map<string, RecordType>()

  for (const s of program) {
    if (s.form === 'record-type') {
      types.set(s.name, s)

      if (s.chain?.includes(EXCEPTION_FORM)) {
        exceptions.set(`${hostOf(s)}/${s.name}`, s)
      }
    }
  }

  // what the entry's own tasks and every route can raise
  const sets = raiseSets(program, new Set([...exceptions.values()].map(e => e.name)))
  const reachable = new Set<string>()

  for (const s of program) {
    if (s.form === 'function' && fileOf(s) === file) {
      for (const name of sets.raises.get(s.name) ?? []) {
        reachable.add(name)
      }
    }

    if (s.form === 'dock') {
      const walk = (route: (typeof s)['route']): void => {
        for (const call of [
          ...route.calls,
          ...route.methods.flatMap(m => m.calls),
        ]) {
          for (const name of sets.raises.get(call.name) ?? []) {
            reachable.add(name)
          }
        }

        route.children.forEach(walk)
      }

      walk(s.route)
    }
  }

  const told = new Map<string, Statement>()
  const wire = new Map<string, Statement>()

  for (const tell of tells) {
    const error = (message: string): void => {
      diagnostics.push(
        diagnose('type-mismatch', { file: fileOf(tell), span: tell.span, message }),
      )
    }

    const exception = exceptions.get(tell.name)

    if (!exception) {
      const bare = tell.name.slice(tell.name.lastIndexOf('/') + 1)
      const candidates = [...exceptions.keys()].filter(k => k.endsWith(`/${bare}`))

      error(
        candidates.length
          ? `"${tell.name}" is not an exception in this build. Did you mean ${candidates.join(' or ')}?`
          : `"${tell.name}" is not an exception in this build`,
      )
      continue
    }

    if (!reachable.has(exception.name)) {
      error(
        `"${tell.name}" is declared but nothing in this program can raise it, so this tell is stale`,
      )
    }

    if (told.has(tell.name)) {
      error(`"${tell.name}" is told twice`)
    }

    told.set(tell.name, tell)

    if (tell.note === undefined) {
      error(`"${tell.name}" is told without a note (\`note <...>\`)`)
    }

    const props = exception.props ? types.get(exception.props) : undefined
    const propNames = new Set((props?.fields ?? []).map(f => f.name))

    for (const link of tell.links) {
      if (!propNames.has(link)) {
        error(
          `"${tell.name}" has no prop "${link}"${
            propNames.size ? ` (it has ${[...propNames].join(', ')})` : ''
          }`,
        )
      }
    }

    const name = tell.alias ?? exception.name
    const other = wire.get(name)

    if (other && other.form === 'tell') {
      error(
        `"${tell.name}" and "${other.name}" would both be "${name}" on the wire. Give one a \`name\``,
      )
    }

    wire.set(name, tell)
  }

  return diagnostics
}
