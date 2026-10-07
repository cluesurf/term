// The nice TypeScript emitter. Compile AST to clean, idiomatic, native TypeScript: real names (kebab to camel),
// native control flow, plain operators, native arithmetic, types from the checker, no runtime imports. Pure and
// browser-safe: returns a string. See note/research/vibe/computation/plans/07-codegen.md.

import type {
  Expression,
  Program,
  Statement,
  Type,
} from '@term/make/code/compile/node'
import type { Fill, RecordCopies, TextCursors } from '@term/make/code/compile/backend'
import {
  recordCopies,
  redeclaredLets,
  fillTasks,
  lentLists,
  tailTasks,
  textCursors,
  gatedTasks,
  listFacts,
} from '@term/make/code/compile/backend'
import { provenArithmetic, type Proven } from '@term/make/code/compile/proven'
import { boundedLoops } from '@term/make/code/ir/facts/bounds'
import type { LoopGuard } from '@term/make/code/ir/facts/bounds'
import { recordPlaces, recordReuse } from '@term/make/code/compile/place'
import type { Reuse } from '@term/make/code/compile/place'
import { asciiTexts } from '@term/make/code/ir/facts/text'
import type { PlaceWrite } from '@term/make/code/compile/place'
import * as tsNames from '@term/make/code/compile/ts-names'
import * as tsEmit from '@term/make/code/compile/ts-emit'
import * as tsPreludes from '@term/make/code/compile/ts-preludes'
import * as tsAssemble from '@term/make/code/compile/ts-assemble'

// The TypeScript emitter is Term in four parts (self-hosting, 2026-10-06): compile/ts-names.tree, the helpers that read
// no emitter state (the names, a type's spelling and empty value, one primary, the identity cases, the fill spec),
// compile/ts-emit.tree, the emitter itself (`makeEmitter` below drives it), compile/ts-preludes.tree, the runtime a
// module carries in front of its code, and compile/ts-assemble.tree, which reads a program into the tables below and
// writes the module. This file keeps the module state the emitter reads, and the analyses whose answers it asks for:
// each is keyed by node identity (compile/place.ts, ir/facts/bounds.ts, the interval fact, ir/facts/text.ts), and
// `tsProven` is one of them.
type Maybe<T> = { form: 'some'; value: T } | { form: 'none' }
const unbox = <T>(value: Maybe<T>): T | undefined => (value.form === 'some' ? value.value : undefined)
const boxed = <T>(value: T | undefined): Maybe<T> => (value === undefined ? { form: 'none' } : { form: 'some', value })

// the TypeScript identifier a seed name compiles to (kebab/snake to camelCase). Exported so the benchmark runner can
// map a seed function name to the exported symbol it must call in the emitted module. Plain camelCase: a user's own
// function `make-api` becomes `makeApi`, not `makeAPI`. Acronym uppercasing (for host FFI names) is reserved for
// member access (see `toMember`), where the emitted name must match the platform exactly.
export function toCamel(name: string): string {
  return tsNames.toCamel(name)
}

// a kebab / snake name to a SCREAMING_SNAKE constant (`database-url` -> `DATABASE_URL`), for environment variable names
export function toConstant(name: string): string {
  return tsNames.toConstant(name)
}

// the empty value of a type: what a left-out field holds (the same rule the Rust / Swift / Kotlin backends apply)
export function tsEmptyOf(type: Type | undefined): string {
  return tsNames.tsEmptyOf(boxed(type) as never)
}

// D10 (decided 2026-10-05): a `need false` field typed `maybe T` is `f?: T` on TypeScript, the shape a TypeScript
// caller writes and tests (`node.type?: Type`), and `maybe T` everywhere else. So a READ of it is a maybe here
// (`__termMaybe(x.f)`, none where the field is absent), and a WRITE unwraps one (`__termSome(m)`, the field left
// undefined for none). A plain `need false` field keeps its type's empty value. Natively nothing changes: the field
// is the maybe it is declared. test/compile/maybe-field.ts. Answers the inner type, or undefined for any other field
export function optionalMaybe(field: { type: Type; optional?: boolean } | undefined): Type | undefined {
  return field ? (unbox(tsNames.optionalMaybe(field as never)) as Type | undefined) : undefined
}

export function toPascal(name: string): string {
  return tsNames.toPascal(name)
}

// ---- the module state the emitter reads, set by emitTypeScript from compile/ts-assemble.tree's tables ----

