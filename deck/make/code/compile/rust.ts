// The Rust backend: emit the language as Rust. Parity with the other backends across every AST form. The scalar +
// control-flow fragment (functions, arithmetic, if, while, recursion, reassignment via `let mut` + shadowing of
// reassigned params) compiles cleanly with rustc; algebraic data types lower to native `enum`s and structs to
// `struct`s, with `match`. Strings are `String`, numbers `i64`. Native `dock` bindings become `use` + `module::fn`
// calls. Pure, browser-safe.
//
// THE FACE (self-hosting, 2026-10-06). Everything that needs no node's identity is Term: names and the spelling of a
// type (compile/rust-names.tree), the traits a form derives and the kinds of module binding (compile/rust-tables.tree),
// the declarations of forms, masks and instances (compile/rust-forms.tree), every expression and statement
// (compile/rust-emit.tree), and the module around them (compile/rust-assemble.tree). This file reads the program into
// the tables those take, runs the analyses, hands over each answer keyed by a node as a test on its own maps, asks for
// each statement, and assembles the module from what the emitter recorded. What stays here, and why:
//   - the analyses that answer by node identity (`ownedElements`, `lastReads`, `slotTakes`, `textCursors`, `sliceKeys`,
//     the proven steps, the loop guards, the ASCII texts), whose answers are WeakMaps and WeakSets over the nodes
//   - the naming of a module's `host` data trees, which renames the record nodes in place
//   - the wake chain, whose entries are open JSON records
// The emitter before the port is in git history (and, while the port is checked, tmp/retired/make/rust-before.ts).

import type {
  Expression,
  Program,
  Statement,
  Type,
} from '@term/make/code/compile/node'
import { unmarked } from '@term/make/code/compile/unit-split'
import { collectBinds, bindImports, referencedBinds } from '@term/make/code/compile/bind'
import {
  textCursors,
  mapUpdate,
  fillTasks,
  fixedLists,
  isText,
  stringCall,
  escapingParams,
  ownedLocals,
  ownedFields,
  ownedElements,
  slotTakes,
  lastReads,
  type SlotTake,
  gatedTasks,
  listFacts,
  borrowedRecords,
  borrowedTexts,
} from '@term/make/code/compile/backend'
import type { Lend, TextCursors } from '@term/make/code/compile/backend'
import { privateForms } from '@term/make/code/compile/place'
import { raiseSetsOf } from '@term/make/code/check/effects'
import { provenIncrements } from '@term/make/code/ir/facts/range'
import { provenArithmetic, type Proven } from '@term/make/code/compile/proven'
import { boundedLoops, unsignedDivisions } from '@term/make/code/ir/facts/bounds'
import { asciiTexts } from '@term/make/code/ir/facts/text'
import { taggedForms } from '@term/make/code/compile/tag'
import * as rustNames from '@term/make/code/compile/rust-names'
import * as rustAssemble from '@term/make/code/compile/rust-assemble'
import * as rustTables from '@term/make/code/compile/rust-tables'
import * as rustEmit from '@term/make/code/compile/rust-emit'

type Maybe<T> = { form: 'some'; value: T } | { form: 'none' }
const unbox = <T>(value: Maybe<T>): T | undefined => (value.form === 'some' ? value.value : undefined)
const boxed = <T>(value: T | undefined): Maybe<T> => (value === undefined ? { form: 'none' } : { form: 'some', value })

function snake(name: string): string {
  return rustNames.snake(name)
}

function pascal(name: string): string {
  return rustNames.pascal(name)
}

// WHAT A TYPE'S SPELLING READS of the module being emitted, set per emit and per function:
//   - `varNames`: a function's free inference variables as its generic letters, so a generic signature prints `T`
//   - `opaqueTypes`: `dock type` handles, seed name to the concrete Rust type
//   - `sharedForms`: the `mark shared` forms (native-dom-0020, optimize-0042), whose value is a `TermShared<Form>`
//     handle (an `Rc<RefCell<Form>>`), shared by every binding, compared and hashed by identity
//   - `textKeys`: whether this program's maps keyed by text hold their keys as a `TermKey` (`textKeysOf`)
//   - `ownedInner`: the element types whose lists of lists own their inner lists (backend.ts, `ownedElements`)
//   - `genericArity`: how many type parameters each generic form declares, for a reference that names it bare
const rustContext: {
  varNames: Map<number, string>
  opaqueTypes: Map<string, string>
  sharedForms: Set<string>
  textKeys: boolean
  ownedInner: Set<string>
  genericArity: Map<string, number>
} = {
  varNames: new Map(),
  opaqueTypes: new Map(),
  sharedForms: new Set(),
  textKeys: false,
  ownedInner: new Set(),
  genericArity: new Map(),
}

function rustType(type: Type | undefined): string {
  return rustNames.rustType(boxed(type) as never, rustContext as never)
}

// the roll grouped by deck, for the generated wake chain (the same shape emitTypeScript takes)
export type WakeGroup = {
  deck: string
  entries: Record<string, unknown>[]
}

// what one emission pass cloned (item 0029): the forms named in any cloned type, and whether any clone was of a type
// not known or generic, which could be any form
type CloneRecord = { forms: Set<string>; generic: boolean }

// The program twice when that buys something: a first pass records every clone it writes, and a recursive form whose
// values no pass ever clones has its children held in a `Box` instead of an `Rc` in a second pass (item 0029; a `Box`
// tree runs about 10% faster on binary-trees, measured). A `Box` cannot be the default: under D1 a record is a value,
// a clone of a `Box` tree copies all of it, and a program that shares structure (a persistent list's common tail)
// would go quadratic. So a form is boxed only when nothing clones it, nor any form that holds it, and nothing
// generic is cloned at all (generic code could be holding it). Anything unproven keeps `Rc`
// with `units`, each module's statements stay marked, for the caller to write one file per module
// (compile/unit-split.ts)
export function emitRust(program: Program, options?: { wake?: WakeGroup[]; units?: boolean }): string {
  const finish = (text: string): string => (options?.units ? text : unmarked(text))
  const record: CloneRecord = { forms: new Set(), generic: false }
  const first = emitRustPass(program, options, new Set(), record)

  if (record.generic) {
    return finish(first)
  }

  const boxed = boxableForms(program, record.forms)

  return finish(boxed.size ? emitRustPass(program, options, boxed, { forms: new Set(), generic: false }) : first)
}

