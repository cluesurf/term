import type {
  Expression,
  Program,
  Type,
  Statement,
} from '@term/make/code/compile/node'
import * as shapes from '@term/make/code/compile/backend-shapes'
import * as names from '@term/make/code/compile/backend-names'
import * as lending from '@term/make/code/compile/backend-lending'
import * as copying from '@term/make/code/compile/backend-copies'
import * as loops from '@term/make/code/compile/backend-loops'
import * as reads from '@term/make/code/compile/backend-reads'
import * as elements from '@term/make/code/compile/backend-elements'
import { numberedWalk } from '@term/make/code/compile/place'

// The shapes every backend detects alike (a map's keys or values, a native collection or string call or read, a
// text-valued expression, the names a body reassigns, a `fill` spec, a valued return, the function parameters a task may
// keep, a two-slot swap, a scalar type) are compile/backend-shapes.tree (self-hosting, 2026-10-06). What follows here
// unboxes their answers to the shapes the emitters hold, and keeps the analyses later in this file. The names and simple
// shapes are compile/backend-names.tree, the lending family (`lendableParams` through `listFacts`) is
// compile/backend-lending.tree, the copies (`recordCopies`, `borrowedTexts`, `borrowedRecords`, `textCursors`) are
// compile/backend-copies.tree, `redeclaredLets`, `listGenerator(s)` and `fixedLists` are compile/backend-loops.tree,
// `tailTasks`, `slotTakes` and `lastReads` are compile/backend-reads.tree, and `ownedElements` is
// compile/backend-elements.tree over compile/place-walk.tree's table of places, its nodes numbered as compile/place.ts
// numbers them.

type Maybe<T> = { form: 'some'; value: T } | { form: 'none' }
const unbox = <T>(value: Maybe<T>): T | undefined => (value.form === 'some' ? value.value : undefined)
const boxed = <T>(value: T | undefined): Maybe<T> => (value === undefined ? { form: 'none' } : { form: 'some', value })
// a set as the table of flags compile/backend-lending.tree reads, and a type test as the task it calls with a maybe
const flags = (names: Iterable<string>): never => new Map([...names].map(name => [name, true])) as never
const freeOf = (free: (type: unknown) => boolean): never => ((type: Maybe<unknown>) => free(unbox(type))) as never

// a value the analyses below took as `unknown` (a body, a statement, an expression or a type), as the node handles
// compile/node-children.tree walks from. Statement and expression forms do not share a name
const STATEMENT_FORMS = new Set([
  'let', 'assign', 'expression', 'if', 'while', 'match', 'for-each', 'break', 'continue', 'return', 'exit', 'debug', 'probe',
  'guard', 'throw', 'hold', 'function', 'record-type', 'mask', 'instance', 'native', 'bind', 'view', 'dock', 'roll', 'tell',
])

function handlesOf(value: unknown): never {
  const out: unknown[] = []
  const add = (one: unknown): void => {
    if (Array.isArray(one)) {
      one.forEach(add)
    } else if (one && typeof one === 'object') {
      const node = one as { form?: unknown; kind?: unknown }

      if (typeof node.form === 'string') {
        out.push({ of: STATEMENT_FORMS.has(node.form) ? 'statement-handle' : 'expression-handle', node })
      } else if (typeof node.kind === 'string') {
        out.push({ of: 'type-handle', node })
      }
    }
  }

  add(value)

  return out as never
}

// `keys` / `values` on a map type are stdlib operations that must materialize a list, not return a native iterator.
// Each backend handles the iterator -> list conversion in its own idiom (Array.from, .cloned().collect(), Array(...),
// .toList()), but they all detect the same shape here: a call whose callee is `<map>.keys` or `<map>.values`. Returns
// the receiver expression and the operation name, or undefined when the callee is not a map keys/values access.
export function mapCollect(
  callee: Expression,
): { target: Expression; name: 'keys' | 'values' } | undefined {
  return unbox(shapes.mapCollectOf(callee as never)) as { target: Expression; name: 'keys' | 'values' } | undefined
}

// ---- native collection operations ----
// The stdlib `hash` / `list` forms are written against the JS collection API (`map.set`, `map.has`, `array.push`, ...).
// On a typed backend that vocabulary does not exist verbatim, so each backend lowers these operations to its own
// platform idiom. The shape is detected once, by the receiver's TYPE (a map or an array), and the operation name.
// The receiver type means a user struct with a field called `set` or `size` never matches.
export type CollectionOp = {
  target: Expression
  op: string
  kind: 'map' | 'array'
}

// the extra trait the element type needs for an array op that goes beyond `Clone`: equality (`includes` / `indexOf`)
// or string rendering (`join`). A backend reads this to constrain the element generic of a method that uses the op.
export const ARRAY_OP_BOUND: Record<string, 'eq' | 'display'> = {
  includes: 'eq',
  indexOf: 'eq',
  lastIndexOf: 'eq',
  join: 'display',
}

// a native collection METHOD CALL (`map.set(k, v)`, `array.push(x)`) on a map/array receiver
export function collectionCall(
  callee: Expression,
): CollectionOp | undefined {
  return unbox(shapes.collectionCall(callee as never)) as CollectionOp | undefined
}

