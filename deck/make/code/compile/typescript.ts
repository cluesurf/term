// The nice TypeScript emitter. Compile AST to clean, idiomatic, native TypeScript: real names (kebab to camel),
// native control flow, plain operators, native arithmetic, types from the checker, no runtime imports. Pure and
// browser-safe: returns a string. See note/research/vibe/computation/plans/07-codegen.md.

import type {
  BinaryOp,
  Expression,
  Program,
  Statement,
  Type,
  ViewNode,
} from '@term/make/code/compile/node'
import type { Fill, RecordCopies, TextCursors } from '@term/make/code/compile/backend'
import {
  recordCopies,
  redeclaredLets,
  mapUpdate,
  fillTasks,
  fillCall,
  lentLists,
  tailTasks,
  textCursors,
  exhausted,
  mapCollect,
  stringCall,
  stringRead,
  isText,
  gatedTasks,
  listFacts,
  namesIn,
} from '@term/make/code/compile/backend'
import { lowerRoutes } from '@term/make/code/compile/route-lower'
import { RENDER } from '@term/make/code/compile/render-names'
import {
  collectBinds,
  renderBind,
  bindGap,
  referencedBinds,
  bindTarget,
} from '@term/make/code/compile/bind'
import type { Bind } from '@term/make/code/compile/bind'
import { armLocals } from '@term/make/code/check/arm'
import { provenArithmetic, type Proven } from '@term/make/code/compile/proven'
import { boundedLoops, listKey } from '@term/make/code/ir/facts/bounds'
import type { LoopGuard } from '@term/make/code/ir/facts/bounds'
import { recordPlaces, recordReuse } from '@term/make/code/compile/place'
import type { Reuse } from '@term/make/code/compile/place'
import { asciiTexts } from '@term/make/code/ir/facts/text'
import type { PlaceWrite } from '@term/make/code/compile/place'