// opaque per-backend handle types (`dock type / load <any>, name tcp-handle`): seed name -> concrete TS type, so a
// `like tcp-handle` field emits the declared type rather than a nonexistent class
let tsOpaqueTypes = new Map<string, string>()

// the exception forms of the program being emitted (every record-type whose chain includes `exception`), so a
// `halt <form>` throws an instance of the runtime class and not a bare object
let tsExceptions = new Set<string>()

// each variant's declared field names, in order, so a match arm can bind them as locals: `case circle` puts
// `radius` in scope (the resolver already declares it), and `link r` renames the first field to `r`. Without this
// the arm read a bare identifier nothing had declared and the program died at run time
let tsVariantFields = new Map<
  string,
  { name: string; type: Type; optional?: boolean }[]
>()

// the same, keyed by the enum that declares the case. A variant NAME is not unique in a program: `any`, `not`,
// `position` and `boundary` are each declared by both `Pattern` and `Condition` in the v4 Sanskrit grammar, and
// the flat map above holds whichever was read last. Filling a construction's left-out fields has to use the
// enum the construction is TYPED as, or it fills the other sum's fields and the literal stops matching its own
// type. Owner -> variant -> fields.
let tsVariantFieldsByOwner = new Map<
  string,
  Map<string, { name: string; type: Type; optional?: boolean }[]>
>()

// the fields of every struct form in the program, for the `fill` / `melt` spec: name, type, `need false`
let tsRecordFields = new Map<string, { name: string; type: Type; optional?: boolean }[]>()
// did this module lower a `fill` or `melt` with a form? Then the walk rides in its prelude
let tsFormWalkUsed = false
// did a host value meet a declared type (`save body, like text, wait fs/read-file(...)`)? Then `__termHost` rides along
let tsHostUsed = false
// set when a `need false` maybe field is read or written (D10), so `__termMaybe` and `__termSome` ride in front
let tsMaybeFieldUsed = false
// the Term names of the program's `dock load` modules: a call rooted at one returns the host's own value
let tsDockNames = new Set<string>()
// set when an emitted `+`, `-` or `*` on two numbers is range-checked (__termInt), so the helper rides in front
let tsIntUsed = false
// set when an `is-equal` compares by structure (__termEqual) or a map key is interned (__termKey)
let tsEqualUsed = false
// set when a text operation goes through `__termText`, which counts code points (note/term/stdlib/semantics.md)
let tsTextUsed = false
// set when a list read, write, pop or slice goes through the checked list helpers (note/term/stdlib/semantics.md)
let tsListUsed = false
// the `note shared` forms: references by design, compared and keyed by identity as on the other backends
let tsSharedForms = new Set<string>()

// `mark tag, name kind`: the unions that discriminate on a field other than `form`, by the union and by each of its
// variants. Only tagged forms are listed, so a program without one emits exactly what it always did
// (self-hosting-0020)
let tsTagByOwner = new Map<string, string>()
let tsTagByVariant = new Map<string, string>()

// `mark text` (D9): each closed set of texts, by the form and by each of its cases, case -> its text. A value of one
// IS its text: the type is the string-literal union, a construction the literal, a match a string comparison. Only
// such forms are listed, so every other program emits what it always did
let tsTextByOwner = new Map<string, Map<string, string>>()
let tsTextByVariant = new Map<string, string>()

// the variants this module constructs with no fields, each ONE frozen constant (name -> constant): a field-less value
// carries nothing a construction could set and nothing a program could write, so every `make leaf` can be the same
// object. A fresh `{ form: "leaf" }` per construction was most of binary-trees' gap to hand-written code
let tsFieldless = new Map<string, string>()

// THE FIELD-LESS CASE TESTED BY IDENTITY, `form/case` keys (`identityCases`). Where every value of a field-less case is
// the one frozen constant, a match tests the value against it (`__termIsEnd(c)`, a type guard so the other branch
// still narrows), never reading the tag: List's every test read `c.form`, polymorphic across the frozen constant's
// shape and a link's, 128 ms to 89 against the hand version's `=== null` at 75 (`tmp/ts-list-identity-ab.ts`)
let tsIdentity = new Set<string>()
// the guards a program's matches called, case -> its guard's name, emitted beside the constants
let tsGuards = new Map<string, string>()

// the forms whose field-less cases are only ever their constant: never in the answer of a call into a native module
// (a shim builds its own `{ form: "none" }`), in no program that fills or melts data into forms, holds a stub of
// another unit's task, or is emitted one module at a time (each module its own constant)
export function identityCases(program: Program, perModule: boolean): Set<string> {
  return new Set(tsNames.identityCases(program as never, perModule))
}