export type StringOp = { target: Expression; op: string }

// is the value a text? The primitive, or the stdlib's `text` form named as such
export function isText(type: { kind: string; name?: string } | undefined): boolean {
  return shapes.isText(boxed(type) as never)
}

// a native string METHOD CALL (`value.charAt(i)`) on a text receiver
export function stringCall(callee: Expression): StringOp | undefined {
  return unbox(shapes.stringCall(callee as never)) as StringOp | undefined
}

// is this expression a text: typed one, or a host string method answering one, which the checker leaves `unknown`
// (`char-at`'s body is `value.charAt(index)`, and so is every call of it once inlined)
export function textValued(e: Expression): boolean {
  return shapes.textValued(e as never)
}

// a native string PROPERTY READ (`value.length`) on a text receiver
export function stringRead(node: Expression): StringOp | undefined {
  return unbox(shapes.stringRead(node as never)) as StringOp | undefined
}

// a native collection PROPERTY READ (`map.size`, `array.length`) on a map/array receiver
export function collectionRead(
  node: Expression,
): CollectionOp | undefined {
  return unbox(shapes.collectionRead(node as never)) as CollectionOp | undefined
}

// the names reassigned anywhere in a body. Rust, Swift, and Kotlin parameters are immutable, so a reassigned one is
// shadowed by a mutable local at the top of the function. This descends into closure bodies. A slot of a list or a
// map written by index, or by a literal position, reassigns nothing: every native backend holds those by reference.
// Shared by the three native backends so the analysis cannot drift between them.
export function reassigned(
  body: Statement[],
  into: Set<string>,
): void {
  for (const name of shapes.reassigned(body as never)) {
    into.add(name)
  }
}

// Shared backend machinery. Every code generator must handle every AST form, on every target.
//
// `exhausted` makes that a COMPILE-TIME invariant. Route the `default` branch of any form switch through it: when a
// case is missing, `node` is not narrowed to `never`, so the call fails to typecheck. If a form ever does reach it at
// runtime (e.g. a hand-built AST), it throws loudly rather than emitting silent wrong code.
export function exhausted(node: never): never {
  throw new Error(
    `backend: unhandled AST form ${JSON.stringify(
      (node as { form?: unknown }).form,
    )}`,
  )
}

// A target that cannot express a form (a GPU shader cannot throw; the HVM pure fragment has no stored closures) emits
// this marker instead of silently dropping or miscompiling the construct. The marker is a comment in the target's
// syntax, so the generated source still parses but the gap is visible and greppable (SEED-UNSUPPORTED), never silent.
export function unsupported(
  target: string,
  form: string,
  comment: string,
): string {
  return shapes.unsupported(target, form, comment)
}

// ---- filling a form from data ----

// the shape a `call fill / <data> / like <form>` walks: one entry per field with its kind. A form that reaches itself
// is cut at the second visit and read as `any`. The TypeScript emitter walks the spec at run time; the native
// emitters generate a function per form from it.
export type FormKind =
  | { kind: 'text' | 'number' | 'decimal' | 'flag' | 'data' | 'any' }
  | { kind: 'list'; item: FormKind }
  | { kind: 'form'; spec: FormSpec }

export type FormSpec = { form: string; fields: { name: string; optional: boolean; kind: FormKind }[] }

export type RecordFields = Map<string, { name: string; type: Type; optional?: boolean }[]>

export function formSpec(type: Type, records: RecordFields, seen: Set<string> = new Set()): FormSpec {
  return shapes.formSpecOf(type as never, records as never, [...seen]) as FormSpec
}

export function formKind(type: Type | undefined, records: RecordFields, seen: Set<string>): FormKind {
  return shapes.formKindOf(boxed(type) as never, records as never, [...seen]) as FormKind
}

// every form a spec reaches, the outer one first, each once
export function specForms(spec: FormSpec, into: Map<string, FormSpec> = new Map()): Map<string, FormSpec> {
  for (const one of shapes.specForms(spec as never, [...into.keys()])) {
    into.set(one.form, one as FormSpec)
  }

  return into
}

// a field whose type has no data spelling cannot be filled on a typed backend: the build says which
export function refuseAny(spec: FormSpec, backend: string): void {
  const refused = unbox(shapes.refuseAny(spec as never, backend))

  if (refused !== undefined) {
    throw new Error(refused)
  }
}

// does any path of this body `return <value>`? A task with no declared result but a valued return still
// needs a non-void native result type (the gradual Any / boxed dynamic).
export function hasValuedReturn(body: import('@term/make/code/compile/node').Statement[]): boolean {
  return shapes.hasValuedReturn(body as never)
}

// The function-typed parameters a task may keep past its call (note/term/codegen/passes.md, P3, in its first and
// most conservative form). A parameter stays NON-escaping only when every mention of it is the callee of a call made
// directly in the task's body; anything this cannot see is treated as escaping, so a mistake can only cost the
// optimization and never the build.
export function escapingParams(fn: Extract<Statement, { form: 'function' }>): Set<string> {
  return new Set(shapes.escapingParams(fn as never))
}

