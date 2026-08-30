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
import {
  exhausted,
  mapCollect,
} from '@term/make/code/compile/backend'
import { lowerRoutes } from '@term/make/code/compile/route-lower'
import {
  collectBinds,
  renderBind,
  bindGap,
  referencedBinds,
} from '@term/make/code/compile/bind'
import type { Bind } from '@term/make/code/compile/bind'
import { armLocals } from '@term/make/code/check/arm'

const guardStart = (text: string): string =>
  /^[([`]/.test(text) ? `;${text}` : text

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
let tsVariantFields = new Map<string, string[]>()

// the fields of every struct form in the program, for the `fill` / `melt` spec: name, type, `need false`
let tsRecordFields = new Map<string, { name: string; type: Type; optional?: boolean }[]>()
// did this module lower a `fill` or `melt` with a form? Then the walk rides in its prelude
let tsFormWalkUsed = false

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
  constructor(base: { note: string; form: string }) {
    super(base.note)
    Object.assign(this, base)
    this.name = ${EXCEPTION_CLASS}.name
    // the hive hears every raise, once wakeHive has hooked it in
    const hive = (globalThis as { __termRaise?: (e: unknown) => void }).__termRaise
    if (hive) hive(this)
  }
}`

// the walk, in the prelude of a module that lowers a `fill` or `melt` with a form. `data` is the value the
// package's reader gives (`{ form: "hash", list: [{ name, base }] }`, `{ form: "array", list }`, a scalar with
// `value`, `{ form: "blank" }`). A value that does not fit raises `data-mismatch`, the package's own exception,
// `path` naming where and `reason` why.
const FORM_WALK_PRELUDE = `function __termMismatch(path: string, reason: string): never {
  throw new ${EXCEPTION_CLASS}({ host: "@term/host", form: "data-mismatch", code: exceptionCode(), time: date.now(), note: "Data does not fit the shape", link: { thing: "data", path: path || ".", reason } } as never)
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

function makeEmitter(
  variants: Set<string>,
  hmr = false,
  binds = new Map<string, Bind>(),
  env = 'node',
) {
  const pad = (depth: number) => '  '.repeat(depth)

  let assignedNames = new Set<string>()

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
        // a template literal: chunks escaped for backticks and `${`, expressions interpolated
        return `\`${node.parts
          .map(part => (typeof part === 'string' ? part.replace(/[\\`]/g, '\\$&').replace(/\$\{/g, '\\${') : `\${${expression(part)}}`))
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
        // `get` / `set` on an ARRAY receiver: JavaScript arrays have no such methods; they are indexing
        if (
          node.callee.form === 'member' &&
          node.callee.target.type?.kind === 'array' &&
          (node.callee.name === 'get' || node.callee.name === 'set')
        ) {
          const target = expression(node.callee.target)

          return node.callee.name === 'get'
            ? `${target}[${expression(node.args[0]!)}]`
            : `(${target}[${expression(node.args[0]!)}] = ${expression(node.args[1]!)})`
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
          const args = node.args.map(arg => expression(arg))

          return (
            renderBind(bind, env, args) ??
            renderBind(bind, 'javascript', args) ??
            bindGap(bind.name)
          )
        }

        // keys / values on a map materialize to an array (a `Map` iterator is not the list the stdlib returns)
        const collected = mapCollect(node.callee)

        if (collected) {
          return `Array.from(${expression(collected.target)}.${collected.name}())`
        }

        return `${expression(node.callee)}(${node.args
          .map(arg => expression(arg))
          .join(', ')})`
      }

      case 'array':
        return `[${node.items
          .map(item => expression(item))
          .join(', ')}]`
      case 'map': {
        // an EMPTY map spells its checked key/value (`new Map<T, boolean>()`), so a construction flowing into a
        // typed field or parameter is assignable (Map's type arguments are invariant); a filled one infers
        const ann =
          node.entries.length === 0 && node.type?.kind === 'map'
            ? `<${tsType(node.type.key)}, ${tsType(node.type.value)}>`
            : ''

        return `new Map${ann}([${node.entries
          .map(e => `[${expression(e.key)}, ${expression(e.value)}]`)
          .join(', ')}])`
      }

      case 'record': {
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

        // an enum variant carries a discriminant tag; a struct is a plain object
        if (variants.has(node.name)) {
          return `{ ${[
            'form: ' + JSON.stringify(node.name),
            ...fields,
          ].join(', ')} }`
        }

        // a field the construction leaves out (`need false`, or one the runtime fills on another path) takes its
        // type's empty value, so the object satisfies its interface -- the rule the native backends already follow
        const declaredFields = tsRecordFields.get(node.name) ?? []
        const givenNames = new Set(node.fields.map(f => f.name))
        const missing = declaredFields
          .filter(f => !givenNames.has(f.name) && !f.optional)
          .map(f => `${toMember(f.name)}: ${tsEmptyOf(f.type)}`)

        return `{ ${[...fields, ...missing].join(', ')} }`
      }

      case 'member':
        // a DYNAMIC segment (`read table/{key}`) subscripts rather than dot-accesses
        if (node.index) {
          return `${expression(node.target)}[${expression(node.index)}]`
        }

        // a binding field with a foreign `name <...>` (e.g. COLOR_BUFFER_BIT) emits that native name verbatim; other
        // members camelCase the seed name
        // a literal index is a plain segment (`read items/0`), and JavaScript spells that with brackets
        if (/^\d+$/.test(node.name)) {
          return `${expression(node.target)}[${node.name}]`
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
        const precedence = PRECEDENCE[node.op]
        const left = expression(node.left, precedence)
        const right = expression(node.right, precedence + 1)
        const text = `${left} ${node.op} ${right}`

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
  // computeds, `element` / `text` make nodes, `read` makes a reactive text node (`dynamic`), attributes / events wire
  // them, and each top-level view node is attached under the host param. fork / walk lower to `show` / `each`. The
  // render runtime (element / text / dynamic / attribute / event / append / show / each) is imported by the zone's
  // own module. See note/seed/plan/zone-components.md.
  const emitZone = (
    node: Extract<Statement, { form: 'view' }>,
  ): string => {
    let counter = 0

    const next = (): string => `view${counter++}`

    // build a node into `out`, returning its variable name. Render-runtime calls are positional, in the param order of
    // each task in code/view/render.tree: element(tag), text(value), dynamic(source), attribute(node, name, value),
    // event(node, name, handler).
    const build = (zone: ViewNode, out: string[]): string => {
      // a named element (`name x`) is emitted under that name, so handlers elsewhere in the zone can read it
      const ref =
        zone.form === 'element' && zone.ref ? toCamel(zone.ref) : next()

      if (zone.form === 'text') {
        out.push(`const ${ref} = text(${JSON.stringify(zone.value)})`)
      } else if (zone.form === 'read') {
        out.push(
          `const ${ref} = dynamic(() => ${expression(zone.value)})`,
        )
      } else if (zone.form === 'element') {
        out.push(`const ${ref} = element(${JSON.stringify(zone.name)})`)

        for (const attribute of zone.attributes) {
          out.push(
            attribute.event
              ? `event(${ref}, ${JSON.stringify(
                  attribute.name,
                )}, () => ${expression(attribute.value)})`
              : `attribute(${ref}, ${JSON.stringify(
                  attribute.name,
                )}, ${expression(attribute.value)})`,
          )
        }

        for (const child of zone.children) {
          attach(child, ref, out)
        }
      } else {
        out.push(`const ${ref} = text("")`)
      }

      return ref
    }

    // the positional render calls for the control-flow nodes (host comes first)
    const showCall = (
      host: string,
      zone: Extract<ViewNode, { form: 'fork' }>,
    ): string => {
      const branch = zone.branches[0]

      return `show(${host}, () => ${
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
      // the iterable is passed as a getter so `each` can read it inside an effect (reactive list rendering)
      `each(${host}, () => ${expression(zone.iterable)}, ${fragment(
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
          out.push(`const ${part} = element("seed-part")`)
          out.push(showCall(part, zone))
          out.push(`append(${parent}, ${part})`)
          collect.push(part)
        } else {
          out.push(showCall(parent, zone))
        }
      } else if (zone.form === 'walk') {
        if (collect) {
          const part = next()
          out.push(`const ${part} = element("seed-part")`)
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
        out.push(`const frag = element("seed-fragment")`)

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
      if (child.form !== 'save') {
        attach(child, host, lines, hmr ? roots : undefined)
      }
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

        const keyword = assignedNames.has(node.name) ? 'let' : 'const'

        return `${keyword} ${toCamel(node.name)} = ${expression(
          node.init,
        )}`
      }

      case 'assign': {
        const target = expression(node.target)

        return node.op === '='
          ? `${target} = ${expression(node.value)}`
          : `${target} ${node.op} ${expression(node.value)}`
      }

      case 'expression':
        return expression(node.expr)
      case 'return':
        return node.value
          ? `return ${expression(node.value)}`
          : 'return'
      case 'throw':
        // a raised exception (`halt <form>`) is thrown as the runtime class, a thrown string becomes an Error, and any
        // other value is thrown as-is
        if (
          node.value.form === 'record' &&
          tsExceptions.has(node.value.name)
        ) {
          return `throw new ${EXCEPTION_CLASS}(${expression(node.value)})`
        }

        return node.value.form === 'string'
          ? `throw new Error(${expression(node.value)})`
          : `throw ${expression(node.value)}`
      case 'while':
        return `while (${expression(node.cond)}) ${block(
          node.body,
          depth,
        )}`
      case 'guard': {
        // `note unsafe` / `halt take`: a try with its catch. The caught value is bound as written; a guard with no
        // handler swallows what it catches, which the checker warns about.
        const handler = node.catch
          ? ` catch (${toCamel(node.catch.name)}) ${block(node.catch.body, depth)}`
          : ' catch {}'

        return `try ${block(node.body, depth)}${handler}`
      }
      case 'for-each':
        return `for (const ${toCamel(node.item)} of ${expression(
          node.iterable,
        )}) ${block(node.body, depth)}`

      case 'match': {
        const raw = expression(node.subject)
        // a fork case over a caught exception (the checker filled `exceptionArms`): `form` is the discriminant,
        // the shared fields read off the carrier, the form's props off its `link`
        if (node.exceptionArms) {
          const exceptionSubject = /^[A-Za-z_$][\w$]*$/.test(raw) ? raw : `(${raw})`
          let out = ''
          node.cases.forEach((branch, i) => {
            const arm = node.exceptionArms![branch.label]!
            const bodyText = branch.body.map(s => statement(s, depth + 1)).join('\n')
            const locals = armLocals([...arm.shared, ...arm.link], branch.binds)
              .filter(({ local }) => new RegExp(`\\b${toCamel(local).replace(/[^\w$]/g, '\\$&')}\\b`).test(bodyText))
              .map(({ field, local }) => `${pad(depth + 1)}const ${toCamel(local)} = ${exceptionSubject}.${arm.link.includes(field) ? `link.${toMember(field)}` : toMember(field)}`)
            out += `${i ? ' else ' : ''}if (${exceptionSubject}.form === ${JSON.stringify(branch.label)}) {\n${[...locals, ...branch.body.map(s => `${pad(depth + 1)}${guardStart(statement(s, depth + 1))}`)].join('\n')}\n${pad(depth)}}`
          })

          if (node.otherwise) {
            out += ` else ${block(node.otherwise, depth)}`
          }

          return out
        }

        // `.form` binds tighter than any operator, so a compound
        // subject (`listSize(x) > 0`) must be parenthesized or the
        // member access attaches to its last operand. Simple
        // identifiers / calls / member chains stay bare to keep the
        // output readable.
        const subject = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*|\((?:[^()]|\([^()]*\))*\))*$/.test(
          raw,
        )
          ? raw
          : `(${raw})`

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

          return out
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

          return out
        }

        let out = ''
        node.cases.forEach((branch, i) => {
          // the variant's fields, as locals: `link` renames them in order, otherwise they keep their names. Only the
          // ones the body reads, so an unused field costs nothing and cannot shadow an outer name by accident.
          const fields = tsVariantFields.get(branch.label) ?? []
          const bodyText = branch.body
            .map(s => statement(s, depth + 1))
            .join('\n')
          const locals = armLocals(fields, branch.binds)
            .filter(({ local }) =>
              new RegExp(`\\b${toCamel(local).replace(/[^\w$]/g, '\\$&')}\\b`).test(bodyText),
            )
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

          out += `${
            i ? ' else ' : ''
          }if (${subject}.form === ${JSON.stringify(
            branch.label,
          )}) ${body}`
        })

        if (node.otherwise) {
          out += ` else ${block(node.otherwise, depth)}`
        }

        return out
      }

      case 'break':
        return 'break'
      case 'continue':
        return 'continue'
      case 'exit':
        return 'process.exit(0)'
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

        // an enum becomes a discriminated union; a struct becomes an interface
        if (node.variants.length > 0) {
          const members = node.variants.map(v => {
            const fields = v.fields.map(
              f => `${toMember(f.name)}: ${tsType(f.type)}`,
            )

            return `{ ${[
              'form: ' + JSON.stringify(v.name),
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
              `${pad(depth + 1)}${toMember(f.name)}: ${tsType(f.type)}`,
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

        // a `need false` parameter with no `fall` is optional in the emitted signature, so a caller that leaves
        // it off (the checker allows it) still typechecks. A required param AFTER an optional one forces the
        // optional to stay required (TypeScript refuses required-after-optional), matching by suffix
        let lastRequired = -1
        node.params.forEach((p, i) => {
          if (!(p.optional && !p.fallback)) {
            lastRequired = i
          }
        })
        const params = node.params
          .map(
            (p, i) =>
              `${toCamel(p.name)}${p.optional && !p.fallback && i > lastRequired ? '?' : ''}: ${tsType(p.type)}`,
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
        const body =
          node.body.length === 0 && node.result && node.result.kind !== 'unit'
            ? `{\n${'  '.repeat(depth + 1)}throw new Error(${JSON.stringify(`stub: ${node.name}`)})\n${'  '.repeat(depth)}}`
            : block(node.body, depth)
        const out = `${keyword} ${toCamel(
          node.name,
        )}${generics}(${params}): ${returnType} ${body}`

        assignedNames = previous

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

  return { statement, expression }
}

export function emitTypeScript(
  program: Program,
  // `variants` carries the enum variant names defined across the WHOLE program. In per-module mode a module that builds
  // `make some` may not itself define `maybe`, so without this its variant constructors would lose their `form` tag.
  options?: {
    hmr?: boolean
    variants?: Set<string>
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

  tsVariantFields = new Map<string, string[]>()
  tsRecordFields = new Map()
  tsFormWalkUsed = false

  for (const node of program) {
    if (node.form === 'record-type') {
      if (node.variants.length === 0) {
        tsRecordFields.set(node.name, node.fields)
      }

      for (const v of node.variants) {
        variants.add(v.name)
        tsVariantFields.set(
          v.name,
          v.fields.map(f => f.name),
        )
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

    if (alias !== globalName && !dockAliases.has(alias)) {
      dockAliases.add(alias)
      imports.push(`const ${alias} = ${globalName}`)
    }
  }

  // a declarative binding's env target may name imports its rendered expression needs (dedup against the natives). Only
  // binds actually called contribute, so an unused alternative does not pull in an import the program never references.
  for (const bind of referencedBinds(program, binds).values()) {
    const target =
      bind.targets.find(t => t.env === env) ??
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
      const exported =
        node.form === 'function' ||
        node.form === 'record-type' ||
        node.form === 'mask'

      return exported ? `export ${text}` : text
    })
    // an ambient host global whose seed name already spells the global emits nothing; drop the blank line
    .filter(line => line.length > 0)

  // the exception class rides in front of the first module that raises or declares one
  const prelude =
    tsExceptions.size > 0 &&
    program.some(
      n => n.form === 'record-type' && n.chain?.includes('exception'),
    )
      ? [EXCEPTION_PRELUDE]
      : []

  // the form walk rides behind the exception class in a module that lowered a `fill` or `melt` with a form
  if (tsFormWalkUsed) {
    prelude.push(FORM_WALK_PRELUDE)
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