// every function's declared parameters, so a left-out trailing `need false` argument is filled with its type's empty
// value, as the Rust, Swift and Kotlin backends fill it: left as `undefined`, a left-out text printed "undefined" here
// and nothing there
let tsFunctionParams = new Map<string, { type?: Type; optional?: boolean }[]>()

// THE TEXT OPERATIONS COUNT CODE POINTS, as they do on Rust, Swift and Kotlin (note/term/stdlib/semantics.md). The
// runtime is compile/ts-preludes.tree's `text-prelude-source`, one object as written, and a module carries only the
// methods its code names, each a function of its own, so a bundle keeps only the functions its program reaches
export const TEXT_PRELUDE = tsPreludes.textPreludeSource()

// the text runtime a module's code needs: the methods it names, what they name in turn, and the helpers they mention
export function textPrelude(code: string): string {
  return tsPreludes.textPrelude(code)
}

// the integer operations proven inside the safe integers (compile/proven.ts). The interval fact reads F1's list facts,
// which this backend keys no representation by, so they are computed here for that alone
function tsProven(program: Statement[]): Proven {
  const masks = new Set(program.flatMap(n => (n.form === 'mask' ? n.methods : [])))
  const { lend, fresh } = listFacts(program, gatedTasks(program, masks))

  return provenArithmetic(program, lend, fresh)
}