const guardStart = (text: string): string =>
  /^[([`]/.test(text) ? `;${text}` : text

// a division of two integers: both operands typed `number` (a `float` or an unresolved operand keeps JavaScript's
// float quotient, since its meaning is not known to be the integer one)
// whether an emitted expression is ONE primary, safe under any operator without parentheses: a name or member chain
// (`a.b.c`), that followed by a call or index group closing at the very end (`Math.trunc(x)`, `a.b[i]`), or a whole
// parenthesized group. Text inside quotes is skipped when matching the groups
function isPrimary(text: string): boolean {
  const close: Record<string, string> = { '(': ')', '[': ']' }

  // the index of the group closing the one that opens at `start`, or -1
  const matching = (start: number): number => {
    const stack: string[] = []
    let quote = ''

    for (let i = start; i < text.length; i++) {
      const ch = text[i]!

      if (quote) {
        if (ch === '\\') {
          i++
        } else if (ch === quote) {
          quote = ''
        }

        continue
      }

      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch
      } else if (ch === '(' || ch === '[') {
        stack.push(close[ch]!)
      } else if (ch === ')' || ch === ']') {
        if (stack.pop() !== ch) {
          return -1
        }

        if (stack.length === 0) {
          return i
        }
      }
    }

    return -1
  }

  if (text.startsWith('(')) {
    return matching(0) === text.length - 1
  }

  const name = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/.exec(text)

  if (!name) {
    return /^\d+$/.test(text)
  }

  let at = name[0].length

  // any run of call and index groups after the name, each closing where the next begins
  while (at < text.length && (text[at] === '(' || text[at] === '[')) {
    const end = matching(at)

    if (end < 0) {
      return false
    }

    at = end + 1
  }

  return at === text.length
}

function integerDivision(node: { left: { type?: { kind: string } }; right: { type?: { kind: string } } }): boolean {
  return node.left.type?.kind === 'number' && node.right.type?.kind === 'number'
}

const PRECEDENCE: Record<BinaryOp, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 3,
  '<=': 3,
  '>': 3,
  '>=': 3,
  '+': 4,
  '-': 4,
  '*': 5,
  '/': 5,
  '%': 5,
}

// JavaScript reserved words that cannot be bare identifiers; a seed name colliding with one is suffixed with `_`.
// Applied uniformly (definitions and uses), so a field/param named `new` stays consistent across the module.
const RESERVED = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'let',
  'static',
  'await',
  'async',
  'implements',
  'interface',
  'package',
  'private',
  'protected',
  'public',
  // not keywords, but illegal as binding names in an ES module / strict mode
  'eval',
  'arguments',
  // not reserved, but the platform globals the runtime shims read by name. A page bundle is a classic script, so a
  // top-level Term task named `window` (list's sliding windows) shadowed the real one for the whole bundle, and the
  // cask bridge's `window.term` read a property of that function: every cask page failed on its first call
  'window',
  'document',
  'globalThis',
  'navigator',
  // the same for the globals the shims call: a Term `fetch` (http's GET) made the http shim's `fetch(url)` call itself.
  // Not `console` or `crypto`: modules dock those by that very name, and a dock alias is written as given
  'fetch',
  'performance',
  'atob',
  'btoa',
  'setTimeout',
  'clearTimeout',
  'queueMicrotask',
  'structuredClone',
])

// acronyms that the host APIs spell in all caps (randomUUID, toJSON, parseURL). A whole kebab segment matching one of
// these uppercases entirely instead of just its first letter, so FFI member names match the platform exactly. `id` is
// deliberately excluded (host convention is `Id`, e.g. userId).
const ACRONYMS = new Set([
  'uuid',
  'url',
  'uri',
  'http',
  'https',
  'html',
  'xml',
  'json',
  'css',
  'api',
  'sql',
  'ascii',
  'utf8',
  'jwt',
])

// the TypeScript identifier a seed name compiles to (kebab/snake to camelCase). Exported so the benchmark runner can
// map a seed function name to the exported symbol it must call in the emitted module. Plain camelCase: a user's own
// function `make-api` becomes `makeApi`, not `makeAPI`. Acronym uppercasing (for host FFI names) is reserved for
// member access (see `toMember`), where the emitted name must match the platform exactly.
export function toCamel(name: string): string {
  const parts = name.split(/[-_]/)
  const head = parts[0] ?? ''
  const camel =
    head +
    parts
      .slice(1)
      .map(p => p.charAt(0).toUpperCase() + p.slice(1))
      .join('')

  return RESERVED.has(camel) ? `${camel}_` : camel
}

// a kebab / snake name to a SCREAMING_SNAKE constant (`database-url` -> `DATABASE_URL`), for environment variable names
export function toConstant(name: string): string {
  return name
    .split(/[-_]/)
    .map(p => p.toUpperCase())
    .join('_')
}

// a member name a seed name compiles to, uppercasing whole-segment acronyms so a host FFI call matches the platform
// spelling exactly (`set-attribute` -> `setAttribute`, `to-json` -> `toJSON`, `inner-html` -> `innerHTML`). Used only
// for member access (`receiver.method(...)`), which is how bind's JS-`this`-style DOM methods are invoked.
function toMember(name: string): string {
  const parts = name.split(/[-_]/)
  const head = parts[0] ?? ''

  return (
    head +
    parts
      .slice(1)
      .map(p =>
        ACRONYMS.has(p)
          ? p.toUpperCase()
          : p.charAt(0).toUpperCase() + p.slice(1),
      )
      .join('')
  )
}

// TypeScript lib type names a seed form must not merge with: an emitted `interface Set` DECLARATION-MERGES with
// the built-in `Set`, so every use site resolves to the wrong shape. Such a form is spelled with a `Form` suffix
// throughout the emit, the way the Swift backend suffixes Foundation collisions.
const TS_TAKEN = new Set([
  'Set',
  'Map',
  'Date',
  'Error',
  'Promise',
  'Symbol',
  'Object',
  'Array',
  'Number',
  'String',
  'Boolean',
  'RegExp',
  'Function',
  'Iterator',
])

// the empty value of a type: what a left-out field holds (the same rule the Rust / Swift / Kotlin backends apply)
export function tsEmptyOf(type: Type | undefined): string {
  switch (type?.kind) {
    case 'string':
      return '""'
    case 'boolean':
      return 'false'
    case 'float':
    case 'number':
      return '0'
    case 'bytes':
      return 'new Uint8Array()'
    case 'array':
      return '[]'
    case 'map':
      return 'new Map()'
    case 'named':
      if (type.name === 'text') {
        return '""'
      }

      if (type.name === 'boolean') {
        return 'false'
      }

      if (type.name === 'list') {
        return '[]'
      }

      if (type.name === 'hash') {
        return 'new Map()'
      }

      return 'undefined as any'
    default:
      return 'undefined as any'
  }
}

// The declared fields of one VARIANT, resolved through the enum the construction was typed as. A variant name
// alone is ambiguous (two sums may each declare a case called `any`), so an overloaded name with no resolved
// type fills NOTHING rather than guessing: an under-filled literal is a type error a reader can act on, and a
// wrongly-filled one is a literal that silently stops matching its own type.
function variantCase(
  name: string,
  type: Type | undefined,
): { name: string; type: Type; optional?: boolean }[] {
  const owner = type?.kind === 'named' ? type.name : undefined
  const byOwner = owner ? tsVariantFieldsByOwner.get(owner) : undefined
  const own = byOwner?.get(name)

  if (own) {
    return own
  }

  let owners = 0

  for (const sum of tsVariantFieldsByOwner.values()) {
    if (sum.has(name)) {
      owners += 1
    }
  }

  return owners === 1 ? (tsVariantFields.get(name) ?? []) : []
}

// The fields a construction left out, each set to its type's empty value, so the object literal satisfies the
// interface (or the variant case) it is written for. A struct has done this since the native backends needed
// it; a VARIANT did not, which is the disagreement between a construction and its own type that lean-0044
// names. A `need false` field left out holds its type's empty value too, as it does on Rust, Swift and Kotlin: left
// `undefined`, a left-out text read as "undefined" here and as the empty text there. One whose type has no empty value
// (a form) stays out, optional in the emitted type.
function emptyFor(
  declared: { name: string; type: Type; optional?: boolean }[],
  given: { name: string }[],
): string[] {
  if (declared.length === 0) {
    return []
  }

  const names = new Set(given.map(f => f.name))

  return declared
    .filter(f => !names.has(f.name) && (!f.optional || !tsEmptyOf(f.type).startsWith('undefined')))
    .map(f => `${toMember(f.name)}: ${tsEmptyOf(f.type)}`)
}

// The members of a construction in the form's DECLARED order, given and filled alike, so every construction of one
// form makes objects of one shape and V8 keeps one hidden class for it: two sites writing the fields in two orders
// made two shapes, and a field read seeing both went polymorphic. A literal evaluates its values in the order they are
// written, so the reorder happens only when no given value can do anything but produce itself (a literal, a name, a
// field of a name). Otherwise the written order stays, followed by the filled fields, as before.
function inDeclaredOrder(
  declared: { name: string; type: Type; optional?: boolean }[],
  given: { name: string; value: Expression }[],
  rendered: string[],
): string[] {
  const inert = (e: Expression): boolean =>
    e.form === 'integer' ||
    e.form === 'float' ||
    e.form === 'boolean' ||
    e.form === 'string' ||
    e.form === 'null' ||
    e.form === 'unit' ||
    e.form === 'variable' ||
    (e.form === 'member' && !e.index && inert(e.target))

  const known = new Set(declared.map(f => f.name))

  if (declared.length === 0 || !given.every(f => known.has(f.name) && inert(f.value))) {
    return [...rendered, ...emptyFor(declared, given)]
  }

  const byName = new Map(given.map((f, i) => [f.name, rendered[i]!]))

  return declared.flatMap(f =>
    byName.has(f.name) ? [byName.get(f.name)!] : f.optional ? [] : [`${toMember(f.name)}: ${tsEmptyOf(f.type)}`],
  )
}

export function toPascal(name: string): string {
  const camel = toCamel(name)
  const spelled = camel.charAt(0).toUpperCase() + camel.slice(1)

  return TS_TAKEN.has(spelled) ? `${spelled}Form` : spelled
}

// opaque per-backend handle types (`dock type / load <any>, name tcp-handle`): seed name -> concrete TS type. Populated
// per emit so a `like tcp-handle` field emits the declared type rather than a nonexistent class.
let tsOpaqueTypes = new Map<string, string>()

// the exception forms of the program being emitted (every record-type whose chain includes `exception`), so a
// `halt <form>` throws an instance of the runtime class and not a bare object. Set by emitTypeScript.
let tsExceptions = new Set<string>()

// each variant's declared field names, in order, so a match arm can bind them as locals: `case circle` puts
// `radius` in scope (the resolver already declares it), and `link r` renames the first field to `r`. Without this
// the arm read a bare identifier nothing had declared and the program died at run time. Set by emitTypeScript.
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
// set when an emitted `+`, `-` or `*` on two numbers is range-checked (__termInt), so the helper rides in front
let tsIntUsed = false
// set when an `is-equal` compares by structure (__termEqual) or a map key is interned (__termKey)
let tsEqualUsed = false
// set when a text operation goes through `__termText`, which counts code points (note/term/stdlib/semantics.md)
let tsTextUsed = false
// set when a list read, write, pop or slice goes through the checked list helpers (note/term/stdlib/semantics.md)
let tsListUsed = false
// the list methods whose JavaScript meaning differs from the stdlib's, and the helper that has the stdlib's
const LIST_HELPER: Record<string, string> = {
  pop: '__termPop',
  shift: '__termShift',
  slice: '__termSlice',
  splice: '__termSplice',
}
// the `note shared` forms: references by design, compared and keyed by identity as on the other backends
let tsSharedForms = new Set<string>()

// `mark tag, name kind`: the unions that discriminate on a field other than `form`, by the union and by each of its
// variants. Only tagged forms are listed, so a program without one emits exactly what it always did
// (self-hosting-0020). Set by emitTypeScript.
let tsTagByOwner = new Map<string, string>()
let tsTagByVariant = new Map<string, string>()

// `mark text` (D9): each closed set of texts, by the form and by each of its cases, case -> its text. A value of one
// IS its text: the type is the string-literal union, a construction the literal, a match a string comparison. Only
// such forms are listed, so every other program emits what it always did. Set by emitTypeScript.
let tsTextByOwner = new Map<string, Map<string, string>>()
let tsTextByVariant = new Map<string, string>()

// the text of a case of a `mark text` form, or undefined. The union the type names decides, as for the tag
function textFor(variant: string, type?: Type): string | undefined {
  const owner = type?.kind === 'named' ? type.name : undefined

  if (owner && tsVariantFieldsByOwner.has(owner)) {
    return tsTextByOwner.get(owner)?.get(variant)
  }

  return tsTextByVariant.get(variant)
}

// the field a variant's union discriminates on. The union, when the type names one, decides: a known union that
// carries no mark is `form` even if another union reuses the variant's name with a tag. Otherwise the variant's own
// entry, else `form`
function tagFor(variant: string, type?: Type): string {
  const owner = type?.kind === 'named' ? type.name : undefined

  if (owner && tsVariantFieldsByOwner.has(owner)) {
    return toMember(tsTagByOwner.get(owner) ?? 'form')
  }

  return toMember(tsTagByVariant.get(variant) ?? 'form')
}

// the guard that tests a field-less case by identity (`identityCases`), its constant registered so the prelude declares
// it even where the program never builds that case
function guardFor(variant: string): string {
  tsFieldless.set(variant, tsFieldless.get(variant) ?? `__termVariant${toPascal(variant)}`)

  const guard = `__termIs${toPascal(variant)}`
  tsGuards.set(variant, guard)

  return guard
}

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
  type Loose = Record<string, unknown> & { form?: string; type?: Type }
  const cases = new Set<string>()

  if (perModule || program.some(n => n.form === 'function' && n.stub)) {
    return cases
  }

  const aliases = new Set(program.flatMap(n => (n.form === 'native' && n.kind !== 'type' ? [n.alias] : [])))
  const fromNative = new Set<string>()
  let filled = false
  const namesIn = (t: Type | undefined, into: Set<string>): void => {
    if (!t) return
    if (t.kind === 'named') {
      into.add(t.name)
      t.args?.forEach(a => namesIn(a, into))
    } else if (t.kind === 'array') namesIn(t.element, into)
    else if (t.kind === 'map') {
      namesIn(t.key, into)
      namesIn(t.value, into)
    } else if (t.kind === 'function') {
      t.params.forEach(p => namesIn(p, into))
      namesIn(t.result, into)
    }
  }
  const rootOf = (e: Loose | undefined): string | undefined =>
    e?.form === 'variable' ? (e.name as string) : e?.form === 'member' ? rootOf(e.target as Loose) : undefined
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return
    if (Array.isArray(value)) return value.forEach(visit)
    const node = value as Loose

    if (node.form === 'call') {
      const callee = node.callee as Loose
      const name = callee.form === 'variable' || callee.form === 'member' ? (callee.name as string) : ''
      const root = rootOf(callee)

      // `call fill / ... / like <form>` reaches the backends as `fill-form` (and `melt-form`), the run-time task as `fill`
      if (['fill', 'melt', 'fill-form', 'melt-form'].includes(name)) filled = true
      if (callee.form === 'member' && root !== undefined && aliases.has(root)) namesIn(node.type, fromNative)
    }

    for (const [key, child] of Object.entries(node)) if (key !== 'type' && key !== 'span') visit(child)
  }

  visit(program)

  if (filled) {
    return cases
  }

  for (const n of program) {
    if (n.form === 'record-type' && n.variants.length > 0 && !n.shared && !fromNative.has(n.name)) {
      n.variants.filter(v => v.fields.length === 0).forEach(v => cases.add(`${n.name}/${v.name}`))
    }
  }

  return cases
}

// every function's declared parameters, so a left-out trailing `need false` argument is filled with its type's empty
// value, as the Rust, Swift and Kotlin backends fill it: left as `undefined`, a left-out text printed "undefined" here
// and nothing there
let tsFunctionParams = new Map<string, { type?: Type; optional?: boolean }[]>()

// does a value of this type compare by its structure rather than by `==`? A record (`form`), a list, a map and bytes
// do, so `is-equal` on two records with equal fields is true here as it is on Rust, Swift and Kotlin
// (note/term/optimize/meaning.md, question 4). A type not known statically (a generic, the gradual `unknown`) does
// too, because `__termEqual` checks identity first and a scalar never reaches the structural walk. A `note shared`
// form and a closure keep identity.
function structuralType(type: Type | undefined): boolean {
  if (!type) {
    return false
  }

  switch (type.kind) {
    case 'array':
    case 'map':
    case 'bytes':
    case 'unknown':
    case 'variable':
    case 'dynamic':
      return true
    case 'named':
      return type.name !== 'text' && type.name !== 'boolean' && type.name !== 'void' && !tsSharedForms.has(type.name)
    default:
      return false
  }
}

// a map receiver's key type: the type when the receiver is a map (`like hash k v` or a native map), `true` when it is
// a map whose key is not spelled, and `false` when the receiver is not a map at all
function mapKeyType(type: Type | undefined): Type | true | false {
  if (type?.kind === 'map') {
    return type.key
  }

  if (type?.kind === 'named' && type.name === 'hash') {
    return type.args?.[0] ?? true
  }

  return false
}

// structural equality and key interning. `__termEqual` walks records (plain objects), lists, maps and bytes, and
// compares anything else by identity (a closure, a class instance from native code). `__termKey` returns ONE
// representative for every structurally equal record, so a JavaScript `Map` (which keys objects by identity) finds
// a record key by an equal record. The table is on globalThis so every emitted module shares one: a key interned in
// one module and looked up in another must meet the same representative. A primitive is returned untouched. The table
// holds each representative WEAKLY: a map that keys by it keeps it alive, and once nothing does, its entry is dropped.
// It held them strongly until 2026-10-02, so a server keyed by request data grew without bound.
const EQUAL_PRELUDE = `const __termShared = Symbol.for('term.shared')
function __termShare<T extends object>(value: T): T {
  Object.defineProperty(value, __termShared, { value: true })
  return value
}
function __termEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return a == b
  if (typeof a !== 'object' || typeof b !== 'object') return false
  if (__termShared in (a as object) || __termShared in (b as object)) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!__termEqual(a[i], b[i])) return false
    return true
  }
  if (a instanceof Map) {
    if (!(b instanceof Map) || a.size !== b.size) return false
    for (const [k, v] of a) if (!b.has(k) || !__termEqual(v, b.get(k))) return false
    return true
  }
  if (a instanceof Uint8Array) {
    if (!(b instanceof Uint8Array) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }
  if (Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false
  const ka = Object.keys(a as object)
  if (ka.length !== Object.keys(b as object).length) return false
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false
    if (!__termEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  }
  return true
}
function __termKeyText(v: unknown): string {
  if (v === undefined) return 'u'
  if (v === null) return 'z'
  switch (typeof v) {
    case 'number': return 'n' + (Object.is(v, -0) ? '0' : String(v))
    case 'string': return 's' + JSON.stringify(v)
    case 'boolean': return v ? 't' : 'f'
    case 'bigint': return 'b' + String(v)
    case 'object': break
    default: return 'i' + __termIdentity(v as object)
  }
  if (__termShared in (v as object)) return 'i' + __termIdentity(v as object)
  if (Array.isArray(v)) return '[' + v.map(__termKeyText).join(',') + ']'
  if (v instanceof Map) return '{' + Array.from(v, ([k, x]) => __termKeyText(k) + ':' + __termKeyText(x)).sort().join(',') + '}'
  if (v instanceof Uint8Array) return 'y' + Array.from(v).join('.')
  if (Object.getPrototypeOf(v) !== Object.prototype) return 'i' + __termIdentity(v as object)
  const o = v as Record<string, unknown>
  return '(' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + __termKeyText(o[k])).join(',') + ')'
}
function __termIdentity(v: object): number {
  const g = globalThis as { __termIdentities?: WeakMap<object, number>; __termIdentityNext?: number }
  const ids = (g.__termIdentities ??= new WeakMap())
  let id = ids.get(v)
  if (id === undefined) { id = g.__termIdentityNext = (g.__termIdentityNext ?? 0) + 1; ids.set(v, id) }
  return id
}
function __termKey<T>(k: T): T {
  if (typeof k !== 'object' || k === null) return k
  const g = globalThis as { __termKeys?: Map<string, WeakRef<object>>; __termKeysGone?: FinalizationRegistry<string> }
  const keys = (g.__termKeys ??= new Map())
  const gone = (g.__termKeysGone ??= new FinalizationRegistry(text => { if (keys.get(text)?.deref() === undefined) keys.delete(text) }))
  const text = __termKeyText(k)
  const seen = keys.get(text)?.deref()
  if (seen !== undefined) return seen as T
  keys.set(text, new WeakRef(k as object))
  gone.register(k as object, text)
  return k
}`

// the shape `__termFill` walks: one entry per field with its member name and kind. A kind is `text`, `number`,
// `decimal`, `flag`, `list` (with its item), `form` (with its own spec, recursively) or `any`. A form that reaches
// itself (a tree) is cut at the second visit and read as `any`.
type FormSpec = { form: string; fields: { name: string; member: string; optional: boolean; kind: FormKind }[] }
type FormKind =
  | { kind: 'text' | 'number' | 'decimal' | 'flag' | 'any' }
  | { kind: 'list'; item: FormKind }
  | { kind: 'form'; spec: FormSpec }

function formSpec(type: Type, seen: Set<string>): FormSpec {
  const name = type.kind === 'named' ? type.name : ''
  const fields = tsRecordFields.get(name) ?? []
  const inner = new Set(seen).add(name)

  return {
    form: name,
    fields: fields.map(f => ({
      name: f.name,
      member: toMember(f.name),
      optional: Boolean(f.optional),
      kind: formKind(f.type, inner),
    })),
  }
}

function formKind(type: Type | undefined, seen: Set<string>): FormKind {
  switch (type?.kind) {
    case 'string':
      return { kind: 'text' }
    case 'boolean':
      return { kind: 'flag' }
    case 'number':
      return { kind: 'number' }
    case 'float':
      return { kind: 'decimal' }
    case 'array':
      return { kind: 'list', item: formKind(type.element, seen) }
    case 'named': {
      if (type.name === 'text') {
        return { kind: 'text' }
      }

      if (type.name === 'boolean') {
        return { kind: 'flag' }
      }

      if (/^(number|integer|natural|size|count|index|u?int(8|16|32|64)?)$/.test(type.name)) {
        return { kind: 'number' }
      }

      if (/^(decimal|float(32|64)?|double|real)$/.test(type.name)) {
        return { kind: 'decimal' }
      }

      if (type.name === 'list') {
        return { kind: 'list', item: formKind(type.args?.[0], seen) }
      }

      if (tsRecordFields.has(type.name) && !seen.has(type.name)) {
        return { kind: 'form', spec: formSpec(type, seen) }
      }

      return { kind: 'any' }
    }
    default:
      return { kind: 'any' }
  }
}

const EXCEPTION_CLASS = 'TermException'
const EXCEPTION_PRELUDE = `export class ${EXCEPTION_CLASS} extends Error {
  host!: string
  form!: string
  note!: string
  code!: string
  time!: number
  link!: unknown
  base?: unknown
  // the whole record a raise builds (host, form, code, time, note, link, base, site, flow), every field copied onto
  // the exception; typed as that record so code checked with tsc takes the fields a raise passes (TS2353 otherwise)
  constructor(base: { note: string; form: string; [field: string]: unknown }) {
    super(base.note)
    Object.assign(this, base)
    this.name = ${EXCEPTION_CLASS}.name
    // the frames of the raise, innermost first, in \`capture-trace\`'s shape, where the raise gave none: every raise
    // built \`flow: []\`, so an exception carried no stack (guides: library/exceptions, 2026-10-05)
    const flow = (this as { flow?: unknown }).flow
    if (!Array.isArray(flow) || flow.length === 0) {
      ;(this as { flow?: unknown }).flow = (this.stack ?? '').split(String.fromCharCode(10)).slice(1).map(line => line.trim()).filter(line => line.length !== 0)
    }
    // the hive hears every raise, once wakeHive has hooked it in
    const hive = (globalThis as { __termRaise?: (e: unknown) => void }).__termRaise
    if (hive) hive(this)
  }
}`

// the range check on an integer sum, difference, product, quotient or remainder: inside the safe integers the double
// is exact, and past them it is not the integer any more, so it raises the stdlib's `excess` (or `shortage` below).
// A value that is not finite came from dividing by zero (no product of safe integers nears the float maximum), and
// raises `defect`. As the exception class when the module carries it, as an Error with the same fields when not
// The check is the whole of `__termInt`, and the stop is a function of its own: V8 inlines a function only while its
// bytecode is small, and with the exception built in place every checked `+` was a real call. Measured on
// spectral-norm, where a four-operation task runs 40 million times: the checks were most of a 5.5x gap to the hand
// version (tmp/ts-fannkuch-ab.ts, tmp/ts-spectral-ab.ts, 2026-10-02)
const intPrelude = (withClass: boolean): string => `function __termInt(x: number): number {
  if (!(x <= 9007199254740991 && x >= -9007199254740991)) __termIntStop(x)
  return x
}
function __termIntStop(x: number): never {
  const base = !Number.isFinite(x)
    ? { host: "@term/base", form: "defect", note: "Invalid", code: "", time: Date.now(), link: { thing: "a division or remainder by zero" } }
    : { host: "@term/base", form: x > 0 ? "excess" : "shortage", note: x > 0 ? "Too large" : "Too small", code: "", time: Date.now(), link: { thing: "number", limit: x > 0 ? 9007199254740991 : -9007199254740991, actual: x } }
  ${withClass ? `throw new ${EXCEPTION_CLASS}(base)` : `throw Object.assign(new Error(base.note), base, { name: "${EXCEPTION_CLASS}" })`}
}`

// THE TEXT OPERATIONS COUNT CODE POINTS, as they do on Rust, Swift and Kotlin (note/term/stdlib/semantics.md).
// JavaScript's own string methods count UTF-16 units, so `"a𝄞b".charAt(1)` is half a surrogate pair here and `𝄞`
// everywhere else. Each method is the meaning on that page; a text with no surrogate takes the native path, which
// is the same answer by construction. No escape sequence appears in it: the White_Space set and the surrogate test
// are built from character codes, because an escaped U+2028 that some later step decodes is a line break inside a
// regular expression.
// the two texts tested last are remembered, so a loop of char-at over one text (or a compare of two) scans each once
// rather than on every call, which made such a loop quadratic (reported 2026-10-02: 1.9 of 2.4 s of the Term hash)
export const TEXT_PRELUDE = `const __termSurrogate = { a: "", aHas: false, b: "", bHas: false, test(s: string): boolean { if (s === this.a) return this.aHas; if (s === this.b) return this.bHas; let has = false; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c >= 55296 && c <= 57343) { has = true; break } } this.b = this.a; this.bHas = this.aHas; this.a = s; this.aHas = has; return has } }
const __termWhite = [9, 10, 11, 12, 13, 32, 133, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288].map(c => String.fromCharCode(c)).join('')
const __termWhiteStart = new RegExp('^[' + __termWhite + ']+')
const __termWhiteEnd = new RegExp('[' + __termWhite + ']+$')
const __termText = {
  length(s: string): number {
    if (!__termSurrogate.test(s)) return s.length
    let n = 0
    for (const _ of s) n++
    return n
  },
  // the UTF-16 offset of code point i, for a text with surrogates
  offset(s: string, i: number): number {
    let at = 0
    let n = 0
    for (const c of s) {
      if (n === i) return at
      at += c.length
      n++
    }
    return s.length
  },
  charAt(s: string, i: number): string {
    if (!(i >= 0)) return ''
    if (!__termSurrogate.test(s)) return i < s.length ? s[i]! : ''
    let n = 0
    for (const c of s) {
      if (n === i) return c
      n++
    }
    return ''
  },
  at(s: string, i: number): string {
    return __termText.charAt(s, i)
  },
  charCodeAt(s: string, i: number): number {
    const c = __termText.charAt(s, i)
    return c === '' ? -1 : c.codePointAt(0)!
  },
  // a code point read through a cursor, [code-point index, unit offset] of the last read, stepped forward or back
  // from, or restarted at the start when that is nearer. A text with no surrogates is read by unit
  // the unit offset of code point i, the end past the last, for a text with surrogates
  cursorTo(s: string, i: number, c: number[]): number {
    let k = c[0]!
    let u = c[1]!
    if (i < k) {
      if (i <= k - i) {
        k = 0
        u = 0
      } else {
        while (k > i) {
          u--
          const x = s.charCodeAt(u)
          if (u > 0 && x >= 56320 && x <= 57343 && s.charCodeAt(u - 1) >= 55296 && s.charCodeAt(u - 1) <= 56319) u--
          k--
        }
      }
    }
    while (k < i && u < s.length) {
      u += s.codePointAt(u)! > 65535 ? 2 : 1
      k++
    }
    c[0] = k
    c[1] = u
    return u
  },
  cursorAt(s: string, i: number, c: number[]): number {
    if (!(i >= 0)) return -1
    if (!__termSurrogate.test(s)) return i < s.length ? s.charCodeAt(i) : -1
    const u = __termText.cursorTo(s, i, c)
    return c[0] === i && u < s.length ? s.codePointAt(u)! : -1
  },
  // the code points from a to e, both clamped and swapped when reversed: JavaScript's own substring on a text with no
  // surrogates, the cursor moved to the start and the end counted on from it otherwise
  cursorSlice(s: string, a: number, e: number, c: number[]): string {
    if (!__termSurrogate.test(s)) return s.substring(a, e)
    const x = Math.max(Math.min(a, e), 0)
    const y = Math.max(Math.max(a, e), 0)
    const from = __termText.cursorTo(s, x, c)
    let to = from
    let k = c[0]!
    while (k < y && to < s.length) {
      to += s.codePointAt(to)! > 65535 ? 2 : 1
      k++
    }
    return s.slice(from, to)
  },
  cursorCodeAt(s: string, i: number, c: number[]): number {
    return __termText.cursorAt(s, i, c)
  },
  cursorCharAt(s: string, i: number, c: number[]): string {
    const x = __termText.cursorAt(s, i, c)
    return x < 0 ? '' : String.fromCodePoint(x)
  },
  indexOf(s: string, n: string, from: number = 0): number {
    const size = __termText.length(s)
    const f = Math.min(Math.max(from, 0), size)
    if (n === '') return f
    const plain = !__termSurrogate.test(s)
    const found = s.indexOf(n, plain ? f : __termText.offset(s, f))
    if (found < 0) return -1
    return plain ? found : __termText.length(s.slice(0, found))
  },
  lastIndexOf(s: string, n: string): number {
    const found = s.lastIndexOf(n)
    if (found < 0) return -1
    return __termText.length(s.slice(0, found))
  },
  split(s: string, d: string): string[] {
    return d === '' ? Array.from(s) : s.split(d)
  },
  substring(s: string, a: number, b?: number): string {
    const plain = !__termSurrogate.test(s)
    const size = plain ? s.length : __termText.length(s)
    let x = Math.min(Math.max(a, 0), size)
    let y = Math.min(Math.max(b === undefined ? size : b, 0), size)
    if (x > y) [x, y] = [y, x]
    if (plain) return s.slice(x, y)
    const from = __termText.offset(s, x)
    return s.slice(from, from + __termText.offset(s.slice(from), y - x))
  },
  slice(s: string, a: number, b?: number): string {
    return __termText.substring(s, a, b)
  },
  toLowerCase(s: string): string {
    return s.toLowerCase()
  },
  toUpperCase(s: string): string {
    return s.toUpperCase()
  },
  trim(s: string): string {
    return s.replace(__termWhiteStart, '').replace(__termWhiteEnd, '')
  },
  trimStart(s: string): string {
    return s.replace(__termWhiteStart, '')
  },
  trimEnd(s: string): string {
    return s.replace(__termWhiteEnd, '')
  },
  pad(s: string, w: number, f: string, front: boolean): string {
    const size = __termText.length(s)
    if (size >= w || f === '') return s
    const fill = Array.from(f)
    let out = ''
    for (let i = 0; i < w - size; i++) out += fill[i % fill.length]
    return front ? out + s : s + out
  },
  padStart(s: string, w: number, f: string): string {
    return __termText.pad(s, w, f, true)
  },
  padEnd(s: string, w: number, f: string): string {
    return __termText.pad(s, w, f, false)
  },
  replace(s: string, a: string, b: string): string {
    const at = s.indexOf(a)
    return at < 0 ? s : s.slice(0, at) + b + s.slice(at + a.length)
  },
  replaceAll(s: string, a: string, b: string): string {
    if (a === '') return b + Array.from(s).join(b) + (s === '' ? '' : b)
    return s.split(a).join(b)
  },
  includes(s: string, n: string): boolean {
    return s.includes(n)
  },
  startsWith(s: string, n: string): boolean {
    return s.startsWith(n)
  },
  endsWith(s: string, n: string): boolean {
    return s.endsWith(n)
  },
  repeat(s: string, n: number): string {
    return n > 0 ? s.repeat(n) : ''
  },
  concat(s: string, b: string): string {
    return s + b
  },
  // code point order, which is UTF-8 byte order: JavaScript's < orders by UTF-16 unit, and the two disagree above
  // the basic plane
  // read in place: up to the first unit that differs the two agree, so that position is a code point boundary in both
  // (or the low half of one shared high surrogate), two units outside the surrogate range order as their code points,
  // and only a surrogate needs the whole code point read. It built two arrays of code points per comparison, so a sort
  // of texts allocated on every comparison
  compare(a: string, b: string): number {
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i++) {
      const x = a.charCodeAt(i)
      const y = b.charCodeAt(i)
      if (x !== y) {
        if ((x < 55296 || x > 57343) && (y < 55296 || y > 57343)) return x < y ? -1 : 1
        const p = a.codePointAt(i)!
        const q = b.codePointAt(i)!
        return p < q ? -1 : p > q ? 1 : 0
      }
    }
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
  },
}`

// A LIST READ PAST THE END STOPS, as it does on Rust, Swift and Kotlin, instead of reading `undefined`. So do a write
// out of range and a pop of an empty list. A slice clamps its bounds and never counts from the end
// (note/term/stdlib/semantics.md). The stop is the stdlib's `defect`, thrown the way `__termInt` throws it.
const listPrelude = (withClass: boolean): string => `function __termStop(thing: string): never {
  const base = { host: "@term/base", form: "defect", note: "Invalid", code: "", time: Date.now(), link: { thing } }
  ${withClass ? `throw new ${EXCEPTION_CLASS}(base)` : `throw Object.assign(new Error(base.note), base, { name: "${EXCEPTION_CLASS}" })`}
}
function __termAt<T>(a: T[], i: number): T {
  if (!(i >= 0 && i < a.length)) __termStop("a list read at " + i + " of " + a.length)
  return a[i]!
}
function __termReadPast(a: unknown[], i: number): never {
  return __termStop("a list read at " + i + " of " + a.length)
}
function __termWritePast(a: unknown[], i: number): never {
  return __termStop("a list write at " + i + " of " + a.length)
}
function __termPut<T>(a: T[], i: number, v: T): T {
  if (!(i >= 0 && i < a.length)) __termStop("a list write at " + i + " of " + a.length)
  return (a[i] = v)
}
function __termPop<T>(a: T[]): T {
  if (a.length === 0) __termStop("a pop of an empty list")
  return a.pop()!
}
function __termShift<T>(a: T[]): T {
  if (a.length === 0) __termStop("a shift of an empty list")
  return a.shift()!
}
function __termSlice<T>(a: T[], s: number, e?: number): T[] {
  const n = a.length
  const x = Math.min(Math.max(s, 0), n)
  const y = Math.min(Math.max(e === undefined ? n : e, 0), n)
  return x < y ? a.slice(x, y) : []
}
function __termSplice<T>(a: T[], s: number, d: number, ...items: T[]): T[] {
  const x = Math.min(Math.max(s, 0), a.length)
  return a.splice(x, Math.min(Math.max(d, 0), a.length - x), ...items)
}`

// the walk, in the prelude of a module that lowers a `fill` or `melt` with a form. `data` is the value the
// package's reader gives (`{ form: "hash", list: [{ name, base }] }`, `{ form: "array", list }`, a scalar with
// `value`, `{ form: "blank" }`). A value that does not fit raises `data-mismatch`, the package's own exception,
// `path` naming where and `reason` why.
const FORM_WALK_PRELUDE = `function __termMismatch(path: string, reason: string): never {
  throw new ${EXCEPTION_CLASS}({ host: "@term/host", form: "data-mismatch", code: "", time: Date.now(), note: "Data does not fit the shape", link: { thing: "data", path: path || ".", reason } } as never)
}