// The three-statement swap of two list slots, `save t, read xs/{i}` / `save xs/{i}, read xs/{j}` / `save xs/{j}, read
// t`, with the temporary read nowhere after. Rust writes it as `slice::swap` and Kotlin as `Collections.swap`; Swift
// keeps the three statements (swift.ts, `block`). Returns undefined for anything else, which is then emitted statement
// by statement
export type Swap = { list: Expression; first: Expression; second: Expression; temp: string }

export function swapAt(body: Statement[], at: number): Swap | undefined {
  return unbox(shapes.swapAt(body as never, at)) as Swap | undefined
}

// F1, the first and narrowest slice (note/term/codegen/shared.md): the list PARAMETERS a task may take LENT, as
// `&mut [T]` ('write') or `&[T]` ('read'), where every list is otherwise an `Rc<RefCell<Vec<T>>>` borrowed again at
// each element. The caller lends once for the whole call. A wrong answer here does not merely slow a program down: a
// second name reaching the same list while it is lent panics on its `RefCell`. So it is refused unless nothing else
// in the task CAN reach a list:
//   - every mention of each list parameter is a slot read or write (`xs/{i}`, `xs/0`), its length, the list a walk
//     walks, or an argument at a position another task takes lent (the mode flows back: passed where it is written,
//     it is written here). Never reassigned, stored, returned or captured
//   - every other parameter is a scalar (a number, a float, a flag, a text), and all the list parameters are lent or
//     none is, since a list left shared could be the same list as a lent one
//   - every other call is to a task that cannot reach a list (`scalarTasks`) or a native call, with scalar arguments;
//     no function value, no closure, no collection from outside the task
// Several lists lent to one call could be one list: the CALL SITE answers that (`lendRefusals`), and a site that
// cannot is refused, which refuses the task.
// `gate` is the same filter `impl Fn` uses: a top-level synchronous task, defined once, never used as a value.
export type Lend = 'read' | 'write'

export function scalarType(type: Type | undefined): boolean {
  return shapes.scalarType(boxed(type) as never)
}

export function lendableParams(
  fn: Extract<Statement, { form: 'function' }>,
  tasks: Set<string>,
  // the program's current answer for every OTHER task (`listFacts` solves them together): a list passed on to one of
  // these, at a position it takes lent, stays lent here, in the same mode or a stronger one
  lend: Map<string, Map<number, Lend>> = new Map(),
  // the tasks that cannot reach a list at all (ir/facts/bounds.ts, `scalarTasks`): a call to one costs nothing
  pure: Set<string> = new Set(),
  // the types that hold no list (ir/facts/bounds.ts, `listFree`); scalars alone when the caller has no program
  free: (type: unknown) => boolean = type => scalarType(type as Type | undefined),
): Map<number, Lend> {
  return lending.lendableParams(fn as never, flags(tasks), lend as never, flags(pure), freeOf(free)) as Map<number, Lend>
}

// F1, the second slice: the list LOCALS a task owns outright, held as a plain `Vec<T>`. A local is owned when it is
// made fresh (`make list`, an empty literal, or a call to a task that answers a fresh list, `fresh`), never rebound,
// and every mention is one that cannot let a second name reach it:
//   - a slot read or write, its length (`list_size`), a walk over it, a `list_push` onto it
//   - an argument a callee takes lent (`lendParams`): the borrow ends with the call
//   - `send back` of it, the list leaving whole (wrapped into the shared cell then, or handed on as the `Vec` itself
//     when this task is `fresh`)
// Never inside a closure, never passed, stored or aliased otherwise. Answers each owned name and whether anything
// writes it (for `let mut`).
export function ownedLocals(
  fn: Extract<Statement, { form: 'function' }>,
  fresh: Set<string>,
  lend: Map<string, Map<number, Lend>>,
  // the variant fields that own their lists (`ownedFields`, `variant/field`), which an owned local may be answered into
  stores: Set<string> = new Set(),
  // the reads that hand an owned local into a list that owns its element lists, at its last mention (`ownedElements`)
  moves: WeakSet<object> = new WeakSet(),
): Map<string, boolean> {
  return lending.ownedLocals(fn as never, flags(fresh), lend as never, flags(stores), ((node: object) => moves.has(node)) as never)
}

// whether every mention of `local` in `body` only reads the list it names: its size, a slot, a walk over it, or an
// argument a task takes lent for reading. Never written, pushed, stored, answered, captured or bound again
export function onlyReads(
  body: Statement[],
  local: string,
  lend: Map<string, Map<number, Lend>>,
  // the caller has checked the name is bound once, by a `let` inside `body` itself
  bound = false,
): boolean {
  return lending.onlyReads(body as never, local, lend as never, bound)
}

// The forms whose values cross into native code: an argument or the result of a native call (`dock load`), or a
// parameter or the result of a task with no body (a binding or a stub a shim fills), and every form those hold through
// their fields. A shim builds and reads such a value in the host's own terms (a list field as the shared cell), which no
// analysis of the program can see, so its representation must stay the one every backend writes by default. (The Rust
// roundtrip's ten E0308s the day this was added were not this: a construction leaving an owned list field out filled
// it with the shared empty list, fixed in rust.ts. This guard is the boundary that case made visible)
export function nativeForms(program: Statement[]): Set<string> {
  return new Set(lending.nativeForms(program as never))
}

