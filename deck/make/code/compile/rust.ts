// The Rust backend: emit the language as Rust. Parity with the other backends across every AST form. The scalar +
// control-flow fragment (functions, arithmetic, if, while, recursion, reassignment via `let mut` + shadowing of
// reassigned params) compiles cleanly with rustc; algebraic data types lower to native `enum`s and structs to
// `struct`s, with `match`. Strings are `String`, numbers `i64`. Native `dock` bindings become `use` + `module::fn`
// calls. Constructs that need ownership care beyond this fragment (closures capturing the environment) emit an
// explicit SEED-UNSUPPORTED marker rather than miscompiling. Pure, browser-safe.

import type {
  Expression,
  Program,
  Statement,
  Type,
} from '@term/make/code/compile/node'
import {
  collectBinds,
  renderBind,
  bindTarget,
  bindGap,
  bindImports,
  referencedBinds,
} from '@term/make/code/compile/bind'
import {
  ARRAY_OP_BOUND,
  collectionCall,
  textAppend,
  textCursors,
  textValued,
  mapUpdate,
  fillTasks,
  fillCall,
  fixedLists,
  isText,
  emptyText,
  collectionRead,
  stringCall,
  stringRead,
  exhausted,
  reassigned,
  hasValuedReturn,
  swapAt,
  escapingParams,
  ownedLocals,
  ownedFields,
  ownedElements,
  writesTo,
  namesIn,
  rebinds,
  assignsName,
  slotTakes,
  lastReads,
  type SlotTake,
  letNames,
  gatedTasks,
  listFacts,
  borrowedRecords,
  borrowedTexts,
} from '@term/make/code/compile/backend'
import type { Lend, TextCursors } from '@term/make/code/compile/backend'
import type { CollectionOp } from '@term/make/code/compile/backend'
import { armLocals } from '@term/make/code/check/arm'
import { privateForms } from '@term/make/code/compile/place'
import { raiseSets } from '@term/make/code/check/effects'
import { provenIncrements } from '@term/make/code/ir/facts/range'
import { provenArithmetic, type Proven } from '@term/make/code/compile/proven'
import { boundedLoops, unsignedDivisions } from '@term/make/code/ir/facts/bounds'
import { asciiTexts } from '@term/make/code/ir/facts/text'
import { declaredLater, formSpec, refuseAny, specForms } from '@term/make/code/compile/backend'
import type { FormKind, FormSpec } from '@term/make/code/compile/backend'

// Rust reserved and reserved-for-future-use keywords that cannot be bare identifiers; a seed name colliding with
// one is suffixed with `_`, the same convention typescript.ts's RESERVED already uses, applied uniformly
// (definitions and uses) so a local named e.g. `continue` stays consistent across the module. `self`/`Self` are
// handled separately below (a rename, not a suffix) since `self` is meaningful in a method body.
const RUST_RESERVED = new Set([
  'as', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl',
  'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'static', 'struct', 'super', 'trait',
  'true', 'type', 'unsafe', 'use', 'where', 'while', 'async', 'await', 'abstract', 'become', 'box', 'do', 'final',
  'macro', 'override', 'priv', 'typeof', 'unsized', 'virtual', 'yield', 'try', 'gen',
])

// `self` is fine in Rust as a name only in methods; as a free identifier rename it. Names snake_case.
function vname(name: string): string {
  if (name === 'self') {
    return 'slf'
  }

  const snakeName = name.replace(/-/g, '_')

  return RUST_RESERVED.has(snakeName) ? `${snakeName}_` : snakeName
}

// a text that is a `&'static str` made owned, a literal or a module text constant (`moduleRead`): borrowed, it is the
// part before `.to_string()`
const STATIC_TEXT = /^("(?:[^"\\]|\\.)*"|MODULE_[A-Z0-9_]+)\.to_string\(\)$/

// the cursor of a text read by position in a loop (backend.ts, `textCursors`)
function cursorName(name: string): string {
  return `__cursor_${vname(name)}`
}

// outer parens around an assigned or returned value are the binary case's grouping: rustc warns on
// them there (unused_parens), so a BALANCED outer pair is stripped
function bare(rendered: string): string {
  if (!rendered.startsWith('(') || !rendered.endsWith(')')) {
    return rendered
  }

  let depth = 0

  for (let i = 0; i < rendered.length; i++) {
    if (rendered[i] === '(') {
      depth += 1
    } else if (rendered[i] === ')') {
      depth -= 1

      if (depth === 0 && i < rendered.length - 1) {
        return rendered
      }
    }
  }

  return rendered.slice(1, -1)
}

// every `format!(...)` in a text replaced by `__formatted`, its parentheses matched outside quoted text
function withoutFormats(text: string): string {
  let out = ''
  let at = 0

  for (;;) {
    const start = text.indexOf('format!(', at)

    if (start < 0) {
      return out + text.slice(at)
    }

    let depth = 0
    let quoted = false
    let end = start + 'format!'.length

    for (; end < text.length; end++) {
      const c = text[end]

      if (quoted) {
        if (c === '\\') end++
        else if (c === '"') quoted = false
        continue
      }

      if (c === '"') quoted = true
      else if (c === '(') depth++
      else if (c === ')' && --depth === 0) break
    }

    out += `${text.slice(at, start)}__formatted`
    at = end + 1
  }
}

// does a value, made a function's tail expression, hold a borrow guard (`Ref`, `MutexGuard`, a `with` closure's) in a
// temporary? Before edition 2024 a tail expression's temporaries outlive the body's locals (E0597), so such a value
// stays a `return` statement. Every block `{ a; b; c }` inside the value is asked of its own tail `c` only: a guard in
// a statement before it (a temporary, or a `let` the block owns) is dropped by the time the block ends
function borrowsAtTail(whole: string): boolean {
  // a `format!(...)` keeps no temporary past itself: it expands to a block of its own that binds its result, so a
  // borrow among its arguments is dropped inside it. Cut out, `compute`'s `return Ok(format!(.., x.borrow()[0], ..))`
  // stayed a `return` (clippy: needless_return), and the tail compiles (tmp/tail-borrow-plain.rs, 2026-10-05)
  const value = withoutFormats(whole)

  // the statement part of each block, `{` up to its last `;`, is cut out; what is left can reach the tail
  const cuts: [number, number][] = []
  const blocks: { open: number; semi: number }[] = []
  let quoted = false

  for (let i = 0; i < value.length; i++) {
    const c = value[i]!

    if (quoted) {
      if (c === '\\') {
        i++
      } else if (c === '"') {
        quoted = false
      }
    } else if (c === '"') {
      quoted = true
    } else if (c === "'" && value[i + 2] === "'") {
      // a char literal (`'"'`, `';'`), never a lifetime, which has no closing quote
      i += 2
    } else if (c === "'" && value[i + 1] === '\\' && value[i + 3] === "'") {
      i += 3
    } else if (c === '{') {
      blocks.push({ open: i, semi: -1 })
    } else if (c === '}') {
      const block = blocks.pop()

      if (block && block.semi > block.open) {
        cuts.push([block.open + 1, block.semi + 1])
      }
    } else if (c === ';' && blocks.length) {
      blocks[blocks.length - 1]!.semi = i
    }
  }

  let kept = ''
  let from = 0

  for (const [start, end] of cuts.sort((a, b) => a[0] - b[0])) {
    if (start >= from) {
      kept += value.slice(from, start)
      from = end
    }
  }

  return /\.borrow(_mut)?\(\)|\.lock\(\)|\.with\(/.test(kept + value.slice(from))
}

// a text's characters escaped for a Rust literal: JSON's `\u0000` is not Rust's `\u{0}`, so neither is JSON.stringify
const rustEscape = (text: string, quote: string): string =>
  text
    .replace(/\\/g, '\\\\')
    .replace(new RegExp(quote, 'g'), `\\${quote}`)
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, c => `\\u{${c.charCodeAt(0).toString(16)}}`)

// a Rust string literal, and a char literal for a one-character text
const rustString = (text: string): string => `"${rustEscape(text, '"')}"`
const rustChar = (text: string): string => `'${rustEscape(text, "'")}'`

// an index expression cast to `usize`, parenthesized only when it needs it. `as` binds tighter than every binary
// operator and looser than a call or a field, so `i - 1` needs them and `i64::checked_sub(a, 1).expect(..)` does not,
// and rustc's unused_parens warning (a gate fails on warnings) fires on the second
function asUsize(text: string): string {
  // an integer literal: a non-negative one IS a usize, and a negative one is typed i64 first, since rustc otherwise
  // infers the literal as the cast's target and refuses to negate a usize (E0600)
  if (/^-\d+$/.test(text)) {
    return `(${text}i64) as usize`
  }

  if (/^\d+$/.test(text)) {
    return text
  }

  let depth = 0
  let quote = false
  let bare = true

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!

    if (quote) {
      if (c === '\\') {
        i++
      } else if (c === '"') {
        quote = false
      }

      continue
    }

    if (c === '"') {
      quote = true
    } else if (c === '(' || c === '[' || c === '{') {
      depth++
    } else if (c === ')' || c === ']' || c === '}') {
      depth--
    } else if (depth === 0 && /[\s+\-*/%<>=!&|?^]/.test(c)) {
      bare = false
      break
    }
  }

  return bare && text.length > 0 ? `${text} as usize` : `(${text}) as usize`
}

function snake(name: string): string {
  const snakeName = name.replace(/-/g, '_')

  // a Term name that is a Rust keyword (`task move`, `task match`, a `move` field) escapes with a trailing
  // underscore, the same way vname does, so every identifier position agrees
  return RUST_RESERVED.has(snakeName) ? `${snakeName}_` : snakeName
}

function pascal(name: string): string {
  // strip every hyphen, including one before a digit (`sha-256` -> `Sha256`), so the result is a valid identifier
  return name.replace(/(^|-)([a-z0-9])/g, (_, _d, c: string) =>
    c.toUpperCase(),
  )
}

// a function's free inference variables become named generic parameters; this maps each variable id to its letter for
// the duration of that function's emission, so a generic signature prints `T` / `U` rather than the `i64` default.
let rustVarNames = new Map<number, string>()

// opaque per-backend handle types (`dock type / load <tokio::net::TcpStream>, name tcp-handle`): seed name -> concrete
// rust type. Populated per emit from the program's native `type` declarations, so a `like tcp-handle` field emits the
// real handle type rather than a nonexistent `TcpHandle` struct.
let rustOpaqueTypes = new Map<string, string>()

// `mark shared` forms (native-dom-0020, optimize-0042): ONE object seen and written through every binding, so a value
// of one is a `TermShared<Form>` handle (an `Rc<RefCell<Form>>` underneath, see `termShared`). Cloning the handle
// shares the object, a field read borrows it, a field write borrows it mutably, and `==` and the hash are identity, as
// on TypeScript, Swift and Kotlin, so a shared value can be a record's field and a map's key like any other
let rustSharedForms = new Set<string>()

// whether this program's maps keyed by text hold their keys as a `TermKey` (`textKeysOf`), set per pass
let rustTextKeys = false

const isSharedType = (type: Type | undefined): boolean =>
  type?.kind === 'named' && rustSharedForms.has(type.name)

// the element types E whose lists of lists own their inner lists (backend.ts, `ownedElements`), set per pass: an inner
// list of one is the plain `Vec<E>`, where every list is otherwise a shared cell
let rustOwnedInner = new Set<string>()

// how the element of a list type is held: an inner list a list of lists owns is the plain `Vec`
function rustElement(list: Extract<Type, { kind: 'array' }>): string {
  const element = list.element

  return element.kind === 'array' && rustOwnedInner.has(rustType(element.element))
    ? `Vec<${rustType(element.element)}>`
    : rustType(element)
}

function rustType(type: Type | undefined): string {
  switch (type?.kind) {
    case 'boolean':
      return 'bool'
    case 'string':
      return 'String'
    case 'unit':
    case undefined:
      return '()'
    case 'array':
      // like the map: a shared, interior-mutable handle, so a list mutated in place (`push`) through one binding is
      // seen through every binding -- the JS reference semantics the stdlib list relies on.
      return `std::rc::Rc<std::cell::RefCell<Vec<${rustElement(type)}>>>`
    case 'map':
      // a shared, interior-mutable handle, so a map mutated through one binding (a `set.insert`) is seen through every
      // binding even after the owning struct is moved. `Rc` is `Clone`, so passing a map shares it, never moving it.
      // a key nothing constrained: the free-variable default is the boxed unknown, which is neither Eq nor Hash,
      // and a key that no use ever pinned is a text one in every program here (route parameters, json objects)
      const key =
        (type.key?.kind === 'variable' && !rustVarNames.has(type.key.id)) || type.key?.kind === 'unknown' || type.key?.kind === 'dynamic'
          ? 'String'
          : rustTextKeys && isText(type.key)
            ? 'TermKey'
            : rustType(type.key)

      return `std::rc::Rc<std::cell::RefCell<TermMap<${key}, ${rustType(type.value)}>>>`

    case 'named': {
      const opaque = rustOpaqueTypes.get(type.name)

      if (opaque) {
        return opaque
      }

      // a generic form named without its arguments (`like maybe`): each parameter is the unknown, i64, the same
      // default a free inference variable gets
      const arity = rustGenericArity.get(type.name) ?? 0
      const plain =
        type.args && type.args.length > 0
          ? `${pascal(type.name)}<${type.args.map(rustType).join(', ')}>`
          : arity > 0
            ? `${pascal(type.name)}<${Array.from({ length: arity }, () => 'i64').join(', ')}>`
            : pascal(type.name)

      // a `mark shared` form is the handle, never the struct
      return rustSharedForms.has(type.name) ? `TermShared<${plain}>` : plain
    }

    case 'function': {
      // a shared trait object, not `impl Fn`: this is the one function type that works in every position -- a
      // parameter, a return, a struct field, AND a collection element. `Rc` (not `Box`) so a record holding a
      // closure is still `Clone`, the property every walk over a list of records relies on (the hive's ears).
      const params = type.params.map(rustType).join(', ')
      const result = rustType(type.result)

      // an async function value returns a boxed, pinned future (Rust has no async `Fn` sugar): the callable yields
      // `Pin<Box<dyn Future<Output = R>>>`, which the call site `.await`s. Matches the async-closure emission below.
      return type.effects?.includes('async')
        ? `std::rc::Rc<dyn Fn(${params}) -> std::pin::Pin<Box<dyn std::future::Future<Output = ${result}>>>>`
        : `std::rc::Rc<dyn Fn(${params}) -> ${result}>`
    }
    case 'number':
      return 'i64'
    case 'float':
      return 'f64'
    case 'dynamic':
      return 'serde_json::Value'
    case 'bytes':
      return 'Vec<u8>'
    case 'variable':
      // a free inference variable: its function's generic letter. One in no generic position that nothing concrete
      // ever met (only the gradual `unknown` / `dynamic`, which unify without binding) is the boxed unknown, so a
      // `make list` fed json items is a `Vec<Rc<dyn Any>>`. It was `i64`, which no value of such a list ever was
      return rustVarNames.get(type.id) ?? 'std::rc::Rc<dyn std::any::Any>'
    case 'unknown':
      // the declared dynamic (`like unknown` / `like any`): a boxed value of any 'static type, so a hive entry's
      // `base` can carry a record. Construction sites box with `Rc::new` (the unsized coercion fills in `dyn Any`).
      return 'std::rc::Rc<dyn std::any::Any>'
    default:
      return 'i64'
  }
}

// collect the inference-variable ids appearing in a type (each an implicit generic parameter of its function)
function collectVars(type: Type | undefined, into: Set<number>): void {
  switch (type?.kind) {
    case 'variable':
      into.add(type.id)
      break
    case 'array':
      collectVars(type.element, into)
      break
    case 'map':
      collectVars(type.key, into)
      collectVars(type.value, into)
      break
    case 'function':
      type.params.forEach(p => collectVars(p, into))
      collectVars(type.result, into)
      break
    case 'named':
      type.args?.forEach(a => collectVars(a, into))
      break
    default:
      break
  }
}

const OP: Record<string, string> = {
  '&&': '&&',
  '||': '||',
  '==': '==',
  '!=': '!=',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
  '+': '+',
  '-': '-',
  '*': '*',
  '/': '/',
  '%': '%',
}

// how many type parameters each generic form declares, for a reference that names the form without them
let rustGenericArity = new Map<string, number>()

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
export function emitRust(program: Program, options?: { wake?: WakeGroup[] }): string {
  const record: CloneRecord = { forms: new Set(), generic: false }
  const first = emitRustPass(program, options, new Set(), record)

  if (record.generic) {
    return first
  }

  const boxed = boxableForms(program, record.forms)

  return boxed.size ? emitRustPass(program, options, boxed, { forms: new Set(), generic: false }) : first
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
  const records = new Map(program.flatMap(n => (n.form === 'record-type' ? [[n.name, n] as const] : [])))
  const held = new Set(cloned)
  const work = [...cloned]
  const namesIn = (t: Type | undefined, into: string[]): void => {
    if (!t) {
      return
    }

    if (t.kind === 'named') {
      into.push(t.name)
      t.args?.forEach(a => namesIn(a, into))
    } else if (t.kind === 'array') {
      namesIn(t.element, into)
    } else if (t.kind === 'map') {
      namesIn(t.key, into)
      namesIn(t.value, into)
    } else if (t.kind === 'function') {
      t.params.forEach(p => namesIn(p, into))
      namesIn(t.result, into)
    }
  }

  while (work.length) {
    const record = records.get(work.pop()!)

    if (!record) {
      continue
    }

    const inner: string[] = []
    record.fields.forEach(f => namesIn(f.type, inner))
    record.variants.forEach(v => v.fields.forEach(f => namesIn(f.type, inner)))

    for (const name of inner) {
      if (!held.has(name)) {
        held.add(name)
        work.push(name)
      }
    }
  }

  return new Set(
    [...records.values()]
      .filter(
        r =>
          !r.shared &&
          (r.params?.length ?? 0) === 0 &&
          r.variants.some(v => v.fields.some(f => f.type.kind === 'named' && f.type.name === r.name)) &&
          !held.has(r.name),
      )
      .map(r => r.name),
  )
}

// TEXT KEYS THAT DO NOT ALLOCATE. A map keyed by text holds each key as a `String`, an allocation per new key: all of
// k-nucleotide's gap, a k-mer per position (86 ms against the hand version's 71, `tmp/rust-knuc-key-ab.ts`). A
// `TermKey` holds up to 22 bytes in place and hashes and compares as the `str` it holds (74 ms). A program's text-keyed
// maps take it only where no key can be seen as a value again, since a `TermKey` is not a `String`: no map of them
// walked or answered by a task whose result or callback mentions its key type, none handed where a map is not
// declared, none in a field of unknown type, and none built or read by a runtime shim, six of which build
// `TermMap<String, ...>` themselves. A key read out by `keys` is made a `String` there. Lookups take the borrowed `str`,
// which serves a `String` key as well (`TermMap`'s `Borrow` lookups)
const KEY_SHIMS = /\b(http2?|server|shape|env-variable)\b/

function textKeysOf(program: Program): boolean {
  return textKeyReason(program) === undefined
}

// why a program's text-keyed maps keep `String` keys, or undefined when they take `TermKey`s (a test reads it)
export function textKeyReason(program: Program): string | undefined {
  type Loose = Record<string, unknown> & { form?: string; type?: Type }
  const textMap = (t: Type | undefined): boolean => t?.kind === 'map' && isText(t.key)
  const fns = new Map(program.flatMap(n => (n.form === 'function' ? [[n.name, n] as const] : [])))
  const fields = new Map(program.flatMap(n => (n.form === 'record-type' ? [[n.name, new Map([...n.fields, ...n.variants.flatMap(v => v.fields)].map(f => [f.name, f.type]))] as const] : [])))
  const variantOwner = new Map(program.flatMap(n => (n.form === 'record-type' ? n.variants.map(v => [v.name, n.name] as const) : [])))
  // whether a type mentions a generic, by its name or its variable, other than as a map's key: a map of the keys
  // answered or handed on still holds them as `TermKey`s (`hash_set` answers its map)
  const same = (t: Type, key: Type): boolean =>
    (key.kind === 'named' && t.kind === 'named' && t.name === key.name) || (key.kind === 'variable' && t.kind === 'variable' && t.id === key.id)
  const mentions = (t: Type | undefined, key: Type): boolean => {
    if (!t) return false
    if (same(t, key)) return true
    if (t.kind === 'array') return mentions(t.element, key)
    if (t.kind === 'map') return (!same(t.key, key) && mentions(t.key, key)) || mentions(t.value, key)
    if (t.kind === 'function') return t.params.some(p => mentions(p, key)) || mentions(t.result, key)
    if (t.kind === 'named') return (t.args ?? []).some(a => mentions(a, key))

    return false
  }
  let any = false
  let leak: string | undefined

  const visit = (value: unknown): void => {
    if (leak || typeof value !== 'object' || value === null) return
    if (Array.isArray(value)) return value.forEach(visit)
    const node = value as Loose

    if (textMap(node.type)) any = true
    if (node.form === 'native' && KEY_SHIMS.test(String(node.module ?? ''))) leak = `the runtime shim ${String(node.module)}`
    if (node.form === 'for-each' && textMap((node.iterable as Loose | undefined)?.type)) leak = 'a walk over a map'

    if (node.form === 'call') {
      const callee = node.callee as Loose
      const def = callee.form === 'variable' ? fns.get(callee.name as string) : undefined
      const name = callee.form === 'variable' ? (callee.name as string) : callee.form === 'member' ? (callee.name as string) : ''

      // `call fill / ... / like <form>` reaches the backends as `fill-form` (and `melt-form`), the run-time task as `fill`
      if (['fill', 'melt', 'fill-form', 'melt-form'].includes(name)) leak = `a call to ${name}`
      ;(node.args as Loose[]).forEach((arg, i) => {
        if (!textMap(arg.type)) return
        const param = def?.params[i]?.type

        // a map handed to a task that is not the program's own, or where no map is declared
        if (!def || param?.kind !== 'map') {
          leak ??= `a map handed to ${name || 'a value'}, argument ${i + 1}`

          return
        }

        // a generic key: no result and no callback of the task may mention it
        const key = param.key

        if ((key.kind === 'named' || key.kind === 'variable') && (mentions(def.result, key) || def.params.some(p => p.type?.kind === 'function' && mentions(p.type, key)))) {
          leak ??= `${name} answers or calls back with a key`
        }
      })
    }

    // a field of unknown type holding one
    if (node.form === 'record' && Array.isArray(node.fields)) {
      const owner = variantOwner.get(node.name as string) ?? (node.name as string)

      for (const f of node.fields as { name: string; value: Loose }[]) {
        const declared = fields.get(owner)?.get(f.name)

        if (textMap(f.value.type) && (declared?.kind === 'unknown' || declared?.kind === 'dynamic')) leak = `a map in the field ${f.name} of unknown type`
      }
    }

    for (const [key, child] of Object.entries(node)) if (key !== 'type' && key !== 'span') visit(child)
  }

  visit(program)

  return leak ?? (any ? undefined : 'no map keyed by text')
}

