// F4 (note/project/term/compiler/codegen/readme.md): a record in a list, updated IN PLACE, the write assigning the
// changed fields of the object already in the slot when no one can see the difference. Two facts decide it: a form's
// values are SLOT-PRIVATE (`privateForms`, fact 1) and a write is IN PLACE (`placeWrites`, fact 2). RECORD REUSE
// (`recordReuse`, Perceus's in-place update) lets a task build its answer in the record it was handed, and SLOT LOCALS
// (`valuePlaces`, Swift) read a record through its slot with no copy. Rust and Swift do not read the writes. Why each
// rule is shaped as it is: compile/places.tree's header and its tasks.
//
// The analyses are Term, compile/places.tree over compile/place-walk.tree's table of places. They run on the program
// STAMPED (compile/places-stamped.tree, item term-self-host-001-0081, decision 011): every place is a node of its own,
// so a node's identity is its `place-row`. The statements these answers key are the stamped program's, and the nodes
// record reuse names are place rows, where this face answered `WeakSet`s of the program's own objects.

import type {
  Expression,
  Program,
  Statement,
  Type,
} from '@term/make/code/compile/node'
import type { Lend } from '@term/make/code/compile/backend'
import * as places from '@term/make/code/compile/places'
import {
  stampedScope,
  rowsOfReuse,
} from '@term/make/code/compile/places-stamped'

// one write made in place: the local that holds the slot's object, and the fields it assigns, in the `make`'s order.
// `temps` when a value reads something an earlier assignment of the same write changes, so every value is computed
// first
export type PlaceWrite = {
  local: string
  fields: { name: string; value: Expression }[]
  temps: boolean
}

// a slot local read through its slot: the list and the index it was read at
export type SlotLocal = { list: Expression; index: Expression }

export type Reuse = {
  // each reusing task: the parameter position, its form, and the place rows of the records its returns build in place.
  // With a carrier of two fields, `keep` is the other one (a scalar) and `carriers` the rows of its returned records:
  // the copy answers that field alone, since the record it built is already back in the caller's slot
  tasks: Map<
    string,
    {
      param: number
      form: string
      builds: Set<number>
      keep?: { field: string; type: Type }
      carriers?: Set<number>
    }
  >
  // with a kept field: the row of each carrier `let` at a site, to the field it now holds alone, and of each
  // write-back, which the copy has already made
  locals: Map<number, string>
  writeBacks: Set<number>
  // the row of each call made at a reuse site
  sites: Set<number>
  // the forms some copy assigns in place (Kotlin declares their fields `var`)
  forms: Set<string>
}

const flags = (names: Iterable<string>): Map<string, boolean> =>
  new Map([...names].map(name => [name, true]))

const writesOf = (
  written: places.Written[],
): Map<Statement, PlaceWrite> =>
  new Map(
    written.map(one => [
      one.node as Statement,
      one.write as unknown as PlaceWrite,
    ]),
  )

// both facts for a whole program, as an emitter reads them: the writes made in place, and the forms some write
// updates (Kotlin declares their fields `var`)
export function recordPlaces(program: Program): {
  writes: Map<Statement, PlaceWrite>
  forms: Set<string>
} {
  const answer = places.recordPlaces(stampedScope(program as never))

  return {
    writes: writesOf(answer.writes),
    forms: new Set(answer.forms),
  }
}

// the same for a backend whose records are VALUES (Swift's structs): no form needs to be slot-private, since a copy
// held elsewhere cannot see a write, so every plain record form is read for its writes and its slot locals
export function valuePlaces(program: Program): {
  writes: Map<Statement, PlaceWrite>
  locals: Map<Statement, SlotLocal>
} {
  const answer = places.valuePlaces(stampedScope(program as never))

  return {
    writes: writesOf(answer.writes),
    locals: new Map(
      answer.locals.map(one => [
        one.node as Statement,
        one.local as unknown as SlotLocal,
      ]),
    ),
  }
}

// the forms whose values are slot-private (fact 1)
export function privateForms(
  program: Program,
  lend: Map<string, Map<number, Lend>>,
  fresh: Set<string>,
  // told each refusal, with the task it is in and the rule that refused, for a test or a probe to say why
  explain?: (form: string, where: string) => void,
  // the places a record reuse needs: the place rows judged as allowed where they stand, and the CARRIER forms, whose
  // field of a candidate form does not make that form nested
  allow?: { rows: Set<number>; carriers: Set<string> },
): Set<string> {
  // a place row is its walk row plus one, and the scope numbers each place by its walk row
  const allowed = new Map(
    [...(allow?.rows ?? [])].map(row => [row - 1, true]),
  )

  const answer = places.privateForms(
    stampedScope(program as never),
    lend as never,
    flags(fresh),
    allowed,
    flags(allow?.carriers ?? []),
  )

  for (let at = 0; explain && at + 1 < answer.told.length; at += 2) {
    explain(answer.told[at]!, answer.told[at + 1]!)
  }

  return new Set(answer.forms)
}

export function recordReuse(program: Program): Reuse {
  const answer = rowsOfReuse(
    places.recordReuse(stampedScope(program as never)),
  )

  const tasks: Reuse['tasks'] = new Map()

  for (const task of answer.tasks) {
    tasks.set(task.name, {
      param: task.param,
      form: task.form,
      builds: new Set(task.builds),
      ...(task.keepField
        ? {
            keep: {
              field: task.keepField,
              type: task.keepType as Type,
            },
            carriers: new Set(task.carriers),
          }
        : {}),
    })
  }

  return {
    tasks,
    sites: new Set(answer.sites),
    forms: new Set(answer.forms),
    locals: new Map(answer.locals.map(one => [one.row, one.field])),
    writeBacks: new Set(answer.writeBacks),
  }
}

// the slot writes made in place (fact 2), for the forms `privateForms` answers. With `locals`, also the SLOT LOCALS
export function placeWrites(
  program: Program,
  forms: Set<string>,
  locals?: Map<Statement, SlotLocal>,
): Map<Statement, PlaceWrite> {
  const answer = places.placeWrites(
    stampedScope(program as never),
    [...forms],
    locals !== undefined,
  )

  for (const one of answer.locals) {
    locals?.set(
      one.node as Statement,
      one.local as unknown as SlotLocal,
    )
  }

  return writesOf(answer.writes)
}