// F1 for lists held in a variant (note/term/codegen/shared.md): the variant fields of list type that OWN their list,
// keyed `variant/field`, so a backend may hold it as the plain list (`Vec<T>` on Rust) where it was a shared one. A list
// owned by its node is never seen by a second name, so whether it is shared or copied cannot be observed. A field owns
// its list when:
//   - every construction gives it a fresh list: a call to a task that answers one (`fresh`), an empty list, or an owned
//     local (`ownedLocals`) handed into it as the node is answered (`send back, make node / bind kids, read kids`)
//   - every read of it is the local an arm binds it to, and that local is only read: its size, a slot, a walk over it,
//     or an argument a task takes lent for reading. Never written, pushed, stored, answered, captured or bound again
//   - no `subject/field` path reads it, and the program fills or melts no form (their walkers build every list field
//     as the shared one)
// Measured first on AWFY's Storage, a tree whose every node holds a list: 623 ms to 318 with the lists plain, the hand
// version 310 (`tmp/rust-storage-ab.ts`)
export function ownedFields(
  program: Statement[],
  fresh: Set<string>,
  lend: Map<string, Map<number, Lend>>,
  // the forms whose records only ever live in one place (compile/place.ts, `privateForms`): a list field of one may
  // also be written through its path
  slotPrivate: Set<string> = new Set(),
): Set<string> {
  return new Set(lending.ownedFields(program as never, flags(fresh), lend as never, flags(slotPrivate)))
}

// F1 for lists of lists (note/term/codegen/shared.md): the element types E for which every `list of list of E` in the
// program OWNS its inner lists, so a backend may hold each inner list as the plain list (`Vec<E>` on Rust) where it
// was a shared one. Decided per type, program-wide, since the inner representation is part of the outer list's type
// wherever it flows. Nothing can then tell an owned inner list from a shared one, because:
//   - every inner list put in is fresh: a fresh task's answer, an empty list, or an owned local handed in at its last
//     mention in its own block (`list_push(cells, near)` as the last thing done with `near`)
//   - every inner list taken out is only read (`onlyReads`): a slot bound to a local, or a walk's item, read by size,
//     slot, walk or a lent read argument
//   - an outer list is used only through its size, a push, a slot, a walk, a lent argument, an alias or a `send back`,
//     so no generic task ever holds one (and could hand an inner list on unchecked)
// `keyOf` names E as the backend spells it. Answers the keys, and the nodes the emitter reads them through: the `let`s
// bound to a slot, the walks, the inner lists put in, and the locals moved in.
// Measured first on Graph, a grid's adjacency lists searched breadth-first: 173 ms to 92 with the inner lists plain,
// the hand version 86 (`tmp/rust-graph-ab.ts`)
export type OwnedElements = {
  keys: Set<string>
  lets: WeakMap<object, string>
  walks: WeakMap<object, string>
  items: WeakMap<object, string>
  moves: WeakSet<object>
}

export function ownedElements(
  program: Statement[],
  fresh: Set<string>,
  lend: Map<string, Map<number, Lend>>,
  keyOf: (type: Type) => string,
): OwnedElements {
  const { w, ids } = numberedWalk(program)
  const answer = elements.ownedElementsOf(w as never, ids, flags(fresh), lend as never, (type: Type) => keyOf(type), (left: object, right: object) => left === right)
  const lets = new WeakMap<object, string>()
  const walks = new WeakMap<object, string>()
  const items = new WeakMap<object, string>()

  for (const one of answer.lets) {
    lets.set(one.node as object, one.key)
  }

  for (const one of answer.walks) {
    walks.set(one.node as object, one.key)
  }

  for (const one of answer.items) {
    items.set(one.node as object, one.key)
  }

  return { keys: new Set(answer.keys), lets, walks, items, moves: new WeakSet(answer.moves as object[]) }
}

// whether anything here assigns the variable itself (`save x, ...`), closures and nested blocks included. A write to a
// slot or field of it (`save x/f, ...`) does not count
export function assignsName(value: unknown, name: string): boolean {
  return names.assignsName(handlesOf(value), name)
}

// every variable name an expression (or statement list) reads, closures and nested blocks included
export function namesIn(value: unknown, into: Set<string> = new Set()): Set<string> {
  for (const name of names.namesIn(handlesOf(value))) {
    into.add(name)
  }

  return into
}

// does anything in these statements write the owned list `name`: a push onto it, a slot write, or a lend for writing
export function writesTo(body: Statement[], name: string, lend: Map<string, Map<number, Lend>>): boolean {
  return names.writesTo(body as never, name, lend as never)
}

// The tasks that answer a FRESH list, returned as a plain `Vec<T>`: every `send back` hands back a list the task owns
// (`ownedLocals`). A fixpoint, since a local made by a call to a fresh task is itself owned. Begins from every task the
// gate admits whose result is a list, and drops one each round until none drops
export function freshTasks(candidates: Extract<Statement, { form: 'function' }>[], lend: Map<string, Map<number, Lend>>): Set<string> {
  return new Set(lending.freshTasks(candidates as never, lend as never))
}

export function letNames(body: Statement[], into: Set<string>): void {
  for (const name of names.letNames(body as never)) {
    into.add(name)
  }
}