function emitRustPass(
  program: Program,
  options: { wake?: WakeGroup[] } | undefined,
  // the recursive forms whose children this pass holds in a `Box` (boxableForms)
  boxedForms: Set<string>,
  // what this pass clones, filled as it emits
  cloneRecord: CloneRecord,
): string {
  const pad = (d: number) => '    '.repeat(d)
  // the TermException carrier is emitted when a raise, a guard or a raising signature is written, recorded there
  // rather than found by searching the emitted text for its name
  let carries = false
  // the reusable forms whose boxes some arm opened, and those some construction built (`reusable`)
  const reuseOpened = new Set<string>()
  const reuseBuilt = new Set<string>()
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
  let fastCalls = new Set<object>()
  const fastTasks = new Set<string>()
  let uncheckedInts = false
  // when the stdlib hive is in the program, every new raise tells it (the throw lowering), and the compiler can
  // emit the wake chain (`wake_hive`) from the roll the driver hands over
  const hasHiveTell = program.some(
    n => n.form === 'function' && n.name === 'hive-tell',
  )
  rustGenericArity = new Map(
    program
      .filter((n): n is Extract<Statement, { form: 'record-type' }> => n.form === 'record-type')
      .map(n => [n.name, n.params?.length ?? 0]),
  )
  rustSharedForms = new Set(
    program.flatMap(n => (n.form === 'record-type' && n.shared && n.variants.length === 0 ? [n.name] : [])),
  )
  // decided below, once the list facts are known (`elementLists`)
  rustOwnedInner = new Set()
  rustTextKeys = textKeysOf(program)
  // per generic task, each parameter that is the key type of a map parameter, and that map's position: a text argument
  // there beside a map of `TermKey`s is made one (`rustTextKeys`). The stdlib's `get`, `get-or-default`, `has`, `set`
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
  rustOpaqueTypes = new Map(
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
  // what holds a form's payload: a `Box` for a form nothing clones, an `Rc` for one the program shares
  const payloadHolder = (owner: string): string => (boxedForms.has(owner) ? 'Box' : 'std::rc::Rc')
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

  // a named type rendered inside a trait declaration: the receiver type becomes `Self`
  const subSelf = (
    t: Type | undefined,
    target: string,
  ): Type | undefined => {
    if (!t) {
      return t
    }

    if (t.kind === 'named') {
      return t.name === target
        ? { kind: 'named', name: 'Self' }
        : t.args
          ? { ...t, args: t.args.map(a => subSelf(a, target)!) }
          : t
    }

    if (t.kind === 'array') {
      return { kind: 'array', element: subSelf(t.element, target)! }
    }

    if (t.kind === 'map') {
      return {
        kind: 'map',
        key: subSelf(t.key, target)!,
        value: subSelf(t.value, target)!,
      }
    }

    if (t.kind === 'function') {
      return {
        kind: 'function',
        params: t.params.map(p => subSelf(p, target)!),
        result: subSelf(t.result, target)!,
        effects: t.effects,
      }
    }

    return t
  }

  // a trait method declaration (no body): `fn measure(self) -> i64;`, derived from an implementation's signature with
  // the receiver as `self` and the receiver type as `Self`
  const traitMethodDecl = (
    fn: Fn | undefined,
    target: string,
  ): string => {
    if (!fn) {
      return ''
    }

    const rest = fn.params
      .slice(1)
      .map(
        p => `${snake(p.name)}: ${rustType(subSelf(p.type, target))}`,
      )

    const ret = fn.result
      ? ` -> ${rustType(subSelf(fn.result, target))}`
      : ''

    return `fn ${snake(fn.method!.name)}(${['self', ...rest].join(
      ', ',
    )})${ret};`
  }

  // an `impl` method that delegates to the free implementation function: `fn measure(self) -> i64 { box_measure(self) }`
  const implMethod = (fn: Fn | undefined, target: string): string => {
    if (!fn) {
      return ''
    }

    const restNames = fn.params.slice(1).map(p => snake(p.name))
    const rest = fn.params
      .slice(1)
      .map(
        p => `${snake(p.name)}: ${rustType(subSelf(p.type, target))}`,
      )

    const ret = fn.result
      ? ` -> ${rustType(subSelf(fn.result, target))}`
      : ''

    const callArgs = ['self', ...restNames].join(', ')

    return `fn ${snake(fn.method!.name)}(${['self', ...rest].join(
      ', ',
    )})${ret} { return ${snake(fn.name)}(${callArgs}); }`
  }

  // within a match arm, which subject variable is narrowed to which variant (so `subject/field` reads the bound local)
  const narrowing = new Map<string, string>()

  // true while emitting the body of a function whose return type is a list: a native dock call returned directly (the
  // shim hands back a plain `Vec`) is wrapped in the seed list's Rc<RefCell> handle to match the declared return type
  let fnReturnsArray = false
  // THE RESULT LOWERING (note/term/hive/11-native-exceptions.md, "Way 2"). A task whose raise set is not empty returns
  // `Result<T, TermException>`; `halt <form>` is `return Err(..)`; a call to a raising task is `call()?` inside a
  // raising task or a guarded body, and `.unwrap_or_else(exit 1 with form and note)` elsewhere, so a raise nothing
  // handles ends the program the way it does on every backend. A guard body is a closure returning
  // `Result<Option<T>, TermException>`: `Ok(Some(v))` is a `send back` inside it, `Ok(None)` falls through, and
  // `Err(e)` runs the handler with `e` bound.
  const raising = new Set<string>()
  let currentRaising = false
  // the parameters of the function being emitted: a call to one is that parameter, never the raising task of its name
  let currentParams = new Set<string>()
  let currentResult: Type | undefined
  // the result a call site's parameter declares for the closure argument being rendered (see the call case)
  let closureHint: Type | undefined
  // how many closures the statement being rendered sits inside: a closure is an `Fn`, run any number of times, so a
  // captured value it returns is cloned rather than moved out (`return root` in a `mount` callback)
  let closureDepth = 0
  // whether the function or closure body being emitted is asynchronous, so a guard inside it can `.await`
  let currentAsync = false
  let guardDepth = 0
  // the raising calls an `await` wraps, so each one's `?` lands after `.await` and not before it
  const awaitedCalls = new WeakSet<object>()
  // the names a guard's handler binds to the caught exception, while that handler's body is emitted
  const caughtNames = new Set<string>()

  // PREEMPTION BY BUDGET (note/term/research/beam-otp-lessons.md, design 5). BEAM switches a process out after 4,000
  // reductions, paying a check on every call. Here a loop in an ASYNCHRONOUS task checks a per-thread budget at the top
  // of each turn and yields to the scheduler when it runs out, so one task's long loop cannot starve the others on the
  // same runtime. A synchronous task cannot yield in Rust at all, which is the same limit TypeScript has. The check is
  // left out of a loop whose condition bounds its counter by a small literal (`i < K`, K at most the budget), the
  // shape of a counted loop over a fixed table, which BEAM still pays for on every turn. It is a reading of the
  // condition, not a proof: a counter that starts far below zero runs longer, and then only fairness suffers, never
  // correctness. Using the walk's proven `down` measure instead is the precise version, and is left open
  let budgetUses = 0
  let budgetElided = 0
  const BUDGET = 4000
  const budgetCheck = (node: Statement, depth: number): string => {
    if (!currentAsync || (node.form !== 'while' && node.form !== 'for-each')) {
      return ''
    }

    if (node.form === 'while' && constantBounded(node.cond, BUDGET)) {
      budgetElided++

      return ''
    }

    budgetUses++

    return `${pad(depth)}__term_budget().await;\n`
  }

  const raiseSuffix = (): string =>
    currentRaising || guardDepth > 0
      ? '?'
      : '.unwrap_or_else(|e| { eprintln!("{}", e); std::process::exit(1) })'

  // MOVE ON LAST USE (the Perceus / linearity insight, realized in Rust). The owned-value style clones every variable
  // argument so a later use is never moved away. But a variable read EXACTLY ONCE in the whole function -- and not
  // inside a loop or a nested closure (where the single read re-executes) -- can be MOVED at that use instead of cloned:
  // there is no later use to invalidate, so the Rust borrow checker always accepts it. This eliminates the clone (a deep
  // copy for `String`, a refcount bump for an `Rc` collection) in the common single-use case. It is conservative: when
  // in any doubt the value is still cloned, so the output always compiles. Recomputed per function body.
  let moveArgs = new Set<string>()
  // the reads that are their name's last (`lastReads`), which move when `lastMove` finds the name held by value
  let moveNodes = new WeakSet<object>()
  // the reads that are the last of several of their name inside one statement (`lastReads`' `many`), and how each name
  // has been written so far in the statement being emitted: a marked read moves only when every earlier one was
  // written as a `.clone()`, since Rust evaluates left to right and an earlier borrow would still be alive (E0505)
  let manyMoves = new WeakSet<object>()
  let statementUses = new Map<string, { clone: number; other: number }>()
  // the locals that are a list slot until their last read, and those last reads, which take the slot (`slotTakes`)
  let slotLets = new WeakMap<object, SlotTake & { kept: boolean }>()
  let slotReads = new WeakMap<object, SlotTake>()
  // the field-less case of a form, the placeholder a take leaves in a slot
  const emptyCase = (type: Type | undefined): { form: string; empty: string } | undefined => {
    const form = type?.kind === 'named' ? program.find(n => n.form === 'record-type' && n.name === type.name) : undefined
    const empty = form?.form === 'record-type' ? form.variants.find(v => v.fields.length === 0) : undefined

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

  // MUTABLE CAPTURES. A closure is a `Box<dyn Fn>`, which cannot mutate captured state, so a variable ASSIGNED inside
  // a closure body is boxed in `Rc<RefCell<T>>` instead: the declaration wraps the value, every read borrows and
  // clones, every assignment writes through `borrow_mut`, and each capturing closure clones the handle before the
  // `move` (so the original stays usable after the closure is built). This is the same interior-mutability currency
  // the collections already use, applied to a scalar/struct local. Recomputed per function body.
  let cellVars = new Set<string>()
  // F1: the list parameters of the function being emitted that arrive lent, a `&mut [T]` or a `&[T]`
  // (`lendableParams`): their slots, length and walk are written on the Vec itself, with no `borrow()`
  let lentNames = new Map<string, Lend>()
  // F1: the list locals the function being emitted owns outright, plain `Vec<T>`s (`ownedLocals`), each with whether
  // anything writes it. They are in `lentNames` too, as 'write', since their slots and walks are written the same way
  let ownedNames = new Map<string, boolean>()
  // F1 for records: the names in scope that are a REFERENCE to a record (`&R`, or `&Rc<R>` for an arm's recursive
  // field): the borrowed parameters of the function being emitted, and the record fields a borrowed match binds
  let borrowedNames = new Set<string>()
  // the texts this task reads through a cursor (backend.ts, `textCursors`)
  let cursors: TextCursors = { names: [], reads: new Map() }
  // the text locals of this task that are only ever a map key and are made from an ASCII substring: held as a `&str`
  // into the text, where each was a String made per key (`sliceKeys`). `borrowSlice` is set while one's init renders
  let sliceLets = new WeakSet<Statement>()
  // the matches nested in tail position in the task being emitted, whose arms answer their values (function case)
  let tailMatches = new WeakSet<object>()
  let sliceNames = new Set<string>()
  let borrowSlice = false
  // set while the init of an owned local is emitted: a call to a fresh task there takes its `Vec` as it is, where
  // every other call to one wraps it into the shared cell
  let rawFresh = false
  // whether the function being emitted answers a fresh list (`freshLists`), so a `send back` of an owned local is the
  // `Vec` itself
  let emittingFresh = false
  // a list's contents for reading or writing: the lent Vec itself, or a borrow of the shared cell
  // set while a path written through renders (`ps[k].xs[i] = v`): a list slot in the middle of it is borrowed mutably
  let writingPath = false
  const view = (target: Expression, write: boolean): string => {
    if (target.form === 'variable' && lentNames.has(target.name)) {
      return vname(target.name)
    }

    if (ownedPath(target)) {
      const outer = writingPath
      writingPath = write
      const path = memberPath(target)
      writingPath = outer

      return path
    }

    return `${expr(target)}.${write ? 'borrow_mut' : 'borrow'}()`
  }
  // a path `r/field` to a plain record's list field that the record owns (`ownedFields`): the `Vec` itself, only read
  const ownedPath = (target: Expression): boolean =>
    target.form === 'member' &&
    target.index === undefined &&
    target.target.type?.kind === 'named' &&
    fieldLists.has(`${target.target.type.name}/${target.name}`)
  // the names the CURRENT function or closure body actually reassigns. A `let` only needs `mut` when something
  // later assigns to it: a list or map local is an `Rc<RefCell<...>>`, so `push` and `insert` mutate through the
  // cell and never touch the binding. Declaring every local `let mut` made rustc's unused_mut fire on all of
  // them, and a strict build treats that as fatal.
  let assignedVars = new Set<string>()

  const mutOf = (name: string): string => (assignedVars.has(name) ? 'mut ' : '')

  // the forms a `fill` / `melt` with a form walks, gathered while the bodies are emitted; their walkers ride at the
  // end of the module
  const fillSpecs = new Map<string, FormSpec>()
  const meltSpecs = new Map<string, FormSpec>()

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
  const shimCall = (value: Expression): boolean => {
    const call = value.form === 'await' ? value.expr : value

    return (
      call.form === 'call' &&
      ((call.callee.form === 'variable' && !nativeAliases.has(call.callee.name)) ||
        (call.callee.form === 'member' &&
          call.callee.target.form === 'variable' &&
          nativeAliases.has(call.callee.target.name)))
    )
  }

  for (const [name, raises] of raiseSets(program, exceptionForms).raises) {
    if (raises.size > 0) {
      raising.add(name)
    }
  }

  // a field value that is a variable or a member read is cloned into the struct, the way an argument is, so the
  // binding it came from stays usable (a closure is not Clone and passes as is)
  // A `number`, `float` or `boolean` is `Copy` (i64, f64, bool), so it is read as it is: `.clone()` on one is noise
  // that clippy flags. A rendering that already ends in a clone (a list element read) is not cloned twice: both
  // emitted `perm.borrow()[i].clone().clone()` and `n.clone()` until 2026-10-02
  const copyType = (type: Type | undefined): boolean => type?.kind === 'number' || type?.kind === 'float' || type?.kind === 'boolean'
  // item 0029: every clone this pass writes, by the Term type it clones, so `emitRust` can tell which recursive forms
  // are never cloned and may hold their children in a `Box`. A clone whose type is not known, or is generic, sets
  // `generic`, since it could be cloning any form
  const noteClone = (type: Type | undefined): void => {
    if (!type || type.kind === 'unknown' || type.kind === 'dynamic' || type.kind === 'variable') {
      cloneRecord.generic = true

      return
    }

    const visit = (t: Type | undefined): void => {
      if (!t) {
        return
      }

      switch (t.kind) {
        case 'named':
          // a generic letter (`like t`) is a type variable spelled by name
          if (/^[a-z]$/.test(t.name) && !recordFields.has(t.name)) {
            cloneRecord.generic = true
          }

          cloneRecord.forms.add(t.name)
          t.args?.forEach(visit)
          break
        // a list or map is an `Rc` handle here: cloning one copies a pointer, never the elements, so it clones no form.
        // A site that copies a list's CONTENTS reports the element type itself
        case 'array':
        case 'map':
        case 'function':
          break
        case 'variable':
        case 'unknown':
        case 'dynamic':
          cloneRecord.generic = true
          break
        default:
          break
      }
    }

    visit(type)
  }
  // the element type of a list type, for a site that copies the list's contents
  const elementOf = (type: Type | undefined): Type | undefined => (type?.kind === 'array' ? type.element : undefined)
  // whether every mention of `name` in a body is an argument at a position its task takes borrowed (`borrowParams`) or
  // the target of a field read, outside any closure: then a reference serves for the value
  const onlyBorrowed = (body: Statement[], name: string): boolean => {
    if (rebinds(body).has(name)) {
      return false
    }

    let fine = true
    type Loose = Record<string, unknown> & { form?: string; name?: string }
    const mine = (node: Loose | undefined): boolean => node?.form === 'variable' && node.name === name

    const visit = (value: unknown): void => {
      if (!fine || typeof value !== 'object' || value === null) {
        return
      }

      if (Array.isArray(value)) {
        value.forEach(visit)

        return
      }

      const node = value as Loose

      if (node.form === 'closure') {
        if (namesIn(node.body).has(name)) {
          fine = false
        }

        return
      }

      if (mine(node)) {
        fine = false

        return
      }

      if (node.form === 'member' && !node.index && mine(node.target as Loose)) {
        return
      }

      if (node.form === 'call' && (node.callee as Loose).form === 'variable') {
        const borrowed = borrowParams.get((node.callee as Loose).name as string)
        const args = node.args as Loose[]

        args.forEach((a, i) => {
          if (!(mine(a) && borrowed?.has(i))) {
            visit(a)
          }
        })

        return
      }

      for (const [key, child] of Object.entries(node)) {
        if (key !== 'type' && key !== 'span') {
          visit(child)
        }
      }
    }

    visit(body)

    return fine
  }
  // a read `lastReads` found to be its name's last, of a record or variant held BY VALUE here: not a cell, a borrowed
  // reference, a lent or owned list, a text slice or a shared handle, and not inside a closure
  const lastMove = (value: Expression): boolean =>
    value.form === 'variable' &&
    closureDepth === 0 &&
    moveNodes.has(value) &&
    value.type?.kind === 'named' &&
    !copyType(value.type) &&
    !isSharedType(value.type) &&
    !cellVars.has(value.name) &&
    !borrowedNames.has(value.name) &&
    !lentNames.has(value.name) &&
    !ownedNames.has(value.name) &&
    !sliceNames.has(value.name)
  // a list given to a field that owns it (`ownedFields`), as the plain `Vec`: an owned local moves in, a fresh task's
  // answer is taken as it is, an empty list is a new one
  const plainList = (value: Expression): string => {
    if (value.form === 'variable' && ownedNames.has(value.name)) {
      return vname(value.name)
    }

    if (value.form === 'call') {
      rawFresh = true
      const made = expr(value)
      rawFresh = false

      return made
    }

    return 'Vec::new()'
  }
  // the last of several reads of its name in this statement (`manyMoves`), every earlier one written as a clone, of a
  // value held by value here: asked BEFORE the read is written, which counts as a use of its own
  const lastOfManyMove = (value: Expression): boolean => {
    const prior = value.form === 'variable' ? statementUses.get(value.name) : undefined

    return (
      value.form === 'variable' &&
      manyMoves.has(value) &&
      prior !== undefined &&
      prior.other === 0 &&
      prior.clone > 0 &&
      closureDepth === 0 &&
      value.type?.kind === 'named' &&
      !copyType(value.type) &&
      !isSharedType(value.type) &&
      !cellVars.has(value.name) &&
      !borrowedNames.has(value.name) &&
      !lentNames.has(value.name) &&
      !ownedNames.has(value.name) &&
      !sliceNames.has(value.name)
    )
  }
  // a read just written as a `.clone()`: counted as a clone, not as some other use of its name
  const countClone = (value: Expression): void => {
    const uses = value.form === 'variable' ? statementUses.get(value.name) : undefined

    if (uses) {
      uses.other--
      uses.clone++
    }
  }
  const owned = (value: Expression): string => {
    const lastOfMany = lastOfManyMove(value)
    const rendered = expr(value)
    // MOVE ON LAST USE, as a call argument does: a variable read exactly once in the function, and not in a loop or a
    // closure (`moveArgs`), moves into the structure. Building `node(head, into)` cloned `into` at its only read
    // a FIELD of function type is held as `Rc<dyn Fn>` and clones like any `Rc`: building `make gap / bind spec,
    // gap/spec` in a loop moved the field out of `gap` on the first turn, E0382 (the repair-loop port, 2026-10-04). A
    // function-typed VARIABLE is an `impl Fn` parameter or a closure, and is passed as it stands
    const clones =
      (value.form === 'variable' || value.form === 'member') &&
      value.type &&
      (value.type.kind !== 'function' || value.form === 'member') &&
      !copyType(value.type) &&
      !rendered.endsWith('.clone()') &&
      !(value.form === 'variable' && cellVars.has(value.name)) &&
      !(value.form === 'variable' && moveArgs.has(value.name) && closureDepth === 0) &&
      !lastMove(value) &&
      !lastOfMany &&
      !slotReads.has(value) &&
      !ownsInner(elementLists.items, value)

    if (clones) {
      noteClone(value.type)
      countClone(value)
    }

    return clones ? `${rendered}.clone()` : rendered
  }

  // a value flowing into an `unknown` slot boxes (`std::rc::Rc::new`; the unsized coercion supplies `dyn Any` from
  // the slot's declared type). Only a read or a call whose own type is unknown is already the boxed dynamic; a
  // literal the checker typed unknown by expectation (a `code 0` bound into an unknown field) still needs the box,
  // and a bare integer pins to i64 so a later downcast sees the seed number type
  const boxUnknown = (
    into: Type | undefined,
    value: Expression,
    rendered: string,
  ): string => {
    if (into?.kind !== 'unknown') {
      return rendered
    }

    const alreadyBoxed =
      (value.form === 'variable' ||
        value.form === 'member' ||
        value.form === 'call' ||
        value.form === 'await') &&
      value.type?.kind === 'unknown'

    if (alreadyBoxed) {
      return rendered
    }

    return value.form === 'integer'
      ? `std::rc::Rc::new((${rendered}) as i64)`
      : `std::rc::Rc::new(${rendered})`
  }

  // the asynchronous tasks, for boxing one read as a value into the pinned-future closure a task slot holds
  const asyncFunctions = new Set<string>(
    program
      .filter((n): n is Extract<Statement, { form: 'function' }> => n.form === 'function' && Boolean(n.async))
      .map(n => n.name),
  )

  // whether a call starts an asynchronous task: a task marked async, or a task value whose type says so
  const isAsyncCall = (call: Extract<Expression, { form: 'call' }>): boolean =>
    (call.callee.form === 'variable' && asyncFunctions.has(call.callee.name)) ||
    (call.callee.type?.kind === 'function' && Boolean(call.callee.type.effects?.includes('async')))
  // how many fire-and-forget calls were queued, so the executor is emitted only for a program that has one
  let spawnUses = 0

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
  rustOwnedInner = elementLists.keys
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
  let stackNames = new Set<string>()
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

  // the `impl Fn` spelling of a function type, for a parameter in `implFnParams`
  const implFnType = (type: Extract<Type, { kind: 'function' }>): string => {
    const result = rustType(type.result)

    return `impl Fn(${type.params.map(rustType).join(', ')})${result === '()' ? '' : ` -> ${result}`}`
  }

  // an argument passed to an `impl Fn` parameter: a closure literal without its `Rc`, anything else borrowed as `&dyn Fn`
  const implFnArg = (arg: Expression, rendered: string): string => {
    const wrap = 'std::rc::Rc::new(move |'
    const at = rendered.indexOf(wrap)

    if (arg.form === 'closure' && at >= 0) {
      const tail = rendered.endsWith(') }') ? ' }' : rendered.endsWith(')') ? '' : undefined

      if (tail !== undefined) {
        return `${rendered.slice(0, at)}${rendered.slice(at + 'std::rc::Rc::new('.length, rendered.length - tail.length - 1)}${tail}`
      }
    }

    return /^[\w:.]+$/.test(rendered) ? `&*${rendered}` : `&*(${rendered})`
  }

  // an empty list or map binding spells its checked type, so rust does not have to infer it from later use
  const emptyAnn = (init: Expression): string => {
    const empty =
      (init.form === 'array' && init.items.length === 0) ||
      (init.form === 'map' && init.entries.length === 0) ||
      (init.form === 'record' && (init.name === 'list' || init.name === 'hash') && init.fields.length === 0)
    const known = init.type && init.type.kind !== 'variable' && init.type.kind !== 'unknown'
    // an empty list literal renders its element already (`Vec::<T>::new()`), so the binding needs no type spelled a
    // second time, which for a shared list of lists clippy reads as too complex (type_complexity)
    const spelled = init.form === 'array' && init.type?.kind === 'array'

    return empty && known && !spelled ? `: ${rustType(init.type)}` : ''
  }

  // the empty value of a type: what a left-out field or argument holds

  // a condition in a `while` / `if` head drops its self-parenthesization, since rustc warns on `while (a > b)`
  // (unused_parens) and a strict build makes the warning fatal. This used to apply only to a BINARY comparison,
  // which left every other self-parenthesizing form to trip the warning: a negated comparison renders `(!(a ==
  // b))` and failed the pdf package's Rust build the moment one was written as an `if` head. The paren-depth
  // scan below is what makes the strip safe, so it does not need the form to be anything in particular.
  const condExpr = (cond: Expression): string => {
    const rendered = expr(cond)

    if (!rendered.startsWith('(') || !rendered.endsWith(')')) {
      return rendered
    }

    // strip the pair only when the FIRST paren really closes at the last character. Parens INSIDE a string
    // literal do not count: `(char == ")".to_string())` closes at the `)` within the string otherwise, the scan
    // gives up, and rustc's unused_parens then fails a strict build on a condition that compares against a
    // bracket character — which is most of a PDF or JSON reader.
    let depth = 0
    let inString = false

    for (let i = 0; i < rendered.length; i++) {
      const c = rendered[i]

      if (inString) {
        if (c === '\\') {
          i++
        } else if (c === '"') {
          inString = false
        }

        continue
      }

      if (c === '"') {
        inString = true
      } else if (c === '(') {
        depth++
      } else if (c === ')') {
        depth--

        if (depth === 0 && i < rendered.length - 1) {
          return rendered
        }
      }
    }

    return rendered.slice(1, -1)
  }

  const emptyOf = (type: Type | undefined): string => {
    switch (type?.kind) {
      case 'string':
        return 'String::new()'
      case 'boolean':
        return 'false'
      case 'float':
        return '0.0'
      case 'bytes':
        return 'Vec::new()'
      case 'array':
        return 'std::rc::Rc::new(std::cell::RefCell::new(Vec::new()))'
      case 'map':
        return 'std::rc::Rc::new(std::cell::RefCell::new(TermMap::new()))'
      case 'named':
        if (type.name === 'text') {
          return 'String::new()'
        }

        if (type.name === 'boolean') {
          return 'false'
        }

        if (type.name === 'maybe') {
          return 'Maybe::None'
        }

        if (type.name === 'list') {
          return 'std::rc::Rc::new(std::cell::RefCell::new(Vec::new()))'
        }

        if (type.name === 'hash') {
          return 'std::rc::Rc::new(std::cell::RefCell::new(TermMap::new()))'
        }

        return '0'
      case 'unknown':
        // an unknown field left out of a construction: a boxed unit (the slot carries anything)
        return 'std::rc::Rc::new(())'
      default:
        return '0'
    }
  }

  // module-level bindings (`host hex-alpha, text <...>` at the top of a module): rust has no top-level `let`, so
  // each becomes a `thread_local!` static and every read clones the value out. A function parameter or local of
  // the same name shadows it, tracked in `localNames` while a function body is emitted.
  const moduleConsts = new Set<string>(
    program.filter((n): n is Extract<Statement, { form: 'let' }> => n.form === 'let').map(n => n.name),
  )
  const localNames = new Set<string>()
  const moduleConstName = (name: string): string => `MODULE_${snake(name).toUpperCase()}`

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

  // a valueless typed module SLOT (`host current, like context`, filled later by a `save`): rust has no
  // lateinit, so the static is a RefCell<Option<T>>; reads unwrap, writes fill (see the variable and assign
  // cases)
  const moduleSlots = new Set<string>(
    program
      .filter(
        (n): n is Extract<Statement, { form: 'let' }> =>
          n.form === 'let' &&
          n.init.form === 'unit' &&
          n.type !== undefined &&
          n.type.kind === 'named',
      )
      .map(n => n.name),
  )

  // a module binding to a number, float or boolean LITERAL that nothing assigns is a Rust `const`: read by name, with no
  // thread-local lookup and no clone, and folded by rustc wherever it is used (note/term/codegen/rust.md, R7)
  const assignedNames = new Set<string>()
  const findAssigned = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(findAssigned)

      return
    }

    const node = value as { form?: string; target?: { form?: string; name?: string } }

    if (node.form === 'assign' && node.target?.form === 'variable' && node.target.name) {
      assignedNames.add(node.target.name)
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        findAssigned(child)
      }
    }
  }
  findAssigned(program)
  const scalarConsts = new Set<string>(
    program
      .filter(
        (n): n is Extract<Statement, { form: 'let' }> =>
          n.form === 'let' &&
          !moduleSlots.has(n.name) &&
          !assignedNames.has(n.name) &&
          (n.init.form === 'integer' || n.init.form === 'float' || n.init.form === 'boolean' || n.init.form === 'string'),
      )
      .map(n => n.name),
  )
  const textConsts = new Set(
    program.flatMap(n => (n.form === 'let' && scalarConsts.has(n.name) && n.init.form === 'string' ? [n.name] : [])),
  )
  // the read of a module binding, by its kind. A non-scalar one is cloned out of its thread-local, at a type this site
  // does not hold, so it counts as a generic clone (item 0029)
  const moduleRead = (name: string): string => {
    // a text constant is a `&'static str`, made a String where one is wanted; a borrowed read takes the constant
    // itself (`strOf`)
    if (scalarConsts.has(name)) {
      return textConsts.has(name) ? `${moduleConstName(name)}.to_string()` : moduleConstName(name)
    }

    cloneRecord.generic = true

    return moduleSlots.has(name)
      ? `${moduleConstName(name)}.with(|v| v.borrow().clone().unwrap())`
      : `${moduleConstName(name)}.with(|v| v.clone())`
  }

  const moduleLet = (node: Extract<Statement, { form: 'let' }>): string =>
    scalarConsts.has(node.name)
      ? node.init.form === 'string'
        ? `const ${moduleConstName(node.name)}: &str = ${rustString(node.init.value)};`
        : `const ${moduleConstName(node.name)}: ${rustType(node.init.type ?? node.type)} = ${expr(node.init)};`
      : moduleSlots.has(node.name)
      ? `thread_local! { static ${moduleConstName(node.name)}: std::cell::RefCell<Option<${rustType(node.type)}>> = std::cell::RefCell::new(None); }`
      : `thread_local! { static ${moduleConstName(node.name)}: ${
          hostStructOf.get(node.name) ?? rustType(node.init.type ?? node.type)
        } = ${expr(node.init)}; }`

  const isNativeCall = (node: Expression): boolean => {
    // SEE THROUGH AN AWAIT. `send back / call shim/list-them / wait true` is an `await` node wrapping the call,
    // and it is the same call: an asynchronous shim returns a plain `Vec<T>` exactly as a synchronous one does.
    // Not looking through it meant a list-returning `note async` task emitted the bare `Vec` where the signature
    // says `Rc<RefCell<Vec<T>>>`, while the SYNCHRONOUS form of the same task compiled clean. The swift emitter
    // had the identical blind spot.
    const call = node.form === 'await' ? node.expr : node

    if (call.form !== 'call' || call.callee.form !== 'member') {
      return false
    }

    const root = rootVariable(call.callee)

    return root !== undefined && aliases.has(root)
  }

  // a generic struct whose fields never mention one of its parameters (an opaque `dock` erases the type) needs
  // a PhantomData field for the unused letters, or rustc refuses it (E0392). Detected up front so every
  // construction of the form appends the marker regardless of declaration order.
  const phantomForms = new Map<string, string>()

  for (const node of program) {
    if (
      node.form !== 'record-type' ||
      node.params.length === 0 ||
      node.variants.length > 0
    ) {
      continue
    }

    const rendered = node.fields.map(f => rustType(f.type)).join(', ')
    const unused = node.params
      .map(p => p.toUpperCase())
      .filter(p => !new RegExp(`\\b${p}\\b`).test(rendered))

    if (unused.length > 0) {
      phantomForms.set(
        node.name,
        unused.length === 1 ? unused[0]! : `(${unused.join(', ')})`,
      )
    }
  }

  // `is-equal` on two records compares their fields, on every backend (note/term/optimize/meaning.md, question 4). A
  // form derives `PartialEq` when every field can be compared, and `Eq + Hash` as well when every field can also be
  // hashed, which is what lets a record be a map key. A closure, a boxed unknown, or a form that does not qualify
  // keeps the form out (a closure has no meaningful equality). Floats compare but do not hash, and a list or a map
  // compares by its items but is not a key (RefCell is not Hash). Decided as a greatest fixpoint, so a recursive form
  // qualifies when nothing outside it disqualifies it.
  const formDecls = new Map<string, Extract<(typeof program)[number], { form: 'record-type' }>>()

  for (const node of program) {
    if (node.form === 'record-type') {
      formDecls.set(node.name, node)
    }
  }

  const equatableForms = new Set(formDecls.keys())
  const hashableForms = new Set(formDecls.keys())

  const fieldTypeQualifies = (
    type: Type,
    params: Set<string>,
    forms: Set<string>,
    hash: boolean,
  ): boolean => {
    switch (type.kind) {
      case 'number':
      case 'boolean':
      case 'string':
      case 'bytes':
      case 'unit':
        return true
      case 'float':
      case 'dynamic':
        return !hash
      case 'array':
        return !hash && fieldTypeQualifies(type.element, params, forms, false)
      case 'map':
        return (
          !hash &&
          fieldTypeQualifies(type.key, params, hashableForms, true) &&
          fieldTypeQualifies(type.value, params, forms, false)
        )
      case 'named': {
        const args = type.args ?? []

        if (type.name === 'text' || type.name === 'boolean') {
          return true
        }

        if (type.name === 'list') {
          return !hash && args.every(a => fieldTypeQualifies(a, params, forms, false))
        }

        if (type.name === 'hash') {
          return (
            !hash &&
            (args[0] === undefined || fieldTypeQualifies(args[0], params, hashableForms, true)) &&
            (args[1] === undefined || fieldTypeQualifies(args[1], params, forms, false))
          )
        }

        // a generic parameter: derive adds the bound itself (`impl<T: PartialEq> PartialEq for Pair<T>`)
        if (params.has(type.name)) {
          return true
        }

        // a `mark shared` value compares and hashes by identity (`TermShared`), whatever it holds
        if (rustSharedForms.has(type.name)) {
          return true
        }

        return forms.has(type.name) && args.every(a => fieldTypeQualifies(a, params, forms, hash))
      }
      default:
        return false
    }
  }

  for (const [forms, hash] of [
    [equatableForms, false],
    [hashableForms, true],
  ] as const) {
    let changed = true

    while (changed) {
      changed = false

      for (const name of [...forms]) {
        const node = formDecls.get(name)!
        const params = new Set(node.params)
        const fields = [...node.fields, ...node.variants.flatMap(v => v.fields)]

        if (!fields.every(f => fieldTypeQualifies(f.type, params, forms, hash))) {
          forms.delete(name)
          changed = true
        }
      }
    }
  }

  // a key must also compare, so a hashable form is always an equatable one
  for (const name of [...hashableForms]) {
    if (!equatableForms.has(name)) {
      hashableForms.delete(name)
    }
  }

  // the generic parameters of a form that sit in a map KEY somewhere in its fields: comparing the form compares that
  // map, which needs the key `Eq + Hash + Clone` (TermMap's PartialEq), a bound `#[derive(PartialEq)]` cannot add
  const keyParams = (node: { params: string[]; fields: { type: Type }[]; variants: { fields: { type: Type }[] }[] }): Set<string> => {
    const params = new Set(node.params)
    const found = new Set<string>()

    const mentions = (type: Type | undefined, into: Set<string>): void => {
      if (!type) {
        return
      }

      if (type.kind === 'named') {
        if (params.has(type.name)) {
          into.add(type.name)
        }

        type.args?.forEach(a => mentions(a, into))
      } else if (type.kind === 'array') {
        mentions(type.element, into)
      } else if (type.kind === 'map') {
        mentions(type.key, into)
        mentions(type.value, into)
      }
    }

    const visit = (type: Type | undefined): void => {
      if (!type) {
        return
      }

      if (type.kind === 'map') {
        mentions(type.key, found)
        visit(type.value)
      } else if (type.kind === 'array') {
        visit(type.element)
      } else if (type.kind === 'named') {
        if (type.name === 'hash') {
          mentions(type.args?.[0], found)
          visit(type.args?.[1])
        } else {
          type.args?.forEach(visit)
        }
      }
    }

    for (const f of [...node.fields, ...node.variants.flatMap(v => v.fields)]) {
      visit(f.type)
    }

    return found
  }

  // `PartialEq` written out for a form `keyParams` names, with the bound the derive cannot spell: every parameter
  // `PartialEq`, and a key parameter `Eq + Hash + Clone` too. Field by field for a struct, case by case for an enum.
  const keyedEquality = (
    node: {
      name: string
      params: string[]
      fields: { name: string; type: Type }[]
      variants: { name: string; fields: { name: string; type: Type }[] }[]
    },
    keyed: Set<string>,
  ): string => {
    const name = pascal(node.name)
    const generics = node.params.length
      ? `<${node.params.map(p => `${p.toUpperCase()}: PartialEq${keyed.has(p) ? ' + Eq + std::hash::Hash + Clone' : ''}`).join(', ')}>`
      : ''
    const applied = node.params.length ? `<${node.params.map(p => p.toUpperCase()).join(', ')}>` : ''
    // `a` and `b` are references in both uses below; a `TermShared` field compares by identity through its own `==`
    const same = (_type: Type, a: string, b: string): string => `${a} == ${b}`

    if (node.variants.length === 0) {
      const each = node.fields.map(f => same(f.type, `&self.${snake(f.name)}`, `&other.${snake(f.name)}`))

      return `impl${generics} PartialEq for ${name}${applied} { fn eq(&self, other: &Self) -> bool { ${each.length ? each.join(' && ') : 'true'} } }`
    }

    const arms = node.variants.map(v => {
      const left = v.fields.map((f, i) => `${snake(f.name)}: a${i}`)
      const right = v.fields.map((f, i) => `${snake(f.name)}: b${i}`)
      const pattern = (binds: string[]) => `${name}::${pascal(v.name)}${binds.length ? ` { ${binds.join(', ')} }` : ''}`
      const each = v.fields.map((f, i) => same(f.type, `a${i}`, `b${i}`))

      return `(${pattern(left)}, ${pattern(right)}) => ${each.length ? each.join(' && ') : 'true'},`
    })

    return `impl${generics} PartialEq for ${name}${applied} { fn eq(&self, other: &Self) -> bool { match (self, other) { ${arms.join(' ')} _ => false } } }`
  }

  // for each form, which of its generic parameters (by index) flow into a map KEY position inside its fields. A `set<t>`
  // stores `items: hash<t, bool>`, so its index 0 is a key; a method generic that fills that slot needs `Eq + Hash`.
  const formKeyIndices = new Map<string, Set<number>>()

  for (const node of program) {
    if (node.form !== 'record-type' || node.params.length === 0) {
      continue
    }

    const keyParams = new Set<string>()

    const findKeys = (t: Type | undefined): void => {
      if (!t) {
        return
      }

      if (t.kind === 'map') {
        if (t.key.kind === 'named') {
          keyParams.add(t.key.name)
        }

        findKeys(t.key)
        findKeys(t.value)
      } else if (t.kind === 'array') {
        findKeys(t.element)
      } else if (t.kind === 'named') {
        t.args?.forEach(findKeys)
      }
    }

    const fields =
      node.variants.length > 0
        ? node.variants.flatMap(v => v.fields)
        : node.fields

    fields.forEach(f => findKeys(f.type))

    const indices = new Set<number>()
    node.params.forEach((p, i) => {
      if (keyParams.has(p)) {
        indices.add(i)
      }
    })

    if (indices.size > 0) {
      formKeyIndices.set(node.name, indices)
    }
  }

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

  // the inner lists put into a list of lists that owns them (`ownedElements`), rendering now: each is the plain `Vec`
  const innerRendering = new WeakSet<object>()
  const expr = (node: Expression): string => {
    // an inner list put into a list of lists that owns it: an owned local moves in, a fresh task's answer is taken as
    // it is, an empty list is a new `Vec`
    if (ownsInner(elementLists.items, node) && !innerRendering.has(node)) {
      if (node.form === 'variable') {
        return vname(node.name)
      }

      if (node.form === 'call') {
        innerRendering.add(node)
        rawFresh = true
        const made = expr(node)
        rawFresh = false
        innerRendering.delete(node)

        return made
      }

      return 'Vec::new()'
    }

    switch (node.form) {
      case 'integer':
        return String(node.value)
      case 'float':
        // a float literal must carry a decimal point so the value and its arithmetic are f64, not integer
        // (JavaScript writes 1e21 and past as `1e+21`, already a float literal, which a `.0` would break)
        return Number.isInteger(node.value) && !/e/i.test(String(node.value))
          ? `${node.value}.0`
          : String(node.value)
      case 'boolean':
        return node.value ? 'true' : 'false'
      case 'string':
        return `${JSON.stringify(node.value)}.to_string()`
      case 'template': {
        // `format!`: braces in the chunks doubled, one `{}` per expression (Display covers text, numbers, flags)
        // each chunk escaped ONCE for a Rust string literal. It was JSON-encoded, joined, JSON-encoded again and the
        // backslash pairs halved, which turned a chunk holding `"` into `\\"`, a string that ends one character early
        const rustChunk = (text: string): string =>
          text
            .replace(/[{}]/g, '$&$&')
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r')
            .replace(/\t/g, '\\t')
            // eslint-disable-next-line no-control-regex
            .replace(/[\u0000-\u001f\u007f]/g, c => `\\u{${c.charCodeAt(0).toString(16)}}`)
        const shape = node.parts.map(part => (typeof part === 'string' ? rustChunk(part) : '{}')).join('')
        // a float interpolates as `term_number` lays it out, the same text as every other backend
        const args = node.parts
          .filter((part): part is Expression => typeof part !== 'string')
          .map(part => (part.type?.kind === 'float' ? `term_number(${expr(part)})` : expr(part)))

        // a template that is one value alone is that value's text, `x.to_string()` (clippy: useless_format)
        if (shape === '{}' && args.length === 1) {
          const only = node.parts.find((part): part is Expression => typeof part !== 'string')!

          return only.type?.kind === 'float' ? args[0]! : `${/^[\w.]+$/.test(args[0]!) ? args[0] : `(${bare(args[0]!)})`}.to_string()`
        }

        return `format!(${[`"${shape}"`, ...args].join(', ')})`
      }
      case 'unit':
        return '()'
      case 'null':
        // null lives in the dynamic currency, which is `serde_json::Value` on rust
        return 'serde_json::Value::Null'
      case 'variable':
      case 'hole': {
        // every read written counts as a use of its name in this statement; `owned` turns its own into a clone
        if (node.form === 'variable') {
          const uses = statementUses.get(node.name) ?? { clone: 0, other: 0 }
          uses.other++
          statementUses.set(node.name, uses)
        }

        // the last read of a local that is a list slot until then TAKES the slot (`slotTakes`)
        const taken = slotReads.get(node)

        if (taken) {
          return `std::mem::replace(&mut ${vname(taken.list)}[${asUsize(expr(taken.index))}], ${pascal(taken.form)}::${pascal(taken.empty)})`
        }
      }
        // a top-level task read as a value (`read dispatch` handed to `on-message`) is a fn item, which is not the
        // `Rc<dyn Fn>` a task-typed slot holds: box it. An asynchronous one is wrapped in a closure that pins the
        // future, since the slot's type is `Fn(..) -> Pin<Box<dyn Future>>` and a fn item's is `-> impl Future`
        if (functionParams.has(node.name) && !localNames.has(node.name) && node.type?.kind === 'function') {
          const type = node.type

          if (asyncFunctions.has(node.name) || type.effects?.includes('async')) {
            const names = type.params.map((_, i) => `a${i}`)
            const typed = type.params.map((p, i) => `a${i}: ${rustType(p)}`).join(', ')

            return `std::rc::Rc::new(move |${typed}| -> std::pin::Pin<std::boxed::Box<dyn std::future::Future<Output = ${rustType(type.result)}>>> { std::boxed::Box::pin(${snake(node.name)}(${names.join(', ')})) })`
          }

          return `std::rc::Rc::new(${snake(node.name)})`
        }

        // a module-level constant lives in a thread_local (rust has no top-level `let`): a read clones it out
        if (moduleConsts.has(node.name) && !localNames.has(node.name)) {
          return moduleRead(node.name)
        }

        // a mutated capture lives in an Rc<RefCell> handle: a read borrows and clones the value out
        if (cellVars.has(node.name)) {
          noteClone(node.type)

          return `${vname(node.name)}.borrow().clone()`
        }

        return vname(node.name)
      case 'unary':
        // a release build's `-i64::MIN` wraps to itself, a different integer: checked_neg stops instead. A literal
        // operand cannot be the minimum, so `-5` stays as written
        if (node.op === '-' && node.operand.type?.kind === 'number' && node.operand.form !== 'integer') {
          return `i64::checked_neg(${expr(node.operand)}).expect("excess: a number past i64")`
        }

        return `${node.op}${expr(node.operand)}`
      case 'binary': {
        // string concatenation: Rust's `+` requires `String + &str`, so two owned `String`s (e.g. function-call
        // results) would not compile. `format!` concatenates any Display operands uniformly, owned or borrowed.
        if (
          node.op === '+' &&
          (node.left.type?.kind === 'string' ||
            node.right.type?.kind === 'string' ||
            node.type?.kind === 'string')
        ) {
          // two texts join in one allocation of the exact length. `&*` reads either a String or a &str as &str. A
          // side that is not text (a number) still goes through `format!`, which renders it
          if (node.left.type?.kind === 'string' && node.right.type?.kind === 'string') {
            return `[&*(${expr(node.left)}), &*(${expr(node.right)})].concat()`
          }

          return `format!("{}{}", ${expr(node.left)}, ${expr(node.right)})`
        }

        // comparing an unknown slot to `make void` is a presence check: Rc<dyn Any> has no `==`, so it asks
        // the box whether it holds the unit
        const voidSide =
          node.right.form === 'record' && node.right.name === 'void'
            ? node.left
            : node.left.form === 'record' && node.left.name === 'void'
              ? node.right
              : undefined

        if (voidSide && (node.op === '==' || node.op === '!=')) {
          const check = `${expr(voidSide)}.is::<()>()`

          return node.op === '==' ? check : `!${check}`
        }

        // a sum, difference or product of two numbers is the integer one or the program stops: a release build's `+`
        // wraps past i64, which is a DIFFERENT integer, and every proof about `number` is about the integer.
        // note/term/proof-by-default/numbers.md. The function form takes a literal operand (`5.checked_add` does not)
        const checked = { '+': 'checked_add', '-': 'checked_sub', '*': 'checked_mul' }[node.op as string]

        // a counted loop's increment is proven in range (ir/facts/range.ts) and is a plain `+`, which LLVM can vectorize
        if (
          checked &&
          node.left.type?.kind === 'number' &&
          node.right.type?.kind === 'number' &&
          !provenSteps.has(node) &&
          !uncheckedInts
        ) {
          // each operand is an argument here, so its grouping parentheses are redundant (rustc: unused_parens)
          return `i64::${checked}(${bare(expr(node.left))}, ${bare(expr(node.right))}).expect("excess: a number past i64")`
        }

        // in a task's unchecked copy, a division whose operands the interval fact proved non-negative is unsigned: `/ 2`
        // is one shift, where a signed division needs a sign fix-up (`unsignedDivisions`)
        if (uncheckedInts && (node.op === '/' || node.op === '%') && unsignedDivs.has(node)) {
          // `as` binds tighter than every binary operator, so each operand keeps its grouping before the cast. A literal
          // is inferred `u64` and takes no cast (clippy: unnecessary_cast)
          const operand = (side: Expression): string => {
            if (side.form === 'integer') {
              return String(side.value)
            }

            const text = expr(side)

            return `${/^[\w.]+$/.test(text) ? text : `(${bare(text)})`} as u64`
          }

          return `((${operand(node.left)} ${node.op} ${operand(node.right)}) as i64)`
        }

        // a text compared with a text literal for equality reads the literal as the `&str` it is, which a `String`
        // compares with directly, where `"a".to_string()` made one per comparison (clippy: cmp_owned). Ordering has no
        // such pairing, so `<` keeps both owned
        const literalText = (side: Expression): string | undefined =>
          (node.op === '==' || node.op === '!=') && side.form === 'string' && node.left.type?.kind === 'string' && node.right.type?.kind === 'string'
            ? rustString(side.value)
            : undefined

        // a left operand that is a block (a call hoisting its lent arguments) is parenthesized: once `bare` drops the
        // outer pair at a statement or a tail, a leading `{ .. }` would be read as a statement of its own
        // and either side that is a construction keeps a pair of its own: `bare` drops the outer one at an `if`
        // condition, and rustc refuses a struct literal there (`if a == Big { .. } {`), as it does a member read off one
        const operand = (side: Expression): string => {
          const text = literalText(side) ?? expr(side)

          // only a literal with a body: a field-less case is a path (`Ordering::Less`), and needs no pair
          return side.form === 'record' && /^[A-Za-z_][\w:]*\s*\{/.test(text) ? `(${text})` : text
        }
        const left = operand(node.left)
        // a left side that opens a block expression (an inlined `big-compare` is a `match`) is a statement of its own
        // at the head of a tail, exactly as a bare `{ .. }` is: `match .. { .. } == 0` fails to parse
        const opensBlock = /^(\{|(match|if|loop|unsafe)\b)/.test(left)

        return `(${opensBlock ? `(${left})` : left} ${OP[node.op]} ${operand(node.right)})`
      }

      case 'call': {
        // FIRE AND FORGET (`tick f(x)`, `background` on the call), wherever it stands: a statement, or the whole body
        // of a handler (`seed click / tick add-post`). Its future is queued for `__term_drain` rather than dropped
        // unpolled, which is all a bare call of an `async fn` does (terminal-target-0005). The call is emitted with the
        // mark cleared and put back, so it is not queued twice
        if (node.background && isAsyncCall(node)) {
          spawnUses++
          node.background = false
          const started = expr(node)
          node.background = true

          return `__term_spawn(${started})`
        }

        // a call the guarded loop copy may make to the task's unchecked copy (`LoopGuard.fast`)
        if (fastCalls.has(node) && node.callee.form === 'variable') {
          fastTasks.add(node.callee.name)

          return expr({ ...node, callee: { ...node.callee, name: `${node.callee.name}-fast` } } as Expression)
        }

        // read once and cleared, so the call's own arguments never take a fresh `Vec` raw
        const raw = rawFresh
        rawFresh = false

        // a push onto, or the size of, an owned list local is the Vec's own (ownedLocals)
        if (
          node.callee.form === 'variable' &&
          (node.callee.name === 'list_push' || node.callee.name === 'list_size') &&
          node.args[0]?.form === 'variable' &&
          ownedNames.has(node.args[0].name)
        ) {
          const list = vname(node.args[0].name)

          return node.callee.name === 'list_size'
            ? `(${list}.len() as i64)`
            : `{ let __push_item = ${bare(owned(node.args[1]!))}; ${list}.push(__push_item); ${list}.len() as i64 }`
        }

        // `call fill / <data> / like <form>` and `call melt / <value> / like <form>`: a function per form, generated
        // from the form's fields at the end of the module (see formWalk below)
        if (
          node.callee.form === 'variable' &&
          (node.callee.name === 'fill-form' || node.callee.name === 'melt-form') &&
          node.into
        ) {
          const spec = formSpec(node.into, recordFields)
          refuseAny(spec, 'Rust')
          const into = node.callee.name === 'fill-form' ? fillSpecs : meltSpecs
          specForms(spec, into)

          // a fill raises `data-mismatch`, passed on or ended the way any raising call is (`raiseSuffix`)
          return node.callee.name === 'fill-form'
            ? `__fill_${snake(spec.form)}(${expr(node.args[0]!)}, String::new())${raiseSuffix()}`
            : `__melt_${snake(spec.form)}(${expr(node.args[0]!)})`
        }

        // a declarative native binding renders its `case rust` template, with `$param` placeholders filled by the
        // emitted (un-cloned) arguments: the template author writes the exact native call shape
        if (
          node.callee.form === 'variable' &&
          binds.has(node.callee.name)
        ) {
          const bind = binds.get(node.callee.name)!

          // the code-point count of an ASCII text (ir/facts/text.ts) is its byte length, where `chars().count()` walked
          if (node.callee.name === 'code-point-count' && node.args[0] && asciiNodes.has(node.args[0])) {
            // `len()` straight on the text, which counts bytes (clippy: needless_as_bytes)
            return `(${bytesOf(node.args[0]).replace(/\.as_bytes\(\)$/, '')}.len() as i64)`
          }

          // a template that is a formatting macro (`panic!("defect: {}", $reason)`) takes a text literal as the
          // literal itself: Display reads a `&str`, and `.to_string()` there is clippy's to_string_in_format_args
          const formats = /^(panic|format|print|println|eprintln|write|writeln)!\(/.test(bindTarget(bind, 'rust')?.expression ?? '')

          return (
            renderBind(bind, 'rust', node.args.map(a => (formats && a.form === 'string' ? JSON.stringify(a.value) : expr(a)))) ??
            bindGap(bind.name)
          )
        }

        // a native map / list operation lowers to rust's collection API through the Rc<RefCell> handle
        const operation = collectionCall(node.callee)

        if (operation) {
          return collectionExpr(operation, node.args)
        }

        // a host string method (what `text.tree` delegates to) lowers to rust's str API
        const text = stringCall(node.callee)

        if (text) {
          // the arguments OWNED, as every by-value argument is: `let n: String = part` moved a parameter read in a loop
          // an ASCII text (ir/facts/text.ts) is read by byte: a code point is one, where `chars().nth(i)` walked
          if (asciiNodes.has(text.target) && ['charAt', 'at', 'charCodeAt'].includes(text.op)) {
            return asciiRead(text.op, text.target, node.args[0]!)
          }

          // a read through the text's cursor (backend.ts, `textCursors`) steps from the last read
          const cursor = cursors.reads.get(node)

          if (cursor !== undefined && (text.op === 'substring' || text.op === 'slice')) {
            const to = node.args[1] ? bare(expr(node.args[1])) : 'i64::MAX'

            return `term_cursor_slice(${strOf(text.target)}, ${bare(expr(node.args[0]!))}, ${to}, &mut ${cursorName(cursor)})`
          }

          if (cursor !== undefined) {
            const read = `term_cursor(${strOf(text.target)}, ${bare(expr(node.args[0]!))}, &mut ${cursorName(cursor)})`

            return text.op === 'charCodeAt' ? `${read}.map_or(-1, |c| c as i64)` : `${read}.map(String::from).unwrap_or_default()`
          }

          // a search of an ASCII text answers a byte offset, which is the code-point index: no count back from it. The
          // start clamped to the text, an empty needle found at it, a needle that is not ASCII found nowhere
          if (asciiNodes.has(text.target) && (text.op === 'indexOf' || text.op === 'lastIndexOf')) {
            // the needle borrowed, a literal as itself: owning it cost a String per search
            const needle = strOf(node.args[0]!)

            if (text.op === 'lastIndexOf') {
              return `{ let h: &str = ${strOf(text.target)}; let n: &str = ${needle}; h.rfind(n).map_or(-1, |b| b as i64) }`
            }

            const from = node.args[1] ? bare(expr(node.args[1])) : '0'

            if (from === '0') {
              return `{ let h: &str = ${strOf(text.target)}; h.find(${needle}).map_or(-1, |b| b as i64) }`
            }

            return `{ let h: &str = ${strOf(text.target)}; let n: &str = ${needle}; let x = (${from}).clamp(0, h.len() as i64) as usize; h[x..].find(n).map_or(-1, |b| (x + b) as i64) }`
          }

          // a substring of an ASCII text is a byte slice, with both ends clamped to the text and swapped when reversed
          // (the Term meaning), where `chars().skip(x).take(y - x)` walked from the start
          if (asciiNodes.has(text.target) && (text.op === 'substring' || text.op === 'slice')) {
            const from = bare(expr(node.args[0]!))
            const to = node.args[1] ? bare(expr(node.args[1])) : undefined

            // borrowed for a local that is only ever a map key (`sliceLets`): no String is made for it
            const slice = borrowSlice ? '&h[x as usize..y as usize]' : 'h[x as usize..y as usize].to_string()'

            return `{ let h: &str = ${strOf(text.target)}; let n = h.len() as i64; let x = (${from}).clamp(0, n); let y = ${to === undefined ? 'n' : `(${to}).clamp(0, n)`}; let (x, y) = if x <= y { (x, y) } else { (y, x) }; ${slice} }`
          }

          return stringExpr(text.op, expr(text.target), node.args.map(a => owned(a)))
        }

        // Rust moves a value passed by value, so a local (or a field read out of a struct) used as an argument would
        // move it away. Cloning a non-function variable / field argument is transparent here -- every collection is an
        // `Rc` (a cheap shared handle), every struct derives `Clone`, scalars are `Copy` -- and frees callers from
        // manual ownership juggling. A closure is function-typed (`Box<dyn Fn>`, not `Clone`), so it passes unchanged.
        // MOVE ON LAST USE: a bare variable read exactly once in the function (and not in a loop or closure) is moved at
        // this use instead of cloned -- there is no later use to invalidate, so the borrow checker accepts it, and the
        // clone (a deep `String` copy or an `Rc` refcount bump) is saved.
        // a closure-typed local (a task parameter) boxes its unknown-typed arguments the same way a known
        // function does: its param types come from the callee's own checked function type. A local shadows a task of
        // its name: the stdlib's `map` calls its parameter `fn`, and a program defining a task `fn` with `fall`
        // parameters had every call of the parameter padded to that task's arity (test/compile/shadowed-callee.ts)
        const params =
          node.callee.form === 'variable'
            ? ((localNames.has(node.callee.name) ? undefined : functionParams.get(node.callee.name)) ??
              (node.callee.type?.kind === 'function'
                ? node.callee.type.params
                : undefined))
            : undefined
        const lending =
          node.callee.form === 'variable' && !localNames.has(node.callee.name) ? lendParams.get(node.callee.name) : undefined
        // a text argument in a generic task's key position, beside a map of `TermKey`s (`rustTextKeys`), is made one
        const keyed = node.callee.form === 'variable' && rustTextKeys ? keyPositions.get(node.callee.name) : undefined
        // the lent arguments that are a fresh task's `Vec`, taken raw
        const rawLent = new Set<number>()
        const argList = node.args.map((a, i) => {
          // a closure passed where a task is declared answers what that task declares: the checker can leave the
          // closure's own result unknown, and boxing a `View` into an `Rc<dyn Any>` then misses an `Fn() -> View`
          // parameter (native-dom-0020: the renderer's `mount` and `dynamic` callbacks)
          const slot = params?.[i]
          closureHint = a.form === 'closure' && slot?.kind === 'function' ? slot.result : undefined

          const besideMap = keyed?.get(i)
          const mapArg = besideMap === undefined ? undefined : node.args[besideMap]?.type

          if (mapArg?.kind === 'map' && isText(mapArg.key) && isText(a.type)) {
            return `TermKey::from(${strOf(a)})`
          }

          // a record the callee only reads is borrowed (borrowedRecords): a name that is already a reference passes as
          // it is (`&Rc<R>` derefs to `&R`), anything else is lent as `&`, never cloned first. Decided BEFORE the
          // owned rendering below, which would record a clone this argument never makes (item 0029)
          if (node.callee.form === 'variable' && !localNames.has(node.callee.name) && borrowParams.get(node.callee.name)?.has(i)) {
            // a text literal lent to a `&str` is the literal itself (clippy: unnecessary_to_owned)
            if (a.form === 'string') {
              return rustString(a.value)
            }

            // a path into a value (`piles/0`, `p/inner`) is lent where it lies, `&piles[0]`, where `&${expr}` cloned the
            // element first to lend the clone. Only a path through no cell (a plain `Vec` or slice, a local record), and
            // only where no other argument names its root, so the loan can meet no write
            const root = a.form === 'member' ? rootVariable(a) : undefined

            if (root !== undefined && !node.args.some((other, j) => j !== i && namesIn(other).has(root))) {
              const place = memberPath(a)

              if (!place.includes('.borrow') && !place.includes('::')) {
                return `&${place}`
              }
            }

            return a.form === 'variable' && borrowedNames.has(a.name) ? vname(a.name) : `&${expr(a)}`
          }

          // a list the callee takes lent (lendParams), likewise before any clone is recorded
          if (lending?.get(i)) {
            // a fresh task's `Vec` is lent straight from the call, with no cell around it to borrow through
            if (a.form === 'call' && a.callee.form === 'variable' && freshLists.has(a.callee.name)) {
              rawLent.add(i)
              rawFresh = true
              const made = expr(a)
              rawFresh = false

              return made
            }

            return expr(a)
          }

          // a parameter the callee only calls is `impl Fn` (implFnParams), and takes the value borrowed
          const toImplFn =
            node.callee.form === 'variable' && !localNames.has(node.callee.name) && Boolean(implFnParams.get(node.callee.name)?.has(i))

          const rendered = (() => {
            if (
              a.form === 'variable' &&
              a.type &&
              (moveArgs.has(a.name) || lastMove(a) || lastOfManyMove(a) || ownsInner(elementLists.items, a))
            ) {
              return expr(a)
            }

            // a mutated capture's read already clones the value out of its cell; no second clone
            if (a.form === 'variable' && cellVars.has(a.name)) {
              return expr(a)
            }

            // an UNTYPED variable is cloned too: the view lowering synthesizes `view0`-style locals with no type, and
            // passing one to `append` then reading it again moved it away (native-dom-0020). A function value here is
            // an `Rc<dyn Fn>`, so its clone is a refcount bump as well, and it is cloned: a task value captured by a
            // closure and passed on from inside it (render.tree's `rebuild(slot, then)` in `show`'s effect) was moved
            // out of the `Fn` closure, E0507. Never one bound for an `impl Fn` parameter, which takes it borrowed.
            // A parameter passed on is never itself `impl Fn` (escapingParams), so every function value here is an `Rc`
            // a `Copy` value (a number, a float, a boolean) is passed as it is, and a read that already clones (a list
            // element) is not cloned twice: clippy's clone_on_copy flagged every `n.clone()`
            const rendered = expr(a)
            const clones =
              (a.form === 'variable' || a.form === 'member') &&
              (!a.type || a.type.kind !== 'function' || !toImplFn) &&
              !copyType(a.type) &&
              !rendered.endsWith('.clone()')

            if (clones) {
              noteClone(a.type)
              countClone(a)
            }

            return clones
              ? `${rendered}.clone()`
              : rendered
          })()

          if (toImplFn) {
            return implFnArg(a, rendered)
          }

          // a binary's grouping parens are redundant at argument position (the comma delimits):
          // rustc warns unused_parens on them
          return bare(boxUnknown(params?.[i], a, rendered))
        })

        // a trailing `need false` parameter left out at the call site still exists in the native signature:
        // fill it with its type's empty value (the boxed unit for an unknown)
        if (params && params.length > argList.length) {
          for (let i = argList.length; i < params.length; i++) {
            const missing = params[i]

            argList.push(
              missing?.kind === 'unknown' || missing === undefined
                ? '(std::rc::Rc::new(()) as std::rc::Rc<dyn std::any::Any>)'
                : emptyOf(missing),
            )
          }
        }

        // a call that lends a list evaluates its arguments into locals first, in order, and borrows the cell only at the
        // call itself, so no argument can borrow it while it is lent (`flip(&mut perm.borrow_mut(), perm.borrow()[0])`
        // would panic). A plain variable or a literal does nothing when evaluated, so it is passed as it stands
        const hoisted: string[] = []

        // an owned Vec, or a fresh task's taken raw, is lent as itself, with no cell to borrow through
        // a list already held as a reference: a lent parameter of the task being emitted (`&[T]` or `&mut [T]`)
        const lentRef = (i: number): boolean => {
          const a = node.args[i]

          return a?.form === 'variable' && lentNames.has(a.name) && !ownedNames.has(a.name)
        }
        const plainAt = (i: number): boolean => {
          const a = node.args[i]

          return (a?.form === 'variable' && ownedNames.has(a.name)) || rawLent.has(i) || lentRef(i) || (a !== undefined && ownedPath(a))
        }
        // the hoisting guards a borrow an argument could collide with: a cell's, or a plain Vec another argument reads
        // (`bump(&mut zs, zs[1])` is E0502: two-phase borrows do not cover an explicit `&mut` argument). A call that
        // lends only plain Vecs nothing else reads borrows nothing an argument could reach
        const plainLent = new Set(
          [...(lending?.keys() ?? [])].flatMap(i => {
            const a = node.args[i]

            return plainAt(i) && a?.form === 'variable' ? [a.name] : []
          }),
        )
        const throughCell =
          lending !== undefined &&
          ([...lending.keys()].some(i => !plainAt(i)) ||
            node.args.some((a, i) => !lending.has(i) && [...namesIn(a)].some(n => plainLent.has(n))))

        if (lending) {
          node.args.forEach((a, i) => {
            const simple =
              !throughCell ||
              (a.form === 'variable' && !cellVars.has(a.name)) ||
              a.form === 'integer' ||
              a.form === 'float' ||
              a.form === 'boolean'

            const lentAs = lending.get(i)

            if (!simple) {
              // a raw `Vec` lent for writing is borrowed `&mut`, so its local is `mut`. A shared cell lent from a place
              // (`cursor.position`) is held by reference: a `let` of the place itself moved the field out (E0382),
              // and the cell borrows the same through the reference
              const byRef = lentAs !== undefined && !rawLent.has(i) && !plainAt(i) && a.form === 'member'
              hoisted.push(`let ${rawLent.has(i) && lentAs === 'write' ? 'mut ' : ''}__lend_${i} = ${byRef ? '&' : ''}${argList[i]};`)
              argList[i] = `__lend_${i}`
            }

            if (lentAs) {
              const plain = plainAt(i)

              // a lent parameter passes on as it is: Rust reborrows a `&mut [T]` argument, and coerces it to `&[T]`
              argList[i] = lentRef(i)
                ? argList[i]!
                : plain
                ? `${lentAs === 'write' ? '&mut ' : '&'}${argList[i]}`
                : lentAs === 'write'
                  ? `&mut ${argList[i]}.borrow_mut()`
                  : `&${argList[i]}.borrow()`
            }
          })
        }

        // a call that hands a shared list's cell over (`out.clone()`) may borrow it mutably inside, so an argument that
        // borrows the same cell to read it (`list_get(&out.borrow(), j)`) is evaluated into a local first. Inline, its
        // `Ref` lives to the call's semicolon and the callee's `borrow_mut` panics: "RefCell already borrowed". Every
        // argument that does something is hoisted, in order, so evaluation order is kept
        if (!lending) {
          const handed = new Set(
            node.args.flatMap(a =>
              a.form === 'variable' &&
              (a.type?.kind === 'array' || (a.type?.kind === 'named' && a.type.name === 'list')) &&
              !ownedNames.has(a.name) &&
              !lentNames.has(a.name)
                ? [a.name]
                : [],
            ),
          )
          const collides = node.args.some(
            (a, i) => a.form !== 'variable' && (argList[i] ?? '').includes('.borrow') && [...namesIn(a)].some(n => handed.has(n)),
          )

          if (collides) {
            node.args.forEach((a, i) => {
              if (a.form === 'variable' || a.form === 'integer' || a.form === 'float' || a.form === 'boolean') {
                return
              }

              hoisted.push(`let __lend_${i} = ${argList[i]};`)
              argList[i] = `__lend_${i}`
            })
          }
        }

        // the call is a `let` statement, never the block's tail: a tail's temporaries (the `RefMut` the lend made)
        // outlive the block's locals before edition 2024 (E0597), while a statement drops them at its semicolon
        const unit = !node.type || node.type.kind === 'unit'
        // a fresh task answers a plain `Vec` (freshLists): into the shared cell here, unless an owned local takes it
        const fresh =
          !raw && node.callee.form === 'variable' && !localNames.has(node.callee.name) && freshLists.has(node.callee.name)
        const lendWrap = (call: string): string => {
          const made = !hoisted.length
            ? call
            : unit
              ? `{ ${hoisted.join(' ')} ${call}; }`
              : `{ ${hoisted.join(' ')} let __lent = ${call}; __lent }`

          return fresh ? `std::rc::Rc::new(std::cell::RefCell::new(${made}))` : made
        }

        // a call to a task that only fills a list is the list made in one allocation (backend.ts, `fillTasks`), where
        // pushing grew it. A size below zero is no list, as the walk was no turns
        const fill = node.callee.form === 'variable' && !localNames.has(node.callee.name) ? fillCall(node, fills) : undefined

        if (fill) {
          const size = fill.size.form === 'integer' ? `${Math.max(Number(fill.size.value), 0)}` : `(${bare(expr(fill.size))}).max(0) as usize`
          const made = `vec![${bare(owned(fill.item))}; ${size}]`

          return raw ? made : `std::rc::Rc::new(std::cell::RefCell::new(${made}))`
        }

        const args = argList.join(', ')

        // a generic trait-method call (`call measure / read x`, x a trait-bounded generic) lowers to a Rust method call
        // through the trait bound: `(x).measure(..)`. The receiver is the first argument; concrete trait calls were
        // already resolved to the free implementation function by the checker, so a bare trait-method name here is the
        // generic case.
        if (
          node.callee.form === 'variable' &&
          maskMethods.has(node.callee.name) &&
          argList.length >= 1
        ) {
          return lendWrap(`(${argList[0]}).${snake(node.callee.name)}(${argList
            .slice(1)
            .join(', ')})`)
        }

        // a slashed callee (`fs/read-to-string`) is a module path: emit Rust `::` segments. A field holding a closure
        // is invoked with parens (`(r.handle)(x)`), distinguishing it from a method call. Both go through `lendWrap`,
        // which declares the arguments hoisted above: without it a call through a closure field named `__lend_1` and
        // nothing declared it (the repair-loop port, 2026-10-04)
        if (node.callee.form === 'member') {
          const callee = memberPath(node.callee)

          return lendWrap(closureFields.has(node.callee.name)
            ? `(${callee})(${args})`
            : `${callee}(${args})`)
        }

        // a parameter called by name is the callback it holds, whose type says it returns a plain value: `list/find-index`
        // calling its `test` read as the raising `file/test` and got a `?` on a `bool` (2026-10-04)
        if (node.callee.form === 'variable' && raising.has(node.callee.name) && !currentParams.has(node.callee.name)) {
          // the call an `await` wraps takes its `?` after `.await`, so none here. Keyed by the node: a flag the next
          // raising call consumed went to the first raising ARGUMENT instead, which lost its `?`, and the awaited call
          // kept one before `.await` (`encrypt(key(), ...)?.await?`, edge-cipher, 2026-10-04)
          const suffix = awaitedCalls.has(node) ? '' : raiseSuffix()

          return lendWrap(`${expr(node.callee)}(${args})${suffix}`)
        }

        // a callee that is not a name (a closure the inliner put in place of a parameter: `apply(adder, 10)` is
        // `adder(10)`) is grouped, or its block reads as a statement and `(10)` as a second one
        const callee = expr(node.callee)

        return lendWrap(`${node.callee.form === 'variable' ? callee : `(${callee})`}(${args})`)
      }

      case 'array':
        // an EMPTY list whose element the checker knows is typed: a bare `vec![]` nothing reads as a list of that
        // element is refused (`type annotations needed`, native-dom-0020: the renderer's `each`)
        if (
          node.items.length === 0 &&
          node.type?.kind === 'array' &&
          node.type.element.kind !== 'variable' &&
          node.type.element.kind !== 'unknown'
        ) {
          return `std::rc::Rc::new(std::cell::RefCell::new(Vec::<${rustElement(node.type)}>::new()))`
        }

        // a list of FUNCTIONS: each task is a type of its own in Rust (an fn item), so `vec![Rc::new(f), Rc::new(g)]`
        // is refused (E0308, "expected fn item, found a different fn item") and each is cast to the element, the
        // `Rc<dyn Fn>` the list holds (deck/test/test/fold-synthesis.tree's list of specs, 2026-10-05)
        if (node.type?.kind === 'array' && node.type.element.kind === 'function' && node.items.length > 0) {
          const element = rustElement(node.type)

          return `std::rc::Rc::new(std::cell::RefCell::new(vec![${node.items
            .map(item => `${expr(item)} as ${element}`)
            .join(', ')}]))`
        }

        return `std::rc::Rc::new(std::cell::RefCell::new(vec![${node.items
          .map(expr)
          .join(', ')}]))`

      case 'record': {
        // `make hash` / `make list` with no binds are the native collections, not record constructions (the
        // pascal of `hash` would otherwise resolve to the std `Hash` derive macro)
        if (node.name === 'hash' && node.fields.length === 0) {
          return 'std::rc::Rc::new(std::cell::RefCell::new(TermMap::new()))'
        }

        if (node.name === 'list' && node.fields.length === 0) {
          return 'std::rc::Rc::new(std::cell::RefCell::new(Vec::new()))'
        }

        // `make void` is the absent value: the boxed unit, so an unknown slot can hold and recognize it
        if (node.name === 'void' && node.fields.length === 0) {
          return '(std::rc::Rc::new(()) as std::rc::Rc<dyn std::any::Any>)'
        }

        // a label several enums share (`text` on both `token` and `data`) is owned by the enum the checker gave the
        // construction; a label of one enum by that enum
        const owner =
          node.type?.kind === 'named' && variantOwners.get(node.name)?.has(node.type.name)
            ? node.type.name
            : variantOwner.get(node.name)

        if (owner) {
          // a case held by payload has its recursive fields plain: the one box is around the whole struct
          const payload = payloadOf(owner, node.name)
          const fields = node.fields.map(f => {
            // a list the node owns (`ownedFields`) takes the plain `Vec`: an owned local moves in, a fresh task's answer
            // is taken as it is, an empty list is a new one
            // a node of a reusable form is built in a box an arm kept (`reusable`)
            const value = fieldLists.has(`${node.name}/${f.name}`)
              ? plainList(f.value)
              : payload || !recursiveFields.has(`${node.name}/${f.name}`)
              ? owned(f.value)
              : reusable(owner)
                ? (reuseBuilt.add(owner), `term_box_${snake(owner)}(${owned(f.value)})`)
                : `${boxedForms.has(owner) ? 'Box' : 'std::rc::Rc'}::new(${owned(f.value)})`

            // `head` for `head: head`, as Rust writes it (clippy: redundant_field_names)
            return value === snake(f.name) ? value : `${snake(f.name)}: ${value}`
          })

          // a type argument nothing constrains (the error type of `make okay` handed straight to a generic task) is
          // left for rustc to infer, and it cannot: it is any type, so it is named the unit type, the others `_`
          const args = node.type?.kind === 'named' ? (node.type.args ?? []) : []
          const free = (a: Type): boolean => a.kind === 'variable' && !rustVarNames.has(a.id)
          const named = args.some(free)
            ? `${pascal(owner)}::<${args.map(a => (free(a) ? '()' : '_')).join(', ')}>`
            : pascal(owner)

          // the payload built and boxed once, in a box an arm kept when the form's boxes are reused
          if (payload) {
            const built = `${payload} { ${fields.join(', ')} }`

            return `${named}::${pascal(node.name)}(${
              reusable(owner) ? (reuseBuilt.add(owner), `term_box_${snake(owner)}(${built})`) : `${payloadHolder(owner)}::new(${built})`
            })`
          }

          return fields.length > 0
            ? `${named}::${pascal(node.name)} { ${fields.join(
                ', ',
              )} }`
            : `${named}::${pascal(node.name)}`
        }

        // a field the construction leaves out (`need false`, or one the runtime fills on another backend) takes its
        // type's empty value, so the struct is whole
        const given = new Set(node.fields.map(f => f.name))
        const declared = new Map(
          (recordFields.get(node.name) ?? []).map(f => [f.name, f.type]),
        )
        // a list the record owns (`ownedFields`) left out is a new plain `Vec`, where its empty value was the shared one
        const missing = (recordFields.get(node.name) ?? [])
          .filter(f => !given.has(f.name))
          .map(f => `${snake(f.name)}: ${fieldLists.has(`${node.name}/${f.name}`) ? 'Vec::new()' : emptyOf(f.type)}`)

        const parts = [
          ...node.fields.map(f => {
            // a list the record owns (`ownedFields`) is the plain `Vec`
            const value = fieldLists.has(`${node.name}/${f.name}`)
              ? plainList(f.value)
              : boxUnknown(declared.get(f.name), f.value, owned(f.value))

            return value === snake(f.name) ? value : `${snake(f.name)}: ${value}`
          }),
          ...missing,
          ...(phantomForms.has(node.name)
            ? ['_marker: std::marker::PhantomData']
            : []),
        ]
        // a field-less struct is `Empty {}`, as rustfmt lays it out
        const built = parts.length ? `${pascal(node.name)} { ${parts.join(', ')} }` : `${pascal(node.name)} {}`

        // a `mark shared` form is made once and handed out as its handle
        return rustSharedForms.has(node.name) ? `TermShared::new(${built})` : built
      }

      case 'member': {
        // a DYNAMIC segment (`read table/{key}`) indexes the collection through its handle; cloned out, since
        // indexing a Vec of non-Copy values (String, Rc) cannot move
        if (node.index) {
          if (!copyType(node.type)) {
            noteClone(node.type)
          }

          return `${view(node.target, false)}[${asUsize(expr(node.index))}]${copyType(node.type) ? '' : '.clone()'}`
        }

        // `map.size` / `array.length` read the length (a map goes through its Rc<RefCell> handle; an array is a plain
        // Vec). Rendered as i64, the seed number type.
        const read = collectionRead(node)

        if (read) {
          // both a map and an array read their length through the Rc<RefCell> handle
          return `(${view(read.target, false)}.len() as i64)`
        }

        const textLength = stringRead(node)

        if (textLength) {
          return `(${expr(textLength.target)}.chars().count() as i64)`
        }

        // a LITERAL index segment (`read parts/0`) on an array target indexes the Vec: `.0` would be a tuple
        // field, which an Rc<RefCell<Vec>> does not have
        if (
          /^\d+$/.test(node.name) &&
          node.target.type?.kind === 'array'
        ) {
          // cloned, as a dynamic index read is: a bare `v.borrow()[1]` moves a String out of the Vec and is refused
          if (!copyType(node.type)) {
            noteClone(node.type)
          }

          return `${view(node.target, false)}[${node.name}]${copyType(node.type) ? '' : '.clone()'}`
        }

        // a field of a `mark shared` value, READ: cloned out of the borrow, since `x.borrow().field` moves a String or
        // a generic `T` out of a `Ref` and is refused (native-dom-0020: the memory host's `element.borrow().text`, the
        // signal's `slf.borrow().value`). A write goes through `memberPath` straight, under `borrow_mut()`
        // The read is a block, so its `Ref` ends with it: a temporary in a call's argument lives to the end of the whole
        // statement, and `put_bits(state.clone(), 8 - state.borrow().held)` still held the borrow when the callee took
        // `state.borrow_mut()`, which panicked (gzip's bit writer, 2026-10-02)
        if (isSharedType(node.target.type)) {
          noteClone(node.type)

          // in parentheses, since a block that begins a statement (`{ ... } == 0`) is read as a statement of its own
          return `({ let __shared_read = ${memberPath(node)}.clone(); __shared_read })`
        }

        // a field of a caught exception, read: cloned, since the carrier reaches its fields through `Deref` and a String
        // cannot move out of one. `send back, read problem/form` in a handler was refused (E0507), found by the
        // host-native fill case on 2026-10-05
        if (node.target.form === 'variable' && caughtNames.has(node.target.name) && !copyType(node.type)) {
          return `${memberPath(node)}.clone()`
        }

        return memberPath(node)
      }

      case 'await': {
        if (node.expr.form === 'call' && node.expr.callee.form === 'variable' && raising.has(node.expr.callee.name)) {
          awaitedCalls.add(node.expr)
          const inner = expr(node.expr)

          return `${inner}.await${raiseSuffix()}`
        }

        // `wait true` on a call whose callee is checked SYNC (a plain task field): rustc refuses awaiting a
        // non-future, so the await is dropped rather than emitted
        if (node.expr.form === 'call') {
          const calleeType =
            node.expr.callee.type?.kind === 'function'
              ? node.expr.callee.type
              : undefined

          if (calleeType && !calleeType.effects?.includes('async')) {
            return expr(node.expr)
          }
        }

        return `${expr(node.expr)}.await`
      }
      case 'map':
        return `std::rc::Rc::new(std::cell::RefCell::new(${
          node.entries.length === 0
            ? 'TermMap::new()'
            : `TermMap::from([${node.entries
                .map(e => `(${rustTextKeys && isText(e.key.type) ? `TermKey::from(${strOf(e.key)})` : expr(e.key)}, ${expr(e.value)})`)
                .join(', ')}])`
        }))`

      case 'closure': {
        // a `move` closure boxed as `Box<dyn Fn>` (owns its captures, so it is `'static` and storable). Reassigned
        // parameters get the same `let mut` shadow functions use, since closure parameters are immutable too. A
        // reassigned name that is a MUTATED CAPTURE keeps its Rc<RefCell> handle instead (no `let mut` shadow).
        const params = node.params.map(p => vname(p.name)).join(', ')
        const mutated = new Set<string>()
        reassigned(node.body, mutated)
        const previousAssignedInClosure = assignedVars
        assignedVars = mutated

        const shadows = node.params
          .filter(p => mutated.has(p.name) && !cellVars.has(p.name))
          .map(p => `let mut ${vname(p.name)} = ${vname(p.name)};`)

        // a closure parameter SHADOWS a same-named cell handle: inside this body the name is the parameter
        const previousCells = cellVars

        if (node.params.some(p => cellVars.has(p.name))) {
          cellVars = new Set(cellVars)
          node.params.forEach(p => cellVars.delete(p.name))
        }

        // inside a closure body, the move-on-last-use set of the enclosing function does not apply (a captured variable
        // cannot be moved out of an `Fn`, and a shadowing closure-local of the same name has different liveness), so
        // clone everything here -- the conservative, always-correct choice.
        const outerMoveArgs = moveArgs
        moveArgs = new Set<string>()
        const previousAsyncInClosure = currentAsync
        currentAsync = Boolean(node.async)
        // a closure answers for ITSELF: its own result (so a `send back` into an unknown result boxes), and it is not
        // the enclosing task's raising body or guard. Its type carries no raise set, so a raise inside it ends the
        // program the way an unhandled raise does. Inheriting the task's state wrapped the closure's returns in the
        // task's `Ok(..)`, which no `Fn` type here returns
        const outerRaising = currentRaising
        const outerGuardDepth = guardDepth
        const outerResult = currentResult
        currentRaising = false
        guardDepth = 0
        // the result the closure was inferred to answer, unless it was left unknown and the parameter it is passed to
        // declares one: then that (set by the call site, consumed here so a nested closure does not inherit it)
        const inferredResult = node.type?.kind === 'function' ? node.type.result : undefined
        const hintedResult = closureHint
        closureHint = undefined
        currentResult =
          node.result ??
          ((!inferredResult || inferredResult.kind === 'unknown') && hintedResult && hintedResult.kind !== 'unknown'
            ? hintedResult
            : inferredResult)
        closureDepth++
        // the locals in scope where the closure is BUILT: rendering the body adds the names it binds itself (a walk's
        // item, its own lets), and those are not captures (render.tree's `each` cloned its own loop's `old`)
        const outerLocals = new Set(localNames)
        const body = [...shadows, ...node.body.map(s => stmt(s, 0))]
          .filter(Boolean)
          .join(' ')
        closureDepth--
        currentRaising = outerRaising
        guardDepth = outerGuardDepth
        currentResult = outerResult
        currentAsync = previousAsyncInClosure
        moveArgs = outerMoveArgs

        // each captured cell handle is cloned BEFORE the `move`, so the closure owns its own Rc and the original
        // handle stays usable after the closure is built (mutations flow both ways through the shared cell)
        const used = new Set<string>()
        usedNames(node.body, used)

        // every other captured local too: a `move` closure takes the outer binding with it, and the enclosing body
        // may read it again after the closure is built (`on-message(made, handler)` then `load-bundle(made, ...)`).
        // Every value here is Clone, and a handle clone shares the same thing
        const paramNames = new Set(node.params.map(p => p.name))
        // and only a name the rendered body actually names: a module-level `host` the body reaches as its thread-local
        // (`MODULE_WATCH`) is no local, and cloning `watch` into the closure named a value that does not exist
        // (native-dom-0020: the memory device host's `watch`)
        const named = (name: string): boolean => new RegExp(`\\b${vname(name)}\\b`).test(body)
        const captured = [...used].filter(
          name => outerLocals.has(name) && !paramNames.has(name) && !cellVars.has(name) && named(name),
        )
        // a mutated capture's cell, under the same rule: a field written through a module-level host
        // (`save watch/installed`) marks `watch` mutated, but the body writes it as `MODULE_WATCH`
        const cells = [...cellVars].filter(name => used.has(name) && named(name))

        // a captured local is cloned at a type this site does not hold (item 0029); a cell is an `Rc` handle
        if (captured.length) {
          cloneRecord.generic = true
        }

        const handleClones = [...cells, ...captured]
          .map(name => `let ${vname(name)} = ${vname(name)}.clone();`)
          .join(' ')

        // an async body is a second `move` (the async block) inside the `Fn`: an `Fn` may not give its captures
        // away, so each one is cloned again inside the closure before the block takes it
        const innerClones = node.async
          ? [...cells, ...captured].map(name => `let ${vname(name)} = ${vname(name)}.clone();`).join(' ')
          : ''

        cellVars = previousCells
        assignedVars = previousAssignedInClosure

        // an async closure becomes a plain `Fn` whose body is a pinned async block: calling it returns a future the
        // caller `.await`s (Rust closures can't themselves be `async`). The `let`/parameter type annotation supplies
        // the `Pin<Box<dyn Future>>` return so the concrete async block coerces to the boxed trait object.
        // a closure whose body is one `return x;` is `move |a| x`, as Rust writes it (clippy: needless_return). Not
        // when the value borrows: a tail expression's temporaries outlive the closure body's locals (see `tailed`)
        const lone = body.trim()
        const expression =
          !node.async &&
          node.body.length === 1 &&
          node.body[0]!.form === 'return' &&
          lone.startsWith('return ') &&
          lone.endsWith(';') &&
          !/\.borrow(_mut)?\(\)|\.lock\(\)|\.with\(/.test(lone)
            ? lone.slice('return '.length, -1)
            : undefined
        const boxed = node.async
          ? `std::rc::Rc::new(move |${params}| { ${innerClones} std::boxed::Box::pin(async move { ${body} }) })`
          : expression !== undefined
            ? `std::rc::Rc::new(move |${params}| ${expression})`
            : `std::rc::Rc::new(move |${params}| { ${body} })`

        return handleClones ? `{ ${handleClones} ${boxed} }` : boxed
      }

      case 'conditional': {
        // a value-position conditional lowers to an if / else-if / else expression chain
        const tail = node.otherwise ? expr(node.otherwise) : '()'

        return node.branches.reduceRight(
          (rest, branch) =>
            `if ${expr(branch.cond)} { ${expr(branch.value)} } else { ${rest} }`,
          tail,
        )
      }

      default:
        return exhausted(node)
    }
  }

  // lower a native map / list operation to rust, going through the Rc<RefCell> handle (`.borrow()` / `.borrow_mut()`).
  // The return shapes match the JS collection API the stdlib forms expect: `set` yields the map (an Rc clone), `delete`
  // / `push` yield a boolean / the new length, `keys` / `values` / list-returning ops materialize a new handle, i64 sizes.
  const wrapList = (vec: string): string =>
    `std::rc::Rc::new(std::cell::RefCell::new(${vec}))`

  const collectionExpr = (
    op: CollectionOp,
    args: Expression[],
  ): string => {
    const target = expr(op.target)
    // an argument is OWNED, the way any value stored into a structure is: cloned unless this is its variable's last
    // use. A bare name here moved the variable into the collection, so `push(started)` followed by a read of
    // `started.dock` was a use after move
    const arg = args.map(owned)

    // the operations that copy a collection's CONTENTS clone its element (or key and value) type (item 0029): a read
    // out, a copy into a new list, the closure operations, and a map insert, whose TermMap asks `Clone` of its key
    const contents =
      op.kind === 'map'
        ? ['get', 'set', 'keys', 'values'].includes(op.op)
        : ['at', 'get', 'concat', 'slice', 'toReversed', 'map', 'filter', 'some', 'every', 'reduce', 'findIndex', 'flat'].includes(op.op)

    if (contents) {
      const held = op.target.type

      if (held?.kind === 'array') {
        noteClone(held.element)
      } else if (held?.kind === 'map') {
        noteClone(held.key)
        noteClone(held.value)
      } else {
        cloneRecord.generic = true
      }
    }

    if (op.kind === 'map') {
      // a text key is looked up borrowed (`TermMap`'s `Borrow` lookups), a `String` key and a `TermKey` alike, and a
      // key stored into a map of `TermKey`s (`rustTextKeys`) is made one
      const textKey = op.target.type?.kind === 'map' && isText(op.target.type.key)
      const stored = (): string => (textKey && rustTextKeys ? `TermKey::from(${strOf(args[0]!)})` : arg[0]!)

      switch (op.op) {
        case 'has':
          return textKey ? `${target}.borrow().has_text(${strOf(args[0]!)})` : `${target}.borrow().contains_key(&${arg[0]})`
        case 'get':
          return textKey ? `${target}.borrow().get_text(${strOf(args[0]!)}).cloned().unwrap()` : `${target}.borrow().get(&${arg[0]}).cloned().unwrap()`
        case 'set':
          // the key and value first: a value that reads the same map (`set(k, add(get-or-default(m, k), 1))`) would
          // otherwise find it already borrowed mutably, and RefCell panics
          return `{ let __set_key = ${stored()}; let __set_value = ${arg[1]}; ${target}.borrow_mut().insert(__set_key, __set_value); ${target}.clone() }`
        case 'delete':
          return textKey ? `${target}.borrow_mut().remove_text(${strOf(args[0]!)}).is_some()` : `${target}.borrow_mut().remove(&${arg[0]}).is_some()`
        case 'keys':
          // a `TermKey` read out is a `String` again
          return wrapList(
            textKey && rustTextKeys
              ? `${target}.borrow().keys().map(|k| k.as_str().to_string()).collect::<Vec<_>>()`
              : `${target}.borrow().keys().cloned().collect::<Vec<_>>()`,
          )
        case 'values':
          return wrapList(
            `${target}.borrow().values().cloned().collect::<Vec<_>>()`,
          )
        default:
          return ''
      }
    }

    // arrays go through the Rc<RefCell<Vec>> handle. The closure ops take a `Box<dyn Fn>` and clone each element into
    // it; an op returning a list materializes a new handle (`wrapList`); the in-place ops use `borrow_mut`.
    // a lent list (`&[T]`, `&mut [T]`) or an owned Vec is read as itself, a shared one through its cell
    const data = view(op.target, false)

    switch (op.op) {
      case 'push':
        // the item first, for the reason `set` gives: `out/push(get(out, k))` reads the list it pushes onto. An owned
        // local is the `Vec` itself (ownedLocals), pushed without a cell
        if (op.target.form === 'variable' && ownedNames.has(op.target.name)) {
          const list = vname(op.target.name)

          return `{ let __push_item = ${arg[0]}; ${list}.push(__push_item); ${list}.len() as i64 }`
        }

        return `{ let __push_item = ${arg[0]}; ${target}.borrow_mut().push(__push_item); ${data}.len() as i64 }`
      case 'pop':
        return `${target}.borrow_mut().pop().unwrap()`
      case 'at':
      case 'get':
        return `${data}[${asUsize(arg[0]!)}].clone()`
      case 'set':
        // the value and the index first: a value that reads the same list (`set(at, or(get(at), bit))`) would
        // otherwise find it already borrowed mutably, and RefCell panics
        return `{ let __set_value = ${arg[1]}; let __set_index = ${asUsize(arg[0]!)}; ${target}.borrow_mut()[__set_index] = __set_value; }`
      case 'includes':
        return `${data}.contains(&${arg[0]})`
      case 'indexOf':
        return `${data}.iter().position(|e| *e == ${arg[0]}).map(|i| i as i64).unwrap_or(-1)`
      case 'lastIndexOf':
        return `${data}.iter().rposition(|e| *e == ${arg[0]}).map(|i| i as i64).unwrap_or(-1)`
      case 'concat':
        // one allocation of the final length: `[a.clone(), b.clone()].concat()` built both copies and then a third
        return wrapList(
          `{ let __a = ${data}; let __b = ${arg[0]}; let __b = __b.borrow(); let mut __v = Vec::with_capacity(__a.len() + __b.len()); __v.extend_from_slice(&__a); __v.extend_from_slice(&__b); __v }`,
        )
      case 'slice':
        // both bounds clamped to the length, empty when start reaches end, never counted from the end
        // (note/term/stdlib/semantics.md); one argument slices to the end
        return wrapList(
          `{ let __d = ${data}; let __n = __d.len() as i64; let __x = (${arg[0]}).max(0).min(__n) as usize; let __y = (${arg[1] ?? '__n'}).max(0).min(__n) as usize; if __x < __y { __d[__x..__y].to_vec() } else { Vec::new() } }`,
        )
      case 'toReversed':
        return wrapList(
          `${data}.iter().rev().cloned().collect::<Vec<_>>()`,
        )
      case 'join': {
        // each item as `to-text` renders it, so a float reads as on every backend. A list of texts joins as it is,
        // where each was formatted again into a new `String` (clippy: useless_format), and a literal separator is the
        // `&str` it is rather than a `String` made to be borrowed (unnecessary_to_owned)
        const element = op.target.type?.kind === 'array' ? op.target.type.element.kind : undefined
        const literal = /^("(?:[^"\\]|\\.)*")\.to_string\(\)$/.exec(arg[0] ?? '')
        const separator = literal ? literal[1]! : `&${arg[0]}`

        return element === 'float'
          ? `${data}.iter().map(|e| term_number(*e)).collect::<Vec<_>>().join(${separator})`
          : element === 'string'
            ? `${data}.join(${separator})`
            : `${data}.iter().map(|e| format!("{}", e)).collect::<Vec<_>>().join(${separator})`
      }
      case 'map':
        return wrapList(
          `${data}.iter().map(|e| ${arg[0]}(e.clone())).collect::<Vec<_>>()`,
        )
      case 'filter':
        return wrapList(
          `${data}.iter().filter(|e| ${arg[0]}((*e).clone())).cloned().collect::<Vec<_>>()`,
        )
      case 'some':
        return `${data}.iter().any(|e| ${arg[0]}(e.clone()))`
      case 'every':
        return `${data}.iter().all(|e| ${arg[0]}(e.clone()))`
      case 'reduce':
        return `${data}.iter().fold(${arg[1]}, |acc, e| ${arg[0]}(acc, e.clone()))`
      case 'findIndex':
        return `${data}.iter().position(|e| ${arg[0]}(e.clone())).map(|i| i as i64).unwrap_or(-1)`
      case 'flat':
        // one level of nesting removed when the items are lists; a copy otherwise (JS `[1,2,3].flat()` is `[1,2,3]`)
        return wrapList(
          op.target.type?.kind === 'array' && op.target.type.element.kind === 'array'
            ? `${data}.iter().flat_map(|e| e.borrow().clone()).collect::<Vec<_>>()`
            : `${data}.clone()`,
        )
      case 'unshift':
        // insert at the front, returning the new length (JS `unshift`)
        return `{ let __push_item = ${arg[0]}; let mut __b = ${target}.borrow_mut(); __b.insert(0, __push_item); __b.len() as i64 }`
      case 'shift':
        // remove and return the front element (JS `shift`); callers guard against empty
        return `${target}.borrow_mut().remove(0)`

      case 'splice': {
        // JS `splice(start, deleteCount, ...items)`: remove `deleteCount` at `start`, insert the items, in place
        const items = arg.slice(2).join(', ')

        // the start clamped to the length and the count to what remains (semantics.md)
        return `{ let __start = ${arg[0]}; let __drop = ${arg[1]}; let __items = vec![${items}]; let mut __b = ${target}.borrow_mut(); let __n = __b.len() as i64; let __s = (__start).max(0).min(__n); let __d = (__drop).max(0).min(__n - __s); let (__s, __d) = (__s as usize, __d as usize); let _: Vec<_> = __b.splice(__s..__s + __d, __items).collect(); 0i64 }`
      }

      default:
        return ''
    }
  }

  // the assignment-target text when the target is (rooted at) a mutated capture: the bare variable writes through
  // `*x.borrow_mut()`, a plain field chain through `x.borrow_mut().field`. Undefined when the target is not cell-boxed
  // (or is an indexed segment, which keeps the default rendering).
  const cellAssignTarget = (target: Expression): string | undefined => {
    if (target.form === 'variable' && cellVars.has(target.name)) {
      return `*${vname(target.name)}.borrow_mut()`
    }

    if (target.form === 'member') {
      const fields: string[] = []
      let node: Expression = target

      while (node.form === 'member' && !node.index) {
        fields.unshift(snake(node.name))
        node = node.target
      }

      if (
        node.form === 'variable' &&
        cellVars.has(node.name) &&
        fields.length > 0
      ) {
        return `${vname(node.name)}.borrow_mut().${fields.join('.')}`
      }
    }

    return undefined
  }

  // a member chain. A native module alias path (`fs/read-to-string`) is a Rust `::` path; a value field access is `.`
  const memberPath = (node: Expression): string => {
    if (node.form === 'member') {
      // a `subject/field` read inside a match arm that narrowed `subject` to a variant resolves to the bound local
      if (node.target.form === 'variable') {
        const variant = narrowing.get(node.target.name)

        if (
          variant &&
          variantFields.get(variant)?.includes(node.name)
        ) {
          return snake(node.name)
        }
      }

      const root = rootVariable(node)
      // a parameter or local of the same name as a dock alias (`take time` beside `load <global:time>, name time`) is the
      // value, not the module
      const separator = root && aliases.has(root) && !localNames.has(root) ? '::' : '.'

      // a field of a `mark shared` value is read through its handle
      if (isSharedType(node.target.type)) {
        return `${memberPath(node.target)}.borrow().${snake(node.name)}`
      }

      // a slot of a list in the middle of a path (`dots/0/x`, `dots/{k}/x`) is that list's own read, which indexes it
      // (`expr`'s member case): `.0` would be a tuple field, which no Vec has (E0609)
      // It is a PLACE here, a field read or written off it next, so it is the list's view indexed (`ps[k]`,
      // `ps.borrow()[k]`) where it was the element cloned out (`(ps[k].clone()).xs`), a whole record copied to read
      // one field of it (Particle, every coordinate read and written through `ps/{k}/xs/{i}`)
      if ((node.index !== undefined || /^\d+$/.test(node.name)) && node.target.type?.kind === 'array') {
        const index = node.index ? expr(node.index) : node.name

        return `${view(node.target, writingPath)}[${asUsize(index)}]`
      }

      return `${memberPath(node.target)}${separator}${snake(node.name)}`
    }

    // a field read straight off a construction (`(Duration { nanoseconds: 0 }).nanoseconds`): bare, a struct literal
    // in an `if` condition is refused by rustc
    if (node.form === 'record') {
      return `(${expr(node)})`
    }

    return expr(node)
  }

  // the bytes of a text, borrowed: a literal as it is, anything else through `as_bytes`
  const bytesOf = (target: Expression): string => {
    const text = expr(target)
    const literal = STATIC_TEXT.test(text)

    return literal ? `${text.slice(0, -'.to_string()'.length)}.as_bytes()` : `${/^[\w.]+$/.test(text) ? text : `(${text})`}.as_bytes()`
  }

  // a text borrowed as a `&str`: a literal as it is, a borrowed parameter as it is, anything else through `&`
  const strOf = (target: Expression): string => {
    const text = expr(target)

    if (STATIC_TEXT.test(text)) {
      return text.slice(0, -'.to_string()'.length)
    }

    return target.form === 'variable' && (borrowedNames.has(target.name) || sliceNames.has(target.name))
      ? text
      : `&${/^[\w.]+$/.test(text) ? text : `(${text})`}`
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

  // `char-at` and `char-code-at` of an ASCII text (ir/facts/text.ts): a byte read, with the same answer past either end
  // as the code-point read, the empty text and -1
  const asciiRead = (op: string, target: Expression, index: Expression): string => {
    const at = expr(index)

    return op === 'charCodeAt'
      ? `{ let b = ${bytesOf(target)}; let i = ${bare(at)}; if i >= 0 && (i as usize) < b.len() { b[i as usize] as i64 } else { -1 } }`
      : `{ let b = ${bytesOf(target)}; let i = ${bare(at)}; if i >= 0 && (i as usize) < b.len() { (b[i as usize] as char).to_string() } else { String::new() } }`
  }

  // JavaScript's string methods over rust's String (see backend.ts, STRING_METHODS). Positions count chars; a read
  // past the end is empty (charAt) or 0 (charCodeAt), never a panic. Each borrows the receiver, so a local read here
  // is not moved away.
  const stringExpr = (op: string, target: string, a: string[]): string => {
    // a text LITERAL is borrowed as it is, not built into a String to be borrowed (clippy: unnecessary_to_owned)
    const literal = STATIC_TEXT.test(target)
    const t = target
    // a borrowed text parameter is a `&str` already, used as it is (clippy: needless_borrow)
    const lent = [...borrowedNames].some(name => vname(name) === target)
    const borrow = literal ? target.slice(0, -'.to_string()'.length) : lent ? target : `&${target}`
    // a position clamped at zero: an integer literal is clamped here, at emit time (clippy: unnecessary_min_or_max)
    // (typed `i64`: a bare `1.min(n)` is an ambiguous numeric type, E0689)
    const atLeastZero = (x: string): string => (/^-?\d+$/.test(x) ? `${Math.max(Number(x), 0)}i64` : `(${x}).max(0)`)

    // the position read once, into `i`, unless it is a variable named `i` already (clippy: redundant_locals)
    const position = a[0] === 'i' ? '' : `let i = ${a[0]}; `

    switch (op) {
      case 'charAt':
      case 'at':
        return `{ let h: &str = ${borrow}; ${position}if i < 0 { String::new() } else { h.chars().nth(i as usize).map(|c| c.to_string()).unwrap_or_default() } }`
      case 'charCodeAt':
        return `{ let h: &str = ${borrow}; ${position}if i < 0 { -1i64 } else { h.chars().nth(i as usize).map(|c| c as i64).unwrap_or(-1) } }`
      case 'indexOf':
        return `{ let h: &str = ${borrow}; let n: String = ${a[0]}; let from = ${atLeastZero(a[1] ?? '0')} as usize; let start = h.char_indices().nth(from).map(|(b, _)| b).unwrap_or(h.len()); match h[start..].find(n.as_str()) { Some(b) => h[..start + b].chars().count() as i64, None => -1 } }`
      case 'lastIndexOf':
        return `{ let h: &str = ${borrow}; let n: String = ${a[0]}; match h.rfind(n.as_str()) { Some(b) => h[..b].chars().count() as i64, None => -1 } }`
      case 'split':
        return `std::rc::Rc::new(std::cell::RefCell::new({ let h: &str = ${borrow}; let d: String = ${a[0]}; if d.is_empty() { h.chars().map(|c| c.to_string()).collect::<Vec<String>>() } else { h.split(d.as_str()).map(|s| s.to_string()).collect::<Vec<String>>() } }))`
      case 'substring':
      case 'slice':
        return `{ let h: &str = ${borrow}; let n = h.chars().count() as i64; let x = ${atLeastZero(a[0]!)}.min(n); let y = ${atLeastZero(a[1] ?? 'n')}.min(n); let (x, y) = if x <= y { (x, y) } else { (y, x) }; h.chars().skip(x as usize).take((y - x) as usize).collect::<String>() }`
      case 'toLowerCase':
        return `${t}.to_lowercase()`
      case 'toUpperCase':
        return `${t}.to_uppercase()`
      case 'startsWith':
        return `{ let n: String = ${a[0]}; ${t}.starts_with(n.as_str()) }`
      case 'endsWith':
        return `{ let n: String = ${a[0]}; ${t}.ends_with(n.as_str()) }`
      case 'trim':
        return `${t}.trim().to_string()`
      case 'trimStart':
        return `${t}.trim_start().to_string()`
      case 'trimEnd':
        return `${t}.trim_end().to_string()`
      // the fill repeats and is cut so the result is exactly the width in code points (semantics.md)
      // the receiver BORROWED, as every method here borrows it: `let o: String = r.name` moved a field out of a record
      // read in a loop, E0507 (the time/table port, 2026-10-04). Owned only where it is the answer unchanged
      case 'padStart':
        return `{ let o: &str = ${borrow}; let f: Vec<char> = (${a[1]}).chars().collect(); let n = o.chars().count() as i64; let w: i64 = ${a[0]}; if n >= w || f.is_empty() { o.to_string() } else { let p: String = (0..(w - n) as usize).map(|i| f[i % f.len()]).collect(); format!("{}{}", p, o) } }`
      case 'padEnd':
        return `{ let o: &str = ${borrow}; let f: Vec<char> = (${a[1]}).chars().collect(); let n = o.chars().count() as i64; let w: i64 = ${a[0]}; if n >= w || f.is_empty() { o.to_string() } else { let p: String = (0..(w - n) as usize).map(|i| f[i % f.len()]).collect(); format!("{}{}", o, p) } }`
      case 'replace':
        return `{ let a: String = ${a[0]}; let b: String = ${a[1]}; ${t}.replacen(a.as_str(), b.as_str(), 1) }`
      case 'replaceAll':
        return `{ let a: String = ${a[0]}; let b: String = ${a[1]}; ${t}.replace(a.as_str(), b.as_str()) }`
      case 'includes':
        return `{ let n: String = ${a[0]}; ${t}.contains(n.as_str()) }`
      case 'concat':
        return `format!("{}{}", ${t}, ${a[0]})`
      case 'repeat':
        return `${t}.repeat((${a[0]}).max(0) as usize)`
      case 'compare':
        // byte order of UTF-8 is code point order (semantics.md)
        return `{ let a: &str = &${t}; let b: String = ${a[0]}; match a.cmp(b.as_str()) { std::cmp::Ordering::Less => -1i64, std::cmp::Ordering::Equal => 0i64, std::cmp::Ordering::Greater => 1i64 } }`
      default:
        return ''
    }
  }

  const block = (body: Statement[], d: number): string => {
    const lines: string[] = []

    for (let at = 0; at < body.length; at++) {
      // an owned list made empty and pushed straight onto is the `vec![..]` of those items (clippy:
      // vec_init_then_push), `mut` only when something after still writes it
      const start = body[at]!

      if (
        start.form === 'let' &&
        ownedNames.has(start.name) &&
        start.init.form !== 'call' &&
        start.type?.kind === 'array'
      ) {
        const items: Expression[] = []
        let next = at + 1

        for (; next < body.length; next++) {
          const s = body[next]!
          // `list_push(out, v)`, or the collection operation it inlines to, `out.push(v)`
          const call = s.form === 'expression' && s.expr.form === 'call' ? s.expr : undefined
          const op = call?.callee.form === 'member' ? collectionCall(call.callee) : undefined
          const item =
            call?.callee.form === 'variable' &&
            call.callee.name === 'list_push' &&
            call.args[0]?.form === 'variable' &&
            call.args[0].name === start.name
              ? call.args[1]
              : op?.kind === 'array' && op.op === 'push' && op.target.form === 'variable' && op.target.name === start.name
                ? call!.args[0]
                : undefined

          if (!item || namesIn(item).has(start.name)) {
            break
          }

          items.push(item)
        }

        if (items.length) {
          const later = writesTo(body.slice(next), start.name, lendParams)
          lines.push(`${pad(d)}let ${later ? 'mut ' : ''}${vname(start.name)}: Vec<${rustElement(start.type)}> = vec![${items.map(i => bare(owned(i))).join(', ')}];`)
          at = next - 1
          continue
        }
      }

      // the three-statement swap of two slots is `slice::swap`, under one `borrow_mut` where it took four borrows
      const swap = swapAt(body, at)

      if (swap) {
        lines.push(`${pad(d)}${view(swap.list, true)}.swap(${asUsize(expr(swap.first))}, ${asUsize(expr(swap.second))});`)
        at += 2
        continue
      }

      // a statement that writes nothing (a slot alias read only once, `slotTakes`) leaves no line
      const line = stmt(body[at]!, d)

      if (line) {
        lines.push(`${pad(d)}${line}`)
      }
    }

    return lines.join('\n')
  }

  const stmt = (node: Statement, d: number): string => {
    // the uses of each name are counted per statement, for the last of several reads (`manyMoves`)
    if (node.form === 'let' || node.form === 'assign' || node.form === 'expression' || node.form === 'return') {
      statementUses = new Map()
    }

    switch (node.form) {
      case 'let': {
        // a bare `save x`, given its value by a later assignment: declared with its type and no value, which rustc
        // takes when every path assigns before a read. It was `let mut x = ;` (2026-10-05)
        if (declaredLater(node)) {
          return `let mut ${vname(node.name)}: ${rustType(node.type)};`
        }

        // a local that is a list slot until its last read (`slotTakes`): a reference to the slot where something reads
        // it first, and nothing at all where the last read is the only one
        const aliased = slotLets.get(node)

        if (aliased) {
          return aliased.kept ? `let ${vname(node.name)} = &${vname(aliased.list)}[${asUsize(expr(aliased.index))}];` : ''
        }

        // an inner list read out of a list of lists that owns it (`ownedElements`), only read after: borrowed from a
        // plain list, and read in place. Out of a shared cell it is cloned, since a borrow held for the rest of the
        // scope would refuse a later push onto the outer list
        if (ownsInner(elementLists.lets, node) && node.init.form === 'member' && node.init.target.form === 'variable') {
          const list = node.init.target.name
          const index =
            node.init.index ??
            ({ form: 'integer', value: Number(node.init.name), span: node.init.span, type: { kind: 'number' } } as Expression)

          lentNames.set(node.name, 'read')

          if (lentNames.has(list)) {
            return `let ${vname(node.name)} = &${vname(list)}[${asUsize(expr(index))}];`
          }

          ownedNames.set(node.name, false)
          noteClone(node.type)

          return `let ${vname(node.name)} = ${expr(node.init.target)}.borrow()[${asUsize(expr(index))}].clone();`
        }

        // a local only ever a map key, made from an ASCII substring, is a `&str` into the text (`sliceLets`)
        if (sliceLets.has(node)) {
          borrowSlice = true
          const slice = expr(node.init)
          borrowSlice = false

          return `let ${vname(node.name)}: &str = ${slice};`
        }

        // an owned list local is a plain `Vec` (ownedLocals): made empty, or taken as it is from a fresh task
        if (ownedNames.has(node.name) && node.type?.kind === 'array') {
          const mutable = ownedNames.get(node.name) ? 'mut ' : ''

          // a fixed list of a literal size made by a fill is an array on the stack (`stackLists`)
          const fill = stackNames.has(node.name) ? fillCall(node.init, fills) : undefined

          if (fill && fill.size.form === 'integer' && Number(fill.size.value) >= 0 && Number(fill.size.value) <= 4096) {
            return `let ${mutable}${vname(node.name)} = [${bare(expr(fill.item))}; ${Number(fill.size.value)}];`
          }

          if (node.init.form === 'call') {
            rawFresh = true
            const made = expr(node.init)
            rawFresh = false

            return `let ${mutable}${vname(node.name)} = ${made};`
          }

          return `let ${mutable}${vname(node.name)}: Vec<${rustElement(node.type)}> = Vec::new();`
        }

        // the gradual boundary on a binding: `host record, like test-entry / read entry/base` re-types the
        // boxed dynamic at a declared FORM, which on rust is a downcast out of the box
        if (
          node.type?.kind === 'named' &&
          node.init.form === 'member' &&
          recordFields.has(node.type.name) &&
          (node.init.type?.kind === 'unknown' ||
            node.init.type?.kind === 'dynamic')
        ) {
          noteClone(node.type)

          return `let ${mutOf(node.name)}${vname(node.name)} = ${expr(node.init)}.downcast_ref::<${rustType(node.type)}>().unwrap().clone();`
        }

        // a MUTATED CAPTURE is declared as its Rc<RefCell> handle (reads / writes go through the cell)
        if (cellVars.has(node.name)) {
          return `let ${vname(
            node.name,
          )} = std::rc::Rc::new(std::cell::RefCell::new(${expr(
            node.init,
          )}));`
        }

        // an async closure stored in a local needs its boxed-future type spelled out, so the concrete async block
        // coerces to `Box<dyn Fn(..) -> Pin<Box<dyn Future>>>` and the parameter types are pinned down.
        const ann =
          node.init.form === 'closure' && node.init.async
            ? `: ${rustType({
                kind: 'function',
                params: node.init.params.map(
                  (p): Type => p.type ?? { kind: 'unknown' },
                ),
                result: node.init.result ?? { kind: 'unknown' },
                effects: ['async'],
              })}`
            : ''

        // a local declared `like unknown` boxes its concrete init, so every later read is already the boxed dynamic
        if (node.type?.kind === 'unknown' && node.init.type?.kind !== 'unknown') {
          return `let ${mutOf(node.name)}${vname(node.name)}: std::rc::Rc<dyn std::any::Any> = std::rc::Rc::new(${owned(node.init)});`
        }

        // a call whose type argument nothing ever constrains (a deque made and only asked whether it is empty) leaves
        // rustc nothing to infer: the argument is any type, so the binding names it `()`
        const initCall =
          node.init.form === 'call' ? node.init : node.init.form === 'await' && node.init.expr.form === 'call' ? node.init.expr : undefined
        const free = new Set<number>()

        if (initCall && node.type?.kind === 'named' && (node.type.args?.length ?? 0) > 0) {
          collectVars(node.type, free)

          for (const id of [...free]) {
            if (rustVarNames.has(id)) {
              free.delete(id)
            }
          }
        }

        if (free.size > 0) {
          const saved = rustVarNames
          rustVarNames = new Map([...saved, ...[...free].map(id => [id, '()'] as const)])
          const closed = rustType(node.type!)
          rustVarNames = saved

          return `let ${mutOf(node.name)}${vname(node.name)}: ${closed} = ${bare(owned(node.init))};`
        }

        return `let ${mutOf(node.name)}${vname(node.name)}${ann || emptyAnn(node.init)} = ${bare(owned(node.init))};`
      }
      case 'assign': {
        // an assignment to a mutated capture writes through the cell: `*x.borrow_mut() = v`, and a field of a
        // cell-boxed struct writes through the borrowed root: `x.borrow_mut().field = v`. The value computes into a
        // temporary FIRST: a `x.borrow()` inside it is a temporary `Ref` guard that lives to the end of its whole
        // statement, so evaluating it in the same statement as the `borrow_mut` would panic at run time
        // (`RefCell already borrowed`). The inner `let` scopes that guard to its own statement.
        // a write to a module SLOT fills the thread_local's Option
        if (
          node.target.form === 'variable' &&
          moduleSlots.has(node.target.name) &&
          !localNames.has(node.target.name)
        ) {
          return `{ let __slot_value = ${bare(owned(node.value))}; ${moduleConstName(node.target.name)}.with(|v| *v.borrow_mut() = Some(__slot_value)); }`
        }

        // a write to a field of a `mark shared` value goes through its handle, the value computed first so no read
        // borrow of the same object is alive at the write
        if (node.target.form === 'member' && !node.target.index && isSharedType(node.target.target.type)) {
          return `{ let __shared_value = ${bare(owned(node.value))}; ${memberPath(node.target.target)}.borrow_mut().${snake(node.target.name)} ${node.op} __shared_value; }`
        }

        // a write to a list slot or a map entry by a COMPUTED key (`save slots/{value}, ...`): the read of the target
        // emits `slots.borrow()[i].clone()`, a value, which is no place to assign to (E0070). The write goes through
        // `borrow_mut`, with the value and the key computed first so no `borrow()` guard is alive at the write
        // A literal slot, `save xs/0, ...`, is a member named `0`: the same write at that index
        const literalSlot =
          node.target.form === 'member' &&
          !node.target.index &&
          /^\d+$/.test(node.target.name) &&
          node.target.target.type?.kind === 'array'
            ? ({ form: 'integer', value: Number(node.target.name), span: node.target.span, type: { kind: 'number' } } as Expression)
            : undefined

        if (node.target.form === 'member' && (node.target.index || literalSlot)) {
          const holder = node.target.target
          const kind = holder.type?.kind
          const named = holder.type?.kind === 'named' ? holder.type.name : undefined
          const slot = node.target.index ?? literalSlot!

          if (kind === 'array' || named === 'list') {
            // a `Copy` variable or literal written at a variable or literal index borrows nothing, so it is written
            // in place. Anything else computes first, so no `borrow()` guard is alive at the `borrow_mut`
            const simple = (e: Expression): boolean => e.form === 'variable' || e.form === 'integer' || e.form === 'float' || e.form === 'boolean'

            if (simple(node.value) && copyType(node.value.type) && simple(slot) && !(node.value.form === 'variable' && cellVars.has(node.value.name))) {
              return `${view(holder, true)}[${asUsize(expr(slot))}] ${node.op} ${expr(node.value)};`
            }

            return `{ let __index_value = ${bare(owned(node.value))}; let __index = ${asUsize(expr(slot))}; ${view(holder, true)}[__index] ${node.op} __index_value; }`
          }

          if ((kind === 'map' || named === 'hash') && node.op === '=' && node.target.index) {
            const index = node.target.index
            const key = rustTextKeys && isText(index.type) ? `TermKey::from(${strOf(index)})` : bare(owned(index))

            return `{ let __index_value = ${bare(owned(node.value))}; let __index = ${key}; ${expr(holder)}.borrow_mut().insert(__index, __index_value); }`
          }
        }

        // a text variable reset to the empty text keeps its storage, `s.clear()`: `s = "".to_string()` freed it, and a
        // line built again after it grew from nothing, a reallocation at 8, 16, 32 and 64 bytes per line
        if (
          node.op === '=' &&
          node.target.form === 'variable' &&
          node.target.type?.kind === 'string' &&
          emptyText(node.value) &&
          !cellVars.has(node.target.name) &&
          !borrowedNames.has(node.target.name)
        ) {
          return `${vname(node.target.name)}.clear();`
        }

        // an append to a text variable writes in place, `s.push_str(..)`, where `format!` copied the whole text every
        // time (backend.ts, `textAppend`). Not a captured cell, whose text lives behind a RefCell
        const append = textAppend(node)

        if (append && !cellVars.has(append.name)) {
          const rest = append.rest as Extract<Expression, { form: 'template' }>
          const target = vname(append.name)
          const [only] = rest.parts

          // a literal: one character is `push` (clippy: single_char_add_str), more is `push_str`
          if (rest.parts.every(p => typeof p === 'string')) {
            const literal = (rest.parts as string[]).join('')

            return [...literal].length === 1 ? `${target}.push(${rustChar(literal)});` : `${target}.push_str(${rustString(literal)});`
          }

          // one character of an ASCII text is pushed as the char, with no one-character String made for it
          if (rest.parts.length === 1 && typeof only !== 'string' && only!.form === 'call' && only!.callee.form === 'member') {
            const text = stringCall(only!.callee)

            if (text && asciiNodes.has(text.target) && (text.op === 'charAt' || text.op === 'at')) {
              return `{ let b = ${bytesOf(text.target)}; let i = ${bare(expr(only!.args[0]!))}; if i >= 0 && (i as usize) < b.len() { ${target}.push(b[i as usize] as char); } }`
            }
          }

          // one character read through a cursor is pushed as the char
          if (rest.parts.length === 1 && typeof only !== 'string' && only!.form === 'call' && only!.callee.form === 'member') {
            const text = stringCall(only!.callee)
            const cursor = cursors.reads.get(only!)

            if (text && cursor !== undefined && text.op !== 'charCodeAt') {
              return `if let Some(c) = term_cursor(${strOf(text.target)}, ${bare(expr(only!.args[0]!))}, &mut ${cursorName(cursor)}) { ${target}.push(c); }`
            }
          }

          // one text value alone is pushed as itself, borrowed; the text itself (`<{s}{s}>`) is copied first, since
          // it cannot be read while it is written
          if (rest.parts.length === 1 && typeof only !== 'string' && textValued(only!)) {
            const self = only!.form === 'variable' && only!.name === append.name

            return `${target}.push_str(&${self ? `${target}.clone()` : bare(expr(only!))});`
          }

          return `${target}.push_str(&${expr(append.rest)});`
        }

        const cellTarget = cellAssignTarget(node.target)

        if (cellTarget) {
          return `{ let __cell_value = ${bare(
            expr(node.value),
          )}; ${cellTarget} ${node.op} __cell_value; }`
        }

        // `i = i + 1` is `i += 1` where the arithmetic is written plain: a step the range fact proved, or a float.
        // A checked integer step stays the `checked_add` call. clippy flagged every one (assign_op_pattern)
        if (
          node.op === '=' &&
          node.target.form === 'variable' &&
          node.value.form === 'binary' &&
          (node.value.op === '+' || node.value.op === '-' || node.value.op === '*') &&
          node.value.left.form === 'variable' &&
          node.value.left.name === node.target.name &&
          (provenSteps.has(node.value) || node.value.type?.kind === 'float') &&
          node.value.right.type?.kind !== 'string'
        ) {
          return `${expr(node.target)} ${node.value.op}= ${bare(expr(node.value.right))};`
        }

        // and any other step the emitter already wrote as plain arithmetic (`left / 2`, a division by a nonzero literal
        // other than -1, which cannot overflow): read off the emitted text, so it is compound exactly when it is plain
        if (
          node.op === '=' &&
          node.target.form === 'variable' &&
          node.value.form === 'binary' &&
          ['+', '-', '*', '/', '%'].includes(node.value.op) &&
          node.value.left.form === 'variable' &&
          node.value.left.name === node.target.name &&
          node.value.right.type?.kind !== 'string'
        ) {
          const target = expr(node.target)
          const right = expr(node.value.right)

          if (bare(owned(node.value)) === `${target} ${node.value.op} ${right}`) {
            return `${target} ${node.value.op}= ${bare(right)};`
          }
        }

        if (node.op === '=') {
          const target = expr(node.target)
          const value = bare(owned(node.value))

          // a list reassigned from a value that borrows it, `seen = merge(&seen.borrow(), ..)`: the `Ref` guard is a
          // temporary that lives to the end of the statement, past the write (E0506). The value computes first, in its
          // own statement, so the guard is gone by the write
          if (node.target.form === 'variable' && new RegExp(`(^|[^\\w.])${target.replace(/[^\w]/g, '\\$&')}\\.borrow\\(\\)`).test(value)) {
            return `{ let __assigned = ${value}; ${target} = __assigned; }`
          }

          return `${target} = ${value};`
        }

        return `${expr(node.target)} ${node.op} ${bare(expr(node.value))};`
      }
      case 'expression':
        // a push onto an owned list whose new length nothing reads is the Vec's `push`, as Rust writes it
        if (
          node.expr.form === 'call' &&
          node.expr.callee.form === 'variable' &&
          node.expr.callee.name === 'list_push' &&
          node.expr.args[0]?.form === 'variable' &&
          ownedNames.has(node.expr.args[0].name)
        ) {
          return `${vname(node.expr.args[0].name)}.push(${bare(owned(node.expr.args[1]!))});`
        }

        // the same through the collection operation `list_push` inlines to, `out.push(v)`
        if (node.expr.form === 'call' && node.expr.callee.form === 'member') {
          const op = collectionCall(node.expr.callee)

          if (op?.kind === 'array' && op.op === 'push' && op.target.form === 'variable' && ownedNames.has(op.target.name)) {
            return `${vname(op.target.name)}.push(${bare(owned(node.expr.args[0]!))});`
          }
        }

        // a map entry updated from its own value is one probe through `upsert`, the key moved in where its last use
        // allows (backend.ts, `mapUpdate`): it hashed the key twice and cloned it for each
        const update = mapUpdate(node)

        if (
          update &&
          update.map.form === 'variable' &&
          !cellVars.has(update.map.name) &&
          (!moduleConsts.has(update.map.name) || localNames.has(update.map.name)) &&
          update.map.type?.kind === 'map' &&
          (update.map.type.value.kind === 'number' || update.map.type.value.kind === 'float')
        ) {
          const step = bare(expr(update.step))
          // a decimal sum is `+=` (clippy: assign_op_pattern); an integer one stays checked
          const write =
            update.map.type.value.kind === 'number'
              ? `*__value = i64::checked_add(*__value, ${step}).expect("excess: a number past i64");`
              : `*__value += ${step};`

          // a text key is looked up borrowed and made a String only when it is new
          // `::<str>` when the key is a reference TO an owned String (`&v`): `upsert_ref` is generic over the borrowed
          // key, so that inferred `Q = String`, which a map of `TermKey`s cannot lend (`TermKey: Borrow<String>` is not
          // satisfied, the ir/perceus port, 2026-10-04). Pinned to `str`, the `&String` coerces, and a map of `String`
          // keys lends a `str` as well. A key that is already a `&str` (a borrowed or sliced name) is written as before
          const key = isText(update.key.type) ? strOf(update.key) : ''
          const upsert = isText(update.key.type)
            ? `upsert_ref${key.startsWith('&') ? '::<str>' : ''}(${key}`
            : `upsert(${bare(owned(update.key))}`

          return `{ let mut __map = ${vname(update.map.name)}.borrow_mut(); let __value = __map.${upsert}, ${bare(expr(update.fallback))}); ${write} }`
        }

        // a ticked call is queued by the call emission itself (`case 'call'`, `background`)
        return `${expr(node.expr)};`
      case 'return': {

        // an owned list local leaves whole: the Vec itself from a fresh task, otherwise into the shared cell
        const ownedOut = node.value?.form === 'variable' && ownedNames.has(node.value.name) && closureDepth === 0
        // a field read off a walk item held BY REFERENCE (`borrowedNames`, the walk's `byRef`) is cloned out: returned
        // as it is, `return one.ascii` moved out of the borrow (E0507), found by the terminal output library's
        // `find-symbol`, 2026-10-04
        const offBorrow =
          node.value?.form === 'member' && !node.value.index && node.value.target.form === 'variable' && borrowedNames.has(node.value.target.name)
        // a list-returning function that returns a native dock call directly wraps the shim's plain `Vec`
        const value = ownedOut
          ? emittingFresh
            ? vname((node.value as Extract<Expression, { form: 'variable' }>).name)
            : `std::rc::Rc::new(std::cell::RefCell::new(${vname((node.value as Extract<Expression, { form: 'variable' }>).name)}))`
          : !node.value
          ? '()'
          : fnReturnsArray && isNativeCall(node.value)
            ? wrapList(expr(node.value))
            : bare(boxUnknown(currentResult, node.value, closureDepth > 0 || offBorrow ? owned(node.value) : expr(node.value)))

        // the gradual boundary: an unknown-typed value returned at a declared FORM type downcasts
        const valueKind =
          node.value?.form === 'await'
            ? (node.value.type ?? node.value.expr.type)?.kind
            : node.value?.type?.kind
        // only a FIELD READ is certainly the boxed dynamic; a dock call's rust value is already concrete,
        // and downcasting a plain struct does not compile
        // and a CALL that answers the unknown, returned at a generic letter (`like t`), downcasts too: a typed channel's
        // `receive` or a typed task's `wait` taking its value back out of the one untyped shim. Every generic here is
        // `Clone + 'static`, which is what the downcast needs
        // NOT a native list or map operation on a typed receiver (`self/pop`, `self/get` in the stdlib's list): its
        // rust value is already the element type, and downcasting a `T` does not compile (E0599), which broke every
        // Rust program that used a list (found by test/compile/meaning-native.ts, 2026-10-02)
        // so only a call into an untyped shim downcasts: a Term task, or a `dock load` module (shimCall)
        const callValue = node.value !== undefined && shimCall(node.value)
        const generic =
          currentResult?.kind === 'variable' ||
          (currentResult?.kind === 'named' &&
            /^[a-z]$/.test(currentResult.name) &&
            !currentResult.args?.length &&
            !recordFields.has(currentResult.name))
        const casted =
          node.value &&
          node.value.form === 'member' &&
          (valueKind === 'unknown' || valueKind === 'dynamic') &&
          currentResult?.kind === 'named' &&
          recordFields.has(currentResult.name)
            ? `${value}.downcast_ref::<${rustType(currentResult)}>().unwrap().clone()`
            : node.value && callValue && (valueKind === 'unknown' || valueKind === 'dynamic') && generic
              ? `${value}.downcast_ref::<${rustType(currentResult!)}>().unwrap().clone()`
              : value

        // a downcast out of the box clones the value at the task's result type (item 0029)
        if (casted !== value) {
          noteClone(currentResult)
        }

        // a bare `send back` in a task whose synthesized result is the boxed dynamic answers the boxed unit
        const boxedUnit =
          !node.value && currentResult?.kind === 'unknown'
            ? '(std::rc::Rc::new(()) as std::rc::Rc<dyn std::any::Any>)'
            : undefined

        // a value that diverges (a `panic!`, what `abandon` renders) is a statement of its own: wrapping it in a
        // `return`, or in an `Ok`, is clippy's diverging_sub_expression
        if (/^(panic|unreachable|unimplemented|todo)!\(/.test(casted)) {
          return `${casted};`
        }

        if (guardDepth > 0) {
          return `return std::result::Result::Ok(Some(${boxedUnit ?? casted}));`
        }

        if (currentRaising) {
          return `return std::result::Result::Ok(${boxedUnit ?? casted});`
        }

        return node.value || boxedUnit ? `return ${boxedUnit ?? casted};` : 'return;'
      }
      case 'throw': {
        // a raise is `Err(TermException)`: the record's shared fields, its props as `link`, the record as `base`; a
        // text raises `failure`; a caught value passes on as it is. Outside any raising task or guard (a raise the
        // checker did not see reach here) it still ends the program, with the form and note. When the program has
        // the stdlib hive, a NEW carrier tells it before unwinding (a pass-on re-raise does not re-tell), the same
        // hook the TypeScript constructor carries.
        carries = true
        // the raised record's fields are cloned into the carrier (item 0029)
        noteClone(node.value.type)
        const tell = (built: string): string =>
          hasHiveTell
            ? `{ let told = ${built}; hive_tell(HiveEntry { host: told.host.clone(), kind: "exception".to_string(), name: told.form.clone(), site: String::new(), base: std::rc::Rc::new(told.clone()) }); told }`
            : built
        // an INTERPOLATED text (`halt <cycle: {{x}}>`, a `template` node) is a text too, and raises `failure`
        // like a plain one. It used to fall to the pass-on branch and hand back a String where a TermException goes
        const carrier =
          node.value.form === 'string' || node.value.form === 'template'
            ? tell(`term_fail(${expr(node.value).replace(/^("(?:[^"\\]|\\.)*")\.to_string\(\)$/, '$1')})`)
            : node.value.form === 'record' && exceptionForms.has(node.value.name)
              ? tell(
                  `{ let raised = ${expr(node.value)}; TermException(Box::new(TermRaised { host: raised.host.clone(), form: raised.form.clone(), note: raised.note.clone(), code: raised.code.clone(), time: raised.time, link: std::rc::Rc::new(raised.link.clone()), base: std::rc::Rc::new(raised) })) }`,
                )
              : `(${expr(node.value)}).clone()`

        if (currentRaising || guardDepth > 0) {
          return `return std::result::Result::Err(${carrier});`
        }

        return `{ let raised = ${carrier}; eprintln!("{}", raised); std::process::exit(1) }`
      }
      case 'while': {
        const budget = budgetCheck(node, d + 1)

        // `while true` emits `loop`, which rustc knows diverges: a function ending in the loop then needs no
        // unreachable trailing value (E0308)
        if (node.cond.form === 'boolean' && node.cond.value === true) {
          return `loop {\n${budget}${block(node.body, d + 1)}\n${pad(d)}}`
        }

        // a counted loop calling a task whose arithmetic is safe below a bound (ir/facts/bounds.ts): written twice, the
        // guard true running a copy that calls the task's unchecked copy (`a_value_fast`). Only the call limits
        const guard = loopGuards.get(node)

        if (guard?.fast?.length && guard.limits?.length && !budget) {
          const test = guard.limits.map(l => (l.low ? `${vname(l.name)} >= 0` : `${vname(l.name)} <= ${l.high}`)).join(' && ')
          const outer = fastCalls
          fastCalls = new Set([...outer, ...guard.fast])
          const fast = `while ${condExpr(node.cond)} {\n${block(node.body, d + 2)}\n${pad(d + 1)}}`
          fastCalls = outer
          const slow = `while ${condExpr(node.cond)} {\n${block(node.body, d + 2)}\n${pad(d + 1)}}`

          return `if ${test} {\n${pad(d + 1)}${fast}\n${pad(d)}} else {\n${pad(d + 1)}${slow}\n${pad(d)}}`
        }

        return `while ${condExpr(node.cond)} {\n${budget}${block(
          node.body,
          d + 1,
        )}\n${pad(d)}}`
      }
      case 'guard': {
        // the body runs as a closure returning Result<Option<T>, TermException>, T the enclosing task's result: a
        // `send back` inside it is Ok(Some(v)) and returns from the task after the match, falling off the end is
        // Ok(None), a raise (its own, or a callee's through `?`) is Err(e) and runs the handler with e bound
        carries = true
        const result = currentResult && currentResult.kind !== 'unit' ? rustType(currentResult) : '()'
        const outerRaising = currentRaising
        guardDepth++
        const body = block(node.body, d + 2)
        guardDepth--
        const returned = outerRaising ? 'return std::result::Result::Ok(value)' : 'return value'
        // the caught value is bound only where the handler reads it (rustc: unused_variables). While its body is
        // emitted the name is a caught one, whose fields are read cloned (the `member` case)
        let handlerBody = ''

        if (node.catch) {
          caughtNames.add(node.catch.name)
          handlerBody = block(node.catch.body, d + 2)
          caughtNames.delete(node.catch.name)
        }

        const handler = node.catch
          ? `std::result::Result::Err(${namesIn(node.catch.body).has(node.catch.name) ? vname(node.catch.name) : '_'}) => {\n${handlerBody}\n${pad(d + 1)}}`
          : 'std::result::Result::Err(_) => {}'

        // inside an asynchronous body the guard is an async block awaited in place, since a closure cannot `.await`
        // and a `send back` or `?` inside the block leaves the block the way it leaves the closure
        const guarded = currentAsync
          ? `(async { ${'\n'}${body}\n${pad(d + 1)}std::result::Result::Ok::<Option<${result}>, TermException>(None)\n${pad(d)}}).await`
          : `(|| -> std::result::Result<Option<${result}>, TermException> {\n${body}\n${pad(d + 1)}std::result::Result::Ok(None)\n${pad(d)}})()`

        return `match ${guarded} {\n${pad(d + 1)}std::result::Result::Ok(Some(value)) => ${returned},\n${pad(d + 1)}std::result::Result::Ok(None) => {}\n${pad(d + 1)}${handler}\n${pad(d)}}`
      }

      case 'for-each': {
        // a list is an Rc<RefCell<Vec>>; iterate an owned clone of its elements so the loop binds `T`, not `&T`, and
        // does not hold a borrow across the body
        const iterable =
          node.iterable.type?.kind === 'array'
            ? `${expr(node.iterable)}.borrow().clone()`
            : expr(node.iterable)

        const budget = budgetCheck(node, d + 1)

        // the item and index are locals, so a top-level task or dock alias of the same name does not capture a read
        localNames.add(node.item)

        if (node.index) {
          localNames.add(node.index)
        }

        // a list is walked by position, each element cloned out under a borrow that ends before the body runs: no copy
        // of the whole Vec, and the body may still push to the list it walks. The length is read every turn, so an
        // item pushed during the walk is visited and a removal ends it early, which is what TypeScript's `for...of`
        // does. It iterated `.borrow().clone()` of the whole list until 2026-10-02 (note/term/codegen/rust.md, R1)
        if (node.iterable.type?.kind === 'array') {
          const index = node.index ? `let ${vname(node.index)} = __at as i64; ` : ''
          // a `Copy` element is read out by value, anything else is cloned out of the borrow. The iterator variable is
          // `__item`, never a name a program can write: it was `value` until 2026-10-04, and a walk inside a task with
          // its own local `value` read the element where the program meant its number (pattern/unicode-read.tree)
          const element = node.iterable.type.kind === 'array' && copyType(node.iterable.type.element) ? '*__item' : '__item.clone()'

          if (element !== '*__item') {
            noteClone(elementOf(node.iterable.type))
          }

          const walkedName = node.iterable.form === 'variable' ? node.iterable.name : undefined
          const lentAs = walkedName !== undefined ? lentNames.get(walkedName) : undefined
          // an inner list of a list of lists that owns it (`ownedElements`), only read in the walk: read in place, by
          // reference off a lent list, cloned out of any other
          const inner = ownsInner(elementLists.walks, node)

          if (inner) {
            lentNames.set(node.item, 'read')

            if (lentAs !== 'read') {
              ownedNames.set(node.item, false)
            }
          }

          // a list lent for reading cannot change under the walk: an iterator, as Rust writes it. Nor can a written list
          // whose walk never mentions it (Polygon's `shapes`, built and then walked)
          const untouched = walkedName !== undefined && lentAs === 'write' && !namesIn(node.body).has(walkedName)
          // a record's own list read through its path (`ownedFields`) is only read, so walked the same way
          const path = ownedPath(node.iterable)

          if (((lentAs === 'read' || untouched) && walkedName !== undefined) || path) {
            const source = walkedName !== undefined ? vname(walkedName) : memberPath(node.iterable)
            const each = node.index ? `(__at, __item) in ${source}.iter().enumerate()` : `__item in ${source}.iter()`
            // an item only handed to tasks that take it borrowed, or read for a field, is the element by reference:
            // cloned out, a node holding its own lists (`ownedFields`) was copied whole per turn
            const byRef = inner || (element !== '*__item' && onlyBorrowed(node.body, node.item))
            // a reference passes on as it is (`borrowedNames`), where `&kid` would borrow it twice (clippy: needless_borrow)
            const outerBorrowed = borrowedNames

            // (an inner list is read through `lentNames`, never as a borrowed record)
            if (byRef && !inner) {
              borrowedNames = new Set([...borrowedNames, node.item])
            }

            const walked = block(node.body, d + 1)
            borrowedNames = outerBorrowed

            return `for ${each} {\n${pad(d + 1)}let ${vname(node.item)} = ${byRef ? '__item' : element}; ${index}\n${budget}${walked}\n${pad(d)}}`
          }

          // the element at `__at` of a list's storage, copied or cloned out, each read its own statement so no borrow
          // outlives it. The length is read every turn: `loop` over `get(..)` with a `break` was clippy's
          // while_let_loop, and a `while let` would hold the borrow through a body that may push onto the list
          const at = (storage: string): string => (element === '*__item' ?`${storage}[__at]` : `${storage}[__at].clone()`)

          // a list lent for writing is walked by position on the Vec itself, so the body may still write it
          if (lentAs === 'write' && walkedName !== undefined) {
            return `{ let mut __at: usize = 0; while __at < ${vname(walkedName)}.len() { let ${vname(node.item)} = ${at(vname(walkedName))}; ${index}__at += 1;\n${budget}${block(
              node.body,
              d + 1,
            )}\n${pad(d)}} }`
          }

          return `{ let __walked = &(${expr(node.iterable)}); let mut __at: usize = 0; while __at < __walked.borrow().len() { let ${vname(node.item)} = ${at('__walked.borrow()')}; ${index}__at += 1;\n${budget}${block(
            node.body,
            d + 1,
          )}\n${pad(d)}} }`
        }

        // a walk that names its INDEX enumerates; `i64` because that is what a Term number is here. lean-0017
        return node.index
          ? `for (${vname(node.index)}, ${vname(node.item)}) in ${iterable}.into_iter().enumerate().map(|(i, v)| (i as i64, v)) {\n${budget}${block(
              node.body,
              d + 1,
            )}\n${pad(d)}}`
          : `for ${vname(node.item)} in ${iterable} {\n${budget}${block(
              node.body,
              d + 1,
            )}\n${pad(d)}}`
      }

      case 'match': {
        // a match whose labels are only true/false is a match over a NATIVE bool (booleans lower to `bool` here, not
        // an ADT), so the arms are the literal patterns `true` / `false`, not enum variants. Rust's bool match with
        // both literal arms is exhaustive; an `otherwise` becomes the wildcard arm.
        // a fork case over a caught TermException: match on `form`, the record recovered from `base` by its form
        if (node.exceptionArms) {
          const carrier = expr(node.subject)
          const arms = node.cases.map(b => {
            const arm = node.exceptionArms![b.label]!
            const bodyText = block(b.body, d + 2)
            // only the fields the arm READS, asked of the program and not of the emitted text (swift.ts says why)
            const read = namesIn(b.body)
            const locals = armLocals([...arm.shared, ...arm.link], b.binds ?? [])
              .filter(({ local }) => read.has(local))
              .map(({ field, local }) =>
                arm.link.includes(field)
                  ? `${pad(d + 2)}let ${snake(local)} = ${carrier}.base.downcast_ref::<${pascal(b.label)}>().unwrap().link.${snake(field)}.clone();`
                  : `${pad(d + 2)}let ${snake(local)} = ${carrier}.${snake(field)}.clone();`,
              )

            // its fields are cloned out of the carrier: the exception's form is cloned (item 0029)
            if (locals.length) {
              noteClone({ kind: 'named', name: b.label })
            }

            return `${pad(d + 1)}${JSON.stringify(b.label)} => {\n${[...locals, bodyText].join('\n')}\n${pad(d + 1)}}`
          })
          arms.push(`${pad(d + 1)}_ => {${node.otherwise ? `\n${block(node.otherwise, d + 2)}\n${pad(d + 1)}` : ''}}`)

          return `match ${carrier}.form.as_str() {\n${arms.join('\n')}\n${pad(d)}}`
        }

        const labels = node.cases.map(branch => branch.label)
        const booleans =
          labels.length > 0 &&
          labels.every(label => label === 'true' || label === 'false')

        if (booleans) {
          const arms = node.cases.map(
            b =>
              `${pad(d + 1)}${b.label} => {\n${block(
                b.body,
                d + 2,
              )}\n${pad(d + 1)}}`,
          )

          // a single-literal match needs the wildcard arm to be exhaustive, even without an `otherwise`
          if (node.otherwise) {
            arms.push(
              `${pad(d + 1)}_ => {\n${block(
                node.otherwise,
                d + 2,
              )}\n${pad(d + 1)}}`,
            )
          } else if (node.cases.length < 2) {
            arms.push(`${pad(d + 1)}_ => {}`)
          }

          return `match ${expr(node.subject)} {\n${arms.join(
            '\n',
          )}\n${pad(d)}}`
        }

        // a `fork case` over a TEXT subject (`fork case, read kind` with `case home` arms): the labels are
        // string values, matched over &str with a wildcard for exhaustiveness
        if (node.subject.type?.kind === 'string') {
          const arms = node.cases.map(
            b =>
              `${pad(d + 1)}${JSON.stringify(b.label)} => {\n${block(
                b.body,
                d + 2,
              )}\n${pad(d + 1)}}`,
          )

          arms.push(
            `${pad(d + 1)}_ => {${
              node.otherwise
                ? `\n${block(node.otherwise, d + 2)}\n${pad(d + 1)}`
                : ''
            }}`,
          )

          return `match ${expr(node.subject)}.as_str() {\n${arms.join('\n')}\n${pad(d)}}`
        }

        // match a clone of the subject: a variant pattern binds (moves out) the variant's fields, so matching the
        // original would partially move it and break a branch that also uses the whole subject (`return self`). Our
        // ADTs all derive Clone, so this is always valid; the bound fields come from the clone, the original is intact.
        // ...unless this match is the variable's only read (`moveArgs`, the last-use analysis): then it is matched by
        // value, nothing is cloned, and the fields move out of it
        const subjectVar =
          node.subject.form === 'variable'
            ? node.subject.name
            : undefined
        const moved =
          subjectVar !== undefined && ((moveArgs.has(subjectVar) && !cellVars.has(subjectVar)) || lastMove(node.subject) || slotReads.has(node.subject))
        // a borrowed record is matched as it is: the arms bind its fields by reference (borrowedRecords)
        const borrowedSubject = subjectVar !== undefined && borrowedNames.has(subjectVar)
        // a local read again after the match is matched BY REFERENCE where it was cloned whole: each arm copies or clones
        // out only the fields it reads, and the bindings end there, so the arm may still use or move the whole subject.
        // Not where an arm assigns the local (the borrow would be live across the write), nor a shared handle or a
        // cell. Towers' `push-disk` read one number out of a pile's top node and cloned the node for it
        const referenced =
          !moved &&
          !borrowedSubject &&
          subjectVar !== undefined &&
          !cellVars.has(subjectVar) &&
          node.subject.type?.kind === 'named' &&
          !isSharedType(node.subject.type) &&
          !assignsName([node.cases, node.otherwise], subjectVar)
        const subject = moved || borrowedSubject ? expr(node.subject) : referenced ? `&${expr(node.subject)}` : `${expr(node.subject)}.clone()`

        // a subject matched by clone copies the whole value (item 0029)
        if (!moved && !borrowedSubject && !referenced) {
          noteClone(node.subject.type)
        }

        const arms = node.cases.map(b => {
          const subjectType = node.subject.type
          const owner =
            subjectType?.kind === 'named' && variantOwners.get(b.label)?.has(subjectType.name)
              ? subjectType.name
              : (variantOwner.get(b.label) ?? '')
          // the case of the subject's own form, where two forms name a case alike (engine/value port, 2026-10-04)
          const fields = caseFieldNames.get(`${owner}/${b.label}`) ?? variantFields.get(b.label) ?? []
          // bind the variant's fields so the branch body can read them; narrow the subject for this arm so a
          // `subject/field` read resolves to the bound local (restored after the arm so sibling arms are unaffected)
          // the arm's `link` lines select or rename the fields (see check/arm.ts); a field left out is `..`
          const locals = armLocals(fields, b.binds ?? [])
          // the fields the arm reads. A `subject/field` read resolves to the bound local (`narrowing`) without naming it,
          // so an arm that mentions the subject at all reads every field
          const named = namesIn(b.body)
          const reads = (local: string): boolean => named.has(local) || (subjectVar !== undefined && named.has(subjectVar))
          // a field nobody reads is bound to `_`: nothing is moved, unwrapped, copied or cloned for it
          const pattern =
            fields.length > 0
              ? ` { ${[
                  ...locals.map(({ field, local }) =>
                    !reads(local) ? `${snake(field)}: _` : field === local ? snake(field) : `${snake(field)}: ${snake(local)}`,
                  ),
                  ...(locals.length < fields.length ? ['..'] : []),
                ].join(', ')} }`
              : ''
          // a case held by payload (`payloads`) binds its box and destructures it with the fields' own pattern: in place
          // under a borrowed or a referenced subject, so each field arrives as the reference it always did, and by value
          // otherwise, through `term_open_` when the form's boxes are reused (the box kept, the whole node in it)
          const payload = payloadOf(owner, b.label)
          const unbox = (fieldPattern: string, bound: boolean): { arm: string; lines: string[] } => {
            if (!payload) {
              return { arm: fieldPattern, lines: [] }
            }

            if (!bound) {
              return { arm: '(_)', lines: [] }
            }

            // an `Rc` payload opened by value moves out when the node is unique and is cloned out when shared
            const source =
              borrowedSubject || referenced
                ? '&**__node'
                : reusable(owner)
                  ? (reuseOpened.add(owner), `term_open_${snake(owner)}(__node)`)
                  : boxedForms.has(owner)
                    ? '*__node'
                    : 'std::rc::Rc::unwrap_or_clone(__node)'

            return { arm: '(__node)', lines: [`${pad(d + 2)}let ${payload}${fieldPattern} = ${source};`] }
          }

          const previous = subjectVar
            ? narrowing.get(subjectVar)
            : undefined

          if (subjectVar) {
            narrowing.set(subjectVar, b.label)
          }

          // under a borrowed subject each field arrives as a reference: a record field stays one (a borrowed name in the
          // arm), a `Copy` field is copied out and anything else cloned out, so the arm's body reads it as it always did
          const fieldTypes = caseFieldTypes.get(`${owner}/${b.label}`) ?? variantTypes.get(b.label)
          // the same test `borrowedRecords` makes: a field whose type is a record (not a `mark shared` handle)
          const recordField = (field: string): boolean => {
            const type = fieldTypes?.get(field)

            return type?.kind === 'named' && plainRecords.has(type.name)
          }
          const armBorrowed = borrowedSubject ? locals.filter(({ field }) => recordField(field)).map(({ local }) => local) : []
          // only a field the arm reads: copying or cloning one nobody reads is work for nothing. An arm that only hands
          // one such field back returns the copy or clone itself (`*width`, `label.clone()`), never a `let` it then
          // returns (clippy: let_and_return)
          const read = borrowedSubject ? namesIn(b.body) : new Set<string>()
          const lone = b.body.length === 1 && b.body[0]!.form === 'return' ? b.body[0]!.value : undefined
          // only where a `return` is written plain: not in a raising task or a guard (an `Ok(..)`), not in a closure, and
          // not where the task answers the boxed dynamic
          const handedBack =
            borrowedSubject &&
            lone?.form === 'variable' &&
            !currentRaising &&
            guardDepth === 0 &&
            closureDepth === 0 &&
            currentResult?.kind !== 'unknown'
              ? locals.find(({ field, local }) => local === lone.name && !recordField(field))
              : undefined

          if (handedBack) {
            const out = copyType(fieldTypes?.get(handedBack.field)) ? `*${snake(handedBack.local)}` : `${snake(handedBack.local)}.clone()`

            if (!copyType(fieldTypes?.get(handedBack.field))) {
              noteClone(fieldTypes?.get(handedBack.field))
            }

            if (subjectVar) {
              if (previous === undefined) {
                narrowing.delete(subjectVar)
              } else {
                narrowing.set(subjectVar, previous)
              }
            }

            const handedPattern = locals.length > 0
              ? ` { ${[
                  ...locals.map(({ field, local }) =>
                    local === handedBack.local ? (field === local ? snake(field) : `${snake(field)}: ${snake(local)}`) : `${snake(field)}: _`,
                  ),
                  ...(locals.length < fields.length ? ['..'] : []),
                ].join(', ')} }`
              : ''
            const handed = unbox(handedPattern, true)

            return `${pad(d + 1)}${pascal(owner)}::${pascal(b.label)}${handed.arm} => {\n${[...handed.lines, `${pad(d + 2)}return ${out};`].join('\n')}\n${pad(d + 1)}}`
          }

          // a list the node owns (`ownedFields`) is only read in the arm: read in place, never copied out
          const ownsList = (field: string): boolean => fieldLists.has(`${b.label}/${field}`)
          const derefs = borrowedSubject
            ? locals
                .filter(({ field, local }) => !recordField(field) && !ownsList(field) && read.has(local))
                .map(({ field, local }) => {
                  if (copyType(fieldTypes?.get(field))) {
                    return `${pad(d + 2)}let ${snake(local)} = *${snake(local)};`
                  }

                  noteClone(fieldTypes?.get(field))

                  return `${pad(d + 2)}let ${snake(local)} = ${snake(local)}.clone();`
                })
            : referenced
              ? // under a referenced subject every field read is copied or cloned out, a recursive one through its
                // `Rc` or `Box` to the plain value the body was written against
                locals
                  .filter(({ field, local }) => reads(local) && !ownsList(field))
                  .map(({ field, local }) => {
                    if (copyType(fieldTypes?.get(field))) {
                      return `${pad(d + 2)}let ${snake(local)} = *${snake(local)};`
                    }

                    noteClone(fieldTypes?.get(field))

                    return recursiveFields.has(`${b.label}/${field}`) && !payload
                      ? `${pad(d + 2)}let ${snake(local)} = (**${snake(local)}).clone();`
                      : `${pad(d + 2)}let ${snake(local)} = ${snake(local)}.clone();`
                  })
              : []
          const outerBorrowed = borrowedNames

          if (armBorrowed.length) {
            borrowedNames = new Set([...borrowedNames, ...armBorrowed])
          }

          // its local is the list itself: a reference under a borrowed or referenced subject, the `Vec` otherwise
          const outerLent = lentNames
          const outerOwned = ownedNames
          const lists = locals.filter(({ field }) => ownsList(field))

          if (lists.length) {
            lentNames = new Map([...lentNames, ...lists.map(({ local }) => [local, 'read'] as const)])

            if (!borrowedSubject && !referenced) {
              ownedNames = new Map([...ownedNames, ...lists.map(({ local }) => [local, false] as const)])
            }
          }

          const body = block(b.body, d + 2)
          borrowedNames = outerBorrowed
          lentNames = outerLent
          ownedNames = outerOwned

          if (subjectVar) {
            if (previous === undefined) {
              narrowing.delete(subjectVar)
            } else {
              narrowing.set(subjectVar, previous)
            }
          }

          // a recursive field arrives Rc-wrapped (see recursiveFields), and the branch body sees the plain enum value
          // it was written against. `Rc::unwrap_or_clone` MOVES the value out when this is the only reference, which
          // it is for a tree built and consumed once, and clones only a shared one: it was always `(*x).clone()`, a
          // clone per node per walk (binary-trees)
          const unwraps = locals
            .filter(({ field, local }) => !payload && !borrowedSubject && !referenced && reads(local) && recursiveFields.has(`${b.label}/${field}`))
            .map(({ local }) =>
              // a reusable form's box is kept for the next node built (`reusable`); otherwise a `Box` child (item
              // 0029) moves out, and an `Rc` one moves when unique and clones when shared
              reusable(owner)
                ? (reuseOpened.add(owner), `${pad(d + 2)}let ${snake(local)} = term_open_${snake(owner)}(${snake(local)});`)
                : boxedForms.has(owner)
                  ? `${pad(d + 2)}let ${snake(local)} = *${snake(local)};`
                  : `${pad(d + 2)}let ${snake(local)} = std::rc::Rc::unwrap_or_clone(${snake(local)});`,
            )

          // an arm that only answers the field it unwrapped answers the unwrapping itself (clippy: let_and_return)
          // the same for a field copied or cloned out of a referenced subject (`rest`'s `(**next).clone()`)
          const only = unwraps.length + derefs.length === 1 ? /^\s*let (\w+) = (.+);$/.exec([...unwraps, ...derefs][0]!) : null
          const answered = only && body.trim() === `return ${only[1]};` ? `${pad(d + 2)}return ${only[2]};` : undefined
          // the arms of a match nested in tail position answer their values (clippy: needless_return), see `tailMatches`
          const unboxed = unbox(pattern, locals.some(({ local }) => reads(local)))
          const lines = [...unboxed.lines, ...(answered ? [answered] : [...unwraps, ...derefs, body])]
          const text = lines.join('\n')
          const last = tailMatches.has(node) ? new RegExp(`(^|\\n)${pad(d + 2)}return (.*);$`).exec(text) : null
          const tailed = last && !borrowsAtTail(last[2]!) ? `${text.slice(0, last.index + last[1]!.length)}${pad(d + 2)}${last[2]}` : text

          return `${pad(d + 1)}${pascal(owner)}::${pascal(b.label)}${unboxed.arm} => {\n${tailed}\n${pad(d + 1)}}`
        })

        if (node.otherwise) {
          arms.push(
            `${pad(d + 1)}_ => {\n${block(
              node.otherwise,
              d + 2,
            )}\n${pad(d + 1)}}`,
          )
        }

        return `match ${subject} {\n${arms.join('\n')}\n${pad(d)}}`
      }

      case 'if': {
        let out = ''
        node.branches.forEach((b, i) => {
          out += `${i ? ' else ' : ''}if ${condExpr(b.cond)} {\n${block(
            b.body,
            d + 1,
          )}\n${pad(d)}}`
        })

        if (node.otherwise) {
          out += ` else {\n${block(node.otherwise, d + 1)}\n${pad(d)}}`
        }

        return out
      }

      case 'break':
        return 'break;'
      case 'continue':
        return 'continue;'
      case 'exit':
        return 'std::process::exit(0);'
      case 'debug':
        return '// breakpoint'

      case 'function': {
        // the names this function binds itself (parameters and locals) shadow a module-level constant of the same name
        localNames.clear()
        node.params.forEach(p => localNames.add(p.name))
        letNames(node.body, localNames)

        // a generic parameter appears in a signature two ways: as a declared name (`head t` that survived as a named
        // type) or as a free inference variable. Collect both. Each free variable gets a fresh letter, mapped by id so
        // `rustType` prints the letter not `i64`. Every generic carries `Clone` (the owned-value style clones freely,
        // and every type a generic is instantiated at is Clone; closures are function-typed, never generic). One used
        // as a map KEY additionally needs `Eq + Hash`.
        const ids = new Set<number>()
        node.params.forEach(p => collectVars(p.type, ids))
        collectVars(node.result, ids)

        // a single pass that records which generics (by variable id or by name) sit in a map-KEY position, following
        // form arguments through `formKeyIndices` so a `Set<U>` marks U even though its map is hidden inside the struct
        const keyIds = new Set<number>()
        const keyNames = new Set<string>()

        const markKeys = (
          t: Type | undefined,
          isKey: boolean,
        ): void => {
          if (!t) {
            return
          }

          if (t.kind === 'variable') {
            if (isKey) {
              keyIds.add(t.id)
            }
          } else if (t.kind === 'map') {
            markKeys(t.key, true)
            markKeys(t.value, false)
          } else if (t.kind === 'array') {
            markKeys(t.element, false)
          } else if (t.kind === 'function') {
            t.params.forEach(p => markKeys(p, false))
            markKeys(t.result, false)
          } else if (t.kind === 'named') {
            if (isKey) {
              keyNames.add(t.name.toUpperCase())
            }

            const keyArgs = formKeyIndices.get(t.name)
            t.args?.forEach((a, i) =>
              markKeys(a, keyArgs?.has(i) ?? false),
            )
          }
        }

        node.params.forEach(p => markKeys(p.type, false))
        markKeys(node.result, false)

        // which declared generics actually appear in the signature (as named types); drop the rest
        const namedInSig = new Set<string>()

        const scanNamed = (t: Type | undefined): void => {
          if (!t) {
            return
          }

          if (t.kind === 'named') {
            namedInSig.add(t.name.toUpperCase())
            t.args?.forEach(scanNamed)
          } else if (t.kind === 'array') {
            scanNamed(t.element)
          } else if (t.kind === 'map') {
            scanNamed(t.key)
            scanNamed(t.value)
          } else if (t.kind === 'function') {
            t.params.forEach(scanNamed)
            scanNamed(t.result)
          }
        }

        node.params.forEach(p => scanNamed(p.type))
        scanNamed(node.result)

        // extra element bounds the body's array ops require: equality (`includes` / `indexOf`), display (`join`)
        const arrayBounds = collectArrayBounds(node.body)

        // a generic's bound: `Clone` always; `Eq + Hash` for a map key (which implies PartialEq); `PartialEq` for an
        // array used with `includes` / `indexOf`; `Display` for one stringified by `join`.
        const bound = (
          name: string,
          isKey: boolean,
          isEq: boolean,
          isDisplay: boolean,
        ): string => {
          // every generic is 'static: our values own their data (String, i64, Rc), and the generic runtime
          // shims (shape, compare, text) require it for the Any-based dispatch
          const traits = ['Clone', "'static"]

          if (isKey) {
            traits.push('Eq', 'std::hash::Hash')
          } else if (isEq) {
            traits.push('PartialEq')
          }

          if (isDisplay) {
            traits.push('std::fmt::Display')
          }

          return `${name}: ${traits.join(' + ')}`
        }

        const pool = ['T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'A', 'B', 'C']
        const used = new Set(
          node.generics.map(g => g.name.toUpperCase()),
        )

        rustVarNames = new Map()

        const fresh: string[] = []

        for (const id of ids) {
          const letter = pool.find(l => !used.has(l)) ?? `T${id}`
          used.add(letter)
          rustVarNames.set(id, letter)
          fresh.push(
            bound(
              letter,
              keyIds.has(id),
              arrayBounds.eqIds.has(id),
              arrayBounds.displayIds.has(id),
            ),
          )
        }

        // a trait-bounded generic (`head t, need sizer`) adds its trait to the bound, so the body's `x.measure()`
        // resolves through it. Keyed by uppercase generic name to match `kept`.
        const needTrait = new Map<string, string>()

        for (const g of node.generics) {
          if (g.need) {
            needTrait.set(g.name.toUpperCase(), pascal(g.need))
          }
        }

        const kept = node.generics
          .map(g => g.name.toUpperCase())
          .filter(name => namedInSig.has(name))
          .map(name => {
            const base = bound(
              name,
              keyNames.has(name),
              arrayBounds.eqNames.has(name),
              arrayBounds.displayNames.has(name),
            )

            return needTrait.has(name)
              ? `${base} + ${needTrait.get(name)}`
              : base
          })

        const decls = [...kept, ...fresh]
        const generics = decls.length ? `<${decls.join(', ')}>` : ''
        const local = implFnParams.get(node.name)
        const lend = lendParams.get(node.name)
        const borrow = borrowParams.get(node.name)
        const params = node.params
          .map((p, i) => {
            // a record the task only reads is borrowed (borrowedRecords), and a text it only reads as text is a `&str`
            if (borrow?.has(i)) {
              return `${vname(p.name)}: &${p.type?.kind === 'string' ? 'str' : rustType(p.type)}`
            }

            const how = lend?.get(i)

            if (how && p.type?.kind === 'array') {
              const element = rustElement(p.type)

              // a slice either way: a lent list is read and written slot by slot, never grown (clippy: ptr_arg)
              return `${vname(p.name)}: ${how === 'write' ? `&mut [${element}]` : `&[${element}]`}`
            }

            return `${vname(p.name)}: ${local?.has(i) && p.type?.kind === 'function' ? implFnType(p.type) : rustType(p.type)}`
          })
          .join(', ')
        const previousLent = lentNames
        const previousOwned = ownedNames
        const previousFresh = emittingFresh
        const previousBorrowed = borrowedNames
        const previousCursors = cursors
        cursors = textCursors(node, asciiNodes)
        const previousSlices = sliceLets
        const previousSliceNames = sliceNames
        const slices = sliceKeys(node)
        sliceLets = slices.lets
        sliceNames = slices.names
        borrowedNames = new Set(node.params.flatMap((p, i) => (borrow?.has(i) ? [p.name] : [])))
        ownedNames = node.async ? new Map() : ownedLocals(node, freshLists, lendParams, fieldLists, elementLists.moves)
        const previousStack = stackNames
        stackNames = node.async ? new Set() : (stackLists.get(node.name) ?? new Set())
        emittingFresh = freshLists.has(node.name)
        lentNames = new Map([
          ...node.params.flatMap((p, i) => (lend?.has(i) ? [[p.name, lend.get(i)!] as const] : [])),
          ...[...ownedNames.keys()].map(name => [name, 'write'] as const),
        ])

        // a task with no declared result but a valued `send back` (a dock forward) answers the boxed dynamic
        const declaredResult =
          node.result && node.result.kind !== 'unit'
            ? node.result
            : hasValuedReturn(node.body)
              ? ({ kind: 'unknown' } as Type)
              : node.result
        // a task that answers a fresh list answers the `Vec` itself (freshLists)
        const plainResult =
          emittingFresh && declaredResult?.kind === 'array'
            ? `Vec<${rustElement(declaredResult)}>`
            : declaredResult && declaredResult.kind !== 'unit'
              ? rustType(declaredResult)
              : ''
        carries ||= raising.has(node.name)
        const ret = raising.has(node.name)
          ? ` -> std::result::Result<${plainResult || '()'}, TermException>`
          : plainResult
            ? ` -> ${plainResult}`
            : ''
        const previousRaising = currentRaising
        const previousAsync = currentAsync
        currentAsync = Boolean(node.async)
        const previousResult = currentResult
        const previousParams = currentParams
        currentParams = new Set(node.params.map(p => p.name))
        currentRaising = raising.has(node.name)
        currentResult = declaredResult

        // names a nested closure ASSIGNS to are boxed in Rc<RefCell> for this whole function body
        const previousCellVars = cellVars
        cellVars = mutatedCaptures(node.body)

        // reassigned parameters are shadowed by `let mut` (Rust parameters are immutable). A parameter that is a
        // MUTATED CAPTURE gets its Rc<RefCell> handle shadow instead.
        const mutated = new Set<string>()
        reassigned(node.body, mutated)
        const previousAssigned = assignedVars
        assignedVars = mutated
        // A parameter mutated in place by `push` / `pop` needs NO rebinding: a list is
        // `Rc<RefCell<Vec<T>>>` here, so the mutation goes through `borrow_mut()` and the binding itself is
        // never assigned. Adding it produced `let mut slf = slf;` in `list_push` and `list_pop`, which rustc
        // reports as unused_mut and a strict build treats as fatal — the otf head package failed on exactly
        // that. Only a genuine REASSIGNMENT (handled by `reassigned` above) needs the shadow.

        const shadows = node.params
          .filter(p => mutated.has(p.name) || cellVars.has(p.name))
          .map(p =>
            cellVars.has(p.name)
              ? `${pad(d + 1)}let ${vname(
                  p.name,
                )} = std::rc::Rc::new(std::cell::RefCell::new(${vname(
                  p.name,
                )}));`
              : `${pad(d + 1)}let mut ${vname(p.name)} = ${vname(
                  p.name,
                )};`,
          )

        const previousReturnsArray = fnReturnsArray
        fnReturnsArray = node.result?.kind === 'array'
        const previousMoveArgs = moveArgs
        const previousMoveNodes = moveNodes
        moveArgs = moveOnLastUse(node.body)
        const previousManyMoves = manyMoves
        manyMoves = new WeakSet()
        moveNodes = lastReads(node.body, manyMoves)
        const previousSlotLets = slotLets
        const previousSlotReads = slotReads
        ;({ lets: slotLets, takes: slotReads } = slotTakes(
          node.body,
          name => lentNames.get(name) === 'write' || ownedNames.get(name) === true,
          moveNodes,
          emptyCase,
          cellVars,
        ))
        // a cell-boxed name is read through its handle on every use; it can never be moved at a use site
        cellVars.forEach(name => moveArgs.delete(name))

        // a raising task whose body falls off the end (a unit task) still answers Ok; a task whose last statement is
        // a guard returned from inside it (the body's or the handler's `send back`), which Rust cannot see through
        // the match, so the fall-through is marked unreachable
        const last = node.body[node.body.length - 1]
        // an if-chain WITH an else whose every branch visibly returns diverges in rustc's own analysis,
        // so an unreachable!() after it draws the unreachable_code warning instead of helping
        const rustSeesDivergence = (s: Statement | undefined): boolean => {
          const branchReturns = (body: Statement[]): boolean => {
            const end = body[body.length - 1]

            return (
              end?.form === 'return' ||
              end?.form === 'throw' ||
              rustSeesDivergence(end)
            )
          }

          if (s?.form === 'if') {
            return (
              Boolean(s.otherwise) &&
              s.branches.every(b => branchReturns(b.body)) &&
              branchReturns(s.otherwise!)
            )
          }

          // an ENUM match (rustc-checked exhaustive) with every arm returning: rustc sees it diverge.
          // The other match shapes get a wildcard arm from this emitter (text and exception subjects
          // always, bool with fewer than two literal arms), and an EMPTY wildcard keeps a live
          // fall-through, so only the shapes whose emitted arms all return count here.
          if (s?.form === 'match' && !s.exceptionArms) {
            const labels = s.cases.map(b => b.label)
            const booleans =
              labels.length > 0 &&
              labels.every(l => l === 'true' || l === 'false')
            const text = s.subject.type?.kind === 'string'
            const wildcard =
              text ||
              (booleans && (s.otherwise || s.cases.length < 2))

            if (wildcard || (booleans && s.cases.length < 2)) {
              // the wildcard arm is the otherwise (or empty): diverges only when an otherwise
              // exists and returns
              return (
                Boolean(s.otherwise) &&
                s.cases.every(b => branchReturns(b.body)) &&
                branchReturns(s.otherwise!)
              )
            }

            return (
              s.cases.every(b => branchReturns(b.body)) &&
              (!s.otherwise || branchReturns(s.otherwise))
            )
          }

          return false
        }
        const lastDiverges =
          last?.form === 'return' ||
          last?.form === 'throw' ||
          rustSeesDivergence(last)
        const tail =
          currentRaising &&
          (!node.result || node.result.kind === 'unit') &&
          !lastDiverges
            ? `${pad(d + 1)}std::result::Result::Ok(())`
            : (last?.form === 'guard' ||
                  last?.form === 'if' ||
                  last?.form === 'while' ||
                  last?.form === 'match') &&
                node.result &&
                node.result.kind !== 'unit' &&
                !rustSeesDivergence(last)
              ? // a valued task whose body ends in branching that returns from every live path: rustc cannot
                // always see the coverage (an `if` chain with no `else`), so the fall-through is marked
                `${pad(d + 1)}unreachable!()`
              : ''
        // a function's FINAL `return x;` is its tail expression `x`, as Rust is written (clippy: needless_return). Only
        // the last statement, and only when it is a `return` on a line of its own at the body's depth, so a return
        // nested deeper, or one inside a block of its own, is left as it is
        const tailed = (text: string): string => {
          // a FINAL `match` is the tail expression too, so the closing `return x;` of each arm is the arm's value. Only
          // a line at the arm's own depth directly before the arm's closing brace, and only inside the text the
          // `match` itself wrote (an `if` chain lays its blocks out one level shallower and is left alone)
          // A final `if` / `else` chain, which rustc saw cover every path (`tail` is empty only then), is the same: the
          // last `return x;` of each branch, at the branch's depth and directly before its `}` or `} else`
          if ((last?.form === 'match' || last?.form === 'if') && !tail) {
            const word = last.form === 'match' ? 'match ' : 'if '
            const head = text.lastIndexOf(`\n${pad(d + 1)}${word}`) + 1 || (text.startsWith(`${pad(d + 1)}${word}`) ? 0 : -1)

            if (head < 0 || !text.endsWith(`${pad(d + 1)}}`)) {
              return text
            }

            const inner = last.form === 'match' ? d + 3 : d + 2
            const close = last.form === 'match' ? `${pad(d + 2)}\\}$` : `${pad(d + 1)}\\}( else|$)`
            const branch = new RegExp(`^${pad(inner)}return (.*);\\n(?=${close})`, 'gm')

            return (
              text.slice(0, head) +
              text.slice(head).replace(branch, (whole, value: string) => (borrowsAtTail(value) ? whole : `${pad(inner)}${value}\n`))
            )
          }

          const marker = `${pad(d + 1)}return `
          const at = text.startsWith(marker) ? 0 : text.lastIndexOf(`\n${marker}`) + 1

          if (last?.form !== 'return' || tail || at < 0 || (at === 0 && !text.startsWith(marker)) || !text.endsWith(';')) {
            return text
          }

          const value = text.slice(at + marker.length, -1)

          // the line found must START the final statement. A closure's body renders from depth 0, so its own
          // `return x;` can sit at this depth inside the final statement, followed by shallower lines (`} else {`).
          // Taking that one dropped the closure's `return` and the final statement's `;` (walk.tree's `take`)
          if (value.split('\n').slice(1).some(line => line.trim() && !line.startsWith(pad(d + 1)))) {
            return text
          }

          // a value that borrows (`out.borrow().iter()...`) stays a `return` statement: before edition 2024 a tail
          // expression's temporaries outlive the block's locals, so the `Ref` guard would outlive `out` (E0597),
          // while a statement drops it at its semicolon
          if (borrowsAtTail(value)) {
            return text
          }

          return value === '()' ? text.slice(0, Math.max(at - 1, 0)) : `${text.slice(0, at)}${pad(d + 1)}${value}`
        }
        // the matches NESTED in tail position: the last statement of an arm of the final match, itself every arm ending
        // in a `return` of a value (or such a match again), so each arm can answer its value and all keep one type. The
        // final match's own arms are `tailed`'s
        const previousTailMatches = tailMatches
        tailMatches = new WeakSet()
        const answers = (m: Extract<Statement, { form: 'match' }>): boolean =>
          [...m.cases.map(c => c.body), ...(m.otherwise ? [m.otherwise] : [])].every(body => {
            const end = body[body.length - 1]

            return (end?.form === 'return' && end.value !== undefined) || (end?.form === 'match' && answers(end))
          })
        const markNested = (m: Extract<Statement, { form: 'match' }>): void => {
          for (const body of [...m.cases.map(c => c.body), ...(m.otherwise ? [m.otherwise] : [])]) {
            const end = body[body.length - 1]

            if (end?.form === 'match' && answers(end)) {
              tailMatches.add(end)
              markNested(end)
            }
          }
        }

        if (last?.form === 'match' && !tail && node.result && node.result.kind !== 'unit') {
          markNested(last)
        }

        // a signature-only stub compiles: its body is the not-implemented panic
        const bodyText =
          node.body.length === 0
            ? `${pad(d + 1)}unimplemented!(${JSON.stringify(`stub: ${node.name}`)})`
            : [...shadows, ...cursors.names.map(name => `${pad(d + 1)}let mut ${cursorName(name)}: (usize, usize) = (0, 0);`), tailed(block(node.body, d + 1)), tail]
                .filter(Boolean)
                .join('\n')

        tailMatches = previousTailMatches
        currentParams = previousParams
        currentRaising = previousRaising
        currentAsync = previousAsync
        currentResult = previousResult
        fnReturnsArray = previousReturnsArray
        lentNames = previousLent
        ownedNames = previousOwned
        emittingFresh = previousFresh
        borrowedNames = previousBorrowed
        cursors = previousCursors
        sliceLets = previousSlices
        stackNames = previousStack
        sliceNames = previousSliceNames
        moveArgs = previousMoveArgs
        moveNodes = previousMoveNodes
        manyMoves = previousManyMoves
        slotLets = previousSlotLets
        slotReads = previousSlotReads
        cellVars = previousCellVars
        assignedVars = previousAssigned

        const asyncMark = node.async ? 'async ' : ''

        return `${asyncMark}fn ${snake(
          node.name,
        )}${generics}(${params})${ret} {\n${bodyText}\n${pad(d)}}`
      }

      case 'record-type': {
        const generics = node.params.length
          ? `<${node.params.map(p => p.toUpperCase()).join(', ')}>`
          : ''

        // every struct/enum is `Clone`: a closure field is an `Rc<dyn Fn>` (a cheap shared handle), so even a
        // record holding one clones. Deriving Clone lets a value be shared at a call site rather than moved --
        // the same property the Rc-wrapped collections rely on.
        // and compares by its fields where every field can be compared, hashing too where every field can be hashed
        // (see `equatableForms`), so `is-equal` on two records means the same thing here as on every other backend.
        // A generic form holding a map keyed by one of its parameters (`set<t>` holds `items: hash<t, boolean>`)
        // cannot DERIVE it: the derive bounds `T: PartialEq`, and a map's equality needs its key `Eq + Hash`. That
        // form gets the impl written out with the bound the derive cannot spell (`keyedEquality` below).
        const keyed = equatableForms.has(node.name) ? keyParams(node) : new Set<string>()
        const writeIt = equatableForms.has(node.name) && keyed.size > 0
        const derive = `#[derive(${[
          'Clone',
          ...(equatableForms.has(node.name) && !writeIt ? ['PartialEq'] : []),
          ...(hashableForms.has(node.name) ? ['Eq', 'Hash'] : []),
        ].join(', ')})]\n${pad(d)}`
        const written = writeIt ? `\n${pad(d)}${keyedEquality(node, keyed)}` : ''

        // an ALIAS form (a base and nothing of its own, `form program / like list, like statement`) is its base. It was
        // emitted as an empty struct, so `for stmt in code` over a `program` did not compile (engine/ast, 2026-10-04)
        if (node.alias && node.fields.length === 0 && node.variants.length === 0) {
          return `pub type ${pascal(node.name)}${generics} = ${rustType(node.alias)};`
        }

        if (node.variants.length > 0) {
          // the structs the payload cases hold, after the enum, deriving what it derives (`payloads`)
          const structs: string[] = []
          const cases = node.variants.map(v => {
            const payload = payloadOf(node.name, v.name)
            const fields = v.fields.map(
              f =>
                `${snake(f.name)}: ${
                  recursiveFields.has(`${v.name}/${f.name}`) && !payload
                    ? boxedForms.has(node.name)
                      ? `Box<${rustType(f.type)}>`
                      : `std::rc::Rc<${rustType(f.type)}>`
                    : // a list the node owns is the plain `Vec` (`ownedFields`)
                      fieldLists.has(`${v.name}/${f.name}`) && f.type.kind === 'array'
                      ? `Vec<${rustElement(f.type)}>`
                      : rustType(f.type)
                }`,
            )

            if (payload) {
              structs.push(`\n${pad(d)}${derive}struct ${payload} { ${fields.join(', ')} }`)

              return `${pad(d + 1)}${pascal(v.name)}(${payloadHolder(node.name)}<${payload}>)`
            }

            return `${pad(d + 1)}${pascal(v.name)}${
              fields.length > 0 ? ` { ${fields.join(', ')} }` : ''
            }`
          })

          return `${derive}enum ${pascal(
            node.name,
          )}${generics} {\n${cases.join(',\n')}\n${pad(d)}}${structs.join('')}${written}`
        }

        // a list the record owns is the plain `Vec` (`ownedFields`)
        const fields = node.fields.map(
          f =>
            `${pad(d + 1)}${snake(f.name)}: ${
              fieldLists.has(`${node.name}/${f.name}`) && f.type.kind === 'array' ? `Vec<${rustElement(f.type)}>` : rustType(f.type)
            }`,
        )

        // a generic parameter no field mentions (an opaque `dock` handle erases it) still has to be used, or
        // rustc refuses the struct (E0392): a PhantomData field carries the unused letters, and every
        // construction of the form appends the marker (see the record case)
        if (phantomForms.has(node.name)) {
          fields.push(
            `${pad(d + 1)}_marker: std::marker::PhantomData<${phantomForms.get(node.name)}>`,
          )
        }

        return `${derive}struct ${pascal(
          node.name,
        )}${generics} {\n${fields.join(',\n')}\n${pad(d)}}${written}`
      }

      case 'hold':
        return '// hold: verified at compile time'
      case 'native':
        return ''

      case 'mask': {
        // a trait, with each method derived from any implementing instance's signature (receiver type -> Self)
        const target = instanceTargets.get(node.name)?.[0]
        const decls = target
          ? node.methods
              .map(m =>
                traitMethodDecl(implFn.get(`${target}:${m}`), target),
              )
              .filter(Boolean)
          : []

        return `trait ${pascal(node.name)} {${
          decls.length
            ? `\n${decls.map(line => pad(d + 1) + line).join('\n')}\n${pad(d)}`
            : ''
        }}`
      }

      case 'instance': {
        // an `impl` block whose methods delegate to the free implementation functions
        const impls = node.methods
          .map(m =>
            implMethod(implFn.get(`${node.target}:${m}`), node.target),
          )
          .filter(Boolean)

        return `impl ${pascal(node.mask)} for ${pascal(node.target)} {${
          impls.length
            ? `\n${impls.map(line => pad(d + 1) + line).join('\n')}\n${pad(d)}`
            : ''
        }}`
      }

      case 'bind':
      case 'view':
      case 'dock':
      case 'tell':
      case 'roll':
        return ''
      default:
        return exhausted(node)
    }
  }

  // `use` declarations for native module bindings (a `<global:X>` binding needs no use; a `type` dock is an inline
  // type reference, not an import)
  const uses = program
    .filter(
      (n): n is Extract<Statement, { form: 'native' }> =>
        n.form === 'native' &&
        n.kind !== 'type' &&
        !n.module.startsWith('global:'),
    )
    .map(n => `use ${n.module.replace(/::|[:/]/g, '::')};`)


  // plus the `use` each rendered `bind` needs (e.g. `use sha2::Sha256;` for a `case rust` that calls `Sha256::digest`).
  // Two paths that bind the SAME final name collide in Rust (`use sha2::Digest;` + `use md5::Digest;` -> E0252), yet a
  // trait like `Digest` only needs to be in scope for method resolution, not named. So the first occurrence binds the
  // name and any later same-name path comes in anonymously with `as _` (in scope, no name), which is the Rust idiom.
  const bound = new Set<string>()

  for (const u of uses) {
    const m = /use .*?(\w+)(?: as (\w+))?;$/.exec(u)
    const name = m?.[2] ?? m?.[1]

    if (name) {
      bound.add(name)
    }
  }

  for (const need of bindImports(
    referencedBinds(program, binds),
    'rust',
  )) {
    const path = need.module.replace(/::|[:/]/g, '::')
    const name = need.alias ?? path.split('::').pop()!
    const line = need.alias
      ? `use ${path} as ${need.alias};`
      : bound.has(name)
        ? `use ${path} as _;`
        : `use ${path};`

    bound.add(name)

    if (!uses.includes(line)) {
      uses.push(line)
    }
  }

  // an abstract module's signature-only declaration and the platform module's implementation share a name by
  // design (platform dispatch): when both are in the closure, the stub yields to the implementation instead of
  // colliding with it (E0428)
  const implemented = new Set(
    program
      .filter(
        (n): n is Extract<Statement, { form: 'function' }> =>
          n.form === 'function' && n.body.length > 0,
      )
      .map(n => n.name),
  )


  // a form declared in an abstract module AND its platform module lands twice in the closure: the empty
  // declaration yields to the full one, and an exact repeat keeps only its first appearance
  const fullForms = new Set(
    program
      .filter(
        (n): n is Extract<Statement, { form: 'record-type' }> =>
          n.form === 'record-type' &&
          (n.fields.length > 0 || n.variants.length > 0),
      )
      .map(n => n.name),
  )
  const seenForms = new Set<string>()
  // a module collected twice (two import spellings of one file) emits its functions twice: keep the first
  const seenFns = new Set<string>()
  const keepStatement = (n: Statement): boolean => {
    if (n.form === 'function') {
      const key = `${n.name}/${n.params.length}`

      if (seenFns.has(key)) {
        return false
      }

      seenFns.add(key)
    }

    if (n.form !== 'record-type') {
      return true
    }

    if (
      n.fields.length === 0 &&
      n.variants.length === 0 &&
      fullForms.has(n.name)
    ) {
      return false
    }

    if (seenForms.has(n.name)) {
      return false
    }

    seenForms.add(n.name)

    return true
  }

  const body = [
    ...hostStructDefs,
    ...program
      .filter(n => n.form !== 'native')
      .filter(
        n =>
          !(
            n.form === 'function' &&
            n.body.length === 0 &&
            implemented.has(n.name)
          ),
      )
      .filter(keepStatement)
      .map(n => (n.form === 'let' ? moduleLet(n) : stmt(n, 0))),
  ].filter(Boolean)

  // each task a guarded loop calls unchecked, once more with plain arithmetic and its proven non-negative divisions
  // unsigned (`a_value_fast`), behind the bound the guard proved its arguments inside (ir/facts/bounds.ts)
  for (const name of fastTasks) {
    const fn = program.find((n): n is Extract<Statement, { form: 'function' }> => n.form === 'function' && n.name === name)

    if (fn) {
      uncheckedInts = true
      body.push(stmt({ ...fn, name: `${name}-fast` }, 0))
      uncheckedInts = false
    }
  }

  // the Term `hash` on this backend: an insertion-ordered map, so a walk over its keys visits them in the order they
  // were first set, as TypeScript's Map and Kotlin's LinkedHashMap do. std's HashMap is seeded per process, and the
  // same binary walked one map in a different order on every run (note/term/optimize/meaning.md, question 1).
  // Always emitted: a runtime shim may name `crate::TermMap` in a program whose own code never does.
  const termMap = [
    `// an insertion-ordered map, the Term \`hash\` (note/term/optimize/meaning.md, question 1)
#[allow(dead_code)]
#[derive(Clone)]
pub struct TermMap<K, V> { table: Vec<u32>, entry: Vec<Option<(u64, K, V)>>, live: usize, tombs: usize, dead: usize, state: std::collections::hash_map::RandomState }
#[allow(dead_code)]
impl<K: std::hash::Hash + Eq + Clone, V> TermMap<K, V> {
    // each key is held once, in its entry: the table holds entry indexes (EMPTY, or TOMB where one was removed), probed
    // linearly from the key's hash, and a key is compared in its entry. The entries keep insertion order, which is
    // what a walk visits
    const EMPTY: u32 = u32::MAX;
    const TOMB: u32 = u32::MAX - 1;
    pub fn new() -> Self { TermMap { table: Vec::new(), entry: Vec::new(), live: 0, tombs: 0, dead: 0, state: std::collections::hash_map::RandomState::new() } }
    pub fn len(&self) -> usize { self.live }
    pub fn is_empty(&self) -> bool { self.live == 0 }
    fn hash<Q: std::hash::Hash + ?Sized>(&self, key: &Q) -> u64 { std::hash::BuildHasher::hash_one(&self.state, key) }
    // the table slot holding the key, if it is present
    fn find<Q: Eq + ?Sized>(&self, h: u64, key: &Q) -> Option<usize> where K: std::borrow::Borrow<Q> {
        if self.table.is_empty() { return None; }
        let mask = self.table.len() - 1;
        let mut at = (h as usize) & mask;
        loop {
            let i = self.table[at];
            if i == Self::EMPTY { return None; }
            if i != Self::TOMB { if let Some((eh, k, _)) = &self.entry[i as usize] { if *eh == h && k.borrow() == key { return Some(at); } } }
            at = (at + 1) & mask;
        }
    }
    // the table rebuilt at a size for the live entries, which also clears every tomb
    fn rebuild(&mut self, size: usize) {
        let size = size.max(8).next_power_of_two();
        self.table = vec![Self::EMPTY; size];
        self.tombs = 0;
        let mask = size - 1;
        for (i, e) in self.entry.iter().enumerate() {
            if let Some((h, _, _)) = e {
                let mut at = (*h as usize) & mask;
                while self.table[at] != Self::EMPTY { at = (at + 1) & mask; }
                self.table[at] = i as u32;
            }
        }
    }
    pub fn contains_key(&self, key: &K) -> bool { self.find(self.hash(key), key).is_some() }
    // a text key looked up as the \`str\` it is, so a \`String\` key and a \`TermKey\` are read alike, with nothing made
    pub fn has_text(&self, key: &str) -> bool where K: std::borrow::Borrow<str> { self.find(self.hash(key), key).is_some() }
    pub fn get_text(&self, key: &str) -> Option<&V> where K: std::borrow::Borrow<str> {
        let at = self.find(self.hash(key), key)?;
        self.entry[self.table[at] as usize].as_ref().map(|e| &e.2)
    }
    pub fn remove_text(&mut self, key: &str) -> Option<V> where K: std::borrow::Borrow<str> {
        let at = self.find(self.hash(key), key)?;
        self.take_at(at)
    }
    pub fn get(&self, key: &K) -> Option<&V> {
        let at = self.find(self.hash(key), key)?;
        self.entry[self.table[at] as usize].as_ref().map(|e| &e.2)
    }
    pub fn get_mut(&mut self, key: &K) -> Option<&mut V> {
        let at = self.find(self.hash(key), key)?;
        let i = self.table[at] as usize;
        self.entry[i].as_mut().map(|e| &mut e.2)
    }
    pub fn insert(&mut self, key: K, value: V) -> Option<V> {
        let h = self.hash(&key);
        if let Some(at) = self.find(h, &key) {
            let i = self.table[at] as usize;
            return self.entry[i].as_mut().map(|e| std::mem::replace(&mut e.2, value));
        }
        self.push(h, key, value);
        None
    }
    // a new entry for a key that is not present, its index answered
    fn push(&mut self, h: u64, key: K, value: V) -> usize {
        // at most half full, tombs counted, so a probe always ends at an EMPTY
        if (self.live + self.tombs + 1) * 2 > self.table.len() { self.rebuild((self.live + 1) * 4); }
        let mask = self.table.len() - 1;
        let mut at = (h as usize) & mask;
        while self.table[at] != Self::EMPTY && self.table[at] != Self::TOMB { at = (at + 1) & mask; }
        if self.table[at] == Self::TOMB { self.tombs -= 1; }
        self.table[at] = self.entry.len() as u32;
        self.entry.push(Some((h, key, value)));
        self.live += 1;
        self.entry.len() - 1
    }
    // the value of a key, made \`fallback\` first when it is absent: one hash and one probe for a read and write
    // (backend.ts, \`mapUpdate\`)
    pub fn upsert(&mut self, key: K, fallback: V) -> &mut V {
        let h = self.hash(&key);
        let i = match self.find(h, &key) { Some(at) => self.table[at] as usize, None => self.push(h, key, fallback) };
        &mut self.entry[i].as_mut().unwrap().2
    }
    // the same through a borrowed key (a \`&str\` for a String key or a \`TermKey\`), made owned only when it is new: a
    // key read out of a larger text costs nothing for an entry already there
    pub fn upsert_ref<Q: std::hash::Hash + Eq + ?Sized>(&mut self, key: &Q, fallback: V) -> &mut V where K: std::borrow::Borrow<Q> + for<'a> From<&'a Q> {
        let h = self.hash(key);
        let i = match self.find(h, key) { Some(at) => self.table[at] as usize, None => self.push(h, K::from(key), fallback) };
        &mut self.entry[i].as_mut().unwrap().2
    }
    pub fn remove(&mut self, key: &K) -> Option<V> {
        let at = self.find(self.hash(key), key)?;
        self.take_at(at)
    }
    // the entry at a table slot taken out, its slot a tomb
    fn take_at(&mut self, at: usize) -> Option<V> {
        let i = self.table[at] as usize;
        self.table[at] = Self::TOMB;
        self.tombs += 1;
        self.live -= 1;
        let out = self.entry[i].take().map(|e| e.2);
        self.dead += 1;
        if self.dead > 16 && self.dead * 2 > self.entry.len() { self.compact(); }
        out
    }
    fn compact(&mut self) {
        self.entry.retain(|e| e.is_some());
        self.dead = 0;
        let size = self.table.len();
        self.rebuild(size);
    }
    pub fn clear(&mut self) { self.table.clear(); self.entry.clear(); self.live = 0; self.tombs = 0; self.dead = 0; }
    pub fn iter(&self) -> impl Iterator<Item = (&K, &V)> { self.entry.iter().filter_map(|e| e.as_ref().map(|(_, k, v)| (k, v))) }
    pub fn keys(&self) -> impl Iterator<Item = &K> { self.iter().map(|(k, _)| k) }
    pub fn values(&self) -> impl Iterator<Item = &V> { self.iter().map(|(_, v)| v) }
}
impl<K: std::hash::Hash + Eq + Clone, V> Default for TermMap<K, V> { fn default() -> Self { Self::new() } }
impl<K: std::hash::Hash + Eq + Clone, V, const N: usize> From<[(K, V); N]> for TermMap<K, V> {
    fn from(items: [(K, V); N]) -> Self { let mut m = Self::new(); for (k, v) in items { m.insert(k, v); } m }
}
impl<K: std::hash::Hash + Eq + Clone, V> std::iter::FromIterator<(K, V)> for TermMap<K, V> {
    fn from_iter<I: IntoIterator<Item = (K, V)>>(items: I) -> Self { let mut m = Self::new(); for (k, v) in items { m.insert(k, v); } m }
}
// two maps are equal when they hold the same keys with equal values, in any order (Kotlin's Map.equals)
impl<K: std::hash::Hash + Eq + Clone, V: PartialEq> PartialEq for TermMap<K, V> {
    fn eq(&self, other: &Self) -> bool { self.len() == other.len() && self.iter().all(|(k, v)| other.get(k) == Some(v)) }
}
impl<K: std::hash::Hash + Eq + Clone + std::fmt::Debug, V: std::fmt::Debug> std::fmt::Debug for TermMap<K, V> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.debug_map().entries(self.iter()).finish() }
}`,
    // a value of a `mark shared` form: one object behind every binding. Equal, and hashed, by IDENTITY, the meaning
    // on every backend, so it can be a record's field and a map's key. Derefs to the RefCell, so `.borrow()` and
    // `.borrow_mut()` reach the object as through a bare `Rc<RefCell<..>>`
    `// a value of a \`mark shared\` form (optimize-0042): one object, compared and hashed by identity
#[allow(dead_code)]
pub struct TermShared<T>(pub std::rc::Rc<std::cell::RefCell<T>>);
#[allow(dead_code)]
impl<T> TermShared<T> { pub fn new(value: T) -> Self { TermShared(std::rc::Rc::new(std::cell::RefCell::new(value))) } }
impl<T> Clone for TermShared<T> { fn clone(&self) -> Self { TermShared(self.0.clone()) } }
impl<T> PartialEq for TermShared<T> { fn eq(&self, other: &Self) -> bool { std::rc::Rc::ptr_eq(&self.0, &other.0) } }
impl<T> Eq for TermShared<T> {}
impl<T> std::hash::Hash for TermShared<T> {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) { (std::rc::Rc::as_ptr(&self.0) as *const () as usize).hash(state) }
}
impl<T> std::ops::Deref for TermShared<T> { type Target = std::cell::RefCell<T>; fn deref(&self) -> &Self::Target { &self.0 } }`,
    // a code point of a text read through its cursor (backend.ts, `textCursors`): the code-point index and byte
    // offset of the last read, stepped forward or back from, or restarted at the start when that is nearer. A read
    // past the end leaves it at the end
    `// a code point read through a cursor, the code-point index and byte offset of the last read: the byte offset of code
// point i, stepped forward or back from the last, or from the start when that is nearer, the end past the last
#[allow(dead_code)]
pub fn term_cursor_to(h: &str, i: usize, c: &mut (usize, usize)) -> usize {
    let b = h.as_bytes();
    if i < c.0 {
        if i <= c.0 - i {
            *c = (0, 0);
        } else {
            while c.0 > i {
                c.1 -= 1;
                while b[c.1] & 0xC0 == 0x80 { c.1 -= 1; }
                c.0 -= 1;
            }
        }
    }
    while c.0 < i {
        if c.1 >= b.len() { return b.len(); }
        c.1 += term_width(b[c.1]);
        c.0 += 1;
    }
    c.1
}
// the UTF-8 width of a code point from its first byte
#[allow(dead_code)]
#[inline]
pub fn term_width(x: u8) -> usize { if x < 0x80 { 1 } else if x < 0xE0 { 2 } else if x < 0xF0 { 3 } else { 4 } }
#[allow(dead_code)]
pub fn term_cursor(h: &str, i: i64, c: &mut (usize, usize)) -> Option<char> {
    if i < 0 { return None; }
    let o = term_cursor_to(h, i as usize, c);
    h[o..].chars().next()
}
// the code points from a to e through the cursor, both clamped to the text and swapped when reversed (the Term
// meaning): the cursor moves to the start, and the end is counted on from it
#[allow(dead_code)]
pub fn term_cursor_slice(h: &str, a: i64, e: i64, c: &mut (usize, usize)) -> String {
    let (x, y) = if a <= e { (a, e) } else { (e, a) };
    let (x, y) = (x.max(0) as usize, y.max(0) as usize);
    let b = h.as_bytes();
    let from = term_cursor_to(h, x, c);
    let mut to = from;
    let mut k = x;
    while k < y && to < b.len() {
        to += term_width(b[to]);
        k += 1;
    }
    h[from..to].to_string()
}`,
    // a float as text, the same on every backend (note/term/stdlib/semantics.md, "Numbers as text"): the shortest
    // digits that read back as the same float, laid out as ECMAScript's Number::toString lays them out. Rust's own
    // Display never uses an exponent and prints -0 as "-0"
    `// a float as text, ECMAScript's layout over the shortest round-trip digits
#[allow(dead_code)]
pub fn term_number(x: f64) -> String {
    if x.is_nan() { return "NaN".to_string(); }
    if x.is_infinite() { return if x > 0.0 { "Infinity".to_string() } else { "-Infinity".to_string() }; }
    if x == 0.0 { return "0".to_string(); }
    let shortest = format!("{:e}", x.abs());
    let (mantissa, exponent) = shortest.split_once('e').unwrap_or((shortest.as_str(), "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let digits = digits.trim_end_matches('0').to_string();
    let digits = if digits.is_empty() { "0".to_string() } else { digits };
    let k = digits.len() as i64;
    let n = exponent.parse::<i64>().unwrap_or(0) + 1;
    let body = if k <= n && n <= 21 {
        format!("{}{}", digits, "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{}", "0".repeat((-n) as usize), digits)
    } else {
        let e = n - 1;
        let sign = if e < 0 { "-" } else { "+" };
        if k == 1 { format!("{}e{}{}", digits, sign, e.abs()) } else { format!("{}.{}e{}{}", &digits[..1], &digits[1..], sign, e.abs()) }
    };
    if x < 0.0 { format!("-{}", body) } else { body }
}`,
  ]

  // a fill walker raises `data-mismatch` through the carrier, so it brings the carrier wherever its fill is
  const carrier = carries || fillSpecs.size > 0
    ? [
        `// the one exception value of a Term program on this backend (note/term/hive/11-native-exceptions.md). Its fields
// are boxed, so the carrier is one pointer and every \`Result\` a raising task answers stays the size of its value: the
// fields inline made each \`Ok\` 136 bytes, copied on every return (clippy's result_large_err). Read through Deref
#[derive(Clone)]
pub struct TermException(pub Box<TermRaised>);
#[derive(Clone)]
pub struct TermRaised { pub host: String, pub form: String, pub note: String, pub code: String, pub time: i64, pub link: std::rc::Rc<dyn std::any::Any>, pub base: std::rc::Rc<dyn std::any::Any> }
impl std::ops::Deref for TermException { type Target = TermRaised; fn deref(&self) -> &TermRaised { &self.0 } }
impl std::ops::DerefMut for TermException { fn deref_mut(&mut self) -> &mut TermRaised { &mut self.0 } }
impl std::fmt::Display for TermException { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{}: {}", self.form, self.note) } }
impl std::fmt::Debug for TermException { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{}: {}", self.form, self.note) } }
impl std::error::Error for TermException {}
// a text raised as \`failure\`, built out of line: the carrier's seven fields written at each raise kept the task that
// raises too large for LLVM to lay out its happy path tight (Towers 69 ms to 63, \`tmp/rust-towers-rest4-ab.ts\`)
#[allow(dead_code)]
#[cold]
#[inline(never)]
fn term_fail(note: impl Into<String>) -> TermException {
    TermException(Box::new(TermRaised { host: String::new(), form: "failure".to_string(), note: note.into(), code: String::new(), time: 0, link: std::rc::Rc::new(()), base: std::rc::Rc::new(()) }))
}
// the same, given what the raising task held that it would otherwise drop on the way out (its spare boxes, rust.ts
// \`localForms\`), so the raise path drops nothing inline
#[allow(dead_code)]
#[cold]
#[inline(never)]
fn term_fail_with<T>(held: T, note: impl Into<String>) -> TermException {
    drop(held);
    term_fail(note)
}`,
      ]
    : []

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
          ? `std::rc::Rc::new(${moduleRead(ref)})`
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

  // the preemption budget, when any loop checks it: BEAM's 4,000 reductions, counted per thread, refilled on a yield
  const budget = budgetUses > 0
    ? [
        `// the preemption budget (note/term/research/beam-otp-lessons.md, design 5): an asynchronous loop yields to the
// scheduler once every ${BUDGET} turns, so no task starves the others on its runtime
thread_local! { static __TERM_BUDGET: std::cell::Cell<u32> = std::cell::Cell::new(${BUDGET}); }
async fn __term_budget() {
    let left = __TERM_BUDGET.with(|b| { let n = b.get().saturating_sub(1); b.set(n); n });
    if left == 0 {
        __TERM_BUDGET.with(|b| b.set(${BUDGET}));
        tokio::task::yield_now().await;
    }
}`,
      ]
    : []

  // the executor for fire-and-forget calls (terminal-target-0005): a queue on this thread, and a drain that polls it
  // until nothing more is ready, with a waker that does nothing. Standard library only, so a program that `tick`s an
  // asynchronous task still builds with a bare rustc. What it runs either finishes without waiting on the outside
  // world, or stays queued for the next drain. Emitted when a call is queued or a program drains (`run-pending`)
  const drains = body.some(line => line.includes('__term_drain('))
  const spawnHelpers = spawnUses > 0 || drains
    ? [
        `// fire and forget: a future nobody awaits is queued here and polled by \`__term_drain\`, never dropped unrun
thread_local! { static __TERM_SPAWNED: std::cell::RefCell<Vec<std::pin::Pin<Box<dyn std::future::Future<Output = ()>>>>> = std::cell::RefCell::new(Vec::new()); }
#[allow(dead_code)]
fn __term_spawn<T: 'static>(work: impl std::future::Future<Output = T> + 'static) {
    __TERM_SPAWNED.with(|queue| queue.borrow_mut().push(Box::pin(async move { let _ = work.await; })));
}
#[allow(dead_code)]
fn __term_drain() {
    let mut context = std::task::Context::from_waker(std::task::Waker::noop());
    loop {
        let pending: Vec<_> = __TERM_SPAWNED.with(|queue| std::mem::take(&mut *queue.borrow_mut()));
        if pending.is_empty() {
            break;
        }
        let mut waiting = Vec::new();
        let mut finished = false;
        for mut work in pending {
            if work.as_mut().poll(&mut context).is_ready() {
                finished = true;
            } else {
                waiting.push(work);
            }
        }
        // what the polled work queued in turn goes after what is still waiting
        __TERM_SPAWNED.with(|queue| {
            let mut queued = queue.borrow_mut();
            waiting.append(&mut queued);
            *queued = waiting;
        });
        if !finished {
            break;
        }
    }
}`,
      ]
    : []

  lastBudgetStats = { checked: budgetUses, elided: budgetElided }

  // `melt` clones every field of each form it melts (item 0029)
  for (const form of meltSpecs.keys()) {
    noteClone({ kind: 'named', name: form })
  }

  // the box reuse of each form an arm opened and a construction built (`reusable`); a form with only one of the two
  // keeps the plain allocation, written back where the calls were emitted
  const reuse: string[] = []
  // a task that both opens and builds a boxed form keeps the box it opened in a local spare and builds its next node in
  // it, where the per-thread pool took two thread-local accesses per node: the box crosses no call, so nothing can
  // tell. Towers' moves, once `pop-disk` and `push-disk` are inlined into them (ir/inline-statements.ts)
  const localForms = [...reuseOpened].filter(form => reuseBuilt.has(form) && boxedForms.has(form))
  const localUsed = new Set<string>()
  // each call to `helper(` in a text with one more argument, `, extra`, inserted at its own closing parenthesis
  const addArgument = (text: string, helper: string, renamed: string, extra: string): string => {
    let out = ''
    let at = 0

    for (;;) {
      const start = text.indexOf(`${helper}(`, at)

      if (start < 0) {
        return out + text.slice(at)
      }

      let depth = 0
      let end = start + helper.length

      for (; end < text.length; end++) {
        if (text[end] === '(') depth++
        if (text[end] === ')' && --depth === 0) break
      }

      out += `${text.slice(at, start)}${renamed}(${text.slice(start + helper.length + 1, end)}, ${extra})`
      at = end + 1
    }
  }
  const localBody = body.map(text => {
    let out = text
    const spares: string[] = []

    for (const form of localForms) {
      const name = snake(form)

      if (!out.startsWith('fn ') && !out.startsWith('pub fn ')) continue
      if (!out.includes(`term_open_${name}(`) || !out.includes(`term_box_${name}(`)) continue

      const spare = `__spare_${name}`
      const payload = reusedPayload(form)
      out = addArgument(out, `term_open_${name}`, `term_open_local_${name}`, `&mut ${spare}`)
      out = addArgument(out, `term_box_${name}`, `term_box_local_${name}`, `&mut ${spare}`)
      const open = out.indexOf('{\n')
      const kept = payload ? `std::mem::MaybeUninit<${payload}>` : pascal(form)
      out = `${out.slice(0, open + 2)}    let mut ${spare}: Option<Box<${kept}>> = None;\n${out.slice(open + 2)}`
      localUsed.add(form)
      spares.push(spare)
    }

    // a text raised in such a task hands its spares to the cold function, which drops them: the raise path then drops
    // nothing of its own, and LLVM lays the task out as tight as one whose raises never return. Towers' `move_top`
    // inlined into the recursion, its `Result` kept, 54 ms to 38 against the hand version's 40
    // (`tmp/rust-towers-rest5-ab.ts`). Not in a task holding a closure, a guard (`(|| ...)()`) or an async block, whose
    // `return` may be its own
    if (spares.length > 0 && !out.includes('move |') && !out.includes('(|| ') && !out.includes('async {')) {
      const held = spares.length === 1 ? spares[0]! : `(${spares.join(', ')})`
      // a raised RECORD keeps its inline drop: a program that raises one carries the exception module's generic code,
      // which turns boxing off (`rustBoxing`, `generic`), so no task holding a spare can raise one today
      // (test/compile/rust-box.ts holds that, so a finer boxing fact is pointed back here)
      out = out.split('return std::result::Result::Err(term_fail(').join(`return std::result::Result::Err(term_fail_with(${held}, `)
    }

    return out
  })
  let assembled = localBody.join('\n\n')

  for (const form of new Set([...reuseOpened, ...reuseBuilt])) {
    const type = pascal(form)
    const name = snake(form)
    const empty = `${type}::${pascal(emptyCase({ kind: 'named', name: form })!.empty)}`
    const boxed = boxedForms.has(form)

    if (!reuseOpened.has(form) || !reuseBuilt.has(form)) {
      assembled = assembled
        .split(`term_box_${name}(`).join(boxed ? 'Box::new(' : 'std::rc::Rc::new(')
        .replace(new RegExp(`term_open_${name}\\((\\w+)\\)`, 'g'), boxed ? '*$1' : 'std::rc::Rc::unwrap_or_clone($1)')
      continue
    }

    const pool = `TERM_POOL_${name.toUpperCase()}`
    const payload = reusedPayload(form)

    // a form held by payload keeps the box of its payload case as memory of that layout, uninitialized: opening reads
    // the node out and writes nothing back, building writes the node in, and nothing is forgotten. Rust has no safe
    // spelling for taking a value out of a box and keeping the allocation, hence the two `unsafe` lines
    if (payload) {
      const kept = `Box<std::mem::MaybeUninit<${payload}>>`

      reuse.push(`// the boxes of \`${form}\` an arm opened, kept for the next \`${form}\` built: a spare, and up to 64 more behind it
// for a run of frees before a run of builds (rust.ts, \`reusable\`). Each is the memory of a \`${payload}\`, holding none
#[allow(clippy::vec_box)]
struct TermPool${type} { spare: std::cell::Cell<Option<${kept}>>, more: std::cell::RefCell<Vec<${kept}>> }
impl TermPool${type} {
    #[inline]
    fn keep(&self, held: ${kept}) {
        if let Some(before) = self.spare.replace(Some(held)) {
            let mut more = self.more.borrow_mut();
            if more.len() < 64 { more.push(before); }
        }
    }
    #[inline]
    fn take(&self) -> Option<${kept}> {
        self.spare.take().or_else(|| self.more.borrow_mut().pop())
    }
}
thread_local! { static ${pool}: TermPool${type} = const { TermPool${type} { spare: std::cell::Cell::new(None), more: std::cell::RefCell::new(Vec::new()) } }; }
// a node read out of its box, and the box kept as memory of the same layout
#[inline]
fn term_split_${name}(held: Box<${payload}>) -> (${payload}, ${kept}) {
    let raw = Box::into_raw(held);
    // SAFETY: \`raw\` came from a live box: the node is read out once, and the allocation is handed back as uninitialized
    unsafe { (std::ptr::read(raw), Box::from_raw(raw.cast::<std::mem::MaybeUninit<${payload}>>())) }
}
#[inline]
fn term_open_${name}(held: Box<${payload}>) -> ${payload} {
    let (value, held) = term_split_${name}(held);
    ${pool}.with(|pool| pool.keep(held));
    value
}
#[inline]
fn term_box_${name}(value: ${payload}) -> Box<${payload}> {
    match ${pool}.with(|pool| pool.take()) {
        Some(held) => Box::write(held, value),
        None => Box::new(value),
    }
}${
        localUsed.has(form)
          ? `
// the same, through a task's own spare first (\`localForms\`): a box opened is kept there, a box built takes it
#[inline]
fn term_open_local_${name}(held: Box<${payload}>, spare: &mut Option<${kept}>) -> ${payload} {
    let (value, held) = term_split_${name}(held);
    if let Some(before) = spare.replace(held) {
        ${pool}.with(|pool| pool.keep(before));
    }
    value
}
#[inline]
fn term_box_local_${name}(value: ${payload}, spare: &mut Option<${kept}>) -> Box<${payload}> {
    match spare.take() {
        Some(held) => Box::write(held, value),
        None => term_box_${name}(value),
    }
}`
          : ''
      }`)
      continue
    }

    const holder = boxed ? `Box<${type}>` : `std::rc::Rc<${type}>`
    // a box kept is unique: a Box always, an Rc when `get_mut` answers, and one still shared is cloned out as before
    const open = boxed
      ? `fn term_open_${name}(mut held: ${holder}) -> ${type} {
    let value = std::mem::replace(&mut *held, ${empty});
    ${pool}.with(|pool| pool.keep(held));
    value
}`
      : `fn term_open_${name}(mut held: ${holder}) -> ${type} {
    match std::rc::Rc::get_mut(&mut held) {
        Some(inner) => {
            let value = std::mem::replace(inner, ${empty});
            ${pool}.with(|pool| pool.keep(held));
            value
        }
        None => (*held).clone(),
    }
}`
    const make = boxed
      ? `fn term_box_${name}(value: ${type}) -> ${holder} {
    match ${pool}.with(|pool| pool.take()) {
        Some(mut held) => {
            // a kept box holds the field-less case its opening left, so it is forgotten rather than dropped
            std::mem::forget(std::mem::replace(&mut *held, value));
            held
        }
        None => Box::new(value),
    }
}`
      : `fn term_box_${name}(value: ${type}) -> ${holder} {
    match ${pool}.with(|pool| pool.take()) {
        Some(mut held) => match std::rc::Rc::get_mut(&mut held) {
            Some(inner) => {
                std::mem::forget(std::mem::replace(inner, value));
                held
            }
            None => std::rc::Rc::new(value),
        },
        None => std::rc::Rc::new(value),
    }
}`

    reuse.push(`// the boxes of \`${form}\` an arm unboxed, kept for the next \`${form}\` built: a spare, and up to 64 more behind it
// for a run of frees before a run of builds (rust.ts, \`reusable\`)
#[allow(clippy::vec_box)]
struct TermPool${type} { spare: std::cell::Cell<Option<${holder}>>, more: std::cell::RefCell<Vec<${holder}>> }
impl TermPool${type} {
    #[inline]
    fn keep(&self, held: ${holder}) {
        if let Some(before) = self.spare.replace(Some(held)) {
            let mut more = self.more.borrow_mut();
            if more.len() < 64 { more.push(before); }
        }
    }
    #[inline]
    fn take(&self) -> Option<${holder}> {
        self.spare.take().or_else(|| self.more.borrow_mut().pop())
    }
}
thread_local! { static ${pool}: TermPool${type} = const { TermPool${type} { spare: std::cell::Cell::new(None), more: std::cell::RefCell::new(Vec::new()) } }; }
#[inline]
${open}
#[inline]
${make}${
      localUsed.has(form)
        ? `
// the same, through a task's own spare first (\`localForms\`): a box opened is kept there, a box built takes it
#[inline]
fn term_open_local_${name}(mut held: ${holder}, spare: &mut Option<${holder}>) -> ${type} {
    let value = std::mem::replace(&mut *held, ${empty});
    if let Some(before) = spare.replace(held) {
        ${pool}.with(|pool| pool.keep(before));
    }
    value
}
#[inline]
fn term_box_local_${name}(value: ${type}, spare: &mut Option<${holder}>) -> ${holder} {
    match spare.take() {
        Some(mut held) => {
            std::mem::forget(std::mem::replace(&mut *held, value));
            held
        }
        None => term_box_${name}(value),
    }
}`
        : ''
    }`)
  }

  // the key of a map keyed by text where nothing can see a key as a value (`textKeysOf`)
  const termKey = rustTextKeys
    ? [
        `// a map key that holds a text of up to 22 bytes in place and allocates only past that (rust.ts, \`textKeysOf\`).
// It hashes, compares and prints as the \`str\` it holds, so a map of them means what a map of \`String\`s does
#[derive(Clone)]
pub enum TermKey { Inline(u8, [u8; 22]), Heap(Box<str>) }
impl TermKey {
    #[inline]
    pub fn as_str(&self) -> &str {
        match self {
            // SAFETY: the bytes were copied whole from a \`str\`, and \`len\` of them are set
            TermKey::Inline(len, bytes) => unsafe { std::str::from_utf8_unchecked(&bytes[..*len as usize]) },
            TermKey::Heap(text) => text,
        }
    }
}
impl From<&str> for TermKey {
    #[inline]
    fn from(text: &str) -> Self {
        if text.len() <= 22 {
            let mut bytes = [0u8; 22];
            bytes[..text.len()].copy_from_slice(text.as_bytes());
            TermKey::Inline(text.len() as u8, bytes)
        } else {
            TermKey::Heap(text.into())
        }
    }
}
// a key built by formatting (\`TermKey::from(&(format!(..)))\`) is a \`&String\`, which trait lookup does not deref to a \`&str\`
impl From<&String> for TermKey {
    #[inline]
    fn from(text: &String) -> Self { TermKey::from(text.as_str()) }
}
impl std::borrow::Borrow<str> for TermKey { fn borrow(&self) -> &str { self.as_str() } }
impl PartialEq for TermKey { fn eq(&self, other: &Self) -> bool { self.as_str() == other.as_str() } }
impl Eq for TermKey {}
impl std::hash::Hash for TermKey { fn hash<H: std::hash::Hasher>(&self, state: &mut H) { self.as_str().hash(state) } }
impl std::fmt::Display for TermKey { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { std::fmt::Display::fmt(self.as_str(), f) } }
impl std::fmt::Debug for TermKey { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { std::fmt::Debug::fmt(self.as_str(), f) } }`,
      ]
    : []

  return [...uses, ...termMap, ...termKey, ...carrier, ...budget, ...spawnHelpers, ...reuse, ...(body.length ? [assembled] : []), ...rustFormWalk(fillSpecs, meltSpecs), ...wake].join('\n\n') + '\n'
}

// how many asynchronous loops the last `emitRust` gave a budget check, and how many it left one out of because a
// small literal bounds them: the elision rate design 5 asked to be measured before it is promised
let lastBudgetStats = { checked: 0, elided: 0 }

export function budgetStats(): { checked: number; elided: number } {
  return lastBudgetStats
}

// MUTATED-CAPTURE analysis: the names a function must box in `Rc<RefCell>` because a nested closure assigns to them.
// Walks every closure body (any nesting), collecting assignment targets -- a bare variable, or the root variable of a
// member target (`x/field = v` mutates x through the capture too). Names the closure itself declares (`let`) or takes
// as parameters are its own locals, not captures, so they are excluded. Function-typed names are left alone (a stored
// closure is never sensibly reassigned through a capture, and `Box<dyn Fn>` is not `Clone`).
function mutatedCaptures(body: Statement[]): Set<string> {
  const out = new Set<string>()

  // collect assign targets in a CLOSURE body, minus the closure's own locals
  const insideClosure = (
    stmts: Statement[],
    locals: Set<string>,
  ): void => {
    for (const s of stmts) {
      switch (s.form) {
        case 'let':
          locals.add(s.name)
          exprWalk(s.init, locals, true)
          break
        case 'assign': {
          let target: Expression = s.target

          while (target.form === 'member') {
            target = target.target
          }

          if (
            target.form === 'variable' &&
            !locals.has(target.name) &&
            target.type?.kind !== 'function'
          ) {
            out.add(target.name)
          }

          exprWalk(s.value, locals, true)
          break
        }
        case 'expression':
          exprWalk(s.expr, locals, true)
          break
        case 'return':
          if (s.value) {
            exprWalk(s.value, locals, true)
          }

          break
        case 'throw':
          exprWalk(s.value, locals, true)
          break
        case 'if':
          s.branches.forEach(b => {
            exprWalk(b.cond, locals, true)
            insideClosure(b.body, locals)
          })

          if (s.otherwise) {
            insideClosure(s.otherwise, locals)
          }

          break
        case 'match':
          exprWalk(s.subject, locals, true)
          s.cases.forEach(c => insideClosure(c.body, locals))

          if (s.otherwise) {
            insideClosure(s.otherwise, locals)
          }

          break
        case 'guard':
          insideClosure(s.body, locals)

          if (s.catch) {
            insideClosure(s.catch.body, locals)
          }

          break
        case 'while':
          exprWalk(s.cond, locals, true)
          insideClosure(s.body, locals)
          break
        case 'for-each':
          exprWalk(s.iterable, locals, true)
          insideClosure(s.body, locals)
          break
        default:
          break
      }
    }
  }

  const exprWalk = (
    e: Expression,
    locals: Set<string>,
    inClosure: boolean,
  ): void => {
    switch (e.form) {
      case 'closure': {
        const inner = new Set(inClosure ? locals : [])
        e.params.forEach(p => inner.add(p.name))
        insideClosure(e.body, inner)
        break
      }
      case 'call':
        exprWalk(e.callee, locals, inClosure)
        e.args.forEach(a => exprWalk(a, locals, inClosure))
        break
      case 'binary':
        exprWalk(e.left, locals, inClosure)
        exprWalk(e.right, locals, inClosure)
        break
      case 'unary':
        exprWalk(e.operand, locals, inClosure)
        break
      case 'array':
        e.items.forEach(i => exprWalk(i, locals, inClosure))
        break
      case 'map':
        e.entries.forEach(en => {
          exprWalk(en.key, locals, inClosure)
          exprWalk(en.value, locals, inClosure)
        })
        break
      case 'record':
        e.fields.forEach(f => exprWalk(f.value, locals, inClosure))
        break
      case 'member':
        exprWalk(e.target, locals, inClosure)
        break
      case 'await':
        exprWalk(e.expr, locals, inClosure)
        break
      case 'conditional':
        e.branches.forEach(b => {
          exprWalk(b.cond, locals, inClosure)
          exprWalk(b.value, locals, inClosure)
        })

        if (e.otherwise) {
          exprWalk(e.otherwise, locals, inClosure)
        }

        break
      default:
        break
    }
  }

  const topWalk = (stmts: Statement[]): void => {
    for (const s of stmts) {
      switch (s.form) {
        case 'let':
          exprWalk(s.init, new Set(), false)
          break
        case 'assign':
          exprWalk(s.target, new Set(), false)
          exprWalk(s.value, new Set(), false)
          break
        case 'expression':
          exprWalk(s.expr, new Set(), false)
          break
        case 'return':
          if (s.value) {
            exprWalk(s.value, new Set(), false)
          }

          break
        case 'throw':
          exprWalk(s.value, new Set(), false)
          break
        case 'if':
          s.branches.forEach(b => {
            exprWalk(b.cond, new Set(), false)
            topWalk(b.body)
          })

          if (s.otherwise) {
            topWalk(s.otherwise)
          }

          break
        case 'match':
          exprWalk(s.subject, new Set(), false)
          s.cases.forEach(c => topWalk(c.body))

          if (s.otherwise) {
            topWalk(s.otherwise)
          }

          break
        case 'guard':
          topWalk(s.body)

          if (s.catch) {
            topWalk(s.catch.body)
          }

          break
        case 'while':
          exprWalk(s.cond, new Set(), false)
          topWalk(s.body)
          break
        case 'for-each':
          exprWalk(s.iterable, new Set(), false)
          topWalk(s.body)
          break
        default:
          break
      }
    }
  }

  topWalk(body)

  return out
}

// every variable name READ or written anywhere in a body (used to decide which Rc<RefCell> handles a closure captures)
// every name a body binds with `let`, at any depth (loop variables and match arms bind through their own forms
// and read through the same emitter paths, so a module constant of those names is shadowed the same way)
function usedNames(body: Statement[], into: Set<string>): void {
  const exprNames = (e: Expression): void => {
    switch (e.form) {
      case 'variable':
      case 'hole':
        into.add(e.name)
        break
      case 'call':
        exprNames(e.callee)
        e.args.forEach(exprNames)
        break
      case 'binary':
        exprNames(e.left)
        exprNames(e.right)
        break
      case 'unary':
        exprNames(e.operand)
        break
      case 'array':
        e.items.forEach(exprNames)
        break
      case 'map':
        e.entries.forEach(en => {
          exprNames(en.key)
          exprNames(en.value)
        })
        break
      case 'record':
        e.fields.forEach(f => exprNames(f.value))
        break
      case 'member':
        exprNames(e.target)
        break
      case 'await':
        exprNames(e.expr)
        break
      case 'closure':
        usedNames(e.body, into)
        break
      case 'conditional':
        e.branches.forEach(b => {
          exprNames(b.cond)
          exprNames(b.value)
        })

        if (e.otherwise) {
          exprNames(e.otherwise)
        }

        break
      default:
        break
    }
  }

  for (const s of body) {
    switch (s.form) {
      case 'let':
        exprNames(s.init)
        break
      case 'assign':
        exprNames(s.target)
        exprNames(s.value)
        break
      case 'expression':
        exprNames(s.expr)
        break
      case 'return':
        if (s.value) {
          exprNames(s.value)
        }

        break
      case 'throw':
        exprNames(s.value)
        break
      case 'if':
        s.branches.forEach(b => {
          exprNames(b.cond)
          usedNames(b.body, into)
        })

        if (s.otherwise) {
          usedNames(s.otherwise, into)
        }

        break
      case 'match':
        exprNames(s.subject)
        s.cases.forEach(c => usedNames(c.body, into))

        if (s.otherwise) {
          usedNames(s.otherwise, into)
        }

        break
      case 'while':
        exprNames(s.cond)
        usedNames(s.body, into)
        break
      case 'for-each':
        exprNames(s.iterable)
        usedNames(s.body, into)
        break
      // a guarded body and its handler: the names they read are a closure's captures like any other. Skipped, a guard
      // inside a closure (every view handler is one, swiftui-target-0003) moved its captures into the `move` closure
      // without the clone beside it, and the next closure to read the same signal found it moved (E0382)
      case 'guard':
        usedNames(s.body, into)

        if (s.catch) {
          usedNames(s.catch.body, into)
        }

        break
      default:
        break
    }
  }
}

// MOVE-ON-LAST-USE analysis. A variable that is read EXACTLY ONCE across the whole function body, where that single
// read is NOT inside a loop or a nested closure, can be moved at that read instead of cloned (no later use can be
// invalidated, so the borrow checker always accepts the move). Returns the set of such variable names. `reads` counts
// every `variable` occurrence (any nesting); `restricted` counts the ones inside a loop or closure body. A name is
// move-eligible when `reads === 1 && restricted === 0`. Conservative by construction: anything else keeps cloning.
// a loop condition that bounds it by a small literal: `i < K` or `i <= K` (either way round), or a conjunction one of
// whose sides does, with K at most `most`. Such a loop ends within one preemption budget
function constantBounded(cond: Expression, most: number): boolean {
  if (cond.form !== 'binary') {
    return false
  }

  if (cond.op === '&&') {
    return constantBounded(cond.left, most) || constantBounded(cond.right, most)
  }

  const small = (e: Expression): boolean => e.form === 'integer' && Number(e.value) <= most

  return (
    ((cond.op === '<' || cond.op === '<=') && small(cond.right)) ||
    ((cond.op === '>' || cond.op === '>=') && small(cond.left))
  )
}

function moveOnLastUse(body: Statement[]): Set<string> {
  const reads = new Map<string, number>()
  const restricted = new Map<string, number>()

  const bump = (name: string, inLoopOrClosure: boolean): void => {
    reads.set(name, (reads.get(name) ?? 0) + 1)

    if (inLoopOrClosure) {
      restricted.set(name, (restricted.get(name) ?? 0) + 1)
    }
  }

  const walkExpr = (node: Expression, restrict: boolean): void => {
    switch (node.form) {
      case 'variable':
        bump(node.name, restrict)
        break
      case 'call':
        walkExpr(node.callee, restrict)
        node.args.forEach(a => walkExpr(a, restrict))
        break
      case 'member':
        walkExpr(node.target, restrict)
        break
      case 'binary':
        walkExpr(node.left, restrict)
        walkExpr(node.right, restrict)
        break
      case 'unary':
        walkExpr(node.operand, restrict)
        break
      case 'await':
        walkExpr(node.expr, restrict)
        break
      case 'array':
        node.items.forEach(i => walkExpr(i, restrict))
        break
      case 'record':
        node.fields.forEach(f => walkExpr(f.value, restrict))
        break
      case 'map':
        node.entries.forEach(e => {
          walkExpr(e.key, restrict)
          walkExpr(e.value, restrict)
        })
        break
      case 'conditional':
        node.branches.forEach(b => {
          walkExpr(b.cond, restrict)
          walkExpr(b.value, restrict)
        })

        if (node.otherwise) {
          walkExpr(node.otherwise, restrict)
        }

        break
      case 'closure':
        // a nested closure body: its reads re-execute on every call (and a captured variable cannot be moved out of a
        // `Fn`), so they are restricted (never move-eligible)
        walkBody(node.body, true)
        break
      case 'template':
        // `text <{p/inner/count}>` reads `p`: uncounted, `deep(p)` before it was taken as p's last use and moved it
        // (E0382)
        node.parts.forEach(part => {
          if (typeof part !== 'string') {
            walkExpr(part, restrict)
          }
        })
        break
      default:
        break
    }
  }

  // only one arm of a branch runs, so a name's reads across the arms count as the MOST any one arm makes, never their
  // sum: `stop` handing back `into` and `node` building with it each read `into` once, and either may move it. Rust
  // accepts a move of one variable in two arms. A read before the branch (its subject, its conditions) still adds
  const arms = (bodies: Statement[][], restrict: boolean): void => {
    const before = { reads: new Map(reads), restricted: new Map(restricted) }
    const most = { reads: new Map<string, number>(), restricted: new Map<string, number>() }

    for (const arm of bodies) {
      reads.clear()
      restricted.clear()
      walkBody(arm, restrict)

      for (const [name, n] of reads) {
        most.reads.set(name, Math.max(most.reads.get(name) ?? 0, n))
      }

      for (const [name, n] of restricted) {
        most.restricted.set(name, Math.max(most.restricted.get(name) ?? 0, n))
      }
    }

    reads.clear()
    restricted.clear()

    for (const [name, n] of before.reads) reads.set(name, n)
    for (const [name, n] of before.restricted) restricted.set(name, n)
    for (const [name, n] of most.reads) reads.set(name, (reads.get(name) ?? 0) + n)
    for (const [name, n] of most.restricted) restricted.set(name, (restricted.get(name) ?? 0) + n)
  }

  const walkBody = (stmts: Statement[], restrict: boolean): void => {
    for (const s of stmts) {
      switch (s.form) {
        case 'let':
          walkExpr(s.init, restrict)
          break
        case 'assign':
          walkExpr(s.value, restrict)
          walkExpr(s.target, restrict)
          break
        case 'expression':
          walkExpr(s.expr, restrict)
          break
        case 'return':
          if (s.value) {
            walkExpr(s.value, restrict)
          }

          break
        case 'throw':
          walkExpr(s.value, restrict)
          break
        case 'if':
          // every condition may be tested, so each adds; the bodies are arms, of which one runs
          s.branches.forEach(b => walkExpr(b.cond, restrict))
          arms([...s.branches.map(b => b.body), ...(s.otherwise ? [s.otherwise] : [])], restrict)

          break
        case 'guard':
          walkBody(s.body, true)

          if (s.catch) {
            walkBody(s.catch.body, true)
          }

          break
        case 'while':
          walkExpr(s.cond, true)
          walkBody(s.body, true)
          break
        case 'for-each':
          walkExpr(s.iterable, restrict)
          walkBody(s.body, true)
          break
        case 'match':
          walkExpr(s.subject, restrict)
          arms([...s.cases.map(c => c.body), ...(s.otherwise ? [s.otherwise] : [])], restrict)

          break
        default:
          break
      }
    }
  }

  walkBody(body, false)

  const out = new Set<string>()

  for (const [name, count] of reads) {
    if (count === 1 && (restricted.get(name) ?? 0) === 0) {
      out.add(name)
    }
  }

  return out
}



// the extra element-type bounds a function body needs from its array ops: equality (`includes` / `indexOf`) or display
// (`join`). Returns the generic variable ids and names sitting at the element position of an array receiving such an op.
function collectArrayBounds(body: Statement[]): {
  eqIds: Set<number>
  displayIds: Set<number>
  eqNames: Set<string>
  displayNames: Set<string>
  mutated: Set<string>
} {
  const eqIds = new Set<number>()
  const displayIds = new Set<number>()
  const eqNames = new Set<string>()
  const displayNames = new Set<string>()
  // arrays mutated in place (`push` / `pop`); a parameter so mutated must be rebound `let mut`
  const mutated = new Set<string>()

  const record = (callee: Expression): void => {
    const op = collectionCall(callee)

    if (op?.kind !== 'array') {
      return
    }

    if (
      (op.op === 'push' || op.op === 'pop') &&
      op.target.form === 'variable'
    ) {
      mutated.add(op.target.name)
    }

    const need = ARRAY_OP_BOUND[op.op]

    if (!need) {
      return
    }

    const element =
      op.target.type?.kind === 'array'
        ? op.target.type.element
        : undefined

    if (element?.kind === 'variable') {
      ;(need === 'eq' ? eqIds : displayIds).add(element.id)
    } else if (element?.kind === 'named') {
      ;(need === 'eq' ? eqNames : displayNames).add(
        element.name.toUpperCase(),
      )
    }
  }

  const visitExpr = (e: Expression | undefined): void => {
    if (!e) {
      return
    }

    switch (e.form) {
      case 'call':
        record(e.callee)
        visitExpr(e.callee)
        e.args.forEach(visitExpr)
        break
      case 'binary':
        visitExpr(e.left)
        visitExpr(e.right)
        break
      case 'unary':
        visitExpr(e.operand)
        break
      case 'member':
        visitExpr(e.target)
        break
      case 'array':
        e.items.forEach(visitExpr)
        break
      case 'map':
        e.entries.forEach(en => {
          visitExpr(en.key)
          visitExpr(en.value)
        })
        break
      case 'record':
        e.fields.forEach(f => visitExpr(f.value))
        break
      case 'await':
        visitExpr(e.expr)
        break
      case 'closure':
        visitStmts(e.body)
        break
      default:
        break
    }
  }

  const visitStmts = (stmts: Statement[]): void => {
    for (const s of stmts) {
      switch (s.form) {
        case 'let':
          visitExpr(s.init)
          break
        case 'assign':
          visitExpr(s.target)
          visitExpr(s.value)
          break
        case 'expression':
          visitExpr(s.expr)
          break
        case 'return':
          visitExpr(s.value)
          break
        case 'throw':
          visitExpr(s.value)
          break
        case 'hold':
          visitExpr(s.expr)
          break
        case 'guard':
          visitStmts(s.body)

          if (s.catch) {
            visitStmts(s.catch.body)
          }

          break
        case 'while':
          visitExpr(s.cond)
          visitStmts(s.body)
          break
        case 'for-each':
          visitExpr(s.iterable)
          visitStmts(s.body)
          break
        case 'if':
          s.branches.forEach(b => {
            visitExpr(b.cond)
            visitStmts(b.body)
          })

          if (s.otherwise) {
            visitStmts(s.otherwise)
          }

          break
        case 'match':
          visitExpr(s.subject)
          s.cases.forEach(c => visitStmts(c.body))

          if (s.otherwise) {
            visitStmts(s.otherwise)
          }

          break
        default:
          break
      }
    }
  }

  visitStmts(body)

  return { eqIds, displayIds, eqNames, displayNames, mutated }
}

// ---- filling a form from data on rust ----

// the walkers a module's `fill` / `melt` with a form need: shared helpers over the package's `Data` enum, then a
// function per form. A value that does not fit raises the package's `data-mismatch`, with its path and reason, as a
// `TermException` in the `Result` the walker answers (RUST_FORM_HELPERS).
function rustFormWalk(fills: Map<string, FormSpec>, melts: Map<string, FormSpec>): string[] {
  if (fills.size === 0 && melts.size === 0) {
    return []
  }

  const out: string[] = [RUST_FORM_HELPERS]

  // an item of a list, or a field's value, read as its kind, its mismatch passed on with `?`. `d` is a Data, `p` its
  // path. A list's item is read in a closure that answers the `Result` itself
  const fillOf = (kind: FormKind, value: string, path: string, optional: boolean): string => {
    switch (kind.kind) {
      case 'text':
        return `__term_text(${value}, ${path}, ${optional})?`
      case 'number':
        return `__term_number(${value}, ${path}, ${optional})?`
      case 'decimal':
        return `__term_decimal(${value}, ${path}, ${optional})?`
      case 'flag':
        return `__term_flag(${value}, ${path}, ${optional})?`
      case 'data':
        return `__term_data(${value}, ${path}, ${optional})?`
      case 'list':
        return `__term_list(${value}, ${path}, ${optional}, &|d: Data, p: String| Ok(${fillOf(kind.item, 'Some(d)', 'p', false)}))?`
      case 'form':
        return `__fill_${snake(kind.spec.form)}(__term_data(${value}, ${path}.clone(), ${optional})?, ${path})?`
      default:
        return '0'
    }
  }

  for (const spec of fills.values()) {
    const known = spec.fields.map(f => JSON.stringify(f.name)).join(', ')
    const fields = spec.fields
      .map(f => `${snake(f.name)}: ${fillOf(f.kind, `find(${JSON.stringify(f.name)})`, `__term_path(&path, ${JSON.stringify(f.name)})`, f.optional)}`)
      .join(', ')

    out.push(
      `fn __fill_${snake(spec.form)}(value: Data, path: String) -> Result<${pascal(spec.form)}, TermException> {\n` +
        `    let entries = __term_entries(value, path.clone())?;\n` +
        `    let known: &[&str] = &[${known}];\n` +
        `    for e in entries.borrow().iter() { if !known.contains(&e.name.as_str()) { return Err(__term_mismatch(__term_path(&path, &e.name), "is not in the form".to_string())); } }\n` +
        `    let find = |name: &str| -> Option<Data> { entries.borrow().iter().find(|e| e.name == name).map(|e| e.base.clone()) };\n` +
        `    Ok(${pascal(spec.form)} { ${fields} })\n}`,
    )
  }

  // a field's value, spelled as data. `v` is the value
  const meltOf = (kind: FormKind, value: string): string => {
    switch (kind.kind) {
      case 'text':
        return `Data::Text { value: ${value} }`
      case 'number':
        return `Data::Number { value: ${value} }`
      case 'decimal':
        return `Data::Decimal { value: ${value} }`
      case 'flag':
        return `Data::Flag { value: ${value} }`
      case 'data':
        return value
      case 'list':
        return `Data::Array { list: std::rc::Rc::new(std::cell::RefCell::new((${value}).borrow().iter().map(|x| ${meltOf(kind.item, 'x.clone()')}).collect::<Vec<Data>>())) }`
      case 'form':
        return `__melt_${snake(kind.spec.form)}(${value})`
      default:
        return 'Data::Blank'
    }
  }

  // an optional field left empty is left out
  const emptyTest = (kind: FormKind, value: string): string | undefined => {
    switch (kind.kind) {
      case 'text':
        return `(${value}).is_empty()`
      case 'list':
        return `(${value}).borrow().is_empty()`
      case 'data':
        return `matches!(${value}, Data::Blank)`
      default:
        return undefined
    }
  }

  for (const spec of melts.values()) {
    const lines = spec.fields.map(f => {
      const value = `value.${snake(f.name)}.clone()`
      const entry = `list.push(DataEntry { name: ${JSON.stringify(f.name)}.to_string(), base: ${meltOf(f.kind, value)} });`
      const empty = f.optional ? emptyTest(f.kind, value) : undefined

      return empty ? `    if !${empty} { ${entry} }` : `    ${entry}`
    })

    out.push(
      `fn __melt_${snake(spec.form)}(value: ${pascal(spec.form)}) -> Data {\n    let mut list: Vec<DataEntry> = Vec::new();\n${lines.join('\n')}\n    Data::Hash { list: std::rc::Rc::new(std::cell::RefCell::new(list)) }\n}`,
    )
  }

  return out
}

// A value that does not fit RAISES `data-mismatch`, the package's own exception, with the fields TypeScript gives it
// (`@term/host`, `Data does not fit the shape`, and the path and reason under `link`), so a `mark unsafe` guard or a
// `sift` catches it as it does there. Every helper answers a `Result` and the walkers pass it on with `?`. It was a
// `panic!`, which no guard catches and which ended the program (guides: language/data, 2026-10-05).
const RUST_FORM_HELPERS = `#[cold]
#[inline(never)]
fn __term_mismatch(path: String, reason: String) -> TermException {
    let path = if path.is_empty() { ".".to_string() } else { path };
    let link: std::collections::HashMap<String, String> = [("thing".to_string(), "data".to_string()), ("path".to_string(), path), ("reason".to_string(), reason)].into_iter().collect();
    TermException(Box::new(TermRaised { host: "@term/host".to_string(), form: "data-mismatch".to_string(), note: "Data does not fit the shape".to_string(), code: String::new(), time: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0), link: std::rc::Rc::new(link), base: std::rc::Rc::new(()) }))
}
fn __term_path(path: &str, key: &str) -> String { if path.is_empty() { key.to_string() } else { format!("{}/{}", path, key) } }
fn __term_kind(value: &Data) -> &'static str {
    match value { Data::Hash { .. } => "a map", Data::Array { .. } => "a list", Data::Blank => "void", Data::Text { .. } => "text", Data::Number { .. } => "number", Data::Decimal { .. } => "decimal", Data::Flag { .. } => "flag", Data::Graft { .. } => "a fuse" }
}
fn __term_entries(value: Data, path: String) -> Result<std::rc::Rc<std::cell::RefCell<Vec<DataEntry>>>, TermException> {
    match value { Data::Hash { list } => Ok(list), other => Err(__term_mismatch(path, format!("is {} where a map belongs", __term_kind(&other)))) }
}
fn __term_text(value: Option<Data>, path: String, optional: bool) -> Result<String, TermException> {
    match value { Some(Data::Text { value }) => Ok(value), None | Some(Data::Blank) => if optional { Ok(String::new()) } else { Err(__term_mismatch(path, "is missing".to_string())) }, Some(other) => Err(__term_mismatch(path, format!("is {} where text belongs", __term_kind(&other)))) }
}
fn __term_number(value: Option<Data>, path: String, optional: bool) -> Result<i64, TermException> {
    match value { Some(Data::Number { value }) => Ok(value), None | Some(Data::Blank) => if optional { Ok(0) } else { Err(__term_mismatch(path, "is missing".to_string())) }, Some(other) => Err(__term_mismatch(path, format!("is {} where number belongs", __term_kind(&other)))) }
}
fn __term_decimal(value: Option<Data>, path: String, optional: bool) -> Result<f64, TermException> {
    match value { Some(Data::Decimal { value }) => Ok(value), Some(Data::Number { value }) => Ok(value as f64), None | Some(Data::Blank) => if optional { Ok(0.0) } else { Err(__term_mismatch(path, "is missing".to_string())) }, Some(other) => Err(__term_mismatch(path, format!("is {} where decimal belongs", __term_kind(&other)))) }
}
fn __term_flag(value: Option<Data>, path: String, optional: bool) -> Result<bool, TermException> {
    match value { Some(Data::Flag { value }) => Ok(value), None | Some(Data::Blank) => if optional { Ok(false) } else { Err(__term_mismatch(path, "is missing".to_string())) }, Some(other) => Err(__term_mismatch(path, format!("is {} where flag belongs", __term_kind(&other)))) }
}
fn __term_data(value: Option<Data>, path: String, optional: bool) -> Result<Data, TermException> {
    match value { Some(d) => Ok(d), None => if optional { Ok(Data::Blank) } else { Err(__term_mismatch(path, "is missing".to_string())) } }
}
fn __term_list<T>(value: Option<Data>, path: String, optional: bool, item: &dyn Fn(Data, String) -> Result<T, TermException>) -> Result<std::rc::Rc<std::cell::RefCell<Vec<T>>>, TermException> {
    match value {
        Some(Data::Array { list }) => Ok(std::rc::Rc::new(std::cell::RefCell::new(list.borrow().iter().enumerate().map(|(i, d)| item(d.clone(), __term_path(&path, &i.to_string()))).collect::<Result<Vec<T>, TermException>>()?))),
        None | Some(Data::Blank) => if optional { Ok(std::rc::Rc::new(std::cell::RefCell::new(Vec::new()))) } else { Err(__term_mismatch(path, "is missing".to_string())) },
        Some(other) => Err(__term_mismatch(path, format!("is {} where a list belongs", __term_kind(&other)))),
    }
}`