function makeEmitter(
  variants: Set<string>,
  hmr = false,
  binds = new Map<string, Statement>(),
  env = 'node',
  // the `+`, `-` and `*` nodes proven not to overflow (compile/proven.ts): written without `__termInt`
  provenSteps: Proven = new WeakSet<Expression>(),
  // the counted loops whose list indexes a guard before the loop can prove in bounds (ir/facts/bounds.ts)
  loopGuards: WeakMap<Statement, LoopGuard> = new WeakMap(),
  // the slot writes of a record that assign the changed fields of the object already there (compile/place.ts)
  places: Map<Statement, PlaceWrite> = new Map(),
  // where a record is copied so a write through one name cannot reach another (backend.ts, `recordCopies`)
  copies: RecordCopies = { params: new Map(), lets: new Map(), plain: new Set() },
  // the text expressions proven ASCII, read with JavaScript's own string reads (ir/facts/text.ts)
  asciiNodes: WeakSet<object> = new WeakSet(),
  // the tasks that only fill a list, made in one allocation at each call (backend.ts, `fillTasks`)
  fills: Map<string, Fill> = new Map(),
  // the records built in the object their task was given (compile/place.ts, `recordReuse`)
  reuse: Reuse = { tasks: new Map(), sites: new WeakSet(), forms: new Set(), locals: new WeakMap(), writeBacks: new WeakSet() },
  // the tasks whose every self call is a tail call, each to those returns (backend.ts, `tailTasks`)
  tailCalls: Map<string, WeakSet<object>> = new Map(),
  // the render runtime's names as the build bound them (D020), for a view's zone
  runtime: { name: string; bound: string }[] = [],
) {
  // each task's text cursors and redeclared `let`s, asked once per task
  const cursorsOf = new WeakMap<object, TextCursors>()
  const cursorsFor = (fn: Statement): TextCursors => {
    let found = cursorsOf.get(fn)

    if (!found) {
      found = textCursors(fn as Extract<Statement, { form: 'function' }>, asciiNodes)
      cursorsOf.set(fn, found)
    }

    return found
  }
  const redeclaredOf = new WeakMap<object, WeakSet<Statement>>()
  const redeclaredFor = (fn: Statement): WeakSet<Statement> => {
    let found = redeclaredOf.get(fn)

    if (!found) {
      found = redeclaredLets(fn as Extract<Statement, { form: 'function' }>)
      redeclaredOf.set(fn, found)
    }

    return found
  }
  const flags = (names: Iterable<string>): Map<string, boolean> => new Map([...names].map(name => [name, true]))
  // the fill tasks as compile/backend-names.tree reads them: a parameter position, or the literal item
  const fillTable = new Map(
    [...fills].map(([name, fill]) => [
      name,
      typeof fill.item === 'number' ? { size: fill.size, itemAt: fill.item } : { size: fill.size, itemAt: -1, item: fill.item },
    ]),
  )
  const facts = {
    variants: flags(variants),
    variantFields: tsVariantFields,
    variantFieldsByOwner: tsVariantFieldsByOwner,
    recordFields: tsRecordFields,
    sharedForms: flags(tsSharedForms),
    identity: flags(tsIdentity),
    textByOwner: tsTextByOwner,
    textByVariant: tsTextByVariant,
    tagByOwner: tsTagByOwner,
    tagByVariant: tsTagByVariant,
    functionParams: tsFunctionParams,
    exceptions: flags(tsExceptions),
    dockNames: flags(tsDockNames),
    opaque: tsOpaqueTypes,
    binds,
    fills: fillTable,
    copyParams: copies.params,
    plainRecords: flags(copies.plain),
    env,
    hmr,
    runtime,
    isProven: (node: object) => provenSteps.has(node as Expression),
    loopGuardOf: (node: object) => boxed(loopGuards.get(node as Statement)),
    isFastIn: (node: object, loop: object) => loopGuards.get(loop as Statement)?.fast?.includes(node) ?? false,
    placeOf: (node: object) => boxed(places.get(node as Statement)),
    copyOfLet: (node: object) => boxed(copies.lets.get(node as Statement)),
    isASCII: (node: object) => asciiNodes.has(node),
    isReuseSite: (node: object) => reuse.sites.has(node),
    reuseKeptOf: (node: object) => boxed(reuse.locals.get(node)),
    isWriteBack: (node: object) => reuse.writeBacks.has(node),
    reuseTaskOf: (name: string) => {
      const task = reuse.tasks.get(name)

      return boxed(task ? { param: task.param, keep: task.keep?.field ?? '' } : undefined)
    },
    isBuild: (task: string, node: object) => reuse.tasks.get(task)?.builds.has(node) ?? false,
    isCarrier: (task: string, node: object) => reuse.tasks.get(task)?.carriers?.has(node) ?? false,
    hasTails: (name: string) => tailCalls.has(name),
    isTailReturn: (task: string, node: object) => tailCalls.get(task)?.has(node) ?? false,
    isRedeclared: (fn: object, node: object) => redeclaredFor(fn as Statement).has(node as Statement),
    cursorNames: (fn: object) => cursorsFor(fn as Statement).names,
    cursorOf: (fn: object, node: object) => boxed(cursorsFor(fn as Statement).reads.get(node)),
    sameNode: (left: object, right: object) => left === right,
  }
  const st = tsEmit.newEmitState(tsFieldless, tsGuards)
  // the prelude flags the emitter raised, onto the module's own
  const sync = <T>(value: T): T => {
    tsFormWalkUsed ||= st.formWalkUsed
    tsHostUsed ||= st.hostUsed
    tsMaybeFieldUsed ||= st.maybeFieldUsed
    tsIntUsed ||= st.intUsed
    tsEqualUsed ||= st.equalUsed
    tsTextUsed ||= st.textUsed
    tsListUsed ||= st.listUsed

    return value
  }

  return {
    statement: (node: Statement, depth: number): string => sync(tsEmit.emitStatement(node as never, depth, st, facts as never)),
    expression: (node: Expression, parent = 0): string => sync(tsEmit.emitExpression(node as never, parent, st, facts as never)),
    unchecked: (fn: Statement): string => sync(tsEmit.emitUnchecked(fn as never, st, facts as never)),
    // a task's copy that builds its result in the record it is given, for a reuse site (`recordReuse`): with a kept
    // field, the copy answers that field alone
    reusingCopy: (fn: Extract<Statement, { form: 'function' }>): string => {
      const task = reuse.tasks.get(fn.name)!
      const copy = { ...fn, name: `${fn.name}-reuse`, ...(task.keep ? { result: task.keep.type } : {}) }

      return sync(tsEmit.emitReusing(copy as never, fn.name, st, facts as never))
    },
    // the field a field-less variant's constant is tagged by, for the prelude
    tagFor: (variant: string): string => tsEmit.tagFor(variant, { form: 'none' } as never, facts as never),
    get fastTasks(): string[] {
      return st.fastTasks
    },
    get reuseTasks(): string[] {
      return st.reuseTasks
    },
  }
}

