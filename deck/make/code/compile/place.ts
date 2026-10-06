// F4 (note/term/codegen/readme.md): a record in a list, updated IN PLACE. The value semantics (D1) say
//
//   save b, call get(bodies, i)
//   save bodies/{i}, make body / bind x, read b/x / bind vx, <new> / ...
//
// builds a new record and puts it in the slot. On TypeScript and Kotlin, where a record is an object, that is one
// allocation per write: n-body writes 25 per step, and ran at 4.5 times its hand-written twin on TypeScript, which
// writes `b.vx -= ...`. The write may assign the changed fields of the object already in the slot instead, when no
// one can see the difference: nothing else holds that object, and nothing reads the old value of a changed field
// after the write. Two facts decide it.
//
// 1. A form's values are SLOT-PRIVATE (`privateForms`): a value of the form only ever lives in one place. It is made
//    fresh (a `make`, or a task every return of which is one), enters a list only fresh (a push, a slot write, a list
//    literal), leaves one only into a local, a field read or a `send back`, and is never copied to a second name,
//    passed (unless fresh), captured, nested in another type or written field by field. And every list of the form is
//    an owned local or a lent parameter (F1's facts), so no list of it is ever copied either: a copy would share its
//    elements. Then an element of a list is held by that list's slot and by locals read out of it, and by nothing else.
//
// 2. A write is IN PLACE (`placeWrites`): `bodies/{i}` gets a `make` of the form, and an earlier local in the same
//    block, `b`, was read from `bodies/{i}` with the same index, with nothing between that could have changed the
//    slot, the list or the index. The `make`'s fields that are `b/<same field>` are unchanged; the rest are assigned
//    on `b`. After the write, `b` may be read only for an unchanged field, and so may any other local read from the
//    same list, unless its index is provably a different one (`j` made as `i + 1` and only ever counted up, with `i`
//    not written meanwhile: the pair loop of every n-body). Otherwise the write stays a `make`.
//
// RECORD REUSE (`recordReuse`, Perceus's in-place update, for the backends whose records are objects): AWFY's Bounce
// writes every ball back through a task that answers a new one (`host moved, call move-ball(balls/{k})` / `save
// balls/{k}, read moved/ball`), and on Kotlin each new ball stored into the list was the cost, 614 ms against 198 with
// the ball changed in place (the hand version 151, `tmp/kotlin-bounce-ab.ts`). An ELIGIBLE task takes one record of a
// plain form F (the others scalars), reads it only by field, and every return is a `make F`, or a `make G` of a CARRIER
// form whose one field of type F is a `make F` and whose other fields are scalars. A REUSE SITE passes `xs/{i}` there and
// writes `xs/{i}` with the result at once, in the same statement or the next one from the carrier's field. F, and the
// carrier, must still be slot-private with those places allowed. A site calls the task's reusing copy (`<task>-reuse`).
//
// SLOT LOCALS (`valuePlaces`, Swift, where a record is a value and holding one copies it): a `let` read from a slot
// whose every later use is a field read the slot itself answers the same is read through the slot, no copy made
// (n-body on Swift: 202 ms to 161, the hand version 155, `tmp/swift-nbody-variants.ts`).
//
// Rust and Swift do not read the writes: a Rust or Swift record is a value already, and a slot write allocates nothing.
//
// The analyses are Term, compile/places.tree over compile/place-walk.tree's table of places (self-hosting, 2026-10-06),
// and its header says how a node stands in for its identity there. This face walks the program once per answer,
// numbers each place by the object it holds (a compiled program shares nodes, and the original kept facts by object),
// hands F1's facts in as the port's tables, and makes the `Map`s, `WeakMap`s and `WeakSet`s of the nodes the port
// answers, which are the program's own objects.

import type { Expression, Program, Statement, Type } from '@term/make/code/compile/node'
import type { Lend } from '@term/make/code/compile/backend'
import { walkProgram } from '@term/make/code/compile/place-walk'
import * as places from '@term/make/code/compile/places'

// one write made in place: the local that holds the slot's object, and the fields it assigns, in the `make`'s order.
// `temps` when a value reads something an earlier assignment of the same write changes, so every value is computed
// first
export type PlaceWrite = { local: string; fields: { name: string; value: Expression }[]; temps: boolean }

// a slot local read through its slot: the list and the index it was read at
export type SlotLocal = { list: Expression; index: Expression }

export type Reuse = {
  // each reusing task: the parameter position, its form, and the record nodes of its returns the copy builds in place.
  // With a carrier of two fields, `keep` is the other one (a scalar) and `carriers` its returned records: the copy
  // answers that field alone, since the record it built is already back in the caller's slot
  tasks: Map<string, { param: number; form: string; builds: WeakSet<object>; keep?: { field: string; type: Type }; carriers?: WeakSet<object> }>
  // with a kept field: each carrier `let` at a site, to the field it now holds alone, and each write-back, which the
  // copy has already made
  locals: WeakMap<object, string>
  writeBacks: WeakSet<object>
  // each call made at a reuse site
  sites: WeakSet<object>
  // the forms some copy assigns in place (Kotlin declares their fields `var`)
  forms: Set<string>
}