function __termFill(value: any, spec: any, path = ""): any {
  const at = (key: string) => (path ? path + "/" + key : key)
  if (value.form !== "hash") __termMismatch(path, "is " + (value.form === "array" ? "a list" : value.form === "blank" ? "void" : "a scalar") + " where a map belongs")
  const out: Record<string, unknown> = {}
  const present = new Map<string, any>(value.list.map((e: any) => [e.name, e.base]))
  for (const field of spec.fields) {
    const found = present.get(field.name)
    if (found === undefined || found.form === "blank") {
      if (!field.optional) __termMismatch(at(field.name), "is missing")
      continue
    }
    out[field.member] = __termFillKind(found, field.kind, at(field.name))
  }
  for (const entry of value.list) {
    if (!spec.fields.some((f: any) => f.name === entry.name)) __termMismatch(at(entry.name), "is not in the form")
  }
  return out
}

function __termFillKind(value: any, kind: any, path: string): any {
  const have = value.form === "hash" ? "map" : value.form === "array" ? "list" : value.form === "blank" ? "void" : value.form
  switch (kind.kind) {
    case "any":
      return __termMeltless(value)
    case "form":
      return __termFill(value, kind.spec, path)
    case "list":
      if (value.form !== "array") __termMismatch(path, "is " + (have === "map" ? "a map" : have === "void" ? "void" : "a scalar") + " where a list belongs")
      return value.list.map((item: any, index: number) => __termFillKind(item, kind.item, path + "/" + index))
    case "decimal":
      if (value.form === "decimal" || value.form === "number") return value.value
      __termMismatch(path, "is " + have + " where decimal belongs")
    default:
      if (value.form === kind.kind) return value.value
      __termMismatch(path, "is " + have + " where " + kind.kind + " belongs")
  }
}

function __termMeltless(value: any): any {
  switch (value.form) {
    case "hash": return Object.fromEntries(value.list.map((e: any) => [e.name, __termMeltless(e.base)]))
    case "array": return value.list.map(__termMeltless)
    case "blank": return null
    default: return value.value
  }
}

function __termMelt(value: any, spec: any): any {
  return { form: "hash", list: spec.fields.flatMap((field: any) => {
    const held = value == null ? undefined : value[field.member]
    if (held === undefined || held === null) return field.optional ? [] : [{ name: field.name, base: { form: "blank" } }]
    return [{ name: field.name, base: __termMeltKind(held, field.kind) }]
  }) }
}

function __termMeltKind(value: any, kind: any): any {
  switch (kind.kind) {
    case "form": return __termMelt(value, kind.spec)
    case "list": return { form: "array", list: (value as unknown[]).map(item => __termMeltKind(item, kind.item)) }
    case "text": return { form: "text", value: String(value) }
    case "number": return { form: "number", value: Number(value) }
    case "decimal": return { form: "decimal", value: Number(value) }
    case "flag": return { form: "flag", value: Boolean(value) }
    default: return __termMeltAny(value)
  }
}

function __termMeltAny(value: any): any {
  if (value === null || value === undefined) return { form: "blank" }
  if (Array.isArray(value)) return { form: "array", list: value.map(__termMeltAny) }
  if (typeof value === "string") return { form: "text", value }
  if (typeof value === "boolean") return { form: "flag", value }
  if (typeof value === "number") return { form: Number.isInteger(value) ? "number" : "decimal", value }
  return { form: "hash", list: Object.entries(value as object).map(([name, base]) => ({ name, base: __termMeltAny(base) })) }
}`

// the runtime class an exception is thrown as: a real `Error` (a stack, `instanceof`) carrying every field of the
// shared `exception` form. `note` is the message, `form` is the name a catch branches on.
// a checked type to a TypeScript type
function tsType(type: Type | undefined): string {
  switch (type?.kind) {
    case 'boolean':
      return 'boolean'
    case 'string':
      return 'string'
    case 'unit':
      return 'void'
    case 'array':
      {
        // a function element needs parens: `(() => string)[]`, not `() => string[]` (which is a function
        // returning an array)
        const element = tsType(type.element)

        return type.element?.kind === 'function'
          ? `(${element})[]`
          : `${element}[]`
      }
    case 'map':
      return `Map<${tsType(type.key)}, ${tsType(type.value)}>`

    case 'named': {
      const opaque = tsOpaqueTypes.get(type.name)

      if (opaque) {
        return opaque
      }

      // `like type` is the UNIVERSE (the type of types): the host has no spelling for it, so a signature that
      // carries one emits `any` rather than a `Type` no module defines
      if (type.name === 'type') {
        return 'any'
      }

      // THE FOUR KEYWORD PRIMITIVES, by their Term names. A milled annotation keeps `like text` as the NAMED
      // type `text` (the checker seeds it to a fresh variable and unifies it with the literal, so it never
      // rewrites the node), and a backend that Pascal-cases it emits a `Text` no module defines. These four
      // and no others: they are exactly the names the mill itself synthesizes for a `host` with no `like`
      // (mint-bridge, "the constant's type is the one its LITERAL names"), plus `like text`. A form the
      // program declares is still its own type, so a local `form text` would win.
      if (
        !tsRecordFields.has(type.name) &&
        !tsVariantFieldsByOwner.has(type.name)
      ) {
        if (type.name === 'text') {
          return 'string'
        }

        if (type.name === 'boolean') {
          return 'boolean'
        }

        // `decimal` and `float` are the float's names: a `host` of a decimal literal is declared `decimal`
        if (type.name === 'number' || type.name === 'integer' || type.name === 'decimal' || type.name === 'float') {
          return 'number'
        }
      }

      // type arguments when the reference carries them, so `like maybe / head
      // text` reaches TypeScript as `Maybe<string>` rather than a bare
      // `Maybe` that says nothing about what it holds.
      const args =
        type.args && type.args.length > 0
          ? `<${type.args.map(a => tsType(a)).join(', ')}>`
          : ''

      return `${toPascal(type.name)}${args}`
    }

    case 'function': {
      const result = type.effects?.includes('async')
        ? `Promise<${tsType(type.result)}>`
        : tsType(type.result)

      return `(${type.params
        .map((p, i) => `a${i}: ${tsType(p)}`)
        .join(', ')}) => ${result}`
    }

    case 'number':
    case 'float':
      return 'number'
    case 'dynamic':
      return 'any'
    case 'bytes':
      return 'Uint8Array'
    case 'unknown':
      // the declared dynamic (`like unknown` / `like any`): any value, so a hive entry's `base` can carry a record
      return 'any'
    case 'variable':
    case undefined:
    default:
      // an unconstrained binding in a numeric program: default to number
      return 'number'
  }
}

// find expressions reassigned to a name, so the binding emits as `let` not `const`. Crucially this descends into
// closure bodies: a variable declared in an outer scope but reassigned inside a callback (e.g. an effect) must be a
// `let`. Without this, the reassignment would target a `const` and throw.
function collectAssignedExpr(
  expr: Expression,
  into: Set<string>,
): void {
  switch (expr.form) {
    case 'closure':
      collectAssigned(expr.body, into)
      break
    case 'call':
      collectAssignedExpr(expr.callee, into)
      expr.args.forEach(a => collectAssignedExpr(a, into))
      break
    case 'binary':
      collectAssignedExpr(expr.left, into)
      collectAssignedExpr(expr.right, into)
      break
    case 'unary':
      collectAssignedExpr(expr.operand, into)
      break
    case 'array':
      expr.items.forEach(i => collectAssignedExpr(i, into))
      break
    case 'map':
      expr.entries.forEach(e => {
        collectAssignedExpr(e.key, into)
        collectAssignedExpr(e.value, into)
      })
      break
    case 'record':
      expr.fields.forEach(f => collectAssignedExpr(f.value, into))
      break
    case 'member':
      collectAssignedExpr(expr.target, into)
      break
    case 'await':
      collectAssignedExpr(expr.expr, into)
      break
    case 'conditional':
      expr.branches.forEach(b => {
        collectAssignedExpr(b.cond, into)
        collectAssignedExpr(b.value, into)
      })

      if (expr.otherwise) {
        collectAssignedExpr(expr.otherwise, into)
      }

      break
    default:
      break
  }
}