// The tasks a backend may change the signature of: top-level, synchronous, with a body, defined once, no trait method
// (`refuse` names the trait methods), and never used as a value, since a task held as a value must keep the one
// shape every function value has. A parameter or local that happens to share a task's name is not a use of the task
// (the stdlib's `fold` takes a `total`). Read by `impl Fn` on Rust and by every F1 lowering on Rust and Swift
export function gatedTasks(program: Statement[], refuse: Set<string>): Extract<Statement, { form: 'function' }>[] {
  return names.gatedTasks(program as never, [...refuse]) as Extract<Statement, { form: 'function' }>[]
}

// every name a body binds: a `let`, a walk's item and index, a closure's parameters, and the fields or `link` names an
// arm of a `fork case` binds. An analysis that goes by name refuses a parameter whose name is in here, since a read of
// the shadow would otherwise count as a read of the parameter
export function rebinds(
  body: unknown,
  into: Set<string> = new Set(),
  // each variant's field names, for an arm that binds them without `link` lines; without it only `link` names count
  fields?: Map<string, Map<string, unknown>>,
  // whether a `let` counts (an analysis that admits one declaration of its own name counts lets itself)
  lets = true,
): Set<string> {
  const table = new Map<string, string[]>()

  for (const [label, named] of fields ?? []) {
    table.set(label, [...named.keys()])
  }

  for (const name of names.rebinds(handlesOf(body), table, lets)) {
    into.add(name)
  }

  return into
}

// F1 for RECORDS: the record parameters a gated task only READS, taken as `&R` on Rust where they arrive by value and
// are destructured (a recursive field through `Rc::unwrap_or_clone`) at every node. A record is a value here: every
// clone is a copy and nothing writes inside a shared subtree, so a borrow can never be seen through a second name,
// and the worst a wrong answer can do is fail to compile, which every native suite would show. Each mention of the
// parameter must be one of
//   - the subject of a `fork case` (a match), whose arms then bind its fields by reference
//   - a scalar field read (`p/size`, a number, a float or a flag)
//   - an argument at a position the callee also takes borrowed, of the same type (a fixpoint: `item-check` calls
//     itself with each branch)
// and an arm's field that is itself a record is held to the same rule, except that it may not be matched again (a
// match through `&Rc<R>` does not dereference). Any other field is copied (a scalar) or cloned (anything else) out of
// the reference at the arm's entry, so the arm's body reads it as it always did
// An APPEND to a text variable: `save s, text <{s}...>`, the variable itself the template's first part. On Rust, Swift
// and Kotlin the template built a new text holding a copy of the old one, so text built in a loop cost O(n) per turn
// and O(n^2) in all; an append writes in place instead (`push_str`, `+=`, a StringBuilder). Answers the variable and
// the template of what is appended
export function textAppend(node: Statement): { name: string; rest: Expression } | undefined {
  return unbox(names.textAppendOf(node as never)) as { name: string; rest: Expression } | undefined
}

// what an append adds when it is one character read out of an ASCII text (`<{s}{char-at(t, i)}>`, ir/facts/text.ts):
// the text and the index, so a backend appends the one unit in place with no one-character text made for it
export function asciiCharAppend(
  rest: Expression,
  ascii: { has(node: Expression): boolean },
): { text: Expression; index: Expression } | undefined {
  return unbox(names.asciiCharAppend(rest as never, node => ascii.has(node as Expression))) as { text: Expression; index: Expression } | undefined
}

// A map entry updated from its own value, `set(m, k, get-or-default(m, k, d) + x)`: the counting update (`tally`,
// k-nucleotide). As written it hashes the key for the read and again for the write, and on Rust clones it for each.
// Every backend has the one-lookup form (Rust's entry, Swift's `default:` subscript, Kotlin's `merge`), so it is
// answered here once: the map and the key are names, the step a literal or a name (so nothing it reads can change
// the map between the read and the write), the read either spelling the simplifier leaves
// (`hash_get-or-default(m, k, d)`, or `maybe_unwrap-or(hash_get(m, k), d)` once that is inlined)
export type MapUpdate = { map: Expression; key: Expression; fallback: Expression; step: Expression }

export function mapUpdate(node: Statement): MapUpdate | undefined {
  return unbox(names.mapUpdateOf(node as never)) as MapUpdate | undefined
}

// The tasks that only FILL a list: an empty list, a counter from 0 up to a size parameter, one push of the same item
// each turn, and the list handed back (sieve's and fannkuch-redux's `filled`). Every host makes such a list in one
// allocation, `vec![x; n]`, `[T](repeating:count:)`, `BooleanArray(n) { x }`, `new Array(n).fill(x)`, where pushing
// grew it, and on Kotlin built a boxed list that a fixed list then copied (AWFY's Sieve: 113 ms to 69). The item is a
// literal or a parameter, so it is one value made once. Each task to the parameter positions of its size and item, or
// the item itself when it is a literal
export type Fill = { size: number; item: number | Expression }

export function fillTasks(program: Statement[]): Map<string, Fill> {
  const out = new Map<string, Fill>()

  for (const [name, fill] of names.fillTasks(program as never)) {
    out.set(name, { size: fill.size, item: fill.itemAt === -1 ? (fill.item as Expression) : fill.itemAt })
  }

  return out
}