export function emitTypeScript(
  program: Program,
  // `variants` carries the enum variant names defined across the WHOLE program. In per-module mode a module that builds
  // `make some` may not itself define `maybe`, so without this its variant constructors would lose their `form` tag.
  options?: {
    hmr?: boolean
    variants?: Set<string>
    // a library host code also builds values of: no field-less case is tested by identity (compile.ts `library`)
    library?: boolean
    env?: string
    // exception form names defined across the WHOLE program, for the same per-module reason as `variants`
    exceptions?: Set<string>
    // the roll to wake the hive with, one group per deck, when the program loads the stdlib hive. The emitter
    // appends a `wakeHive()` that calls `hiveWake` per deck and hooks raised exceptions into `hiveTell`
    wake?: { deck: string; entries: Record<string, unknown>[] }[]
    // export each top-level constant too: per-module emit (compile/modules.ts), where another module reads it
    exportConstants?: boolean
    // THE WHOLE PROGRAM, read and never emitted: per-module emit hands this emitter one module, and a `case` on a form
    // another module defines then declared none of its fields, so `case graft` in @term/host's fuse read `name` and
    // `value` that were never bound (2026-10-05, found by `stdlib emit-types` on the separate build). The forms, their
    // fields, tags and texts, the handle types and the tasks' parameters come from here as well as `program`
    context?: Program
    // the render runtime's names as the build bound them (D020): a view's zone calls these, a name the build split by
    // file under the one render.tree reaches
    runtime?: { name: string; bound: string }[]
  },
): string {
  const env = options?.env ?? 'node'
  // stubs dropped, `hook` routes lowered, and every table the emitter's facts are built from
  const tables = tsAssemble.tsTables(
    program as never,
    boxed(options?.context) as never,
    [...(options?.variants ?? [])],
    [...(options?.exceptions ?? [])],
    options?.library ?? false,
    options?.variants !== undefined,
    env,
  )
  const lowered = tables.program as unknown as Program

  tsOpaqueTypes = tables.opaque
  tsExceptions = new Set(tables.exceptions.keys())
  tsVariantFields = tables.variantFields as never
  tsVariantFieldsByOwner = tables.variantFieldsByOwner as never
  tsRecordFields = tables.recordFields as never
  tsFormWalkUsed = false
  tsHostUsed = false
  tsMaybeFieldUsed = false
  tsDockNames = new Set(tables.dockNames.keys())
  tsIntUsed = false
  tsEqualUsed = false
  tsTextUsed = false
  tsListUsed = false
  tsFieldless = new Map()
  tsIdentity = new Set(tables.identity)
  tsGuards = new Map()
  tsSharedForms = new Set(tables.sharedForms.keys())
  tsTagByOwner = tables.tagByOwner
  tsTagByVariant = tables.tagByVariant
  tsTextByOwner = tables.textByOwner
  tsTextByVariant = tables.textByVariant
  tsFunctionParams = tables.functionParams as never

  const emitter = makeEmitter(
    new Set(tables.variants.keys()),
    options?.hmr ?? false,
    tables.binds as unknown as Map<string, Statement>,
    env,
    tsProven(lowered),
    boundedLoops(lowered, lentLists(lowered)),
    recordPlaces(lowered).writes,
    recordCopies(lowered, options?.context),
    asciiTexts(lowered),
    fillTasks(lowered),
    recordReuse(lowered),
    tailTasks(lowered),
    options?.runtime ?? [],
  )

  // the wake entries, each its text: an entry with a `ref` is a declared kind's constant, its `base` the constant's live
  // value and not a copy. Written here because an entry is an open JSON record, whatever keys it has
  const entryText = (entry: Record<string, unknown>): string => {
    const { ref, ...rest } = entry

    if (typeof ref !== 'string') {
      return JSON.stringify(rest)
    }

    const { base: _base, ...own } = rest

    return `{ ...${JSON.stringify(own)}, base: ${toCamel(ref)} }`
  }
  return tsAssemble.assembleTypeScript(
    tables,
    env,
    options?.exportConstants === true,
    Boolean(options?.wake?.length),
    () => (options?.wake ?? []).map(group => ({ deck: group.deck, entries: group.entries.map(entryText) })),
    node => emitter.statement(node as unknown as Statement, 0),
    (node, name) => emitter.unchecked({ ...(node as unknown as Statement), name } as Statement),
    node => emitter.reusingCopy(node as unknown as Extract<Statement, { form: 'function' }>),
    variant => emitter.tagFor(variant),
    () => emitter.fastTasks,
    () => emitter.reuseTasks,
    () => ({
      formWalkUsed: tsFormWalkUsed,
      hostUsed: tsHostUsed,
      maybeFieldUsed: tsMaybeFieldUsed,
      intUsed: tsIntUsed,
      equalUsed: tsEqualUsed,
      textUsed: tsTextUsed,
      listUsed: tsListUsed,
      fieldless: tsFieldless,
      guards: tsGuards,
    }),
  )
}