const flags = (names: Iterable<string>): Map<string, boolean> => new Map([...names].map(name => [name, true]))

// the program as compile/place-walk.tree's table of places, each numbered by the first place holding the same object.
// compile/backend.ts `ownedElements` reads the same
export function numberedWalk(program: Program): { w: ReturnType<typeof walkProgram>; ids: number[] } {
  const w = walkProgram(program as never)
  const first = new Map<object, number>()
  const ids = w.handles.map((handle, row) => {
    const node = handle.node as object
    const id = first.get(node)

    if (id !== undefined) {
      return id
    }

    first.set(node, row)

    return row
  })

  return { w, ids }
}

function scopeOf(program: Program): places.PlaceScope {
  const { w, ids } = numberedWalk(program)

  return places.scopeOf(w, ids)
}

const writesOf = (written: places.Written[]): Map<Statement, PlaceWrite> =>
  new Map(written.map(one => [one.node as Statement, one.write as unknown as PlaceWrite]))

// both facts for a whole program, as an emitter reads them: the writes made in place, and the forms some write
// updates (Kotlin declares their fields `var`)
export function recordPlaces(program: Program): { writes: Map<Statement, PlaceWrite>; forms: Set<string> } {
  const answer = places.recordPlaces(scopeOf(program))

  return { writes: writesOf(answer.writes), forms: new Set(answer.forms) }
}

// the same for a backend whose records are VALUES (Swift's structs): no form needs to be slot-private, since a copy
// held elsewhere cannot see a write, so every plain record form is read for its writes and its slot locals
export function valuePlaces(program: Program): { writes: Map<Statement, PlaceWrite>; locals: Map<Statement, SlotLocal> } {
  const answer = places.valuePlaces(scopeOf(program))

  return {
    writes: writesOf(answer.writes),
    locals: new Map(answer.locals.map(one => [one.node as Statement, one.local as unknown as SlotLocal])),
  }
}

// the forms whose values are slot-private (fact 1)
export function privateForms(
  program: Program,
  lend: Map<string, Map<number, Lend>>,
  fresh: Set<string>,
  // told each refusal, with the task it is in and the rule that refused, for a test or a probe to say why
  explain?: (form: string, where: string) => void,
  // the places a record reuse needs: nodes judged as allowed where they stand, and the CARRIER forms, whose field of a
  // candidate form does not make that form nested
  allow?: { nodes: WeakSet<object>; carriers: Set<string> },
): Set<string> {
  const scope = scopeOf(program)
  const allowed = new Map<number, boolean>()

  if (allow) {
    scope.w.handles.forEach((handle, row) => {
      if (allow.nodes.has(handle.node as object)) {
        allowed.set(scope.ids[row]!, true)
      }
    })
  }

  const answer = places.privateForms(scope, lend as never, flags(fresh), allowed, flags(allow?.carriers ?? []))

  if (explain) {
    for (let at = 0; at + 1 < answer.told.length; at += 2) {
      explain(answer.told[at]!, answer.told[at + 1]!)
    }
  }

  return new Set(answer.forms)
}

export function recordReuse(program: Program): Reuse {
  const answer = places.recordReuse(scopeOf(program))
  const tasks: Reuse['tasks'] = new Map()

  for (const task of answer.tasks) {
    tasks.set(task.name, {
      param: task.param,
      form: task.form,
      builds: new WeakSet(task.builds as object[]),
      ...(task.keepField ? { keep: { field: task.keepField, type: task.keepType as Type }, carriers: new WeakSet(task.carriers as object[]) } : {}),
    })
  }

  const locals = new WeakMap<object, string>()

  for (const local of answer.locals) {
    locals.set(local.node as object, local.field)
  }

  return {
    tasks,
    sites: new WeakSet(answer.sites as object[]),
    forms: new Set(answer.forms),
    locals,
    writeBacks: new WeakSet(answer.writeBacks as object[]),
  }
}

// the slot writes made in place (fact 2), for the forms `privateForms` answers. With `locals`, also the SLOT LOCALS
export function placeWrites(
  program: Program,
  forms: Set<string>,
  locals?: Map<Statement, SlotLocal>,
): Map<Statement, PlaceWrite> {
  const answer = places.placeWrites(scopeOf(program), [...forms], locals !== undefined)

  for (const one of answer.locals) {
    locals?.set(one.node as Statement, one.local as unknown as SlotLocal)
  }

  return writesOf(answer.writes)
}