// a call to a fill task (`fillTasks`): the size and the item, as arguments of this call
export function fillCall(node: Expression, fills: Map<string, Fill>): { size: Expression; item: Expression } | undefined {
  const table = new Map<string, { size: number; itemAt: number; item?: Expression }>()

  for (const [name, fill] of fills) {
    table.set(name, typeof fill.item === 'number' ? { size: fill.size, itemAt: fill.item } : { size: fill.size, itemAt: -1, item: fill.item })
  }

  return unbox(names.fillCallOf(node as never, table as never)) as { size: Expression; item: Expression } | undefined
}

// The tasks whose every call to themselves is a TAIL call, `send back, call <self>(..)`, each to the `return`s that make
// one: such a task is a loop (AWFY's List: `is-shorter` walks two lists by recursion, which JavaScript, having no
// tail-call elimination, ran as a call per step, 209 ms against 110 as a loop, `tmp/ts-list-ab.ts`). TypeScript writes
// the body inside `while (true)` and each tail call as the parameters rebound, Kotlin marks the task `tailrec`, which is
// the same transform made by its compiler. Only where that is plain: not async, not generic over a mask, every self
// call in a `return` that sits in no loop (a `continue` there would continue that loop), no closure and no guard
export function tailTasks(program: Statement[]): Map<string, WeakSet<object>> {
  return new Map(reads.tailTasksOf(program as never).map(one => [one.name, new WeakSet<object>(one.returns as object[])]))
}

// the empty text, as a literal or a template with no parts (`text <>`)
export function emptyText(value: Expression | undefined): boolean {
  return names.emptyText(boxed(value) as never)
}

// The text locals of a task that are only ever BUILT by appending (and reset to the empty text between builds, as a
// loop that builds one line at a time does): declared once, every write an append (`textAppend`),
// and never mentioned inside a closure, which could see the text change under it. Kotlin holds one as a
// StringBuilder, appends in place, and reads it with `toString()`: never worse than a copy per append, since every
// other read costs what one append used to
export function textBuilders(fn: Extract<Statement, { form: 'function' }>): Set<string> {
  return new Set(names.textBuilders(fn as never))
}

// The `let`s that declare again a name an earlier `let` in the same statement list declared, at the same type, where
// the task also assigns that name: two counted walks over `i` in one body each lower to a `let i` and a `while`. Rust
// shadows the first; TypeScript, Swift and Kotlin refuse a second declaration in one scope, so each writes the second
// as an assignment to the first, which is dead by then (every later read is of the second). The name being assigned
// is what makes the first a `let` / `var` there rather than a `const` / `let` / `val`
// a local declared by a bare `save x` and given its value by a later assignment: mutable, the unit placeholder as its
// initializer, and a type the checker filled from that assignment (check/infer.ts). A named type is left to each
// backend's module-slot path, and a type still open has nothing to declare it with
export function declaredLater(node: Statement): boolean {
  return names.declaredLater(node as never)
}

export function redeclaredLets(fn: Extract<Statement, { form: 'function' }>): WeakSet<Statement> {
  return new WeakSet(loops.redeclaredLets(fn as never) as Statement[])
}

// F4 `walked` (note/term/codegen/shared.md): the texts a task reads by position in a loop, each given a CURSOR, the
// code-point index of its last read and that code point's byte (Rust, Swift) or unit (Kotlin, TypeScript) offset. A
// read steps from the cursor, so a loop reading a text forward, or around one place (`i - 1`, `i + 1`), is O(1) per
// read where every read walked from the start (`chars().nth(i)`, `offsetBy`, a code-point count), O(n^2) over the
// loop. A text qualifies when it cannot change under its cursor and the cursor has one home:
//   - a parameter, or a `let` at the top of the task's body, nothing else in the task binds by that name
//   - never written in the task
//   - read by `char-at`, `at`, `char-code-at`, `substring` or `slice` at least once inside a loop, never inside a closure
//   - not ASCII (ir/facts/text.ts), where every read is already a direct index
// Every cursor is declared at the start of the task: it is two integers and never the text, so it holds for a `let`
// assigned later as well, being used only after it.
// The answer is the names, and each read through a cursor to its text's name
export type TextCursors = { names: string[]; reads: Map<object, string> }

export function textCursors(fn: Extract<Statement, { form: 'function' }>, ascii: { has(node: object): boolean }): TextCursors {
  const cursors = copying.textCursorsOf(fn as never, ((node: object) => ascii.has(node)) as never)

  return { names: cursors.names, reads: new Map(cursors.reads.map(one => [one.call as object, one.name])) }
}

// D1 for records on the backends whose records are objects (TypeScript, Kotlin): where a copy must be made so a write
// through one name cannot reach another. A record is a value, so a task that writes a field of a record it was passed
// works on its own copy, and `save b, read a` followed by a field write through either name leaves the other as it was.
// Rust and Swift copy by construction and never read this.
//   - `params`: per task, the record parameters whose fields it writes (a field write whose base is the parameter, or
//     the parameter passed on at a position its callee writes), each with whether some written path is deeper than one
//     field (`t/inner/x`), which a one-level copy would not separate
//   - `lets`: the `let`s that alias a record (`save b, read a`) where either name is written through, same flag
// A `mark shared` form is a reference by design and is never copied.
//   - `plain`: the record forms all this reads, every one with fields that is not `mark shared` and has no variants
export type RecordCopies = { params: Map<string, Map<number, boolean>>; lets: Map<Statement, boolean>; plain: Set<string> }