function collectAssigned(
  statements: Statement[],
  into: Set<string>,
): void {
  for (const statement of statements) {
    switch (statement.form) {
      case 'let':
        collectAssignedExpr(statement.init, into)
        break
      case 'assign':
        if (statement.target.form === 'variable') {
          into.add(statement.target.name)
        }

        collectAssignedExpr(statement.value, into)
        break
      case 'expression':
        collectAssignedExpr(statement.expr, into)
        break
      case 'return':
        if (statement.value) {
          collectAssignedExpr(statement.value, into)
        }

        break
      case 'throw':
        collectAssignedExpr(statement.value, into)
        break
      case 'hold':
        collectAssignedExpr(statement.expr, into)
        break
      case 'guard':
        collectAssigned(statement.body, into)

        if (statement.catch) {
          collectAssigned(statement.catch.body, into)
        }

        break
      case 'while':
        collectAssignedExpr(statement.cond, into)
        collectAssigned(statement.body, into)
        break
      case 'for-each':
        collectAssignedExpr(statement.iterable, into)
        collectAssigned(statement.body, into)
        break
      case 'match':
        collectAssignedExpr(statement.subject, into)

        for (const branch of statement.cases) {
          collectAssigned(branch.body, into)
        }

        if (statement.otherwise) {
          collectAssigned(statement.otherwise, into)
        }

        break
      case 'if':
        for (const branch of statement.branches) {
          collectAssignedExpr(branch.cond, into)
          collectAssigned(branch.body, into)
        }

        if (statement.otherwise) {
          collectAssigned(statement.otherwise, into)
        }

        break
      case 'function':
        collectAssigned(statement.body, into)
        break
      default:
        break
    }
  }
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
  binds = new Map<string, Bind>(),
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
) {
  const pad = (depth: number) => '  '.repeat(depth)
  // a record's copy: one level, a spread. A nested write rebuilds its path rather than writing the nested record, so a
  // copy one level deep separates every write
  const copyRecord = (text: string, _deep: boolean): string => `{ ...${text} }`
  // the forms a nested write rebuilds through: every record form that is not `mark shared`
  const plainRecords = copies.plain
  // the lists whose slots the loop copy being emitted reads and writes unchecked: its guard holds (loopGuards)
  let uncheckedLists = new Set<string>()
  // the lists reached through a path that the loop copy being emitted read once before it, each by its key, and the
  // count for their locals' names
  let hoisted = new Map<string, string>()
  let pathCount = 0
  // the calls in that copy that may call their task's unchecked copy (`LoopGuard.fast`), the tasks some such call
  // reached (each emitted once more, unchecked, behind the program), and whether the body being emitted is one
  let fastCalls = new Set<object>()
  const fastTasks = new Set<string>()
  // the texts the task being emitted reads through a cursor (backend.ts, `textCursors`)
  let cursors: TextCursors = { names: [], reads: new Map() }
  // the tasks a reuse site calls, emitted again as `<task>Reuse`; while one is emitted, its record parameter and the
  // builds it makes in that object; and the build a `return` has already assigned, read as the parameter
  const reuseTasks = new Set<string>()
  let reusing: { param: string; builds: WeakSet<object>; keep?: string; carriers?: WeakSet<object> } | undefined
  // the carrier locals of the task being emitted that hold their kept field alone, to that field's name
  let carrierLocals = new Map<string, string>()
  let reused: object | undefined
  let reuseCount = 0
  // the tasks that are loops (backend.ts, `tailTasks`), and while one is emitted, its parameters and tail returns
  let tailing: { params: string[]; types: string[]; returns: WeakSet<object> } | undefined
  let redeclared = new WeakSet<Statement>()
  let uncheckedInts = false

  let assignedNames = new Set<string>()

  // A list read with its check written IN PLACE when the list and the index are plain (a name, a literal, a field of a
  // name), so evaluating each twice changes nothing: `(i >= 0 && i < xs.length ? xs[i]! : __termReadPast(xs, i))`.
  // The stop stays out of line. One shared `__termAt` saw lists of every element type at one call site, and on
  // fannkuch-redux the call was most of the gap to hand-written code (2.58x to 1.38x with the checks inlined away,
  // tmp/ts-check-cost.ts, 2026-10-02). Anything else keeps `__termAt`, which evaluates each once
  const plainOperand = (e: Expression): boolean =>
    e.form === 'variable' || e.form === 'integer' || (e.form === 'member' && !e.index && !/^\d+$/.test(e.name) && plainOperand(e.target))
  // a value with no effect of its own beyond stopping: a write may then check before it computes the value
  const effectFree = (e: Expression): boolean =>
    plainOperand(e) ||
    e.form === 'float' ||
    e.form === 'string' ||
    e.form === 'boolean' ||
    (e.form === 'member' && e.index !== undefined && e.target.type?.kind === 'array' && plainOperand(e.target) && plainOperand(e.index)) ||
    (e.form === 'binary' && effectFree(e.left) && effectFree(e.right)) ||
    (e.form === 'unary' && effectFree(e.operand))
  const readAt = (list: Expression, index: Expression): string => {
    const xs = expression(list)
    const i = expression(index)

    // inside the guarded copy of a counted loop the index is proven in bounds (ir/facts/bounds.ts), a list reached
    // through a path by its key
    if (uncheckedLists.size && uncheckedLists.has(listKey(list) ?? '')) {
      return `${xs}[${i}]!`
    }

    // a literal index that is not negative needs only the upper check
    const low = index.form === 'integer' && Number(index.value) >= 0 ? '' : `${i} >= 0 && `

    return plainOperand(list) && plainOperand(index)
      ? `(${low}${i} < ${xs}.length ? ${xs}[${i}]! : __termReadPast(${xs}, ${i}))`
      : `__termAt(${xs}, ${i})`
  }

  const expression = (
    node: Expression,
    parentPrecedence = 0,
  ): string => {
    switch (node.form) {
      case 'integer':
        return String(node.value)
      case 'float':
        return String(node.value)
      case 'boolean':
        return node.value ? 'true' : 'false'
      case 'string':
        return JSON.stringify(node.value)
      case 'template':
        // a template literal: chunks escaped for backticks and `${`, expressions interpolated. A carriage return is
        // written as `\r`, because ECMAScript reads a raw one inside a template as a line feed: a live region's
        // `ESC[3A\r ESC[J` moved down a line on every redraw
        return `\`${node.parts
          .map(part =>
            typeof part === 'string'
              ? part.replace(/[\\`]/g, '\\$&').replace(/\$\{/g, '\\${').replace(/\r/g, '\\r')
              : `\${${expression(part)}}`,
          )
          .join('')}\``
      case 'unit':
        return 'undefined'
      case 'null':
        return 'null'
      case 'variable':
        return toCamel(node.name)
      case 'hole':
        return toCamel(node.name)

      case 'call': {
        // a call at a reuse site: the task's copy that builds its result in the object it is given
        if (reuse.sites.has(node) && node.callee.form === 'variable') {
          reuseTasks.add(node.callee.name)

          return expression({ ...node, callee: { ...node.callee, name: `${node.callee.name}-reuse` } } as Expression, parentPrecedence)
        }

        // a call to a task that only fills a list is the array made at its size and filled (backend.ts, `fillTasks`),
        // packed by V8 where pushing grew it. A size below zero is no list, as the walk was no turns
        const fill = node.type?.kind === 'array' ? fillCall(node, fills) : undefined

        if (fill && node.type?.kind === 'array') {
          const size = fill.size.form === 'integer' ? `${Math.max(Number(fill.size.value), 0)}` : `Math.max(${expression(fill.size)}, 0)`

          return `new Array<${tsType(node.type.element)}>(${size}).fill(${expression(fill.item)})`
        }

        // the stdlib's `list_push` and `list_size` are the array's own `push` (which answers the new length, as
        // `list_push` does) and `length`. Called through the stdlib's one function, every list in the program met at
        // one call site that V8 saw megamorphic: Graph's numbers and its lists of lists, 205 ms to 139
        // (`tmp/ts-graph-ab.ts`)
        if (node.callee.form === 'variable' && node.callee.name === 'list_push' && node.args.length === 2 && node.args[0]!.type?.kind === 'array') {
          return `${expression(node.args[0]!, 100)}.push(${expression(node.args[1]!)})`
        }

        if (node.callee.form === 'variable' && node.callee.name === 'list_size' && node.args.length === 1 && node.args[0]!.type?.kind === 'array') {
          return `${expression(node.args[0]!, 100)}.length`
        }

        // a call inside a guarded loop copy whose guard bounds its arguments (`integerBounds`): the task's copy with no
        // overflow checks, `aValueFast`
        if (fastCalls.has(node) && node.callee.form === 'variable') {
          fastTasks.add(node.callee.name)

          return expression({ ...node, callee: { ...node.callee, name: `${node.callee.name}-fast` } } as Expression, parentPrecedence)
        }

        // `get` / `set` / `at` on an ARRAY receiver: JavaScript arrays have no `get` or `set`; they are
        // indexing. `at` is a real method and was left alone until 2026-09-13, and that was the outlier:
        // Rust, Swift and Kotlin all lower `at` to a direct index read, so its negative-index reading was
        // never portable, while its `T | undefined` result did not match `list/get`'s declared `like t` and
        // that one stdlib line, inlined into every module, was 47 of the v4 grammar's 61 strict errors.
        // Since 2026-10-02 the read and the write are CHECKED, and a pop, shift, slice and splice follow the one
        // meaning in note/term/stdlib/semantics.md: out of range stops with `defect`, a slice clamps.
        if (
          node.callee.form === 'member' &&
          node.callee.target.type?.kind === 'array' &&
          (node.callee.name === 'get' ||
            node.callee.name === 'set' ||
            node.callee.name === 'at')
        ) {
          tsListUsed = true
          const target = expression(node.callee.target)

          return node.callee.name === 'set'
            ? `__termPut(${target}, ${expression(node.args[0]!)}, ${expression(node.args[1]!)})`
            : readAt(node.callee.target, node.args[0]!)
        }

        if (
          node.callee.form === 'member' &&
          node.callee.target.type?.kind === 'array' &&
          LIST_HELPER[node.callee.name]
        ) {
          tsListUsed = true

          return `${LIST_HELPER[node.callee.name]}(${[
            expression(node.callee.target),
            ...node.args.map(arg => expression(arg)),
          ].join(', ')})`
        }

        // membership and position in a list of records compare by structure, as `is-equal` does
        if (
          node.callee.form === 'member' &&
          node.callee.target.type?.kind === 'array' &&
          (node.callee.name === 'includes' ||
            node.callee.name === 'indexOf' ||
            node.callee.name === 'lastIndexOf') &&
          structuralType(node.callee.target.type.element)
        ) {
          tsEqualUsed = true
          const target = expression(node.callee.target)
          const item = expression(node.args[0]!)
          const test = `(__e) => __termEqual(__e, ${item})`

          return node.callee.name === 'includes'
            ? `${target}.some(${test})`
            : node.callee.name === 'indexOf'
              ? `${target}.findIndex(${test})`
              : `${target}.findLastIndex(${test})`
        }

        // a text method follows the code-point meaning (`__termText`), never JavaScript's UTF-16 one
        const textOp = stringCall(node.callee)

        // a substring of an ASCII text: JavaScript's `substring` clamps both ends to the text and swaps them when
        // reversed, which is the Term meaning (note/term/stdlib/semantics.md), counted in units that are code points here
        if (textOp && asciiNodes.has(textOp.target) && (textOp.op === 'substring' || textOp.op === 'slice')) {
          return `${expression(textOp.target, 100)}.substring(${node.args.map(arg => expression(arg)).join(', ')})`
        }

        // a search of an ASCII text answers a unit index, which is the code-point index: JavaScript's own `indexOf`
        // clamps its start to the text and finds an empty needle at it, the Term meaning, and a needle that is not
        // ASCII is found nowhere either way
        if (textOp && asciiNodes.has(textOp.target) && (textOp.op === 'indexOf' || textOp.op === 'lastIndexOf')) {
          return `${expression(textOp.target, 100)}.${textOp.op}(${node.args.map(arg => expression(arg)).join(', ')})`
        }

        // an ASCII text (ir/facts/text.ts): a code point is one UTF-16 unit, so JavaScript's own reads mean the same,
        // with the same answers past either end, the empty text and -1
        if (textOp && asciiNodes.has(textOp.target) && ['charAt', 'at', 'charCodeAt'].includes(textOp.op)) {
          const target = expression(textOp.target, 100)
          const at = expression(node.args[0]!)
          // the index is read three times in a code read, so only when reading it twice costs and changes nothing
          const plain = /^[\w.]+$/.test(at) && /^[\w.]+$/.test(target)

          if (textOp.op !== 'charCodeAt') {
            return `(${target}[${at}] ?? "")`
          }

          if (plain) {
            return `(${at} >= 0 && ${at} < ${target}.length ? ${target}.charCodeAt(${at}) : -1)`
          }
        }

        // a read through the text's cursor (backend.ts, `textCursors`) steps from the last read, which matters only
        // for a text with surrogates: one without is read by unit anyway
        const cursor = cursors.reads.get(node)

        if (textOp && cursor !== undefined && (textOp.op === 'substring' || textOp.op === 'slice')) {
          tsTextUsed = true

          return `__termText.cursorSlice(${expression(textOp.target)}, ${expression(node.args[0]!)}, ${node.args[1] ? expression(node.args[1]) : 'Infinity'}, __cursor${toPascal(cursor)})`
        }

        if (textOp && cursor !== undefined) {
          tsTextUsed = true

          return `__termText.${textOp.op === 'charCodeAt' ? 'cursorCodeAt' : 'cursorCharAt'}(${expression(textOp.target)}, ${expression(node.args[0]!)}, __cursor${toPascal(cursor)})`
        }

        if (textOp) {
          tsTextUsed = true

          return `__termText.${textOp.op}(${[
            expression(textOp.target),
            ...node.args.map(arg => expression(arg)),
          ].join(', ')})`
        }

        // `flat()` on an array: TypeScript's conditional flat type does not narrow back to the declared element,
        // so the call rides through `any` (the value is correct at run time; the signature carries the type)
        if (
          node.callee.form === 'member' &&
          node.callee.name === 'flat' &&
          node.callee.target.type?.kind === 'array'
        ) {
          return `(${expression(node.callee.target)}.flat() as any)`
        }

        // `call fill / <data> / like <form>`: walk the data against the form's fields (a spec built here from the
        // record type) into a value of the form; `melt` is the reverse. The walk is the `__termFill` / `__termMelt`
        // prelude below, raised once per emitted module.
        if (
          node.callee.form === 'variable' &&
          (node.callee.name === 'fill-form' || node.callee.name === 'melt-form') &&
          node.into
        ) {
          tsFormWalkUsed = true
          const helper = node.callee.name === 'fill-form' ? '__termFill' : '__termMelt'

          return `${helper}(${expression(node.args[0]!)}, ${JSON.stringify(formSpec(node.into, new Set()))})`
        }

        // a declarative native binding renders its environment's template in place of a real call. The `javascript`
        // target covers both node and browser when no env-specific target is given.
        if (
          node.callee.form === 'variable' &&
          binds.has(node.callee.name)
        ) {
          const bind = binds.get(node.callee.name)!

          // the code-point count of an ASCII text (ir/facts/text.ts) is its length, where `Array.from` built an array
          if (node.callee.name === 'code-point-count' && node.args[0] && asciiNodes.has(node.args[0])) {
            return `${expression(node.args[0], 100)}.length`
          }

          // each argument as an operand, grouped when compound: a template that is the argument alone (`to-decimal`'s
          // `$value`) stands where the call stood, so `1 / to-decimal(a + b)` must keep `(a + b)`
          const args = node.args.map(arg => expression(arg, 100))
          const rendered = renderBind(bind, env, args) ?? renderBind(bind, 'javascript', args)

          if (rendered === undefined) {
            return bindGap(bind.name)
          }

          // and the template itself grouped where it stands under an operator, unless it is one primary already: the
          // stdlib's `bignum-compare` is `$a < $b ? -1 : (...)`, so `is-below(big-compare(x, y), 0)` emitted
          // `x < y ? -1 : (...) < 0`, which compares the wrong thing (engine/data/integer port, 2026-10-04,
          // test/compile/bind-group.ts)
          return parentPrecedence > 0 && !isPrimary(rendered) ? `(${rendered})` : rendered
        }

        // a map READ is the stored value: Term's raw `get` reads a key it has (the stdlib's `hash-get` asks `has` first),
        // so the read is `get(k)!`, as TypeScript writes a read it knows is there. `tsc --strict` refused `V | undefined`
        // where a `V` was declared
        const mapRead =
          node.callee.form === 'member' &&
          node.callee.name === 'get' &&
          node.callee.target.type?.kind === 'map' &&
          node.args.length === 1

        // a map read or write whose key may be a record goes through `__termKey`, so an equal record finds the entry
        // (a JavaScript Map keys objects by identity). A primitive key costs one `typeof`.
        if (
          node.callee.form === 'member' &&
          (node.callee.name === 'get' ||
            node.callee.name === 'set' ||
            node.callee.name === 'has' ||
            node.callee.name === 'delete') &&
          node.args.length > 0
        ) {
          const key = mapKeyType(node.callee.target.type)

          if (key !== false && structuralType(key === true ? node.args[0]!.type : key)) {
            tsEqualUsed = true

            return `${expression(node.callee)}(${[
              `__termKey(${expression(node.args[0]!)})`,
              ...node.args.slice(1).map(arg => expression(arg)),
            ].join(', ')})${mapRead ? '!' : ''}`
          }
        }

        // keys / values on a map materialize to an array (a `Map` iterator is not the list the stdlib returns)
        const collected = mapCollect(node.callee)

        if (collected) {
          return `Array.from(${expression(collected.target)}.${collected.name}())`
        }

        // a record passed to a task that writes its fields is the task's own copy (D1, `recordCopies`): a spread for a
        // one-level write, a deep copy where some written path goes further
        // a parameter or local shadows a task of its name: neither that task's copies nor its arity apply to its calls
        // (the stdlib's `map` calls its parameter `fn`, beside a program's task `fn`, test/compile/shadowed-callee.ts)
        const task =
          node.callee.form === 'variable' &&
          node.callee.binding?.kind !== 'parameter' &&
          node.callee.binding?.kind !== 'local'
            ? node.callee.name
            : undefined
        const writes = task === undefined ? undefined : copies.params.get(task)
        const rendered = node.args.map((arg, i) =>
          writes?.has(i) && arg.form !== 'record' ? copyRecord(expression(arg), writes.get(i)!) : expression(arg),
        )
        const declared = task === undefined ? undefined : tsFunctionParams.get(task)

        if (declared) {
          for (let i = rendered.length; i < declared.length && declared[i]!.optional; i++) {
            const empty = tsEmptyOf(declared[i]!.type)

            if (empty.startsWith('undefined')) {
              break
            }

            rendered.push(empty)
          }
        }

        return `${expression(node.callee)}(${rendered.join(', ')})${mapRead ? '!' : ''}`
      }

      case 'array': {
        // AN EMPTY LIST SPELLS ITS ELEMENT, for the reason the empty map below spells its key and value:
        // `const out = []` is `never[]` to TypeScript, so the first `push` onto it is an error under
        // `strict` and every `out` after it is the wrong type. A filled literal infers from its items.
        const ann =
          node.items.length === 0 && node.type?.kind === 'array'
            ? `: ${tsType(node.type.element)}[]`
            : ''

        // the annotation belongs on the BINDING, and an expression has none to put it on, so an empty list
        // in expression position is cast instead: both say the same thing to the checker. Parenthesized, since a
        // member read of it (`count-binds([])` inlined to `binds.length`) bound `.length` to the type: `[] as T[].length`
        return ann === ''
          ? `[${node.items.map(item => expression(item)).join(', ')}]`
          : `([] as ${tsType(node.type!.kind === 'array' ? node.type.element : node.type!)}[])`
      }
      case 'map': {
        // an EMPTY map spells its checked key/value (`new Map<T, boolean>()`), so a construction flowing into a
        // typed field or parameter is assignable (Map's type arguments are invariant); a filled one infers
        const ann =
          node.entries.length === 0 && node.type?.kind === 'map'
            ? `<${tsType(node.type.key)}, ${tsType(node.type.value)}>`
            : ''

        return `new Map${ann}([${node.entries
          .map(e => {
            const key = expression(e.key)

            if (!structuralType(e.key.type)) {
              return `[${key}, ${expression(e.value)}]`
            }

            tsEqualUsed = true

            return `[__termKey(${key}), ${expression(e.value)}]`
          })
          .join(', ')}])`
      }

      case 'record': {
        // the build this `return` has assigned on the object the task was given (`recordReuse`)
        if (reusing && reused === node) {
          return toCamel(reusing.param)
        }

        const fields = node.fields.map(
          f => `${toMember(f.name)}: ${expression(f.value)}`,
        )

        // `make hash` / `make list` build the native map / array (what a `like hash` / `like list` is)
        if (node.name === 'hash' && fields.length === 0) {
          return 'new Map()'
        }

        if (node.name === 'list' && fields.length === 0) {
          return '[]'
        }

        // `make void` is the absent value, not an empty object: `{} == {}` is never true, so a void slot
        // written as `{}` could not be recognized again
        if (node.name === 'void' && fields.length === 0) {
          return 'undefined'
        }

        // an enum variant carries a discriminant tag; a struct is a plain object. A variant fills what it leaves
        // out for the same reason a struct does, and until 2026-09-13 it did not: `reference <x>` emitted
        // `{ form: "reference", element: "x" }` while the emitted variant TYPE requires every field of the case,
        // so the construction and its own type disagreed and nothing noticed, because a literal with no
        // contextual type is never checked against the type it is meant to be. 636 of the v4 grammar's strict
        // errors were one such pattern built without its optional `system`.
        if (variants.has(node.name)) {
          // a case of a closed set of texts is its text
          const text = textFor(node.name, node.type)

          if (text !== undefined) {
            return JSON.stringify(text)
          }

          // a variant with no fields at all, declared or given, and not `mark shared` (whose identity is the point): the
          // module's one frozen constant for it
          if (node.fields.length === 0 && variantCase(node.name, node.type).length === 0 && !tsSharedForms.has(node.name)) {
            const constant = tsFieldless.get(node.name) ?? `__termVariant${toPascal(node.name)}`
            tsFieldless.set(node.name, constant)

            return constant
          }

          return `{ ${[
            `${tagFor(node.name, node.type)}: ` + JSON.stringify(node.name),
            ...inDeclaredOrder(variantCase(node.name, node.type), node.fields, fields),
          ].join(', ')} }`
        }

        // a field the construction leaves out (`need false`, or one the runtime fills on another path) takes its
        // type's empty value, so the object satisfies its interface -- the rule the native backends already follow
        const made = `{ ${inDeclaredOrder(tsRecordFields.get(node.name) ?? [], node.fields, fields).join(', ')} }`

        // a `mark shared` value carries a hidden marker, so a record holding it compares it by identity and a map
        // keys it by identity, as Rust (`Rc::ptr_eq`), Swift (`===`) and Kotlin (a plain class) do
        if (tsSharedForms.has(node.name)) {
          tsEqualUsed = true

          return `__termShare(${made})`
        }

        return made
      }

      case 'member':
        // a list reached through a path that this loop copy read once before it
        if (hoisted.size > 0 && node.index === undefined && node.type?.kind === 'array') {
          const local = hoisted.get(listKey(node) ?? '')

          if (local) {
            return local
          }
        }

        // a DYNAMIC segment (`read table/{key}`) subscripts rather than dot-accesses. On a list it is the checked
        // read, which stops past the end as every other backend does
        if (node.index) {
          if (node.target.type?.kind === 'array') {
            tsListUsed = true

            return readAt(node.target, node.index)
          }

          return `${expression(node.target)}[${expression(node.index)}]`
        }

        // the length of a text counts code points
        if (stringRead(node)) {
          tsTextUsed = true

          return `__termText.length(${expression(node.target)})`
        }

        // a binding field with a foreign `name <...>` (e.g. COLOR_BUFFER_BIT) emits that native name verbatim; other
        // members camelCase the seed name
        // a literal index is a plain segment (`read items/0`), and JavaScript spells that with brackets
        if (/^\d+$/.test(node.name)) {
          if (node.target.type?.kind === 'array') {
            tsListUsed = true

            return readAt(node.target, { form: 'integer', value: Number(node.name), span: node.span })
          }

          return `${expression(node.target)}[${node.name}]`
        }

        // the kept field of a carrier that holds it alone
        if (node.target.form === 'variable' && carrierLocals.get(node.target.name) === node.name) {
          return toCamel(node.target.name)
        }

        return `${expression(node.target)}.${node.nick ?? toMember(node.name)}`
      case 'await':
        return `await ${expression(node.expr)}`

      case 'closure': {
        const params = node.params
          .map(p => `${toCamel(p.name)}: ${tsType(p.type)}`)
          .join(', ')

        const arrow = node.async ? `async (${params})` : `(${params})`

        // a single trailing `return X` becomes a concise arrow; the body is parenthesized so an object literal is
        // not mistaken for a block (`() => ({ ... })`)
        if (
          node.body.length === 1 &&
          node.body[0]!.form === 'return' &&
          node.body[0].value
        ) {
          return `${arrow} => (${expression(node.body[0].value)})`
        }

        return `${arrow} => ${block(node.body, 0)}`
      }

      case 'unary':
        return `${node.op}${expression(node.operand, 6)}`

      case 'binary': {
        // `is-equal` on records, lists, maps or bytes compares their structure, as Rust, Swift and Kotlin do.
        // JavaScript's `==` on two objects is identity, which made two records with equal fields unequal here only
        // (note/term/optimize/meaning.md, question 4)
        // a comparison with a number, text or boolean LITERAL is never structural: the literal equals only a value of
        // its own kind, which `===` decides. `!__termEqual(k, 0)` walked an unknown-typed list read on every turn
        const scalarLiteral = (e: Expression): boolean => e.form === 'integer' || e.form === 'float' || e.form === 'string' || e.form === 'boolean'

        if (
          (node.op === '==' || node.op === '!=') &&
          !scalarLiteral(node.left) &&
          !scalarLiteral(node.right) &&
          (structuralType(node.left.type) || structuralType(node.right.type))
        ) {
          tsEqualUsed = true
          const call = `__termEqual(${expression(node.left)}, ${expression(node.right)})`

          return node.op === '==' ? call : `!${call}`
        }

        // two texts order by code point (note/term/stdlib/semantics.md); JavaScript's `<` orders by UTF-16 unit
        if (
          (node.op === '<' || node.op === '>' || node.op === '<=' || node.op === '>=') &&
          isText(node.left.type) &&
          isText(node.right.type)
        ) {
          tsTextUsed = true
          const compared = `__termText.compare(${expression(node.left)}, ${expression(node.right)}) ${node.op} 0`

          return parentPrecedence > 0 ? `(${compared})` : compared
        }

        const precedence = PRECEDENCE[node.op]
        const left = expression(node.left, precedence)
        const right = expression(node.right, precedence + 1)
        // strict equality: JavaScript's `==` converts (`0 == ""` is true), which no other backend does. A comparison
        // with a `null` literal stays loose, because it is the one test that means "null or undefined"
        const nullish = node.left.form === 'null' || node.right.form === 'null'
        const op = nullish ? node.op : node.op === '==' ? '===' : node.op === '!=' ? '!==' : node.op
        const text = `${left} ${op} ${right}`

        // `number` is an integer, and its quotient truncates toward zero on every backend: `7 / 2` is 3, as it is on
        // Rust, Swift and Kotlin. JavaScript's `/` is the float quotient. note/term/proof-by-default/numbers.md
        // (and a division by zero, `Infinity` or `NaN` here, is refused by the same check below)
        if (node.op === '/' && integerDivision(node)) {
          // in a task's unchecked copy the interval fact proved the quotient finite and safe, and elsewhere
          // compile/proven.ts proved its divisor nonzero
          if (uncheckedInts || provenSteps.has(node)) {
            return `Math.trunc(${text})`
          }

          tsIntUsed = true

          return `__termInt(Math.trunc(${text}))`
        }

        // and its sum, difference, product and remainder are the integer one or nothing: a result past the safe
        // integers would come back ROUNDED, a different integer, so it raises `excess` (or `shortage`) instead, and a
        // remainder by zero (`NaN`) raises `defect`. Rust, Swift and Kotlin stop the same way past i64.
        // note/term/proof-by-default/numbers.md
        if (
          (node.op === '+' || node.op === '-' || node.op === '*' || node.op === '%') &&
          integerDivision(node) &&
          !provenSteps.has(node) &&
          !uncheckedInts
        ) {
          tsIntUsed = true

          return `__termInt(${text})`
        }

        return precedence < parentPrecedence ? `(${text})` : text
      }

      case 'conditional': {
        // a value-position conditional lowers to a ternary chain: cond0 ? value0 : cond1 ? value1 : otherwise
        const tail = node.otherwise
          ? expression(node.otherwise)
          : 'undefined'

        const text = node.branches.reduceRight(
          (rest, branch) =>
            `${expression(branch.cond)} ? ${expression(
              branch.value,
            )} : ${rest}`,
          tail,
        )

        return parentPrecedence > 0 ? `(${text})` : text
      }

      default:
        return exhausted(node)
    }
  }

  const block = (body: Statement[], depth: number): string => {
    if (body.length === 0) {
      return '{}'
    }

    const inner = body
      .map(s => `${pad(depth + 1)}${guardStart(statement(s, depth + 1))}`)
      .join('\n')

    return `{\n${inner}\n${pad(depth)}}`
  }

  // emit a zone (view component) to a function that builds its DOM via the render runtime: `save` declares state /
  // computeds, `make-element` / `make-text` make nodes, `read` makes a reactive text node (`make-dynamic-text`),
  // attributes / events wire them, and each top-level view node is attached under the host param. fork / walk lower
  // to `show` / `render-each`. The render runtime's names come from ./render-names.ts, and the zone's own module
  // imports them. See note/seed/plan/zone-components.md.
  const emitZone = (
    node: Extract<Statement, { form: 'view' }>,
  ): string => {
    // the render runtime's tasks as this backend spells them
    const make = {
      element: toCamel(RENDER.element),
      text: toCamel(RENDER.text),
      dynamic: toCamel(RENDER.dynamic),
      attribute: toCamel(RENDER.attribute),
      event: toCamel(RENDER.event),
      show: toCamel(RENDER.show),
      each: toCamel(RENDER.each),
    }
    let counter = 0

    const next = (): string => `view${counter++}`

    // build a node into `out`, returning its variable name. Render-runtime calls are positional, in the param order of
    // each task in code/view/render.tree: make-element(tag), make-text(value), make-dynamic-text(source),
    // write-attribute(node, name, value), attach-event(node, name, handler).
    const build = (zone: ViewNode, out: string[]): string => {
      // a named element (`name x`) is emitted under that name, so handlers elsewhere in the zone can read it
      const ref =
        zone.form === 'element' && zone.ref ? toCamel(zone.ref) : next()

      if (zone.form === 'text') {
        out.push(`const ${ref} = ${make.text}(${JSON.stringify(zone.value)})`)
      } else if (zone.form === 'read') {
        out.push(
          `const ${ref} = ${make.dynamic}(() => ${expression(zone.value)})`,
        )
      } else if (zone.form === 'element') {
        out.push(`const ${ref} = ${make.element}(${JSON.stringify(zone.name)})`)

        for (const attribute of zone.attributes) {
          // an event handler is a function, so a single expression (`hook click, call submit`) is wrapped in one. A
          // multi-statement body already milled to a closure and is passed through: wrapping it again would build the
          // function and never call it.
          const handler =
            attribute.value.form === 'closure'
              ? expression(attribute.value)
              : `() => ${expression(attribute.value)}`

          out.push(
            attribute.event
              ? `${make.event}(${ref}, ${JSON.stringify(
                  attribute.name,
                )}, ${handler})`
              : `${make.attribute}(${ref}, ${JSON.stringify(
                  attribute.name,
                )}, ${expression(attribute.value)})`,
          )
        }

        for (const child of zone.children) {
          attach(child, ref, out)
        }
      } else {
        out.push(`const ${ref} = ${make.text}("")`)
      }

      return ref
    }

    // the positional render calls for the control-flow nodes (host comes first)
    const showCall = (
      host: string,
      zone: Extract<ViewNode, { form: 'fork' }>,
    ): string => {
      const branch = zone.branches[0]

      return `${make.show}(${host}, () => ${
        branch ? expression(branch.cond) : 'false'
      }, ${fragment([], branch ? branch.body : [])}, ${fragment(
        [],
        zone.otherwise ?? [],
      )})`
    }

    const eachCall = (
      host: string,
      zone: Extract<ViewNode, { form: 'walk' }>,
    ): string =>
      // the iterable is passed as a getter so `render-each` can read it inside an effect (reactive list rendering)
      `${make.each}(${host}, () => ${expression(zone.iterable)}, ${fragment(
        [toCamel(zone.item)],
        zone.body,
      )})`

    // attach a child under `parent`: nodes are built + appended; fork / walk lower to show / each. When `collect` is
    // given (the top level under the host in HMR mode), record the single removable node per child: a built element /
    // text ref directly, a fork / walk wrapped in a container so its whole subtree can be removed on hot-swap.
    const attach = (
      zone: ViewNode,
      parent: string,
      out: string[],
      collect?: string[],
    ): void => {
      if (zone.form === 'fork') {
        if (collect) {
          const part = next()
          out.push(`const ${part} = ${make.element}("seed-part")`)
          out.push(showCall(part, zone))
          out.push(`append(${parent}, ${part})`)
          collect.push(part)
        } else {
          out.push(showCall(parent, zone))
        }
      } else if (zone.form === 'walk') {
        if (collect) {
          const part = next()
          out.push(`const ${part} = ${make.element}("seed-part")`)
          out.push(eachCall(part, zone))
          out.push(`append(${parent}, ${part})`)
          collect.push(part)
        } else {
          out.push(eachCall(parent, zone))
        }
      } else if (zone.form !== 'slot') {
        const ref = build(zone, out)
        out.push(`append(${parent}, ${ref})`)

        if (collect) {
          collect.push(ref)
        }
      }
    }

    // a body list as a thunk `(params) => view` returning one node (children attached under a fragment element).
    // Not an IIFE: it is the `then` / `other` / `build` callback the render runtime invokes.
    const fragment = (params: string[], body: ViewNode[]): string => {
      const out: string[] = []
      const only = body[0]

      // a single static node is returned directly (no wrapper); anything else (0 or 2+ nodes, or control flow) goes
      // under a `seed-fragment` so the callback always returns exactly one node
      if (
        body.length === 1 &&
        only &&
        (only.form === 'element' ||
          only.form === 'text' ||
          only.form === 'read')
      ) {
        const ref = build(only, out)
        out.push(`return ${ref}`)
      } else {
        out.push(`const frag = ${make.element}("seed-fragment")`)

        for (const child of body) {
          attach(child, 'frag', out)
        }

        out.push('return frag')
      }

      return `(${params.join(', ')}) => { ${out.join('; ')} }`
    }

    // a top-level `save` whose value creates a signal (`save count / call make-signal / ...`). Its value is preserved
    // across a hot-swap, so in HMR mode it is seeded from the snapshot kept by the dev client.
    const isSignalSave = (
      child: Extract<ViewNode, { form: 'save' }>,
    ): boolean =>
      child.value.form === 'call' &&
      child.value.callee.form === 'variable' &&
      child.value.callee.name === 'make-signal'

    const params = node.params
      .map(p => `${toCamel(p.name)}: ${tsType(p.type)}`)
      .join(', ')

    const host = node.params[0] ? toCamel(node.params[0].name) : 'host'
    // the zone's key in the hot snapshot / remount map is its exported (camelCase) name, so the accept callback can
    // look the component up on the fresh module namespace by the same key
    const name = JSON.stringify(toCamel(node.name))
    const lines: string[] = []
    const signals: string[] = []

    // HMR: read the saved signal snapshot for this zone (if the dev client kept one), and open an ownership scope so
    // every effect created while building the view can be torn down together on the next hot-swap.
    if (hmr) {
      lines.push(
        `const __seed = (hot && hot.data.signals && hot.data.signals[${name}]) || {}`,
      )
      lines.push(`const __scope = openScope()`)
    }

    for (const child of node.body) {
      if (child.form === 'save') {
        if (hmr && isSignalSave(child)) {
          signals.push(child.name)

          const key = JSON.stringify(child.name)
          const init =
            child.value.form === 'call' && child.value.args[0]
              ? expression(child.value.args[0])
              : 'undefined'

          lines.push(
            `const ${toCamel(
              child.name,
            )} = makeSignal(${key} in __seed ? __seed[${key}] : ${init})`,
          )
        } else {
          lines.push(
            `const ${toCamel(child.name)} = ${expression(child.value)}`,
          )
        }
      }
    }

    const roots: string[] = []

    for (const child of node.body) {
      if (child.form === 'save') {
        continue
      }

      // a setup statement runs where it is written, so it sees the elements declared above it
      if (child.form === 'call') {
        lines.push(expression(child.value))
        continue
      }

      attach(child, host, lines, hmr ? roots : undefined)
    }

    // HMR: close the scope and register this instance (host, live signals, scope, root nodes) so the dev client can
    // snapshot its state, tear it down, and re-mount it from the fresh module on the next change.
    if (hmr) {
      lines.push(`closeScope()`)

      const sigObject = signals
        .map(s => `${JSON.stringify(s)}: ${toCamel(s)}`)
        .join(', ')

      lines.push(
        `if (hot) (hot.data.instances || (hot.data.instances = [])).push(` +
          `{ zone: ${name}, host: ${host}, signals: { ${sigObject} }, ` +
          `scope: __scope, nodes: [${roots.join(', ')}] })`,
      )
    }

    return `export function ${toCamel(
      node.name,
    )}(${params}) {\n  ${lines.join('\n  ')}\n}`
  }

  // A CHECKED VALUE WRITTEN TO A NAME IS TESTED WHERE IT STANDS. `x = __termInt(a + b)` is the value made into a
  // temporary, the same test as `__termInt` written in place, then the write: `const __n0 = a + b; if (!(__n0 <=
  // 9007199254740991 && __n0 >= -9007199254740991)) __termIntStop(__n0); x = __n0`. Nothing about the meaning moves:
  // every addition is still tested before anything reads it, and a raise still leaves the name unwritten. What moves
  // is the call: V8 did not inline `__termInt` inside a recursive task, and the call was most of the check's cost.
  // AWFY Permute, 639 ms to 587 against the hand version's 524, with every check still made (`tmp/ts-permute-ab3.ts`,
  // 11 rounds; 647 to 598 in the emitted program, 15 rounds, `tmp/ts-permute-ab4.ts`). A `let`, a write to a plain
  // variable and a `return`, and only a value that IS one `__termInt(...)` from its first character to its last
  let testedCount = 0
  const testedInPlace = (text: string): { lines: string; name: string } | undefined => {
    const head = '__termInt('

    if (!text.startsWith(head) || !text.endsWith(')')) {
      return undefined
    }

    let depth = 0
    let quote = ''

    for (let i = head.length - 1; i < text.length; i++) {
      const c = text[i]!

      if (quote) {
        if (c === '\\') i++
        else if (c === quote) quote = ''
        continue
      }

      if (c === '"' || c === "'" || c === '`') quote = c
      else if (c === '(') depth++
      else if (c === ')' && --depth === 0 && i !== text.length - 1) return undefined
    }

    const name = `__n${testedCount++}`

    return {
      lines: `const ${name} = ${text.slice(head.length, -1)}; if (!(${name} <= 9007199254740991 && ${name} >= -9007199254740991)) __termIntStop(${name})`,
      name,
    }
  }

  const statement = (node: Statement, depth: number): string => {
    switch (node.form) {
      case 'let': {
        // a host global (`host document, name <document>`): alias the seed name to the foreign global, or emit nothing
        // when the seed name already spells the global (so `document` resolves to the real `document`). Never bind it
        // to `undefined`.
        if (node.foreign) {
          const alias = toCamel(node.name)

          return alias === node.foreign
            ? ''
            : `const ${alias} = ${node.foreign}`
        }

        // a second declaration of a name the same statement list declared already is an assignment to it (backend.ts,
        // `redeclaredLets`): two counted walks over `i` in one task
        if (redeclared.has(node)) {
          return `${toCamel(node.name)} = ${expression(node.init)}`
        }

        // a carrier at a reuse site holds its kept field alone (compile/place.ts, `recordReuse`)
        const kept = reuse.locals.get(node)

        if (kept !== undefined) {
          carrierLocals.set(node.name, kept)

          return `const ${toCamel(node.name)} = ${expression(node.init)}`
        }

        const keyword = assignedNames.has(node.name) ? 'let' : 'const'

        // A DECLARED TYPE IS SPELLED ON THE BINDING. An object literal with no contextual type is inferred
        // WIDENED -- `{ form: "some", value: 200 }` infers `{ form: string; value: number }`, which does not
        // match `Maybe<number>` -- and a `host x / like list / like feature-state` with a hundred entries
        // then fails at whatever reads it rather than where it is written. Only when the source declared one:
        // an inferred binding is left to inference, as it was.
        // An anonymous record (a nested `host` table, typed `named ''`) has no name to spell, so it is left to inference
        // rather than written `const range:  = ...`
        const spelled = node.type ? tsType(node.type) : ''
        const declared = spelled ? `: ${spelled}` : ''

        // a second name for a record one of the two is written through: its own copy (D1, `recordCopies`)
        const alias = copies.lets.get(node)
        const init = alias === undefined ? expression(node.init) : copyRecord(expression(node.init), alias)
        const tested = alias === undefined ? testedInPlace(init) : undefined

        return tested
          ? `${tested.lines}; ${keyword} ${toCamel(node.name)}${declared} = ${tested.name}`
          : `${keyword} ${toCamel(node.name)}${declared} = ${init}`
      }

      case 'assign': {
        // the write-back of a reuse site: the reusing copy built the record in the object this slot holds already
        if (reuse.writeBacks.has(node)) {
          return '// the slot holds the record its task built in place'
        }

        // a record written back to the slot it was read from, its changed fields assigned on the object already there
        // (compile/place.ts): `b.vx = b.vx - dx * m` where the write would have allocated a new record. The read of
        // the slot already checked the index
        const place = places.get(node)

        if (place) {
          const local = toCamel(place.local)

          if (!place.temps) {
            return place.fields.map(f => `${local}.${toCamel(f.name)} = ${expression(f.value)}`).join('; ')
          }

          const temps = place.fields.map((f, i) => `const __place${i} = ${expression(f.value)}`)
          const sets = place.fields.map((f, i) => `${local}.${toCamel(f.name)} = __place${i}`)

          return `{ ${[...temps, ...sets].join('; ')} }`
        }

        // a write to a map's slot (`save counts/{key}, ...`) is the Map's `set`: `counts[key] = v` set a property of the
        // Map object, which no `get`, `has`, `size` or walk of the map ever sees, so the write was lost on this backend
        // alone (found by meaning-native `text-keys`)
        if (node.op === '=' && node.target.form === 'member' && node.target.index && node.target.target.type?.kind === 'map') {
          return `${expression(node.target.target)}.set(${expression(node.target.index)}, ${expression(node.value)})`
        }

        // a write to a list slot (`save slots/{value}, ...`, `save xs/0, ...`): the READ of one is the checked
        // `__termAt(xs, i)`, which is no place to assign to (esbuild: "Invalid assignment target"). The write keeps
        // the same check, so a slot past the end stops here as on every other backend, then writes the slot itself
        if (node.target.form === 'member' && node.target.target.type?.kind === 'array' && (node.target.index || /^\d+$/.test(node.target.name))) {
          tsListUsed = true
          const list = expression(node.target.target)
          const at = node.target.index ? expression(node.target.index) : node.target.name
          // one checked write, `__termPut`, which evaluates the list and the index ONCE: the read-then-write pair
          // evaluated both twice and made two calls. The value is computed first, as on Rust (`__set_value`). With a
          // plain list and index and a value that has no effect of its own, the check is written in place (readAt)
          if (node.op === '=') {
            const index: Expression = node.target.index ?? { form: 'integer', value: Number(node.target.name), span: node.span }

            // inside the guarded copy of a counted loop the slot is proven in bounds (ir/facts/bounds.ts)
            if (uncheckedLists.size && uncheckedLists.has(listKey(node.target.target) ?? '')) {
              return `${list}[${at}] = ${expression(node.value)}`
            }

            if (plainOperand(node.target.target) && plainOperand(index) && effectFree(node.value)) {
              return `${at} >= 0 && ${at} < ${list}.length ? (${list}[${at}] = ${expression(node.value)}) : __termWritePast(${list}, ${at})`
            }

            return `__termPut(${list}, ${at}, ${expression(node.value)})`
          }

          return `__termAt(${list}, ${at}); ${list}[${at}] ${node.op} ${expression(node.value)}`
        }

        // a write two or more fields deep never changes the nested record in place: it may be another name's too (a
        // record built from a variable holds that variable's record), and a record is a value (D1). The path is rebuilt
        // from its first field instead, `p.inner = { ...p.inner, count: 99 }` (codegen-performance-0028)
        if (node.op === '=' && node.target.form === 'member') {
          const segments: string[] = []
          let base: Expression = node.target
          let rebuild = true

          while (base.form === 'member') {
            const holder = base.target.type

            if (base.index || /^\d+$/.test(base.name) || holder?.kind !== 'named' || !plainRecords.has(holder.name)) {
              rebuild = false
            }

            segments.unshift(base.name)
            base = base.target
          }

          if (rebuild && segments.length > 1) {
            const at = (k: number): string => `${expression(base)}.${segments.slice(0, k).map(toCamel).join('.')}`
            let value = expression(node.value)

            for (let k = segments.length - 1; k >= 1; k--) {
              value = `{ ...${at(k)}, ${toCamel(segments[k]!)}: ${value} }`
            }

            return `${at(1)} = ${value}`
          }
        }

        const target = expression(node.target)

        if (node.op === '=') {
          const value = expression(node.value)
          const tested = node.target.form === 'variable' ? testedInPlace(value) : undefined

          return tested ? `${tested.lines}; ${target} = ${tested.name}` : `${target} = ${value}`
        }

        return `${target} ${node.op} ${expression(node.value)}`
      }

      case 'expression': {
        // a map entry updated from its own value (backend.ts, `mapUpdate`): JavaScript's Map has no one-probe update,
        // so it is the read and the write the hand version writes, with no `Maybe` made per read
        const update = mapUpdate(node)

        if (update && update.map.type?.kind === 'map' && (update.map.type.value.kind === 'number' || update.map.type.value.kind === 'float')) {
          const map = expression(update.map, 100)
          const key = expression(update.key)
          const sum = `(${map}.get(${key}) ?? ${expression(update.fallback)}) + ${expression(update.step)}`
          const checked = update.map.type.value.kind === 'number' && !uncheckedInts

          tsIntUsed ||= checked

          return `${map}.set(${key}, ${checked ? `__termInt(${sum})` : sum})`
        }

        // a statement that would begin with `{` (an object literal) is read by JavaScript as a block, and one that would
        // begin with `function` as a declaration: either is written in parentheses, so it stays the expression it is
        const text = expression(node.expr)

        return /^(\{|function\b)/.test(text) ? `(${text})` : text
      }
      case 'return': {
        // a tail call of a task that is a loop: the arguments computed first, then the parameters rebound
        if (tailing?.returns.has(node) && node.value?.form === 'call') {
          const k = reuseCount++
          // typed as the parameter, so a record literal keeps its tag (`form: "node"`, not `string`)
          const temps = node.value.args.map((a, i) => `const __tail${k}_${i}: ${tailing!.types[i]} = ${expression(a)}`)
          const sets = tailing.params.map((name, i) => `${toCamel(name)} = __tail${k}_${i}`)

          return [...temps, ...sets, 'continue'].join(`\n${pad(depth)}`)
        }

        // in a reusing copy, the build in the returned value is made in the object the task was given: every field
        // computed first, since each may read that object's old fields, then assigned on it (`recordReuse`)
        const build = reusing && node.value ? findBuild(node.value, reusing.builds) : undefined

        if (build && reusing) {
          const k = reuseCount++
          const temps = build.fields.map((f, i) => `const __reuse${k}_${i} = ${expression(f.value)}`)
          const sets = build.fields.map((f, i) => `${toCamel(reusing!.param)}.${toMember(f.name)} = __reuse${k}_${i}`)
          reused = build
          // the kept field of a carrier alone, the record already being in the caller's slot
          const kept =
            reusing.keep && reusing.carriers?.has(node.value!) && node.value!.form === 'record'
              ? node.value!.fields.find(f => f.name === reusing!.keep)?.value
              : undefined
          const back = `return ${expression(kept ?? node.value!)}`
          reused = undefined

          return [...temps, ...sets, back].join(`\n${pad(depth)}`)
        }

        if (!node.value) {
          return 'return'
        }

        // a checked value returned is tested where it stands too (`testedInPlace`)
        const value = expression(node.value)
        const tested = testedInPlace(value)

        return tested ? `${tested.lines}; return ${tested.name}` : `return ${value}`
      }
      case 'throw':
        // a raised exception (`halt <form>`) is thrown as the runtime class, a thrown text becomes an Error, and any
        // other value is thrown as-is. An INTERPOLATED text is a text too: `halt <cycle: {{x}}>` was a `template`
        // node, missed here, and threw a bare string with no message and no stack (found porting compile/affected)
        if (
          node.value.form === 'record' &&
          tsExceptions.has(node.value.name)
        ) {
          return `throw new ${EXCEPTION_CLASS}(${expression(node.value)})`
        }

        // a text raises `failure`, the carrier every native backend builds for one (rust.ts `throw`): a handler reads
        // `form` and `note` off it alike everywhere. It was a bare `Error`, so `problem/form` was `undefined` here
        // and `failure` there (guides: language/errors, 2026-10-03)
        return node.value.form === 'string' || node.value.form === 'template'
          ? `throw ((note: string) => Object.assign(new Error(note), { name: "TermException", host: "", form: "failure", note, code: "", time: Date.now(), link: {} }))(${expression(node.value)})`
          : `throw ${expression(node.value)}`
      case 'while': {
        // a counted loop whose list indexes a guard proves in bounds (ir/facts/bounds.ts) is written twice: the guard
        // true runs it with no bounds checks, the guard false runs the original, so a run that could reach outside a
        // list takes the checked copy and stops where it always did
        const guard = loopGuards.get(node)

        if (!guard) {
          return `while (${expression(node.cond)}) ${block(node.body, depth)}`
        }

        // each name written the way the emitter writes that variable everywhere else
        const name = (id: string): string => expression({ form: 'variable', name: id, span: node.span } as Expression)
        const test = guard.checks
          .map(c => {
            const value =
              c.base === undefined
                ? String(c.offset)
                : c.offset === 0
                  ? name(c.base)
                  : `${name(c.base)} ${c.offset < 0 ? '-' : '+'} ${Math.abs(c.offset)}`

            // a list reached through a path reads its length through it. Its own slots read unchecked: their checks
            // come earlier in this `&&` (bounds.ts bounds a path's prefix first), so the read runs only once they hold
            if (c.side === 'high' && c.path) {
              const before = uncheckedLists
              uncheckedLists = new Set([...before, ...guard.checks.map(g => g.list)])
              const length = `${expression(c.path as Expression, 20)}.length`
              uncheckedLists = before

              return `${value} < ${length}`
            }

            return c.side === 'low' ? `${value} >= 0` : `${value} < ${name(c.list)}.length`
          })
          .concat((guard.limits ?? []).map(l => (l.low ? `${name(l.name)} >= 0` : `${name(l.name)} <= ${l.high}`)))
          .filter((term, i, all) => all.indexOf(term) === i)
          .join(' && ')
        const outer = uncheckedLists
        const outerCalls = fastCalls
        const outerHoisted = hoisted
        uncheckedLists = new Set([...outer, ...guard.checks.map(c => c.list)])
        fastCalls = new Set([...outerCalls, ...(guard.fast ?? [])])
        // each list reached through a path is read ONCE before the copy, which the guard makes safe and the loop cannot
        // change (bounds.ts: its root and indexes are not written in it, nor a field, nor a record's slot), and the body
        // indexes the local. A record here is a reference, so the local is the record's own list
        const reads: string[] = []
        const paths = new Map<string, Expression>()

        for (const c of guard.checks) {
          if (c.path && !paths.has(c.list)) {
            paths.set(c.list, c.path as Expression)
          }
        }

        for (const [key, path] of paths) {
          const local = `__path${pathCount++}`
          reads.push(`const ${local} = ${expression(path)}`)
          hoisted = new Map([...hoisted, [key, local]])
        }

        const fast = [...reads, `while (${expression(node.cond)}) ${block(node.body, depth + 1)}`].join(`\n${pad(depth + 1)}`)
        uncheckedLists = outer
        fastCalls = outerCalls
        hoisted = outerHoisted
        const slow = `while (${expression(node.cond)}) ${block(node.body, depth + 1)}`

        return `if (${test}) {\n${pad(depth + 1)}${fast}\n${pad(depth)}} else {\n${pad(depth + 1)}${slow}\n${pad(depth)}}`
      }
      case 'guard': {
        // `note unsafe` / `halt take`: a try with its catch. The caught value is bound as written; a guard with no
        // handler swallows what it catches, which the checker warns about. Bound as `any`: the handler's reads of the
        // exception's fields are the checker's, already typed, and a strict tsc types a bare binding `unknown`
        // (TS18046 at every `error.form` a `sift` reads)
        const handler = node.catch
          ? ` catch (${toCamel(node.catch.name)}: any) ${block(node.catch.body, depth)}`
          : ' catch {}'

        return `try ${block(node.body, depth)}${handler}`
      }
      case 'for-each': {
        // a walk over a LIST that names its index is a counted loop: `entries()` made a `[i, x]` pair per turn, and
        // this allocates nothing. The length is read every turn, as the array iterator `for...of` uses does
        if (node.index && node.iterable.type?.kind === 'array') {
          const walked = `__walked${depth}`
          const body = block(node.body, depth)

          return `{ const ${walked} = ${expression(node.iterable)}; for (let ${toCamel(node.index)} = 0; ${toCamel(node.index)} < ${walked}.length; ${toCamel(node.index)}++) {\n${pad(depth + 1)}const ${toCamel(node.item)} = ${walked}[${toCamel(node.index)}]!${body.slice(1)} }`
        }

        // a walk that names its INDEX over anything else iterates the entries; one that does not keeps the plain `of`
        // loop. lean-0017
        return node.index
          ? `for (const [${toCamel(node.index)}, ${toCamel(node.item)}] of ${expression(
              node.iterable,
            )}.entries()) ${block(node.body, depth)}`
          : `for (const ${toCamel(node.item)} of ${expression(
              node.iterable,
            )}) ${block(node.body, depth)}`
      }

      case 'match': {
        const raw = expression(node.subject)
        // a fork case over a caught exception (the checker filled `exceptionArms`): `form` is the discriminant,
        // the shared fields read off the carrier, the form's props off its `link`
        if (node.exceptionArms) {
          const exceptionSubject = /^[A-Za-z_$][\w$]*$/.test(raw) ? raw : `(${raw})`
          let out = ''
          node.cases.forEach((branch, i) => {
            const arm = node.exceptionArms![branch.label]!
            // only the fields the arm READS, asked of the program and not of the emitted text (swift.ts says why)
            const read = namesIn(branch.body)
            const locals = armLocals([...arm.shared, ...arm.link], branch.binds ?? [])
              .filter(({ local }) => read.has(local))
              .map(({ field, local }) => `${pad(depth + 1)}const ${toCamel(local)} = ${exceptionSubject}.${arm.link.includes(field) ? `link.${toMember(field)}` : toMember(field)}`)
            out += `${i ? ' else ' : ''}if (${exceptionSubject}.form === ${JSON.stringify(branch.label)}) {\n${[...locals, ...branch.body.map(s => `${pad(depth + 1)}${guardStart(statement(s, depth + 1))}`)].join('\n')}\n${pad(depth)}}`
          })

          // an exception no arm names goes on to the caller, as it does on Rust, Swift and Kotlin. Without the
          // rethrow the handler fell through and the task returned undefined: a JSON refusal in the browser env,
          // raised as a TypeError by a failing uuid, came back from `why` as nothing at all
          out += node.otherwise ? ` else ${block(node.otherwise, depth)}` : ` else {\n${pad(depth + 1)}throw ${exceptionSubject}\n${pad(depth)}}`

          return out
        }

        // THE SUBJECT IS EVALUATED ONCE, and a subject that is not already a NAME is bound to one first.
        //
        // The chain below reads the subject in every arm's test and again in every field local, so a call
        // subject ran once per arm: `fork case / list-find one/override ...` called `listFind` three times
        // for every block of every root, which is wrong if the callee has an effect and wasteful when it
        // does not. It also cost the emitted TypeScript its narrowing, because `f(x).form === "some"` tells
        // the checker nothing about the NEXT `f(x)`, so reading `.value` in the arm was an error under
        // `strict` (mesh's v4 grammar, 2026-09-12).
        //
        // A bare identifier or a plain member chain is left alone: it is already a name, re-reading it is
        // free, and the output stays readable.
        const isName = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(raw)
        // a name is held too when an arm binds a field of the same name (`fork case, read value` over a variant with
        // a `value` field): `const value = value.value` reads the new binding before it exists
        const root = raw.split('.')[0]
        const shadowed = node.cases.some(branch =>
          armLocals((tsVariantFields.get(branch.label) ?? []).map(f => f.name), branch.binds ?? []).some(
            ({ local }) => toCamel(local) === root,
          ),
        )
        const held = isName && !shadowed ? undefined : `__at${depth}`
        const subject = held ?? raw

        // the chain, wrapped in a block that holds the subject where one was bound
        const wrap = (chain: string): string =>
          held === undefined
            ? chain
            : `{\n${pad(depth + 1)}const ${held} = ${raw}\n${pad(depth + 1)}${chain}\n${pad(depth)}}`

        // Booleans lower to NATIVE JS booleans in this backend (a
        // comparison emits `>`, an `if` tests truthiness), so a
        // match whose labels are only true/false must test the
        // value itself. Reading `.form` off a primitive boolean
        // yields undefined and every branch silently misses.
        const labels = node.cases.map(branch => branch.label)
        const booleans =
          labels.length > 0 &&
          labels.every(label => label === 'true' || label === 'false')

        if (booleans) {
          // when the second literal arm is the negation of the first (both true and false are covered), close the
          // chain with a plain `else`: the control flow is exhaustive, and TypeScript's return analysis sees it.
          const closed =
            !node.otherwise &&
            node.cases.length === 2 &&
            labels[0] !== labels[1]

          let out = ''
          node.cases.forEach((branch, i) => {
            const cond =
              branch.label === 'true' ? subject : `!${subject}`
            out +=
              closed && i === 1
                ? ` else ${block(branch.body, depth)}`
                : `${i ? ' else ' : ''}if (${cond}) ${block(
                    branch.body,
                    depth,
                  )}`
          })

          if (node.otherwise) {
            out += ` else ${block(node.otherwise, depth)}`
          }

          return wrap(out)
        }

        // A match on an enum tests the `.form` discriminant. A match on
        // a plain STRING value (`fork case, read kind` where kind is
        // text: "keychain" / "secret" / ...) tests the value itself.
        // The two are told apart by the labels: enum arms name known
        // variants, so if NONE of these labels is a program-wide
        // variant, the subject is a value and `.form` would read
        // undefined off a string and silently miss every arm. This is
        // the string analogue of the boolean case above.
        const values =
          labels.length > 0 &&
          labels.every(label => !variants.has(label))

        if (values) {
          let out = ''
          node.cases.forEach((branch, i) => {
            out += `${
              i ? ' else ' : ''
            }if (${subject} === ${JSON.stringify(
              branch.label,
            )}) ${block(branch.body, depth)}`
          })

          if (node.otherwise) {
            out += ` else ${block(node.otherwise, depth)}`
          }

          return wrap(out)
        }

        let out = ''
        node.cases.forEach((branch, i) => {
          // the variant's fields, as locals: `link` renames them in order, otherwise they keep their names. Only the
          // ones the body reads, so an unused field costs nothing and cannot shadow an outer name by accident.
          // the case of the SUBJECT's form: two forms may name a case alike (`leaf` on engine/data/array's `vector` and
          // string's `rope`), and keyed by the name alone the one declared last answered, so `rope`'s arm declared
          // `vector`'s fields and read an outer `length` (the engine/value port, 2026-10-04)
          const owned = node.subject.type?.kind === 'named' ? tsVariantFieldsByOwner.get(node.subject.type.name)?.get(branch.label) : undefined
          const fields = (owned ?? tsVariantFields.get(branch.label) ?? []).map(
            f => f.name,
          )
          // the ones the arm's program READS, as the exception arms ask: a `subject.field` read stays on the subject,
          // so nothing reaches a local except by its name, and an emitted `time.now()` is not a read of `time`
          const read = namesIn(branch.body)
          const locals = armLocals(fields, branch.binds ?? [])
            .filter(({ local }) => read.has(local))
            .map(
              ({ field, local }) =>
                `${pad(depth + 1)}const ${toCamel(local)} = ${subject}.${toMember(field)}`,
            )

          const body =
            locals.length === 0
              ? block(branch.body, depth)
              : `{\n${locals.join('\n')}\n${branch.body
                  .map(s => `${pad(depth + 1)}${guardStart(statement(s, depth + 1))}`)
                  .join('\n')}\n${pad(depth)}}`

          // THE LAST ARM OF AN EXHAUSTIVE MATCH IS A PLAIN `else`, the way the boolean case above closes.
          // The checker sets `closed` when the arms cover every variant and there is no `otherwise`, and
          // without it a task whose arms all return reads to TypeScript as one that can fall out of the
          // bottom: 43 such functions in one grammar, each an error under `strict` (2026-09-12).
          const last = node.closed && !node.otherwise && i === node.cases.length - 1

          // the only arm of an exhaustive match runs unconditionally: a form of one case has one shape, so its fields
          // read as they are, and an `if` with no `else` read to TypeScript as a task that can fall out of the bottom
          // a field-less case only ever its constant is tested by identity, through its guard (`identityCases`)
          const owner = node.subject.type?.kind === 'named' ? node.subject.type.name : ''
          const text = textFor(branch.label, node.subject.type)
          const test = text !== undefined
            ? `${subject} === ${JSON.stringify(text)}`
            : tsIdentity.has(`${owner}/${branch.label}`)
            ? `${guardFor(branch.label)}(${subject})`
            : `${subject}.${tagFor(branch.label, node.subject.type)} === ${JSON.stringify(branch.label)}`

          out += last && i === 0
            ? body
            : last
            ? ` else ${body}`
            : `${i ? ' else ' : ''}if (${test}) ${body}`
        })

        if (node.otherwise) {
          out += ` else ${block(node.otherwise, depth)}`
        }

        return wrap(out)
      }

      case 'break':
        return 'break'
      case 'continue':
        return 'continue'
      case 'exit':
        // a page has no process to end: `process` is a ReferenceError in a browser, so `exit` there is a return
        return env === 'browser' ? 'return' : 'process.exit(0)'
      case 'debug':
        return 'debugger'

      case 'record-type': {
        // THE FORM'S HEADS BECOME TYPE PARAMETERS.
        //
        // `form maybe / head t` declares a parameter, and dropping it emitted
        //
        //   export type Maybe =
        //     | { form: "some"; value: T }
        //
        // where `T` is never declared. Nothing caught it, because `term boot`
        // strips types rather than checking them, so the annotation only had
        // to parse. The cost was that a head written in the source could
        // never constrain anything: `like maybe / head text` and a provider
        // returning the wrong shape looked identical to the compiler.
        // Each parameter is given `= any`. A reference that carries no
        // arguments is common in emitted code, and a parameter with no
        // default would make every one of those an error. `any` (not
        // `unknown`) because a bare reference is the GRADUAL case: a
        // `Maybe` built with a concrete value must flow into a
        // `Maybe<number>` slot, which `unknown` refuses. A reference that
        // DOES carry arguments is checked properly.
        const generics =
          node.params && node.params.length > 0
            ? `<${node.params
                .map(p => `${toPascal(p)} = any`)
                .join(', ')}>`
            : ''

        // an ALIAS form (`form program / like list, like statement`, a base and nothing of its own) is its base. The
        // checker unifies the two already; written as an interface it was `interface Program {}`, which every value
        // fits and nothing reads (engine/ast's `Program`, 2026-10-04)
        if (node.alias && node.fields.length === 0 && node.variants.length === 0) {
          return `type ${toPascal(node.name)}${generics} = ${tsType(node.alias)}`
        }

        // a closed set of texts (`mark text`, D9) is the union of its texts
        if (node.text && node.variants.length > 0) {
          return `type ${toPascal(node.name)} =\n${node.variants
            .map(v => `${pad(depth + 1)}| ${JSON.stringify(v.text ?? v.name)}`)
            .join('\n')}`
        }

        // an enum becomes a discriminated union; a struct becomes an interface
        if (node.variants.length > 0) {
          const members = node.variants.map(v => {
            // `link x, like t, need false` makes a field OPTIONAL, and the emitted type has to say so or the
            // construction and its own type disagree: `element` takes its `pattern` `need false` and passed the
            // optional parameter into a field the case declared required, in every module the builder is
            // inlined into. The mill has carried `optional` since `need false` existed; this backend ignored it.
            const fields = v.fields.map(
              f =>
                `${toMember(f.name)}${f.optional ? '?' : ''}: ${tsType(f.type)}`,
            )

            return `{ ${[
              `${toMember(node.tag ?? 'form')}: ` + JSON.stringify(v.name),
              ...fields,
            ].join('; ')} }`
          })

          return `type ${toPascal(node.name)}${generics} =\n${members
            .map(m => `${pad(depth + 1)}| ${m}`)
            .join('\n')}`
        }

        const fields = node.fields
          .map(
            f =>
              `${pad(depth + 1)}${toMember(f.name)}${f.optional ? '?' : ''}: ${tsType(f.type)}`,
          )
          .join('\n')

        return `interface ${toPascal(node.name)}${generics} {\n${fields}\n${pad(
          depth,
        )}}`
      }

      case 'if': {
        let out = ''
        node.branches.forEach((branch, i) => {
          out += `${i ? ' else ' : ''}if (${expression(
            branch.cond,
          )}) ${block(branch.body, depth)}`
        })

        if (node.otherwise) {
          out += ` else ${block(node.otherwise, depth)}`
        }

        return out
      }

      case 'function': {
        const previous = assignedNames
        assignedNames = new Set<string>()
        collectAssigned(node.body, assignedNames)
        const previousCursors = cursors
        cursors = textCursors(node, asciiNodes)
        const previousCarriers = carrierLocals
        carrierLocals = new Map()
        const previousRedeclared = redeclared
        redeclared = redeclaredLets(node)

        // a `need false` parameter with no `fall` is optional in the emitted signature, so a caller that leaves
        // it off (the checker allows it) still typechecks. A required param AFTER an optional one forces the
        // optional to stay required (TypeScript refuses required-after-optional), matching by suffix
        let lastRequired = -1
        node.params.forEach((p, i) => {
          if (!(p.optional && !p.fallback)) {
            lastRequired = i
          }
        })
        // A `fall` DEFAULT IS SPELLED IN THE SIGNATURE (`binds: string[] = []`). The checker already fills it at
        // every Term call site, so Term callers are unchanged; what the default buys is the TypeScript that calls an
        // emitted module directly, which passed `undefined` straight into the body. Found porting `check/arm`
        // (self-hosting-0033, 2026-10-02), whose twelve TypeScript callers had to change because of it.
        const params = node.params
          .map(
            (p, i) =>
              `${toCamel(p.name)}${p.optional && !p.fallback && i > lastRequired ? '?' : ''}: ${tsType(p.type)}${
                p.fallback ? ` = ${expression(p.fallback)}` : ''
              }`,
          )
          .join(', ')

        const generics = node.generics.length
          ? `<${node.generics.map(g => toPascal(g.name)).join(', ')}>`
          : ''

        const returnType = node.async
          ? `Promise<${tsType(node.result)}>`
          : tsType(node.result)

        const keyword = node.async ? 'async function' : 'function'
        // a signature-only stub (a public module whose impl arrives from the platform module in a fuller
        // closure) still typechecks: its body is the not-implemented throw, matching the native backends
        // a task whose every self call is a tail call is a loop, its tail calls rebinding the parameters (backend.ts,
        // `tailTasks`): JavaScript has no tail-call elimination, so each was a call per step
        const previousTails = tailing
        const tails = tailCalls.get(node.name)
        tailing = tails ? { params: node.params.map(p => p.name), types: node.params.map(p => tsType(p.type)), returns: tails } : undefined
        const declared = cursors.names.map(name => `${'  '.repeat(depth + 1)}const __cursor${toPascal(name)}: number[] = [0, 0]\n`).join('')
        const body =
          node.body.length === 0 && node.result && node.result.kind !== 'unit'
            ? `{\n${'  '.repeat(depth + 1)}throw new Error(${JSON.stringify(`stub: ${node.name}`)})\n${'  '.repeat(depth)}}`
            : tails
              ? `{\n${declared}${'  '.repeat(depth + 1)}while (true) ${block(node.body, depth + 1)}\n${'  '.repeat(depth)}}`
              : block(node.body, depth).replace(/^\{\n/, `{\n${declared}`)
        tailing = previousTails
        const out = `${keyword} ${toCamel(
          node.name,
        )}${generics}(${params}): ${returnType} ${body}`

        assignedNames = previous
        cursors = previousCursors
        carrierLocals = previousCarriers
        redeclared = previousRedeclared

        return out
      }

      case 'hold':
        return '// hold: verified at compile time'

      case 'mask': {
        // a trait becomes an interface of its method signatures
        const methods = node.methods
          .map(m => `  ${toCamel(m)}(...args: Array<unknown>): unknown`)
          .join('\n')

        return `interface ${toPascal(node.name)} {\n${methods}\n}`
      }

      case 'instance':
        // a trait implementation: the methods are emitted as their own functions; this records the dictionary
        return `// ${toPascal(node.target)} implements ${toPascal(
          node.mask,
        )} { ${node.methods.map(toCamel).join(', ')} }`
      case 'native':
        // a `dock load` native binding: emitted as a host import at the top of the module, not inline here
        return ''
      case 'bind':
        // a declarative native binding: no declaration is emitted; it renders inline at each call site
        return ''
      case 'view':
        // a view component: emit a builder over the render runtime (element / text / dynamic / show / each)
        return emitZone(node)
      case 'dock':
      case 'tell':
      case 'roll':
        // routing/CLI (dock) DSL is lowered elsewhere, not here
        return ''
      default:
        return exhausted(node)
    }
  }

  // a task's copy that builds its result in the record it is given, for a reuse site (`recordReuse`)
  const reusingCopy = (fn: Extract<Statement, { form: 'function' }>): string => {
    const task = reuse.tasks.get(fn.name)!
    reusing = { param: fn.params[task.param]!.name, builds: task.builds, keep: task.keep?.field, carriers: task.carriers }
    // with a kept field, the copy answers that field alone
    const text = statement({ ...fn, name: `${fn.name}-reuse`, ...(task.keep ? { result: task.keep.type } : {}) }, 0)
    reusing = undefined

    return text
  }

  // a task's body emitted with no overflow checks, for its unchecked copy
  const unchecked = (fn: Statement): string => {
    uncheckedInts = true
    const text = statement(fn, 0)
    uncheckedInts = false

    return text
  }

  return { statement, expression, unchecked, fastTasks, reusingCopy, reuseTasks }
}

// the build of a reusing task inside a returned value: the value itself, or a field of the carrier it is
function findBuild(value: Expression, builds: WeakSet<object>): Extract<Expression, { form: 'record' }> | undefined {
  if (value.form !== 'record') {
    return undefined
  }

  if (builds.has(value)) {
    return value
  }

  const field = value.fields.find(f => builds.has(f.value))

  return field ? (field.value as Extract<Expression, { form: 'record' }>) : undefined
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
  },
): string {
  // separate-compilation stubs are typing context only: their owning unit emits the real definition, and the
  // per-module import wiring reconnects references. They must never be emitted here.
  program = program.filter(s => !(s.form === 'function' && s.stub))

  // lower `hook` web routes to a `route(host, path)` dispatcher + a `boot(url, port)` that hands it to the env-
  // abstracted `host` (browser mount / node SSR server). The browser build auto-runs boot; the node build exports it
  // for `seed boot`. A no-op when there are no routes.
  program = lowerRoutes(program, options?.env ?? 'node')

  // opaque handle types declared by `dock type` shims: seed name -> concrete TS type
  tsOpaqueTypes = new Map(
    program
      .filter(
        (n): n is Extract<typeof n, { form: 'native' }> =>
          n.form === 'native' && n.kind === 'type',
      )
      .map(n => [n.alias, n.module]),
  )

  const variants = new Set<string>(options?.variants)
  tsExceptions = new Set<string>(options?.exceptions)

  tsVariantFields = new Map<
    string,
    { name: string; type: Type; optional?: boolean }[]
  >()
  tsVariantFieldsByOwner = new Map()
  tsRecordFields = new Map()
  tsFormWalkUsed = false
  tsIntUsed = false
  tsEqualUsed = false
  tsTextUsed = false
  tsListUsed = false
  tsFieldless = new Map()
  tsIdentity = options?.library ? new Set() : identityCases(program, options?.variants !== undefined)
  tsGuards = new Map()
  tsSharedForms = new Set(
    program.flatMap(n => (n.form === 'record-type' && n.shared ? [n.name] : [])),
  )
  tsTagByOwner = new Map()
  tsTagByVariant = new Map()
  tsTextByOwner = new Map()
  tsTextByVariant = new Map()

  for (const node of program) {
    if (node.form === 'record-type' && node.text) {
      tsTextByOwner.set(node.name, new Map(node.variants.map(v => [v.name, v.text ?? v.name])))

      for (const v of node.variants) {
        tsTextByVariant.set(v.name, v.text ?? v.name)
      }
    }

    if (node.form === 'record-type' && node.tag) {
      tsTagByOwner.set(node.name, node.tag)

      for (const v of node.variants) {
        tsTagByVariant.set(v.name, node.tag)
      }
    }
  }
  tsFunctionParams = new Map(
    program.flatMap(n => (n.form === 'function' ? [[n.name, n.params] as const] : [])),
  )

  for (const node of program) {
    if (node.form === 'record-type') {
      if (node.variants.length === 0) {
        tsRecordFields.set(node.name, node.fields)
      }

      const own = new Map<
        string,
        { name: string; type: Type; optional?: boolean }[]
      >()

      for (const v of node.variants) {
        variants.add(v.name)
        tsVariantFields.set(v.name, v.fields)
        own.set(v.name, v.fields)
      }

      if (own.size > 0) {
        tsVariantFieldsByOwner.set(node.name, own)
      }

      if (node.chain?.includes('exception')) {
        tsExceptions.add(node.name)
      }
    }
  }

  const env = options?.env ?? 'node'
  const binds = collectBinds(program)
  const emitter = makeEmitter(
    variants,
    options?.hmr ?? false,
    binds,
    env,
    tsProven(program),
    boundedLoops(program, lentLists(program)),
    recordPlaces(program).writes,
    recordCopies(program),
    asciiTexts(program),
    fillTasks(program),
    recordReuse(program),
    tailTasks(program),
  )

  // native module bindings (`dock load`) become host imports at the top. A `<global:X>` binding refers to a host
  // global (console, process, ...) — no import; alias it to the global (unless the alias already is the global name).
  const natives = program.filter(
    (node): node is Extract<typeof node, { form: 'native' }> =>
      node.form === 'native',
  )

  // the FFI is DYNAMIC by design (`dock` members are the host's `any`): the import is aliased through `any`,
  // so a shim call is not typechecked against the host package's own declarations
  const dockAliases = new Set<string>()
  const imports: string[] = []

  for (const node of natives.filter(
    n => n.kind !== 'type' && !n.module.startsWith('global:'),
  )) {
    // two modules in one closure may dock the same alias (`fs` in a file module and its stream module): one import
    const alias = toCamel(node.alias)

    if (dockAliases.has(alias)) {
      continue
    }

    dockAliases.add(alias)
    imports.push(
      `import * as __dock_${alias} from "${node.module}"\nconst ${alias}: any = __dock_${alias}`,
    )
  }

  const declaredGlobals = new Set<string>()

  for (const node of natives.filter(n =>
    n.module.startsWith('global:'),
  )) {
    // a global is a JS binding, so a hyphenated dock name (`global:http2-stream`) spells camel — the shim that
    // defines it must use the same spelling
    const globalName = toCamel(node.module.slice('global:'.length))

    // the runtime shim defines the global at boot (nativePrelude prepends it); the module itself DECLARES it,
    // so the emitted file is self-consistent TypeScript on its own (`declare` erases at transpile time)
    if (!declaredGlobals.has(globalName)) {
      declaredGlobals.add(globalName)
      imports.push(`declare const ${globalName}: any`)
    }

    const alias = toCamel(node.alias)

    // the alias reads the global when the module loads, so a build with no shim for it (the CLI port, which never
    // calls it) must not fail there: an absent global leaves the alias undefined, as a bare `declare` leaves it unread
    if (alias !== globalName && !dockAliases.has(alias)) {
      dockAliases.add(alias)
      imports.push(`const ${alias}: any = typeof ${globalName} === "undefined" ? undefined : ${globalName}`)
    }
  }

  // a declarative binding's env target may name imports its rendered expression needs (dedup against the natives). Only
  // binds actually called contribute, so an unused alternative does not pull in an import the program never references.
  for (const bind of referencedBinds(program, binds).values()) {
    const target =
      bindTarget(bind, env) ??
      bind.targets.find(t => t.env === 'javascript')

    for (const need of target?.imports ?? []) {
      if (need.alias) {
        const alias = toCamel(need.alias)

        if (dockAliases.has(alias)) {
          continue
        }

        dockAliases.add(alias)
        imports.push(
          `import * as __dock_${alias} from "${need.module}"\nconst ${alias}: any = __dock_${alias}`,
        )
      } else {
        const line = `import "${need.module}"`

        if (!imports.includes(line)) {
          imports.push(line)
        }
      }
    }
  }

  // dedupe top-level named declarations: a generated binding has overloaded methods that collapse to one name (three
  // `create-element` overloads -> one `documentCreateElement`), and an interface can recur across merged modules.
  // Emitting each twice is a JS redeclaration error, so keep the LAST of each (form, name): it matches the signature
  // the type checker kept (last registration wins), and a native impl loaded after the abstract signature it imports
  // (its dependency) wins over that empty signature.
  const declares = (
    node: Statement,
  ): node is Extract<
    Statement,
    { form: 'function' | 'record-type' | 'mask' }
  > =>
    node.form === 'function' ||
    node.form === 'record-type' ||
    node.form === 'mask'

  const emittable = program.filter(node => node.form !== 'native')
  const lastIndex = new Map<string, number>()
  emittable.forEach((node, i) => {
    if (declares(node)) {
      lastIndex.set(`${node.form}:${node.name}`, i)
    }
  })

  const lines = emittable
    .filter(
      (node, i) =>
        !declares(node) ||
        lastIndex.get(`${node.form}:${node.name}`) === i,
    )
    .map(node => {
      const text = emitter.statement(node, 0)
      // a `mark private` task is not exported: privacy was a check and not an emission, so TypeScript importing the
      // built module could call what no other Term file may (guides: language/modules)
      const exported =
        (node.form === 'function' && !node.private) ||
        node.form === 'record-type' ||
        node.form === 'mask'

      return exported ? `export ${text}` : text
    })
    // an ambient host global whose seed name already spells the global emits nothing; drop the blank line
    .filter(line => line.length > 0)

  // each task a guarded loop calls unchecked, once more with no overflow checks (`aValueFast`): the guard proved its
  // arguments inside the bound under which its arithmetic cannot leave the safe integers (ir/facts/bounds.ts)
  for (const name of emitter.fastTasks) {
    const fn = emittable.find((n): n is Extract<Statement, { form: 'function' }> => n.form === 'function' && n.name === name)

    if (fn) {
      lines.push(`export ${emitter.unchecked({ ...fn, name: `${name}-fast` })}`)
    }
  }

  // each task a reuse site calls, once more building its result in the object it was given (compile/place.ts)
  for (const name of emitter.reuseTasks) {
    const fn = emittable.find((n): n is Extract<Statement, { form: 'function' }> => n.form === 'function' && n.name === name)

    if (fn) {
      lines.push(`export ${emitter.reusingCopy(fn)}`)
    }
  }

  // the exception class rides in front of the first module that raises or declares one
  const prelude =
    tsExceptions.size > 0 &&
    program.some(
      n => n.form === 'record-type' && n.chain?.includes('exception'),
    )
      ? [EXCEPTION_PRELUDE]
      : []

  // the form walk rides behind the exception class in a module that lowered a `fill` or `melt` with a form, and it
  // raises `data-mismatch` through that class, so it brings the class when nothing else did. A fill with no handler
  // around it stopped with `ReferenceError: TermException is not defined` instead of the mismatch (guides:
  // language/data, 2026-10-04)
  if (tsFormWalkUsed) {
    if (!prelude.includes(EXCEPTION_PRELUDE)) {
      prelude.unshift(EXCEPTION_PRELUDE)
    }

    prelude.push(FORM_WALK_PRELUDE)
  }

  if (tsIntUsed) {
    prelude.push(intPrelude(prelude.includes(EXCEPTION_PRELUDE)))
  }

  if (tsEqualUsed) {
    prelude.push(EQUAL_PRELUDE)
  }

  if (tsTextUsed) {
    prelude.push(TEXT_PRELUDE)
  }

  if (tsListUsed) {
    prelude.push(listPrelude(prelude.includes(EXCEPTION_PRELUDE)))
  }

  // the field-less variants' constants, ahead of every use
  for (const [name, constant] of tsFieldless) {
    prelude.push(`const ${constant} = Object.freeze({ ${tagFor(name)}: ${JSON.stringify(name)} as const })`)
  }

  // the identity tests of field-less cases (`identityCases`), each a type guard so the other branch still narrows
  for (const [name, guard] of tsGuards) {
    const tag = tagFor(name)

    prelude.push(
      `function ${guard}(value: { ${tag}: string }): value is { ${tag}: ${JSON.stringify(name)} } { return value === ${tsFieldless.get(name)} }`,
    )
  }

  // the wake chain: one `hiveWake` per deck with its static entries, then the raise hook, when the program has the
  // stdlib hive and the compile driver handed over the roll. See note/term/hive/05-hive.md.
  const wake: string[] = []

  if (
    options?.wake?.length &&
    program.some(n => n.form === 'function' && n.name === 'hive-wake')
  ) {
    // an entry with a `ref` is a declared kind's constant: its `base` is the constant's live value, not a copy
    const entryText = (entry: Record<string, unknown>): string => {
      const { ref, ...rest } = entry

      if (typeof ref !== 'string') {
        return JSON.stringify(rest)
      }

      const { base: _base, ...own } = rest

      return `{ ...${JSON.stringify(own)}, base: ${toCamel(ref)} }`
    }

    const groups = options.wake
      .map(
        group =>
          `  hiveWake(${JSON.stringify(group.deck)}, [${group.entries.map(entryText).join(', ')}])`,
      )
      .join('\n')

    wake.push(
      `export function wakeHive(): void {\n${groups}\n  ;(globalThis as { __termRaise?: (e: unknown) => void }).__termRaise = (e) => {\n    const x = e as { host: string; form: string; note: string }\n    hiveTell({ host: x.host, kind: "exception", name: x.form, site: "", base: x })\n  }\n}`,
    )
  }

  const body = `${[...prelude, ...lines, ...wake].join('\n\n')}\n`

  return imports.length > 0 ? `${imports.join('\n')}\n\n${body}` : body
}