// what the first pass recorded and which forms it boxes, for a test to assert (test/compile/rust-box.ts)
export function rustBoxing(program: Program): { cloned: string[]; generic: boolean; boxed: string[] } {
  const record: CloneRecord = { forms: new Set(), generic: false }
  emitRustPass(program, undefined, new Set(), record)

  return {
    cloned: [...record.forms].sort(),
    generic: record.generic,
    boxed: record.generic ? [] : [...boxableForms(program, record.forms)].sort(),
  }
}

// the recursive forms (a variant field whose type is the form itself) that nothing cloned, directly or through a form
// holding one: a cloned form is closed over the forms its fields hold, at any depth
function boxableForms(program: Program, cloned: Set<string>): Set<string> {
  return new Set(rustNames.boxableForms(program as never, [...cloned]))
}

// TEXT KEYS THAT DO NOT ALLOCATE. A map keyed by text holds each key as a `String`, an allocation per new key: all of
// k-nucleotide's gap, a k-mer per position (86 ms against the hand version's 71, `tmp/rust-knuc-key-ab.ts`). A
// `TermKey` holds up to 22 bytes in place and hashes and compares as the `str` it holds (74 ms). A program's text-keyed
// maps take it only where no key can be seen as a value again, since a `TermKey` is not a `String`: no map of them
// walked or answered by a task whose result or callback mentions its key type, none handed where a map is not
// declared, none in a field of unknown type, and none built or read by a runtime shim, six of which build
// `TermMap<String, ...>` themselves. A key read out by `keys` is made a `String` there. Lookups take the borrowed `str`,
// which serves a `String` key as well (`TermMap`'s `Borrow` lookups)
function textKeysOf(program: Program): boolean {
  return rustNames.textKeysOf(program as never)
}

// why a program's text-keyed maps keep `String` keys, or undefined when they take `TermKey`s (a test reads it)
export function textKeyReason(program: Program): string | undefined {
  return unbox(rustNames.textKeyReason(program as never))
}