// `context` is what a unit of the separate build imports (compile/separate.ts): a form declared in another module is a
// record all the same, and reading the unit alone left every alias of one uncopied (`save copy, one` then a field
// write through `copy` changed the caller's record, 2026-10-05)
export function recordCopies(program: Statement[], context: Statement[] = []): RecordCopies {
  const copies = copying.recordCopiesOf(program as never, context as never)

  return {
    params: copies.params as Map<string, Map<number, boolean>>,
    lets: new Map(copies.lets.map(one => [one.node as Statement, one.deep])),
    plain: new Set(copies.plain),
  }
}

// The text parameters a task only READS AS TEXT: every mention a string method's receiver (`value/char-at`), a length
// read, or a part of a template, never rebound, never seen by a closure. Rust takes one as `&str`, so a caller lends
// its text where it cloned the String into every call: fasta's `char_at(alu.clone(), i)` copied 287 characters per
// character it read. Only a task the program itself calls: one called from outside (a harness, a host) is called with
// what that caller has, a String. And only the string operations that borrow their receiver on Rust: `pad-start` and
// `pad-end` take theirs by value
export function borrowedTexts(program: Statement[], gated: Extract<Statement, { form: 'function' }>[]): Map<string, Set<number>> {
  return new Map([...copying.borrowedTexts(program as never, gated as never)].map(([name, at]) => [name, new Set(at)]))
}

export function borrowedRecords(program: Statement[], gated: Extract<Statement, { form: 'function' }>[]): Map<string, Set<number>> {
  return new Map([...copying.borrowedRecords(program as never, gated as never)].map(([name, at]) => [name, new Set(at)]))
}

// A list GENERATED by a counted loop: `xs = []`, `i = <literal>`, `while (i < n) { push(xs, e); i = i + 1 }`, which a
// backend may make in one sized construction (Kotlin's `MutableList(n) { e }`, `Array(n) { e }`), running `e` for each
// index in the same order. Only where nothing can tell: `e` reads neither the list nor (through a closure) the counter,
// the bound is a literal or a name no closure writes, the counter is declared once in the task and mentioned nowhere
// after the loop, the list is never assigned whole, and the task has no guard (a raise inside `e` would otherwise leave
// a half-made list for a handler to see). The push is `list_push(xs, e)` or the collection operation it inlines to,
// `xs.push(e)`. A list of numbers is left to the caller, which keeps its own storage for them
export type ListGenerator = { list: string; counter: string; base: number; bound: Expression; item: Expression; type: Type; push: Expression }

export function listGenerator(body: Statement[], at: number, fn: Extract<Statement, { form: 'function' }> | undefined): ListGenerator | undefined {
  return fn ? (unbox(loops.listGeneratorAt(body as never, at, fn as never)) as ListGenerator | undefined) : undefined
}

// every generated list in a task (`listGenerator`), by the `let` that makes it
export function listGenerators(fn: Extract<Statement, { form: 'function' }>): Map<Statement, ListGenerator> {
  return new Map(loops.listGenerators(fn as never).map(one => [one.made as Statement, one.generator as ListGenerator]))
}

// F1, the fixed-length slice: the lists a backend may hold as a plain primitive ARRAY (Kotlin's `LongArray`), which
// cannot grow. Measured first on Kotlin fannkuch-redux: the 64-bit hand version in term.tree's own shape over plain
// `LongArray`s ran 21% faster than the emitted program with every check stripped and direct storage access, so the
// list representation itself was the cost (tmp/kotlin-width-ab.ts, 2026-10-02).
//   - a LOCAL is fixed when it is owned (`ownedLocals`), its element passes `element`, it is made by a call to a fresh
//     task (so it starts full; `make list` starts empty and must grow), nothing in its task pushes onto it, and it is
//     never handed back
//   - a lent PARAMETER is fixed when its element passes `element` and EVERY call to its task passes, at that position, a
//     fixed local or a fixed parameter of the caller, or a call to a fresh task (converted once at the call)
//   - a local stays fixed only while every lend of it is to a fixed parameter
// The last two depend on each other, so they are solved together, dropping candidates until none drops.
export function fixedLists(
  program: Statement[],
  lend: Map<string, Map<number, Lend>>,
  fresh: Set<string>,
  element: (type: Type) => boolean,
  // whether a list a counted loop generates (`listGenerator`) counts as made full, for a backend that writes the
  // generator as one sized construction: it then starts full like a fresh task's answer, its one push the generator's
  generated = false,
): { locals: Map<string, Set<string>>; params: Map<string, Set<number>> } {
  const fixed = loops.fixedListsOf(program as never, lend as never, flags(fresh), element as never, generated)

  return {
    locals: new Map([...fixed.locals].map(([name, names]) => [name, new Set(names.keys())])),
    params: new Map([...fixed.params].map(([name, at]) => [name, new Set(at.keys())])),
  }
}

