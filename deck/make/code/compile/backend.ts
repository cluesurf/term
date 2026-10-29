// The facts every native backend reads alike (self-hosting, item term-self-host-001-0068). Each is Term: the shapes
// (compile/backend-shapes.tree), the names and simple shapes (compile/backend-names.tree), the lending family
// (compile/backend-lending.tree), the copies and text cursors (compile/backend-copies.tree), the generated and fixed
// lists (compile/backend-loops.tree) and the tail calls (compile/backend-reads.tree). The four program emitters
// (rust-, swift-, kotlin- and ts-program.tree) call them directly and key every node fact by its place row. This face
// keeps the names the remaining TypeScript callers import (compile/wgsl.ts, compile/proven.ts, the tests and
// task/term/step-census.ts) and hands each answer through as the port gives it: no answer is keyed by a node's object.
// The face before the collapse is tmp/retired/make/compile/backend-face.ts.

import type {
  Expression,
  Statement,
  Type,
} from '@term/make/code/compile/node'
import * as shapes from '@term/make/code/compile/backend-shapes'
import * as names from '@term/make/code/compile/backend-names'
import * as lending from '@term/make/code/compile/backend-lending'
import * as copying from '@term/make/code/compile/backend-copies'
import * as loops from '@term/make/code/compile/backend-loops'
import * as reads from '@term/make/code/compile/backend-reads'

type Task = Extract<Statement, { form: 'function' }>

// how a task takes a list parameter it is lent (`listFacts`)
export type Lend = 'read' | 'write'

// a set as the table of flags the ports read
const flags = (keys: Iterable<string>): never =>
  new Map([...keys].map(key => [key, true])) as never

// Route the `default` branch of a form switch through this: a missing case leaves `node` unnarrowed, so the call fails
// to typecheck. A form that reaches it at run time throws rather than emitting wrong code.
export function exhausted(node: never): never {
  throw new Error(
    `backend: unhandled AST form ${JSON.stringify((node as { form?: unknown }).form)}`,
  )
}

// the marker a target writes for a form it cannot express, a comment in its own syntax (SEED-UNSUPPORTED)
export function unsupported(
  target: string,
  form: string,
  comment: string,
): string {
  return shapes.unsupported(target, form, comment)
}

// the forms whose values cross into native code, and every form they hold
export function nativeForms(program: Statement[]): Set<string> {
  return new Set(lending.nativeForms(program as never))
}

// the variant fields of list type that own their list, keyed `variant/field`
export function ownedFields(
  program: Statement[],
  fresh: Set<string>,
  lend: Map<string, Map<number, Lend>>,
  slotPrivate = new Set<string>(),
): Set<string> {
  return new Set(
    lending.ownedFields(
      program as never,
      flags(fresh),
      lend as never,
      flags(slotPrivate),
    ),
  )
}

// the tasks a backend may change the signature of; `refuse` names the trait methods
export function gatedTasks(
  program: Statement[],
  refuse: Set<string>,
): Task[] {
  return names.gatedTasks(program as never, [...refuse]) as Task[]
}

// which list parameter each gated task takes lent, and which tasks answer a fresh list
export function listFacts(
  program: Statement[],
  gated: Task[],
): { lend: Map<string, Map<number, Lend>>; fresh: Set<string> } {
  const facts = lending.listFactsOf(program as never, gated as never)

  return {
    lend: facts.lend as Map<string, Map<number, Lend>>,
    fresh: new Set(facts.fresh),
  }
}

// the list parameters each task takes lent, with the gate every emitter uses: a trait's methods are never lent
export function lentLists(
  program: Statement[],
): Map<string, Map<number, Lend>> {
  return listFacts(
    program,
    gatedTasks(
      program,
      new Set(
        program.flatMap(n => (n.form === 'mask' ? n.methods : [])),
      ),
    ),
  ).lend
}

// the lists a backend may hold as a plain primitive array, locals by task and lent parameters by position
export function fixedLists(
  program: Statement[],
  lend: Map<string, Map<number, Lend>>,
  fresh: Set<string>,
  element: (type: Type) => boolean,
  generated = false,
): {
  locals: Map<string, Set<string>>
  params: Map<string, Set<number>>
} {
  const fixed = loops.fixedListsOf(
    program as never,
    lend as never,
    flags(fresh),
    element as never,
    generated,
  )

  return {
    locals: new Map(
      [...fixed.locals].map(([name, held]) => [
        name,
        new Set(held.keys()),
      ]),
    ),
    params: new Map(
      [...fixed.params].map(([name, at]) => [name, new Set(at.keys())]),
    ),
  }
}

// the tasks whose every self call is a tail call, each to the `return`s that make one
export function tailTasks(
  program: Statement[],
): Map<string, Statement[]> {
  return new Map(
    reads
      .tailTasksOf(program as never)
      .map(one => [one.name, one.returns as Statement[]]),
  )
}

// the texts a task reads by position in a loop, and each read through a cursor with its text's name
export type TextCursors = {
  names: string[]
  reads: { call: Expression; name: string }[]
}

export function textCursors(
  fn: Task,
  ascii: { has(node: object): boolean },
): TextCursors {
  return copying.textCursorsOf(
    fn as never,
    ((node: object) => ascii.has(node)) as never,
  ) as TextCursors
}