function emitRustPass(
  program: Program,
  options: { wake?: WakeGroup[] } | undefined,
  // the recursive forms whose children this pass holds in a `Box` (boxableForms)
  boxedForms: Set<string>,
  // what this pass clones, filled as it emits
  cloneRecord: CloneRecord,
): string {
  // the `+`, `-` and `*` nodes proven not to overflow (compile/proven.ts): written without the checked call. The
  // counted steps here, joined below by the interval fact once the list facts it reads are known
  let provenSteps: Proven = provenIncrements(program)
  // the counted loops whose calls to a bounded task may run its unchecked copy (ir/facts/bounds.ts), the divisions that
  // copy does unsigned, the calls in the loop copy being emitted, the tasks some such call reached, and whether the
  // body being emitted is an unchecked copy
  // no lend facts: a fast copy of a task that takes a list is emitted under its own name, which this backend's list
  // facts (the lent, fixed and borrowed parameters, all keyed by task) do not reach, so only tasks that take no list
  // run unchecked here. TypeScript keys no list representation by task and passes them
  const loopGuards = boundedLoops(program)
  const unsignedDivs = unsignedDivisions(program)
  // the text expressions proven ASCII, read by byte (ir/facts/text.ts)
  const asciiNodes = asciiTexts(program)
  // the tasks that only fill a list (backend.ts, `fillTasks`)
  const fills = fillTasks(program)
  // when the stdlib hive is in the program, every new raise tells it (the throw lowering), and the compiler can
  // emit the wake chain (`wake_hive`) from the roll the driver hands over
  const hasHiveTell = program.some(
    n => n.form === 'function' && n.name === 'hive-tell',
  )
  rustContext.genericArity = new Map(
    program
      .filter((n): n is Extract<Statement, { form: 'record-type' }> => n.form === 'record-type')
      .map(n => [n.name, n.params?.length ?? 0]),
  )
  rustContext.sharedForms = new Set(
    program.flatMap(n => (n.form === 'record-type' && n.shared && n.variants.length === 0 ? [n.name] : [])),
  )
  // decided below, once the list facts are known (`elementLists`)
  rustContext.ownedInner = new Set()
  rustContext.textKeys = textKeysOf(program)
  // per generic task, each parameter that is the key type of a map parameter, and that map's position: a text argument
  // there beside a map of `TermKey`s is made one (`rustContext.textKeys`). The stdlib's `get`, `get-or-default`, `has`, `set`
  const keyPositions = new Map<string, Map<number, number>>()

  for (const fn of program) {
    if (fn.form !== 'function') {
      continue
    }

    const generic = (t: Type | undefined): t is Type =>
      t?.kind === 'variable' || (t?.kind === 'named' && fn.generics.some(g => g.name === t.name))
    const same = (a: Type, b: Type): boolean =>
      (a.kind === 'variable' && b.kind === 'variable' && a.id === b.id) || (a.kind === 'named' && b.kind === 'named' && a.name === b.name)
    const positions = new Map<number, number>()

    fn.params.forEach((p, i) => {
      if (!generic(p.type)) return
      const map = fn.params.findIndex(q => q.type?.kind === 'map' && generic(q.type.key) && same(q.type.key, p.type!))
      if (map >= 0) positions.set(i, map)
    })

    if (positions.size) {
      keyPositions.set(fn.name, positions)
    }
  }
  // opaque handle types declared by `dock type` shims: seed name -> concrete rust type
  rustContext.opaqueTypes = new Map(
    program
      .filter(
        (n): n is Extract<Statement, { form: 'native' }> =>
          n.form === 'native' && n.kind === 'type',
      )
      // `load <any>` is the portable opaque spelling (a public module's handle with no per-backend type): the
      // boxed dynamic here, `Any` on Swift and Kotlin
      .map(n => [
        n.alias,
        n.module === 'any'
          ? 'std::rc::Rc<dyn std::any::Any>'
          : n.module,
      ]),
  )

  const variantOwner = new Map<string, string>()
  // every enum that declares a variant label (`text` is on both `token` and `data`), so a construction or a match
  // can be steered by the checked type
  const variantOwners = new Map<string, Set<string>>()
  // a variant's field names, for binding them in a `match` arm (`Maybe::Some { value } => ...`) so the branch body can
  // read them; a `subject/field` read inside the branch then resolves to that bound local.
  const variantFields = new Map<string, string[]>()
  // the same, by FORM and case (`rope/leaf`): two forms may name a case alike, and an arm reads its own form's
  const caseFieldNames = new Map<string, string[]>()
  // struct / variant fields that hold a closure (a `Box<dyn Fn>`): calling one needs parentheses (`(r.handle)(x)`),
  // since rust would otherwise read `r.handle(x)` as a method call on a field named `handle`.
  const closureFields = new Set<string>()
  // a variant field whose type is the enclosing enum itself (`node.next: linked-list t`): rust refuses the
  // infinitely sized enum, so the field is stored as `Rc<Enum>`, wrapped at construction and unwrapped
  // (cloned out) at the match binding. Keyed `variant/field`.
  const recursiveFields = new Set<string>()

  for (const node of program) {
    if (node.form !== 'record-type') {
      continue
    }

    for (const v of node.variants) {
      variantOwner.set(v.name, node.name)
      variantOwners.set(v.name, (variantOwners.get(v.name) ?? new Set()).add(node.name))
      variantFields.set(
        v.name,
        v.fields.map(f => f.name),
      )
      caseFieldNames.set(`${node.name}/${v.name}`, v.fields.map(f => f.name))

      for (const f of v.fields) {
        if (f.type.kind === 'function') {
          closureFields.add(f.name)
        }
        if (f.type.kind === 'named' && f.type.name === node.name) {
          recursiveFields.add(`${v.name}/${f.name}`)
        }
      }
    }

    for (const f of node.fields) {
      if (f.type.kind === 'function') {
        closureFields.add(f.name)
      }
    }
  }

  // A BOXED PAYLOAD. A case of a boxed form that holds the form itself keeps ALL its fields in one box, a struct of its
  // own (`Disk(Box<StackDisk>)`, `StackDisk { size, below: Stack }`), where it held each recursive field in a box of
  // its own (`Disk { size, below: Box<Stack> }`). The enum is one pointer, a node is one allocation however many
  // children it has (binary-trees' branch was two), and the box a match opens holds the whole node, so a node built
  // again takes it entire (Towers' moves: 78 ms to 70, `tmp/rust-towers-payload-ab.ts`). An arm binds the box and
  // destructures it with the fields' own pattern (`Stack::Disk(__node) => { let StackDisk { size, .. } = *__node; }`).
  // Keyed `form/case`. A struct name some form already takes leaves its case as it was
  const payloads = new Map<string, string>()
  const takenNames = new Set(program.flatMap(n => (n.form === 'record-type' ? [pascal(n.name)] : [])))

  // A form the program clones (held by `Rc`) takes the same payload behind its `Rc`: `Link(Rc<ChainLink>)`, so a value
  // is one pointer and a clone one count, where `Link { value, next: Rc<Chain> }` was a 16-byte value copied with every
  // clone. With each name's last read moved (`manyMoves`), Rust List 43 ms to 33 against the hand version's
  // `Option<Rc<Element>>` at 34; either alone was worth 3 (`tmp/rust-list-payload-ab.ts`). Not a generic form, whose
  // struct would carry the parameters, and not a `mark shared` one
  for (const node of program) {
    if (node.form !== 'record-type' || !(boxedForms.has(node.name) || (node.params.length === 0 && !node.shared))) {
      continue
    }

    for (const v of node.variants) {
      const name = `${pascal(node.name)}${pascal(v.name)}`

      if (v.fields.some(f => recursiveFields.has(`${v.name}/${f.name}`)) && !takenNames.has(name)) {
        payloads.set(`${node.name}/${v.name}`, name)
      }
    }
  }

  const payloadOf = (owner: string, label: string): string | undefined => payloads.get(`${owner}/${label}`)
  // the payload a form's reused boxes hold: its one payload case's, so the helpers have one type. A form with two keeps
  // the plain allocation
  const reusedPayload = (owner: string): string | undefined => {
    const own = [...payloads].filter(([key]) => key.startsWith(`${owner}/`))

    return own.length === 1 ? own[0]![1] : undefined
  }

  // traits (masks) emit as native Rust traits, instances as `impl` blocks, and a trait-bounded generic gains a trait
  // bound on its type parameter, so a generic trait-method call lowers to `x.method(..)`. Method signatures are derived
  // from the instance implementations (each desugared to a `<target>_<method>` free function tagged with `method`),
  // with the receiver type replaced by `Self`. See note/seed/compiler/trait-dictionary-passing.md.
  const maskMethods = new Set<string>()

  for (const node of program) {
    if (node.form === 'mask') {
      for (const m of node.methods) {
        maskMethods.add(m)
      }
    }
  }

  // a trait's implementing targets, in program order, so a trait body can borrow one target's signatures
  const instanceTargets = new Map<string, string[]>()

  for (const node of program) {
    if (node.form === 'instance') {
      const list = instanceTargets.get(node.mask) ?? []
      list.push(node.target)
      instanceTargets.set(node.mask, list)
    }
  }

  // the free function implementing a given form's method (`box` + `measure` -> the `box_measure` function node)
  type Fn = Extract<Statement, { form: 'function' }>
  const implFn = new Map<string, Fn>()

  for (const node of program) {
    if (node.form === 'function' && node.method) {
      implFn.set(`${node.method.form}:${node.method.name}`, node)
    }
  }

  // A TRAIT METHOD RAISES WHEN ANY INSTANCE'S TASK DOES. The signature was taken from one instance alone, so a mask
  // worn by a big integer, which never raises, and a rational, whose reduction raises on a zero denominator, declared
  // `-> Self` and the rational's impl handed back a `Result` (decisions-2026-10.md, D5). Raising, the trait answers
  // `Result<T, TermException>`, an impl whose task does not raise wraps its answer in `Ok` (compile/rust-forms.tree), and
  // a call through the trait takes the raise as any raising call does. Read after `raising` is filled
  const maskOf = new Map<string, string>()

  for (const node of program) {
    if (node.form === 'mask') {
      for (const m of node.methods) {
        maskOf.set(m, node.name)
      }
    }
  }

  // THE RESULT LOWERING (note/term/hive/11-native-exceptions.md, "Way 2"). A task whose raise set is not empty returns
  // `Result<T, TermException>`; `halt <form>` is `return Err(..)`; a call to a raising task is `call()?` inside a
  // raising task or a guarded body, and `.unwrap_or_else(exit 1 with form and note)` elsewhere, so a raise nothing
  // handles ends the program the way it does on every backend (compile/rust-emit.tree, `raise-suffix`)
  const raising = new Set<string>()

  // the field-less case of a form, the placeholder a take leaves in a slot
  const emptyCase = (type: Type | undefined): { form: string; empty: string } | undefined => {
    const form =
      type?.kind === 'named'
        ? program.find((n): n is Extract<Statement, { form: 'record-type' }> => n.form === 'record-type' && n.name === type.name)
        : undefined
    const empty = form?.variants.find(v => v.fields.length === 0)

    return form && empty ? { form: form.name, empty: empty.name } : undefined
  }
  // REUSE OF A RECURSIVE FORM'S BOXES (Perceus' reuse, across tasks). A match arm that unboxes a recursive field
  // (`*below`, `Rc::unwrap_or_clone(below)`) freed the box, and the next node built (`Box::new(top)`) asked the
  // allocator for one the same size: Towers' pop and push, once per move. Here the unboxing keeps the box, its value
  // replaced by the form's field-less case, and the next node of the form is built in it. A spare box per thread, and
  // a short list of more behind it for a run of frees before a run of builds. Inlining pop into push would do this
  // inside one task (Koka's reuse token); this does it across the call, where Term keeps them. A form takes part when
  // it is not generic (a `thread_local` has one type) and has a field-less case; one the program never unboxes keeps
  // `Box::new`, rewritten at the end, so a program that only builds and drops pays nothing
  const reusable = (name: string): boolean => {
    const form = program.find(n => n.form === 'record-type' && n.name === name)
    // a form held by payload reuses only the boxes of its one payload case (`reusedPayload`)
    const payloaded = form?.form === 'record-type' && form.variants.some(v => payloadOf(name, v.name))

    // an `Rc` payload is not reused: its node may be shared
    return (
      form?.form === 'record-type' &&
      form.params.length === 0 &&
      form.variants.some(v => v.fields.length === 0) &&
      (!payloaded || (reusedPayload(name) !== undefined && boxedForms.has(name)))
    )
  }

  // every struct form's declared fields, for a construction that leaves some out; and the exception forms, whose
  // raise panics with the note
  const recordFields = new Map<string, { name: string; type: Type }[]>(
    program
      .filter((n): n is Extract<Statement, { form: 'record-type' }> => n.form === 'record-type' && n.variants.length === 0)
      .map(n => [n.name, n.fields]),
  )
  const exceptionForms = new Set(
    program
      .filter((n): n is Extract<Statement, { form: 'record-type' }> => n.form === 'record-type' && Boolean(n.chain?.includes('exception')))
      .map(n => n.name),
  )
  // the value answered by an untyped SHIM: a call to a Term task, or to a `dock load` module, awaited or not. A built-in
  // collection operation is neither: its value is already the element type, and a downcast of it does not compile
  const nativeAliases = new Set(
    program.flatMap(n => (n.form === 'native' && n.kind !== 'type' ? [n.alias] : [])),
  )

  for (const [name, raises] of raiseSetsOf(program, [...exceptionForms]).raises) {
    if (raises.length > 0) {
      raising.add(name)
    }
  }

  // the asynchronous tasks, for boxing one read as a value into the pinned-future closure a task slot holds
  const asyncFunctions = new Set<string>(
    program
      .filter((n): n is Extract<Statement, { form: 'function' }> => n.form === 'function' && Boolean(n.async))
      .map(n => n.name),
  )

  // every task's declared parameter types, for boxing an argument into an `unknown` parameter
  const functionParams = new Map<string, (Type | undefined)[]>(
    program
      .filter((n): n is Extract<Statement, { form: 'function' }> => n.form === 'function')
      .map(n => [n.name, n.params.map(p => p.type)]),
  )

  // F2 escape (note/term/codegen/shared.md): a function parameter the task only CALLS is `impl Fn(..)`, statically
  // dispatched and inlinable, where every other function value is an `Rc<dyn Fn>`, a heap allocation per closure
  // and an indirect call. Only for a top-level task that is synchronous, no trait method, defined once, and never
  // used as a value (a generic function cannot become an `Rc<dyn Fn>`). Passing the parameter on counts as an
  // escape (`escapingParams`), so a recursive task never instantiates itself at an ever-deeper closure type. At the
  // call site a closure literal is passed bare and any other function value as `&*f`, a `&dyn Fn` being an `Fn`
  const implFnParams = new Map<string, Set<number>>()
  // the tasks whose signature this backend may change (`gatedTasks`), and F1's facts about their lists (`listFacts`):
  // which list parameter each takes lent, and which answer a fresh list as a plain `Vec`
  const gated = gatedTasks(program, maskMethods)
  const { lend: lendParams, fresh: freshLists } = listFacts(program, gated)
  provenSteps = provenArithmetic(program, lendParams, freshLists)
  // the variant fields that own their lists, held as a plain `Vec` (backend.ts, `ownedFields`)
  const fieldLists = ownedFields(program, freshLists, lendParams, privateForms(program, lendParams, freshLists))
  // the lists of lists that own their inner lists, each inner list a plain `Vec` (backend.ts, `ownedElements`)
  const elementLists = ownedElements(program, freshLists, lendParams, t => rustType(t))
  rustContext.ownedInner = elementLists.keys
  // whether a node `ownedElements` recorded belongs to a key still standing
  const ownsInner = (at: WeakMap<object, string>, node: object): boolean => {
    const key = at.get(node)

    return key !== undefined && elementLists.keys.has(key)
  }
  // the owned list locals of each task that never grow, are never handed back and are only lent (backend.ts,
  // `fixedLists`): one made by a fill of a literal size is a fixed array on the stack, `[x; N]`, where a `Vec` was a heap
  // allocation per call (AWFY's Queens, four boards per run: 53.7 ms to 47.2, `tmp/rust-queens-ab.ts`). An element
  // that is a plain scalar, so the array is `Copy`-filled; a size up to 4096, so it is a frame and not a stack overflow
  const stackLists = fixedLists(program, lendParams, freshLists, t => t.kind === 'number' || t.kind === 'float' || t.kind === 'boolean').locals
  // F1 for records: the record parameters each task only reads, taken `&R` (`borrowedRecords`)
  const borrowParams = borrowedRecords(program, gated)

  // and the text parameters a task only reads as text, taken `&str` (`borrowedTexts`): lent like a borrowed record
  for (const [name, at] of borrowedTexts(program, gated)) {
    borrowParams.set(name, new Set([...(borrowParams.get(name) ?? []), ...at]))
  }
  // each variant's field types, for what a borrowed match binds: a record field stays a reference, a `Copy` one is
  // copied out, anything else cloned out
  const variantTypes = new Map(
    program.flatMap(n =>
      n.form === 'record-type' ? n.variants.map(v => [v.name, new Map(v.fields.map(f => [f.name, f.type]))] as const) : [],
    ),
  )
  const caseFieldTypes = new Map(
    program.flatMap(n =>
      n.form === 'record-type' ? n.variants.map(v => [`${n.name}/${v.name}`, new Map(v.fields.map(f => [f.name, f.type]))] as const) : [],
    ),
  )
  // the records a borrow may reach into (every form but a `mark shared` handle), as `borrowedRecords` counts them
  const plainRecords = new Set(program.flatMap(n => (n.form === 'record-type' && !n.shared ? [n.name] : [])))

  for (const n of gated) {
    const escapes = escapingParams(n)
    const local = new Set(
      n.params.flatMap((p, i) =>
        p.type?.kind === 'function' && !p.type.effects?.includes('async') && !escapes.has(p.name) ? [i] : [],
      ),
    )

    if (local.size) {
      implFnParams.set(n.name, local)
    }
  }


  // module-level bindings (`host hex-alpha, text <...>` at the top of a module): rust has no top-level `let`, so
  // each becomes a `thread_local!` static and every read clones the value out. A function parameter or local of
  // the same name shadows it, tracked in `localNames` while a function body is emitted.
  const moduleConsts = new Set<string>(
    program.filter((n): n is Extract<Statement, { form: 'let' }> => n.form === 'let').map(n => n.name),
  )


  // a module-level `host` data tree (`host range` / `host h` / `host start, code 0`) is an ANONYMOUS nested
  // record: no form names it, so Rust gets one synthesized struct per record node, named by the binding and
  // the field path (HostRange, HostRangeH). The record nodes are renamed in place so the construction and the
  // static's type line up, and the struct defs ride ahead of the module lets.
  const hostStructDefs: string[] = []
  const hostStructOf = new Map<string, string>()
  const hostLeafType = (v: Expression): string =>
    v.form === 'integer'
      ? 'i64'
      : v.form === 'float'
        ? 'f64'
        : v.form === 'string'
          ? 'String'
          : v.form === 'boolean'
            ? 'bool'
            : v.type
              ? rustType(v.type)
              : 'i64'
  const nameHostRecord = (
    node: Extract<Expression, { form: 'record' }>,
    base: string,
  ): string => {
    node.name = base

    const fields = node.fields.map(f => {
      const type =
        f.value.form === 'record' && f.value.name === ''
          ? nameHostRecord(f.value, `${base}${pascal(f.name)}`)
          : hostLeafType(f.value)

      return `pub ${snake(f.name)}: ${type}`
    })

    hostStructDefs.push(
      `#[derive(Clone)] pub struct ${base} { ${fields.join(', ')} }`,
    )

    return base
  }

  for (const node of program) {
    if (
      node.form === 'let' &&
      node.init.form === 'record' &&
      node.init.name === ''
    ) {
      hostStructOf.set(
        node.name,
        nameHostRecord(node.init, `Host${pascal(node.name)}`),
      )
    }
  }

  // WHAT EACH MODULE BINDING IS (compile/rust-tables.tree `module-bindings-of`): a valueless typed module SLOT
  // (`host current, like context`, filled later by a `save`) is a RefCell<Option<T>>, since rust has no lateinit,
  // whose reads unwrap and writes fill; and a binding to a number, float, boolean or text LITERAL that nothing assigns
  // is a Rust `const`, read by name with no thread-local lookup and no clone, and folded by rustc wherever it is used
  // (note/term/codegen/rust.md, R7). A text one is a `&'static str`
  const bindings = rustTables.moduleBindingsOf(program as never)
  const moduleSlots = new Set<string>(bindings.slots)
  const scalarConsts = new Set<string>(bindings.scalars)
  const textConsts = new Set<string>(bindings.texts)

  // a generic struct whose fields never mention one of its parameters (an opaque `dock` erases the type) needs
  // a PhantomData field for the unused letters, or rustc refuses it (E0392). Detected up front so every
  // construction of the form appends the marker regardless of declaration order.
  const phantomForms = new Map<string, string>(
    rustTables.phantomForms(program as never, rustContext as never).map(p => [p.form, p.marker] as const),
  )

  // `is-equal` on two records compares their fields, on every backend (note/term/optimize/meaning.md, question 4). A
  // form derives `PartialEq` when every field can be compared, and `Eq + Hash` as well when every field can also be
  // hashed, which is what lets a record be a map key. A closure, a boxed unknown, or a form that does not qualify
  // keeps the form out. Floats compare but do not hash, and a list or a map compares by its items but is not a key.
  // THE FORMS THAT CAN BE A MAP KEY go by the key rule (TermHash), where a float, a list and a map can all be keys,
  // and each gets a `TermHash` impl. Each set is a greatest fixpoint, so a recursive form qualifies when nothing
  // outside it disqualifies it (compile/rust-tables.tree `form-traits-of`)
  const traits = rustTables.formTraitsOf(program as never, rustContext as never)
  const equatableForms = new Set(traits.equatable)
  const hashableForms = new Set(traits.hashable)
  const keyableForms = new Set(traits.keyable)
  // the forms whose tag the program reads as a field, each given `term_tag`
  const taggedNames = new Set(taggedForms(program))

  // for each form, which of its generic parameters (by index) flow into a map KEY position inside its fields. A `set<t>`
  // stores `items: hash<t, bool>`, so its index 0 is a key; a method generic that fills that slot needs `Eq + Hash`.
  const formKeyIndices = new Map<string, Set<number>>(
    rustTables.formKeyIndices(program as never).map(entry => [entry.form, new Set(entry.indices)] as const),
  )

  // native dock aliases: `fs/read-to-string` is a module path (`fs::read_to_string`), but `r/body` (r a value) is a
  // field access (`r.body`). Only a member chain rooted at a dock alias uses `::`; everything else uses `.`.
  const aliases = new Set<string>()

  for (const node of program) {
    if (node.form === 'native') {
      aliases.add(node.alias)
    }
  }

  // declarative native bindings render their `case rust` template at call sites
  const binds = collectBinds(program)
  const rootVariable = (node: Expression): string | undefined =>
    node.form === 'variable'
      ? node.name
      : node.form === 'member'
        ? rootVariable(node.target)
        : undefined

  // what the declarations of forms, masks and instances read (compile/rust-forms.tree): every table here is keyed by a
  // name, so the program's own maps and sets cross as they are
  const formFacts = {
    payloads,
    recursiveFields,
    boxedForms,
    fieldLists,
    phantom: phantomForms,
    tagged: taggedNames,
    equatable: equatableForms,
    hashable: hashableForms,
    keyable: keyableForms,
    raising,
    instanceTargets,
    implFn,
    maskOf,
    context: rustContext,
  }

  // the text locals of a task that are only ever the key of a map update (`mapUpdate`) and are made from a substring
  // of an ASCII text, by a single `let`: a `&str` into the text serves the borrowed lookup, so no String is made per key.
  // A key that is new to the map is made owned inside `upsert_ref`
  const sliceKeys = (fn: Extract<Statement, { form: 'function' }>): { lets: WeakSet<Statement>; names: Set<string> } => {
    type Loose = Record<string, unknown> & { form?: string }
    const keys = new Set<string>()
    const updates = new Set<object>()
    const reads = new Map<string, number>()
    const lets = new Map<string, Loose[]>()

    const find = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) return
      if (Array.isArray(value)) return value.forEach(find)

      const node = value as Loose
      const update = mapUpdate(node as unknown as Statement)

      if (update && update.key.form === 'variable' && isText(update.key.type)) {
        keys.add(update.key.name)
        updates.add(node)

        return
      }

      if (node.form === 'variable') reads.set(node.name as string, (reads.get(node.name as string) ?? 0) + 1)
      if (node.form === 'let') lets.set(node.name as string, [...(lets.get(node.name as string) ?? []), node])

      for (const [key, child] of Object.entries(node)) {
        if (key !== 'type' && key !== 'span') find(child)
      }
    }

    find(fn.body)

    const out = { lets: new WeakSet<Statement>(), names: new Set<string>() }

    for (const name of keys) {
      const made = lets.get(name)
      const init = made?.length === 1 ? (made[0]!.init as Expression) : undefined
      const text = init?.form === 'call' ? stringCall(init.callee) : undefined

      if (text && (text.op === 'substring' || text.op === 'slice') && asciiNodes.has(text.target) && !reads.get(name) && !fn.params.some(p => p.name === name)) {
        out.lets.add(made![0] as unknown as Statement)
        out.names.add(name)
      }
    }

    return out
  }

  // WHAT ONE TASK'S EMISSION READS BY NODE, worked out when its emission starts (compile/rust-emit.tree `enter-task`) and
  // dropped when it ends: the texts read through a cursor, the text locals that are slice keys, the owned list locals,
  // the reads that are their name's last (`lastReads`) and the last of several in one statement, and the locals that are
  // a list slot until their last read (`slotTakes`). A stack, since nothing nests a task, read only at its top
  type TaskReads = {
    cursors: TextCursors
    sliceLets: WeakSet<Statement>
    moveNodes: WeakSet<object>
    manyMoves: WeakSet<object>
    slotLets: WeakMap<object, SlotTake & { kept: boolean }>
    slotReads: WeakMap<object, SlotTake>
  }
  const outside: TaskReads = {
    cursors: { names: [], reads: new Map() },
    sliceLets: new WeakSet(),
    moveNodes: new WeakSet(),
    manyMoves: new WeakSet(),
    slotLets: new WeakMap(),
    slotReads: new WeakMap(),
  }
  const tasks: TaskReads[] = []
  const reading = (): TaskReads => tasks[tasks.length - 1] ?? outside
  const enterTask = (node: Statement): rustEmit.TaskEntry => {
    const fn = node as Extract<Statement, { form: 'function' }>
    const cursors = textCursors(fn, asciiNodes)
    const slices = sliceKeys(fn)
    const owned = fn.async ? new Map<string, boolean>() : ownedLocals(fn, freshLists, lendParams, fieldLists, elementLists.moves)
    const lend = lendParams.get(fn.name)
    const lent = new Map<string, Lend>([
      ...fn.params.flatMap((p, i) => (lend?.has(i) ? [[p.name, lend.get(i)!] as const] : [])),
      ...[...owned.keys()].map(name => [name, 'write'] as const),
    ])
    const manyMoves = new WeakSet<object>()
    const moveNodes = lastReads(fn.body, manyMoves)
    const { lets: slotLets, takes: slotReads } = slotTakes(
      fn.body,
      name => lent.get(name) === 'write' || owned.get(name) === true,
      moveNodes,
      emptyCase,
      new Set(rustNames.mutatedCaptures(fn.body as never)),
    )

    tasks.push({ cursors, sliceLets: slices.lets, moveNodes, manyMoves, slotLets, slotReads })

    return {
      cursorNames: cursors.names,
      sliceNames: [...slices.names],
      owned: [...owned].map(([name, writes]) => ({ name, writes })),
    }
  }

  // a set as the table of flags the emitter reads
  const flagsOf = (names: Iterable<string>): Map<string, boolean> => new Map([...names].map(name => [name, true]))
  const listsOf = <K, V>(table: Map<K, Iterable<V>>): Map<K, V[]> => new Map([...table].map(([key, values]) => [key, [...values]]))
  // the fill tasks as compile/backend-names.tree reads them (backend.ts, `fillCall`)
  const fillTable = new Map<string, { size: number; itemAt: number; item?: Expression }>()

  for (const [name, fill] of fills) {
    fillTable.set(name, typeof fill.item === 'number' ? { size: fill.size, itemAt: fill.item } : { size: fill.size, itemAt: -1, item: fill.item })
  }

  // THE EMITTER (compile/rust-emit.tree): the program's tables, each keyed by a name, and the answers keyed by a node as
  // tests on this pass's own maps
  const facts: rustEmit.RustFacts = {
    variantOwner,
    variantOwners: listsOf(variantOwners),
    variantFields,
    caseFieldNames,
    closureFields: flagsOf(closureFields),
    recursiveFields: flagsOf(recursiveFields),
    payloads,
    boxedForms: flagsOf(boxedForms),
    reusable: flagsOf(
      program.flatMap(n => (n.form === 'record-type' && reusable(n.name) ? [n.name] : [])),
    ),
    maskMethods: flagsOf(maskMethods),
    maskOf,
    instanceTargets,
    implFn: implFn as never,
    raising: flagsOf(raising),
    recordFields: recordFields as never,
    exceptionForms: flagsOf(exceptionForms),
    nativeAliases: flagsOf(nativeAliases),
    functionParams: new Map([...functionParams].map(([name, params]) => [name, params.map(p => boxed(p))])) as never,
    asyncFunctions: flagsOf(asyncFunctions),
    implFnParams: listsOf(implFnParams),
    lendParams: lendParams as never,
    freshLists: flagsOf(freshLists),
    fieldLists: flagsOf(fieldLists),
    borrowParams: listsOf(borrowParams),
    variantTypes: variantTypes as never,
    caseFieldTypes: caseFieldTypes as never,
    plainRecords: flagsOf(plainRecords),
    moduleConsts: flagsOf(moduleConsts),
    moduleSlots: flagsOf(moduleSlots),
    scalarConsts: flagsOf(scalarConsts),
    textConsts: flagsOf(textConsts),
    hostStructOf,
    phantomForms,
    aliases: flagsOf(aliases),
    binds: binds as never,
    keyPositions,
    hasHiveTell,
    fills: fillTable as never,
    stackLists: listsOf(stackLists),
    formKeyIndices: listsOf(formKeyIndices),
    formFacts: formFacts as never,
    context: rustContext as never,
    isProven: node => provenSteps.has(node as never),
    loopGuardOf: node => {
      const guard = loopGuards.get(node as never)

      return boxed(
        guard && {
          fast: (guard.fast?.length ?? 0) > 0,
          limits: (guard.limits ?? []).map(l => ({ name: l.name, low: Boolean(l.low), high: l.high ?? 0 })),
        },
      )
    },
    isFastIn: (node, loop) => Boolean(loopGuards.get(loop as never)?.fast?.includes(node)),
    isUnsignedDiv: node => unsignedDivs.has(node as never),
    isASCII: node => asciiNodes.has(node),
    ownsInnerItem: node => ownsInner(elementLists.items, node),
    ownsInnerLet: node => ownsInner(elementLists.lets, node),
    ownsInnerWalk: node => ownsInner(elementLists.walks, node),
    isMoveNode: node => reading().moveNodes.has(node),
    isManyMove: node => reading().manyMoves.has(node),
    slotLetOf: node => boxed(reading().slotLets.get(node)) as never,
    slotReadOf: node => boxed(reading().slotReads.get(node)) as never,
    isSliceLet: node => reading().sliceLets.has(node as never),
    cursorOf: node => boxed(reading().cursors.reads.get(node)),
    enterTask,
    leaveTask: () => {
      tasks.pop()

      return true
    },
    sameNode: (left, right) => left === right,
    sameStatement: (left, right) => left === right,
    fail: reason => {
      throw new Error(reason)
    },
  }
  const st = rustEmit.newRustState()
  const stmt = (node: Statement, d: number): string => rustEmit.emitStatement(node as never, d, st, facts)
  const moduleLet = (node: Extract<Statement, { form: 'let' }>): string => rustEmit.moduleLet(node as never, st, facts)

  // `use` declarations for native module bindings, then the `use` each called bind needs, each name bound once
  // (compile/rust-assemble.tree `rust-uses`)
  const uses = rustAssemble.rustUses(program as never, bindImports(referencedBinds(program, binds), 'rust') as never)

  // each statement's text, beside the module it came from, which is marked on it once the passes below that read a
  // text's start (`fn `) have run (compile/unit-split.ts). The statements written are `keptStatements`': no native
  // binding, no signature-only task another module implements, a task once per name and arity, a form once
  const written = [
    ...hostStructDefs.map(text => [text, undefined] as const),
    ...(rustAssemble.keptStatements(program as never) as unknown as Statement[]).map(
      n => [n.form === 'let' ? moduleLet(n) : stmt(n, 0), n.span.file] as const,
    ),
  ].filter(([text]) => Boolean(text))
  const body: string[] = written.map(([text]) => text)
  const bodyFiles: (string | undefined)[] = written.map(([, file]) => file)

  // each task a guarded loop calls unchecked, once more with plain arithmetic and its proven non-negative divisions
  // unsigned (`a_value_fast`), behind the bound the guard proved its arguments inside (ir/facts/bounds.ts)
  // (the list grows while it is walked, as a set walked in order does, when a copy calls another task unchecked)
  for (let at = 0; at < st.fastTasks.length; at++) {
    const name = st.fastTasks[at]!
    const fn = program.find((n): n is Extract<Statement, { form: 'function' }> => n.form === 'function' && n.name === name)

    if (fn) {
      body.push(rustEmit.emitUnchecked({ ...fn, name: `${name}-fast` } as never, st, facts))
      bodyFiles.push(fn.span.file)
    }
  }

  // a fill walker raises `data-mismatch` through the carrier, so it brings the carrier wherever its fill is
  const fillsForms = st.fillSpecs.size > 0

  // the wake chain: one `hive_wake` per deck with its static entries, when the program has the stdlib hive and the
  // compile driver handed over the roll. A static entry's `base` is the declaration as JSON text, boxed; an entry
  // with a `ref` (a declared kind's constant) binds the live module constant instead. See note/term/hive/05-hive.md.
  const wake: string[] = []

  if (
    options?.wake?.length &&
    program.some(n => n.form === 'function' && n.name === 'hive-wake')
  ) {
    const entryText = (entry: Record<string, unknown>): string => {
      const { ref, base, ...own } = entry
      const boxed =
        typeof ref === 'string'
          ? `std::rc::Rc::new(${rustEmit.moduleRead(ref, st, facts)})`
          : `std::rc::Rc::new(${JSON.stringify(JSON.stringify(base ?? {}))}.to_string())`

      return `HiveEntry { host: ${JSON.stringify(String(own.host ?? ''))}.to_string(), kind: ${JSON.stringify(String(own.kind ?? ''))}.to_string(), name: ${JSON.stringify(String(own.name ?? ''))}.to_string(), site: ${JSON.stringify(String(own.site ?? ''))}.to_string(), base: ${boxed} }`
    }

    const calls = options.wake
      .map(
        group =>
          `    hive_wake(${JSON.stringify(group.deck)}.to_string(), std::rc::Rc::new(std::cell::RefCell::new(vec![${group.entries.map(entryText).join(', ')}])));`,
      )
      .join('\n')

    wake.push(`pub fn wake_hive() {\n${calls}\n}`)
  }

  lastBudgetStats = { checked: st.budgetUses, elided: st.budgetElided }

  // `melt` clones every field of each form it melts (item 0029)
  for (const form of st.meltSpecs.keys()) {
    rustEmit.noteClone(boxed({ kind: 'named', name: form }) as never, st, facts)
  }

  // what this pass cloned, for `emitRust` to box the forms nothing cloned
  for (const form of st.cloneForms.keys()) {
    cloneRecord.forms.add(form)
  }

  cloneRecord.generic ||= st.cloneGeneric

  // THE MODULE (compile/rust-assemble.tree `rust-module`): the runtime in front (the insertion-ordered `TermMap`,
  // `TermShared`, the text cursor, `term_number`, `TermKey` where text keys hold it, the exception carrier where a raise
  // or a fill is written, the preemption budget where a loop checks it, the executor where anything is asynchronous),
  // each task's spare boxes, the box pools of the forms an arm opened and a construction built, the statements marked
  // with their modules, and the walkers and the wake chain after
  return rustAssemble.rustModule(
    {
      uses,
      body,
      bodyFiles: bodyFiles.map(file => file ?? ''),
      carries: st.carries,
      fills: fillsForms,
      budgetUses: st.budgetUses,
      spawnUses: st.spawnUses,
      boxedFutures: st.boxedFutures,
      textKeys: rustContext.textKeys,
      reuseOpened: [...st.reuseOpened],
      reuseBuilt: [...st.reuseBuilt],
      boxedForms: [...boxedForms],
      payloads: [...payloads].map(([key, name]) => ({ key, name })),
      formWalk: rustFormWalk(st.fillSpecs, st.meltSpecs),
      wake,
    } as never,
    program as never,
  )
}

// how many asynchronous loops the last `emitRust` gave a budget check, and how many it left one out of because a
// small literal bounds them: the elision rate design 5 asked to be measured before it is promised
let lastBudgetStats = { checked: 0, elided: 0 }

export function budgetStats(): { checked: number; elided: number } {
  return lastBudgetStats
}


// ---- filling a form from data on rust ----

// the walkers a module's `fill` / `melt` with a form need: shared helpers over the package's `Data` enum, then a
// function per form. A value that does not fit raises the package's `data-mismatch`
function rustFormWalk(fills: Map<string, rustEmit.FormSpec>, melts: Map<string, rustEmit.FormSpec>): string[] {
  return rustNames.rustFormWalk([...fills.values()] as never, [...melts.values()] as never)
}