// the list parameters each task takes lent (`listFacts`), with the gate every emitter uses: a trait's methods are
// never lent. For a fact that needs to know which calls can change no list's length (`boundedLoops`)
export function lentLists(program: Statement[]): Map<string, Map<number, Lend>> {
  const maskMethods = new Set(program.flatMap(n => (n.form === 'mask' ? n.methods : [])))

  return listFacts(program, gatedTasks(program, maskMethods)).lend
}

// The tasks that reach a list only through their arguments, though they may make and use lists of their own: no
// module-level name mentioned that could hold a list, and every call made to another such task, a scalar one, a native
// call or a collection operation. `lendableParams` gives one only list-free arguments and lists of the caller's own, so
// a list lent across the call cannot be seen twice. `scalarTasks` asks the stronger question, whether a task touches
// any list at all, and refused `zeros(n)` and `list_push(kids, ..)` in AWFY's Storage, which kept `build`'s generator
// state a shared cell. Solved optimistically and dropped until stable
export function isolatedTasks(program: Statement[], free: (type: unknown) => boolean): Set<string> {
  return new Set(lending.isolatedTasks(program as never, freeOf(free)))
}

// F1's program-wide facts, the same on every backend that reads them: which list parameter each gated task takes
// lent, and which tasks answer a fresh list
export function listFacts(
  program: Statement[],
  gated: Extract<Statement, { form: 'function' }>[],
): { lend: Map<string, Map<number, Lend>>; fresh: Set<string> } {
  const facts = lending.listFactsOf(program as never, gated as never)

  return { lend: facts.lend as Map<string, Map<number, Lend>>, fresh: new Set(facts.fresh) }
}

// A SLOT TAKEN AT ITS LAST READ. `host top, read piles/{pile}` copied the slot out (an `Rc` bump for a node, a deep copy
// for a text), and when the slot was written again the old value was dropped: a node read and written back was never
// unique, so `Rc::unwrap_or_clone` cloned where it could move and a box was freed and made again on every step. Here
// the local is the slot itself until its last read, which TAKES it (`std::mem::replace` with a field-less case), so
// the value moves out whole. Two shapes, each in one block of a task:
//   - the last read inside the value written straight back to the same slot (`save piles/{pile}, make disk / bind
//     below, read top`): the earlier reads see the slot through a reference
//   - the last read the subject of a match whose every arm either is the placeholder case (the slot then holds what it
//     held) or writes the slot first (`case disk` / `save piles/{pile}, read below`)
// A raise between the take and the write would leave the placeholder where the value was, so nothing between them
// may raise: the value written back holds no call, and nothing between the `let` and the last read mentions the list.
// Earlier reads are only a match's subject or a `top/field` read, which a reference serves. The list is one the task
// holds as a plain `Vec` or slice (`lists`), the index a literal or a name nothing assigns
// `form` and `empty` name the placeholder, the form's field-less case written into the slot by the take
export type SlotTake = { list: string; index: Expression; form: string; empty: string }

export function slotTakes(
  body: Statement[],
  lists: (name: string) => boolean,
  last: WeakSet<object>,
  // the field-less case of the form a local holds, when it has one
  placeholder: (type: Type | undefined) => { form: string; empty: string } | undefined,
  // the locals held some other way (a mutated capture's cell)
  held: Set<string>,
): { lets: WeakMap<object, SlotTake & { kept: boolean }>; takes: WeakMap<object, SlotTake> } {
  const found = reads.slotTakesOf(
    body as never,
    lists as never,
    ((node: object) => last.has(node)) as never,
    ((type: Maybe<Type>) => boxed(placeholder(unbox(type)))) as never,
    flags(held),
  )

  return {
    lets: new WeakMap(found.lets.map(one => [one.node as object, { ...(one.take as SlotTake), kept: one.kept }])),
    takes: new WeakMap(found.takes.map(one => [one.node as object, one.take as SlotTake])),
  }
}

// MOVE ON LAST USE, by node: `moveOnLastUse` moves a name read once in the whole task, and a name read twice was cloned
// at both reads. Here the LAST read of a name moves however many came before: the read that is the only mention of
// its name in the last statement of a block to mention it, outside any loop, closure or guard inside that statement,
// with nothing after the block mentioning it either. An `if` or `match` that is that last statement passes the question
// into each arm, since one arm runs. Answers the variable nodes themselves, so only that read moves; the emitter
// still decides by type and by how the name is held whether a move is legal there (`lastMove`). Towers' `push-disk`
// read a pile's top for its size and then built the new node with it, `Rc::new(top.clone())`
// `many`, when given, gets each read that is the LAST of several reads of its name inside one statement, in evaluation
// order (a call's callee, then its arguments left to right): a backend may move it when every earlier one there was a
// copy, which only the backend knows (rust.ts, `owned`). Rust List's `tail(rest(z), x, y)` cloned each a third time
export function lastReads(body: Statement[], many?: WeakSet<object>): WeakSet<object> {
  const found = reads.lastReadsOf(body as never, many !== undefined)

  for (const node of found.many) {
    many?.add(node as object)
  }

  return new WeakSet(found.last as object[])
}
