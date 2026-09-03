// The Swift backend: emit the language as idiomatic, type-static Swift. Parity with the TypeScript backend across
// every AST form. Algebraic data types lower to NATIVE generic enums (`enum Maybe<T> { case some(value: T); case none }`),
// `match` to native `if case let` pattern binding (a matched variant's fields bind to locals, and field access on the
// subject rewrites to those locals), and struct forms to `struct`s. Construction uses leading-dot syntax so Swift
// infers the type parameter from context (return type, annotated binding, argument position) — no monomorphization
// needed. Generic functions emit `<T>`. Pure, browser-safe. See note/research/vibe/computation/plans/07-codegen.md.

import { armLocals } from '@term/make/code/check/arm'
import { raiseSets } from '@term/make/code/check/effects'
import type {
  Expression,
  Program,
  Statement,
  Type,
} from '@term/make/code/compile/node'
import {
  ARRAY_OP_BOUND,
  collectionCall,
  collectionRead,
  exhausted,
  reassigned,
  stringCall,
  stringRead,
} from '@term/make/code/compile/backend'
import type { CollectionOp, FormKind, FormSpec } from '@term/make/code/compile/backend'
import { formSpec, hasValuedReturn, refuseAny, specForms } from '@term/make/code/compile/backend'
import {
  collectBinds,
  renderBind,
  bindGap,
  bindImports,
  referencedBinds,
} from '@term/make/code/compile/bind'

// Swift reserved keywords. When one is used as an identifier (a function / parameter / member named `repeat`,
// `default`, etc.) it must be backtick-escaped, in both the declaration and every reference.
const SWIFT_KEYWORDS = new Set([
  'associatedtype',
  'class',
  'deinit',
  'enum',
  'extension',
  'fileprivate',
  'func',
  'import',
  'init',
  'inout',
  'internal',
  'let',
  'open',
  'operator',
  'private',
  'protocol',
  'public',
  'rethrows',
  'static',
  'struct',
  'subscript',
  'typealias',
  'var',
  'break',
  'case',
  'continue',
  'default',
  'defer',
  'do',
  'else',
  'fallthrough',
  'for',
  'guard',
  'if',
  'in',
  'repeat',
  'return',
  'switch',
  'where',
  'while',
  'as',
  'catch',
  'false',
  'is',
  'nil',
  'super',
  'self',
  'throw',
  'throws',
  'true',
  'try',
  'async',
  'await',
  'actor',
  'any',
  'some',
])

function escape(identifier: string): string {
  return SWIFT_KEYWORDS.has(identifier)
    ? `\`${identifier}\``
    : identifier
}

function camelize(name: string): string {
  // strip every hyphen, including one before a digit (`sha-256` -> `sha256`), so the result is a valid identifier
  return name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

// `self` is reserved in Swift; every other name is camelCased, then keyword-escaped
function vname(name: string): string {
  return name === 'self' ? 'slf' : escape(camelize(name))
}

function camel(name: string): string {
  return escape(camelize(name))
}

// type / variant names are capitalized, so they can never collide with a (lowercase) keyword
// Foundation and standard-library type names a seed form must not shadow: `form data` would hide `Foundation.Data`
// from every shim that uses it, so such a form is spelled with a `Form` suffix throughout the emit
const SWIFT_TAKEN = new Set([
  'Data',
  'Date',
  'URL',
  'Error',
  'Result',
  'Optional',
  'Character',
  'Set',
  'Array',
  'Dictionary',
  'String',
  'Int',
  'Double',
  'Bool',
  'Task',
  'Thread',
  'Process',
  'Bundle',
  'Timer',
  'Locale',
  'Decimal',
  'Stream',
  'Host',
  'Pipe',
  'Scanner',
  'Operation',
  'Notification',
  'Range',
  'Unit',
])

function pascal(name: string): string {
  const c = camelize(name)
  const spelled = c.charAt(0).toUpperCase() + c.slice(1)

  return SWIFT_TAKEN.has(spelled) ? `${spelled}Form` : spelled
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

// gather the inference-variable ids appearing in a type (each is an implicit generic parameter of its function)
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

// the generic variable ids and names that sit at the element position of an array used with `includes` / `indexOf`,
// which need an `Equatable` bound (Array.contains / firstIndex(of:) require it). Walks the function body's calls.
function collectArrayEq(body: Statement[]): {
  ids: Set<number>
  names: Set<string>
} {
  const ids = new Set<number>()
  const names = new Set<string>()

  const record = (callee: Expression): void => {
    const op = collectionCall(callee)

    if (op?.kind !== 'array') {
      return
    }

    if (ARRAY_OP_BOUND[op.op] !== 'eq') {
      return
    }

    const element =
      op.target.type?.kind === 'array'
        ? op.target.type.element
        : undefined

    if (element?.kind === 'variable') {
      ids.add(element.id)
    } else if (element?.kind === 'named') {
      names.add(element.name.toUpperCase())
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

  return { ids, names }
}

// the seed primitive forms by name, for a `named` reference the checker did not seed (a module-level binding's
// annotation)
const SWIFT_PRIMITIVES: Record<string, string> = {
  text: 'String',
  boolean: 'Bool',
  number: 'Int',
  integer: 'Int',
  decimal: 'Double',
}

// the roll grouped by deck, for the generated wake chain (the same shape emitTypeScript takes)
export type WakeGroup = {
  deck: string
  entries: Record<string, unknown>[]
}

export function emitSwift(
  program: Program,
  options?: { wake?: WakeGroup[] },
): string {
  const pad = (d: number) => '  '.repeat(d)
  // when the stdlib hive is in the program, every new raise tells it (the throw lowering), and the compiler can
  // emit the wake chain (`wakeHive`) from the roll the driver hands over
  const hasHiveTell = program.some(
    n => n.form === 'function' && n.name === 'hive-tell',
  )
  // every known function's declared parameter types, for filling a left-out trailing `need false` argument
  const functionParams = new Map<string, (Type | undefined)[]>(
    program
      .filter(
        (n): n is Extract<Statement, { form: 'function' }> =>
          n.form === 'function',
      )
      .map(n => [n.name, n.params.map(p => p.type)]),
  )

  // declarative native bindings render their `case swift` template at call sites
  const binds = collectBinds(program)

  // every name assigned anywhere (whole, or through a member path): a module-level binding one of these targets must
  // be a `var` (`hive.roll = kept` in hive-clear writes through the module's `host hive`)
  const assignedAnywhere = new Set<string>()

  for (const node of program) {
    if (node.form === 'function') {
      reassigned(node.body, assignedAnywhere)
    }
  }

  // a function's free inference variables become named generic parameters; this maps each to its letter for the
  // duration of that function's emission, so `(t) -> ?5` prints as `(T) -> U` with `U` declared, not an unused `S`.
  let varNames = new Map<number, string>()

  // opaque per-backend handle types (`dock type / load <Foundation.Process>, name child-handle`): seed name -> concrete
  // swift type, so a `like child-handle` field emits the real handle type rather than a nonexistent struct.
  const opaqueTypes = new Map<string, string>(
    program
      .filter(
        (n): n is Extract<Statement, { form: 'native' }> =>
          n.form === 'native' && n.kind === 'type',
      )
      .map(n => [n.alias, n.module === 'any' ? 'Any' : n.module]),
  )

  // how many type parameters each generic form declares, for a reference that names the form without them
  const genericArity = new Map<string, number>(
    program
      .filter((n): n is Extract<Statement, { form: 'record-type' }> => n.form === 'record-type')
      .map(n => [n.name, n.params?.length ?? 0]),
  )

  const swiftType = (type: Type | undefined): string => {
    switch (type?.kind) {
      case 'boolean':
        return 'Bool'
      case 'string':
        return 'String'
      case 'unit':
      case undefined:
        return 'Void'
      case 'array':
        // a reference class wrapping an Array, so a list mutated in place (`push`) through one binding is seen through
        // every binding. A bare Swift Array is a value type and would not carry the mutation across a copy.
        return `SeedList<${swiftType(type.element)}>`
      case 'map':
        // a reference class wrapping a Dictionary, so a map mutated through one binding (a `set.insert`) is seen
        // through every binding. A bare Swift Dictionary is a value type and would not carry the mutation across a copy.
        // a key nothing constrained is any Hashable value, not `Any`, which Swift cannot hash: the free-variable
        // default is `Any`, and a map key needs the hashable form of it
        const key =
          (type.key?.kind === 'variable' && !varNames.has(type.key.id)) || type.key?.kind === 'unknown' || type.key?.kind === 'dynamic'
            ? 'AnyHashable'
            : swiftType(type.key)

        return `SeedMap<${key}, ${swiftType(type.value)}>`

      case 'named': {
        const opaque = opaqueTypes.get(type.name)

        if (opaque) {
          return opaque
        }

        // the seed primitives written by name (`like text` on a module-level binding reaches here unseeded)
        const primitive = SWIFT_PRIMITIVES[type.name]

        if (primitive) {
          return primitive
        }

        if (type.args && type.args.length > 0) {
          return `${pascal(type.name)}<${type.args.map(swiftType).join(', ')}>`
        }

        // a generic form named without its arguments (`like maybe`): swift needs every parameter, so each is Any
        const arity = genericArity.get(type.name) ?? 0

        return arity > 0
          ? `${pascal(type.name)}<${Array.from({ length: arity }, () => 'Any').join(', ')}>`
          : pascal(type.name)
      }

      case 'function': {
        // an async function value is an `async` function type; the call site `await`s it.
        const marker = type.effects?.includes('async') ? ' async' : ''

        return `(${type.params
          .map(swiftType)
          .join(', ')})${marker} -> ${swiftType(type.result)}`
      }
      case 'number':
        return 'Int'
      case 'float':
        return 'Double'
      case 'dynamic':
        return 'Any'
      case 'bytes':
        return 'Data'
      case 'variable':
        // a free variable not in this function's scope: nothing concrete ever met it, only the gradual `unknown` /
        // `dynamic` (which unify without binding), so the faithful type is `Any`. It was `Int`, which made a `make
        // list` fed json items a `SeedList<Int>` returned where a declared `like list, like unknown` wanted
        // `SeedList<Any>` (the cask dispatcher's items-of)
        return varNames.get(type.id) ?? 'Any'
      case 'unknown':
        // the declared dynamic (`like unknown` / `like any`): any value, so a hive entry's `base` can carry a record
        return 'Any'
      default:
        return 'Int'
    }
  }

  // the `<...>` clause for a function: its declared generics that survive, plus a fresh letter for each free
  // inference variable in the signature. Sets `varNames` for the rest of this function's emission.
  const genericClause = (
    node: Extract<Statement, { form: 'function' }>,
  ): string => {
    const ids = new Set<number>()
    node.params.forEach(p => collectVars(p.type, ids))
    collectVars(node.result, ids)

    const declared = node.generics.map(g => g.name.toUpperCase())
    const pool = ['T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'A', 'B', 'C']
    const used = new Set(declared)
    varNames = new Map()

    // which generics sit in a map-KEY position (a Dictionary key must be Hashable), following form args transitively so
    // a `Set<U>` marks U even though its map is hidden inside the struct
    const keyIds = new Set<number>()
    const keyNames = new Set<string>()

    const markKeys = (t: Type | undefined, isKey: boolean): void => {
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
        t.args?.forEach((a, i) => markKeys(a, keyArgs?.has(i) ?? false))
      }
    }

    node.params.forEach(p => markKeys(p.type, false))
    markKeys(node.result, false)

    // generics used as an array element with `includes` / `indexOf` need `Equatable` (a map key's `Hashable` implies it)
    const arrayEq = collectArrayEq(node.body)
    const bound = (
      name: string,
      isKey: boolean,
      isEq: boolean,
    ): string =>
      isKey ? `${name}: Hashable` : isEq ? `${name}: Equatable` : name

    const fresh: string[] = []

    for (const id of ids) {
      const letter = pool.find(l => !used.has(l)) ?? `T${id}`
      used.add(letter)
      varNames.set(id, letter)
      fresh.push(bound(letter, keyIds.has(id), arrayEq.ids.has(id)))
    }

    // declared generics that actually appear in the signature (as named types) are kept; the rest are dropped
    const namedInSig = new Set<string>()

    const scan = (t: Type | undefined): void => {
      if (!t) {
        return
      }

      if (t.kind === 'named') {
        namedInSig.add(t.name.toUpperCase())
        t.args?.forEach(scan)
      } else if (t.kind === 'array') {
        scan(t.element)
      } else if (t.kind === 'map') {
        scan(t.key)
        scan(t.value)
      } else if (t.kind === 'function') {
        t.params.forEach(scan)
        scan(t.result)
      }
    }

    node.params.forEach(p => scan(p.type))
    scan(node.result)

    // a trait-bounded generic (`head t, need sizer`) adds its protocol to the bound (Swift joins bounds with `&`),
    // so the body's `x.measure()` resolves through it
    const needTrait = new Map<string, string>()

    for (const g of node.generics) {
      if (g.need) {
        needTrait.set(g.name.toUpperCase(), pascal(g.need))
      }
    }

    const keptDeclared = declared
      .filter(d => namedInSig.has(d))
      .map(d => {
        const base = bound(d, keyNames.has(d), arrayEq.names.has(d))

        if (!needTrait.has(d)) {
          return base
        }

        return base.includes(':')
          ? `${base} & ${needTrait.get(d)}`
          : `${base}: ${needTrait.get(d)}`
      })

    const all = [...keptDeclared, ...fresh]

    return all.length ? `<${all.join(', ')}>` : ''
  }

  // variant label -> the owning enum, and each variant's field names (for construction and match binding)
  const variantFields = new Map<string, string[]>()
  const variantSet = new Set<string>()
  // the forms a `fill` / `melt` with a form walks, gathered while the bodies are emitted
  const fillSpecs = new Map<string, FormSpec>()
  const meltSpecs = new Map<string, FormSpec>()
  // every struct form's declared fields (in order: swift's memberwise init takes them so), and the exception forms,
  // whose structs conform to Error so a raise can `throw` them
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

  // the empty value of a type: what a left-out field holds
  const emptyOf = (type: Type | undefined): string => {
    switch (type?.kind) {
      case 'string':
        return '""'
      case 'boolean':
        return 'false'
      case 'number':
        return '0'
      case 'float':
        return '0.0'
      case 'bytes':
        return 'Data()'
      case 'array':
        return 'SeedList()'
      case 'map':
        return 'SeedMap()'
      case 'named':
        if (type.name === 'text') {
          return '""'
        }

        if (type.name === 'boolean') {
          return 'false'
        }

        if (type.name === 'number' || type.name === 'integer') {
          return '0'
        }

        if (type.name === 'decimal') {
          return '0.0'
        }

        if (type.name === 'maybe') {
          return '.none'
        }

        if (type.name === 'list') {
          return 'SeedList()'
        }

        if (type.name === 'hash') {
          return 'SeedMap()'
        }

        return '0'
      default:
        return '0'
    }
  }
  // for each form, which generic parameters (by index) flow into a map KEY position inside its fields. A `set<t>` stores
  // `items: hash<t, bool>`, so index 0 is a key; a method generic filling that slot must be `Hashable` (a Dictionary key).
  const formKeyIndices = new Map<string, Set<number>>()

  for (const node of program) {
    if (node.form !== 'record-type') {
      continue
    }

    for (const v of node.variants) {
      variantSet.add(v.name)
      variantFields.set(
        v.name,
        v.fields.map(f => f.name),
      )
    }

    if (node.params.length > 0) {
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
  }

  // native dock module aliases (`dns`, `fs`): a call to one returning a list yields a plain Array that must be wrapped
  const aliases = new Set<string>()

  for (const node of program) {
    if (node.form === 'native' && node.kind !== 'type') {
      aliases.add(node.alias)
    }
  }

  const rootName = (node: Expression): string | undefined =>
    node.form === 'variable'
      ? node.name
      : node.form === 'member'
        ? rootName(node.target)
        : undefined

  // true while emitting a list-returning function: a native dock call returned directly (a plain Array from the shim,
  // which has no access to the SeedList class) is wrapped in the seed list's SeedList handle to match the return type
  let fnReturnsArray = false
  // the enclosing function's declared result, so a `return <unknown-typed value>` casts at the gradual
  // boundary (`read mock/dock` returned as `like mock-data`)
  let currentResult: Type | undefined

  const isNativeCall = (node: Expression): boolean => {
    // SEE THROUGH AN AWAIT. `send back / call shim/list-them / wait true` is an `await` node wrapping the call,
    // and it is the same call: an asynchronous shim returns a plain `[T]` exactly as a synchronous one does. Not
    // looking through it meant a list-returning `note async` task emitted `return await shim.listThem(..)` with
    // no `SeedList(..)` around it, which swiftc rejects with `cannot convert return expression of type '[String]'
    // to return type 'SeedList<String>'`. The synchronous form of the very same task compiled clean, which is
    // what made it look like a shim problem rather than an emitter one.
    const call = node.form === 'await' ? node.expr : node

    if (call.form !== 'call' || call.callee.form !== 'member') {
      return false
    }

    const root = rootName(call.callee)

    return root !== undefined && aliases.has(root)
  }

  // traits (masks) emit as protocols, instances as conformance extensions, and a trait-bounded generic gains a protocol
  // bound on its type parameter so a generic trait-method call lowers to `x.method(..)`. Method signatures are derived
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

  const instanceTargets = new Map<string, string[]>()

  for (const node of program) {
    if (node.form === 'instance') {
      const list = instanceTargets.get(node.mask) ?? []
      list.push(node.target)
      instanceTargets.set(node.mask, list)
    }
  }

  type Fn = Extract<Statement, { form: 'function' }>
  const implFn = new Map<string, Fn>()

  for (const node of program) {
    if (node.form === 'function' && node.method) {
      implFn.set(`${node.method.form}:${node.method.name}`, node)
    }
  }

  // the functions whose body throws directly: their signatures carry `throws`, and every CALL to one is emitted as
  // `try!`. The language has no catch construct, so a thrown SeedError is always fatal -- exactly what `try!` does --
  // and no caller has to propagate `throws` through its own signature (which would cascade through the whole program).
  // This matches the other targets: an uncaught JS Error, a Rust `panic!`, an uncaught Kotlin RuntimeException.
  const throwingFns = new Set<string>()

  for (const node of program) {
    if (node.form === 'function' && bodyThrows(node.body)) {
      throwingFns.add(node.name)
    }
  }

  // the raise sets (note/term/hive/04-reach.md): a function that can raise, through its callees too, is `throws`, a
  // call to one is `try` where the caller is itself `throws` or the call sits in a guarded body, and `try!` elsewhere
  // (a raise nothing handles ends the program, as on every backend)
  const sets = raiseSets(program, exceptionForms)

  for (const [name, raises] of sets.raises) {
    if (raises.size > 0) {
      throwingFns.add(name)
    }
  }

  let currentThrows = false
  let guardDepth = 0
  const tryWord = (): string => (currentThrows || guardDepth > 0 ? 'try' : 'try!')

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

  // a protocol method requirement: `func measure() -> Int` (the receiver is implicit `self`, so the first parameter is
  // dropped; remaining parameters keep their types with the receiver type as `Self`)
  const protocolMethod = (
    fn: Fn | undefined,
    target: string,
  ): string => {
    if (!fn) {
      return ''
    }

    const rest = fn.params
      .slice(1)
      .map(
        p =>
          `_ ${camel(p.name)}: ${swiftType(subSelf(p.type, target))}`,
      )

    return `func ${camel(fn.method!.name)}(${rest.join(', ')}) -> ${swiftType(
      subSelf(fn.result, target),
    )}`
  }

  // a conformance method that delegates to the free implementation function: `func measure() -> Int { return boxMeasure(self) }`
  const extensionMethod = (
    fn: Fn | undefined,
    target: string,
  ): string => {
    if (!fn) {
      return ''
    }

    const restNames = fn.params.slice(1).map(p => camel(p.name))
    const rest = fn.params
      .slice(1)
      .map(
        p =>
          `_ ${camel(p.name)}: ${swiftType(subSelf(p.type, target))}`,
      )

    const callArgs = ['self', ...restNames].join(', ')
    const invoke = throwingFns.has(fn.name)
      ? `try! ${camel(fn.name)}(${callArgs})`
      : `${camel(fn.name)}(${callArgs})`

    return `${protocolMethod0(fn, target, rest)} { return ${invoke} }`
  }

  // shared header builder so the extension method matches the protocol method exactly
  const protocolMethod0 = (
    fn: Fn,
    target: string,
    rest: string[],
  ): string =>
    `func ${camel(fn.method!.name)}(${rest.join(', ')}) -> ${swiftType(
      subSelf(fn.result, target),
    )}`

  // within a matched branch, a subject variable's fields are bound to locals; `subject/field` reads that local
  type Bindings = Map<string, Set<string>>

  const expr = (node: Expression, bind: Bindings): string => {
    switch (node.form) {
      case 'integer':
        return String(node.value)
      case 'float':
        // a float literal needs a decimal point so it is a Double, not an Int
        return Number.isInteger(node.value)
          ? `${node.value}.0`
          : String(node.value)
      case 'boolean':
        return node.value ? 'true' : 'false'
      case 'string':
        return JSON.stringify(node.value)
      case 'template':
        // `"a\\(x)b"`: chunks escaped as a Swift string, expressions interpolated
        return `"${node.parts
          .map(part => (typeof part === 'string' ? JSON.stringify(part).slice(1, -1) : `\\(${expr(part, bind)})`))
          .join('')}"`
      case 'unit':
        return '()'
      case 'null':
        // null in the dynamic currency (`Any`) is Foundation's null object, the JSON-null representation
        return 'NSNull()'
      case 'variable':
      case 'hole':
        return vname(node.name)
      case 'unary': {
        // an operator over a throwing call needs the `try` in front of the whole expression, not the call alone
        const operand = expr(node.operand, bind)

        return operand.includes('try ') ? `(try ${node.op}${operand})` : `${node.op}${operand}`
      }
      case 'binary': {
        if (
          node.op === '%' &&
          (node.left.type?.kind === 'float' || node.right.type?.kind === 'float' || node.type?.kind === 'float')
        ) {
          return `(${expr(node.left, bind)}).truncatingRemainder(dividingBy: ${expr(node.right, bind)})`
        }

        // comparing an unknown slot to `make void` is a presence check: Any has no `==`, so it asks whether
        // the slot holds the unit
        const voidSide =
          node.right.form === 'record' && node.right.name === 'void'
            ? node.left
            : node.left.form === 'record' && node.left.name === 'void'
              ? node.right
              : undefined

        if (voidSide && (node.op === '==' || node.op === '!=')) {
          const check = `(${expr(voidSide, bind)} is Void)`

          return node.op === '==' ? check : `!${check}`
        }

        const left = expr(node.left, bind)
        const right = expr(node.right, bind)
        // `a == (try f())` is refused by Swift ("operator can throw"): the `try` goes in front of the operator
        const mark = left.includes('try ') || right.includes('try ') ? 'try ' : ''

        return `(${mark}${left} ${OP[node.op]} ${right})`
      }

      case 'call': {
        // `call fill / <data> / like <form>` and `call melt / <value> / like <form>`: a function per form, generated
        // from the form's fields at the end of the module (see swiftFormWalk below)
        if (
          node.callee.form === 'variable' &&
          (node.callee.name === 'fill-form' || node.callee.name === 'melt-form') &&
          node.into
        ) {
          const spec = formSpec(node.into, recordFields)
          refuseAny(spec, 'Swift')
          const into = node.callee.name === 'fill-form' ? fillSpecs : meltSpecs
          specForms(spec, into)

          return node.callee.name === 'fill-form'
            ? `__fill${pascal(spec.form)}(${expr(node.args[0]!, bind)}, "")`
            : `__melt${pascal(spec.form)}(${expr(node.args[0]!, bind)})`
        }

        // a declarative native binding renders its `case swift` template
        if (
          node.callee.form === 'variable' &&
          binds.has(node.callee.name)
        ) {
          const found = binds.get(node.callee.name)!

          return (
            renderBind(
              found,
              'swift',
              node.args.map(a => expr(a, bind)),
            ) ?? bindGap(found.name)
          )
        }

        // a native map / list operation lowers to swift's collection API (a map goes through the SeedMap wrapper)
        const operation = collectionCall(node.callee)

        if (operation) {
          return collectionExpr(operation, node.args, bind)
        }

        // a host string method (what `text.tree` delegates to) lowers to swift's String API
        const text = stringCall(node.callee)

        if (text) {
          return stringExpr(text.op, expr(text.target, bind), node.args.map(a => expr(a, bind)))
        }

        // a generic trait-method call lowers to a protocol method call on the receiver: `x.measure(..)`. The receiver
        // is the first argument; concrete trait calls were already resolved to the free function by the checker.
        if (
          node.callee.form === 'variable' &&
          maskMethods.has(node.callee.name) &&
          node.args.length >= 1
        ) {
          const rest = node.args.slice(1).map(a => expr(a, bind))

          return `${expr(node.args[0]!, bind)}.${camel(
            node.callee.name,
          )}(${rest.join(', ')})`
        }

        // a trailing `need false` parameter left out at the call site still exists in the native signature:
        // fill it with its type's empty value (the unit tuple for an unknown)
        const renderedArgs = node.args.map(a => expr(a, bind))
        const declaredParams =
          node.callee.form === 'variable'
            ? functionParams.get(node.callee.name)
            : undefined

        if (declaredParams && declaredParams.length > renderedArgs.length) {
          for (let i = renderedArgs.length; i < declaredParams.length; i++) {
            const missing = declaredParams[i]

            renderedArgs.push(
              missing === undefined || missing.kind === 'unknown'
                ? '()'
                : emptyOf(missing),
            )
          }
        }

        // a call to a throwing function is `try!`: fatal on error (there is no catch construct), and the caller's own
        // signature stays clean. Parenthesized so the call composes inside any surrounding expression.
        if (
          node.callee.form === 'variable' &&
          throwingFns.has(node.callee.name)
        ) {
          return `(${tryWord()} ${expr(node.callee, bind)}(${renderedArgs.join(', ')}))`
        }

        return `${expr(node.callee, bind)}(${renderedArgs.join(', ')})`
      }

      case 'array': {
        // an empty literal gives Swift nothing to infer the element from, so name it explicitly
        const arg =
          node.type?.kind === 'array'
            ? `<${swiftType(node.type.element)}>`
            : ''

        return `SeedList${arg}([${node.items
          .map(i => expr(i, bind))
          .join(', ')}])`
      }

      case 'map': {
        const arg =
          node.type?.kind === 'map'
            ? `<${swiftType(node.type.key)}, ${swiftType(
                node.type.value,
              )}>`
            : ''

        return node.entries.length === 0
          ? `SeedMap${arg}()`
          : `SeedMap${arg}([${node.entries
              .map(e => `${expr(e.key, bind)}: ${expr(e.value, bind)}`)
              .join(', ')}])`
      }

      case 'record': {
        // `make hash` / `make list` with no binds are the native collections, not record constructions; the
        // checked type pins the element parameters where swift cannot infer them (a generic function body)
        if (node.name === 'hash' && node.fields.length === 0) {
          const args =
            node.type?.kind === 'map' &&
            node.type.key.kind !== 'variable' &&
            node.type.value.kind !== 'variable'
              ? `<${swiftType(node.type.key)}, ${swiftType(node.type.value)}>`
              : ''

          return `SeedMap${args}()`
        }

        if (node.name === 'list' && node.fields.length === 0) {
          // a still-FREE element stays unspelled, so swift infers it from the expected type at the use site
          const args =
            node.type?.kind === 'array' &&
            node.type.element.kind !== 'variable'
              ? `<${swiftType(node.type.element)}>`
              : ''

          return `SeedList${args}()`
        }

        // `make void` is the absent value: the unit tuple, recognized on an Any slot with `is Void`
        if (node.name === 'void' && node.fields.length === 0) {
          return '()'
        }

        // leading-dot construction: Swift infers the enum/struct type from context
        if (variantSet.has(node.name)) {
          const labelled = node.fields.map(
            f => `${camel(f.name)}: ${expr(f.value, bind)}`,
          )

          return labelled.length > 0
            ? `.${camel(node.name)}(${labelled.join(', ')})`
            : `.${camel(node.name)}`
        }

        // a struct: name the type and pass the fields, in declared order (the memberwise init), a field the
        // construction leaves out taking its type's empty value
        const declared = recordFields.get(node.name)

        // an empty collection field value spells the DECLARED element type, since the checker's gradual
        // unify leaves it free and the zonked default (Int) would not fit an Any-elemented field
        const fieldValue = (name: string, value: Expression): string => {
          // only for a non-generic form: a generic form's declared element is its own type parameter
          if ((genericArity.get(node.name) ?? 0) > 0) {
            return expr(value, bind)
          }

          const declaredType = declared?.find(f => f.name === name)?.type

          if (
            ((value.form === 'record' &&
              value.fields.length === 0 &&
              value.name === 'list') ||
              (value.form === 'array' && value.items.length === 0)) &&
            declaredType?.kind === 'array'
          ) {
            return `SeedList<${swiftType(declaredType.element)}>([])`
          }

          if (
            ((value.form === 'record' &&
              value.fields.length === 0 &&
              value.name === 'hash') ||
              (value.form === 'map' && value.entries.length === 0)) &&
            declaredType?.kind === 'map'
          ) {
            return `SeedMap<${swiftType(declaredType.key)}, ${swiftType(declaredType.value)}>()`
          }

          return expr(value, bind)
        }

        if (declared) {
          const given = new Map(node.fields.map(f => [f.name, f.value]))

          return `${pascal(node.name)}(${declared
            .map(f => `${camel(f.name)}: ${given.has(f.name) ? fieldValue(f.name, given.get(f.name)!) : emptyOf(f.type)}`)
            .join(', ')})`
        }

        return `${pascal(node.name)}(${node.fields
          .map(f => `${camel(f.name)}: ${expr(f.value, bind)}`)
          .join(', ')})`
      }

      case 'member': {
        // a DYNAMIC segment (`read table/{key}`) subscripts the wrapper's storage
        if (node.index) {
          return `${expr(node.target, bind)}.data[${expr(node.index, bind)}]`
        }

        // `map.size` / `array.length` read the count (a map goes through its wrapper's `data`; an array is plain)
        const read = collectionRead(node)

        if (read) {
          // both a map and an array (SeedMap / SeedList) read their length through the wrapper's `.data`
          return `${expr(read.target, bind)}.data.count`
        }

        const textLength = stringRead(node)

        if (textLength) {
          return `${expr(textLength.target, bind)}.count`
        }

        // a LITERAL index segment (`read parts/0`) on an array target subscripts the SeedList's storage
        if (/^\d+$/.test(node.name) && node.target.type?.kind === 'array') {
          return `${expr(node.target, bind)}.data[${node.name}]`
        }

        // a matched variant's field reads the bound local; otherwise a normal field access
        if (
          node.target.form === 'variable' &&
          bind.get(node.target.name)?.has(node.name)
        ) {
          return camel(node.name)
        }

        return `${expr(node.target, bind)}.${camel(node.name)}`
      }

      case 'await':
        return `await ${expr(node.expr, bind)}`

      case 'closure': {
        // a function literal as a Swift closure. The trailing `send back X` becomes the closure's value
        // expression when it stands alone; with statements before it the implicit-return rule no longer
        // applies, so the `return` stays explicit.
        const last = node.body[node.body.length - 1]
        const lead = node.body
          .slice(0, -1)
          .map(s => stmt(s, 0, bind))
          .filter(Boolean)

        const tail =
          last?.form === 'return' && last.value
            ? lead.length > 0
              ? `return ${expr(last.value, bind)}`
              : expr(last.value, bind)
            : last
              ? stmt(last, 0, bind)
              : ''

        // an async closure carries an explicit `(params) async -> Ret in` signature: Swift closures express async in
        // the signature (there is no async-block form), and the explicit types let `let f = { ... }` infer the async
        // function type without a separate annotation. The call site `await`s the result.
        // A sync closure with a DECLARED result gets an explicit `-> Ret` too: a leading-dot value
        // (`.some(value: x)`) in its body has no context to resolve against otherwise. Its params stay
        // BARE names: a param the source never annotated has no recorded type (it would print `Void`),
        // and Swift infers bare params from the expected function type.
        const signature = node.async
          ? `(${node.params
              .map(p => `${camel(p.name)}: ${swiftType(p.type)}`)
              .join(', ')}) async -> ${swiftType(node.result)} in `
          : node.result
            ? `(${node.params
                .map(p => camel(p.name))
                .join(', ')}) -> ${swiftType(node.result)} in `
            : `(${node.params.map(p => camel(p.name)).join(', ')}) in `

        return `{ ${signature}${[...lead, tail]
          .filter(Boolean)
          .join('; ')} }`
      }

      case 'conditional': {
        // a value-position conditional lowers to a ternary chain
        const tail = node.otherwise ? expr(node.otherwise, bind) : '()'

        return node.branches.reduceRight(
          (rest, branch) =>
            `(${expr(branch.cond, bind)} ? ${expr(
              branch.value,
              bind,
            )} : ${rest})`,
          tail,
        )
      }

      default:
        return exhausted(node)
    }
  }

  // lower a native map / list operation to swift. A map goes through the SeedMap wrapper (`.data` is its Dictionary,
  // `.setting` / `.removing` mutate and return). The return shapes match the JS collection API the stdlib forms expect.
  const collectionExpr = (
    op: CollectionOp,
    args: Expression[],
    bind: Bindings,
  ): string => {
    const target = expr(op.target, bind)
    const arg = args.map(a => expr(a, bind))

    if (op.kind === 'map') {
      switch (op.op) {
        case 'has':
          return `(${target}.data[${arg[0]}] != nil)`
        case 'get':
          return `${target}.data[${arg[0]}]!`
        case 'set':
          return `${target}.setting(${arg[0]}, ${arg[1]})`
        case 'delete':
          return `${target}.removing(${arg[0]})`
        case 'keys':
          return `SeedList(Array(${target}.data.keys))`
        case 'values':
          return `SeedList(Array(${target}.data.values))`
        default:
          return ''
      }
    }

    // arrays go through the SeedList wrapper (`.data` is its Array, `.appending` / `.popping` mutate). An op returning a
    // list wraps a new SeedList; `String(describing:)` renders any element for `join` with no bound.
    const data = `${target}.data`

    switch (op.op) {
      case 'push':
        return `${target}.appending(${arg[0]})`
      case 'pop':
        return `${target}.popping()`
      case 'at':
      case 'get':
        return `${data}[${arg[0]}]`
      case 'set':
        // wrapped in parens so two set statements in a row do not parse as a trailing closure on the first
        return `({ ${target}.data[${arg[0]}] = ${arg[1]} }())`
      case 'includes':
        return `${data}.contains(${arg[0]})`
      case 'indexOf':
        return `Int(${data}.firstIndex(of: ${arg[0]}) ?? -1)`
      case 'lastIndexOf':
        return `Int(${data}.lastIndex(of: ${arg[0]}) ?? -1)`
      case 'concat':
        return `SeedList(${data} + ${arg[0]}.data)`
      case 'slice':
        return arg[1] !== undefined
          ? `SeedList(Array(${data}[${arg[0]}..<${arg[1]}]))`
          : `SeedList(Array(${data}[${arg[0]}...]))`
      case 'toReversed':
        return `SeedList(${data}.reversed())`
      case 'join':
        return `${data}.map { String(describing: $0) }.joined(separator: ${arg[0]})`
      case 'map':
        return `SeedList(${data}.map(${arg[0]}))`
      case 'filter':
        return `SeedList(${data}.filter(${arg[0]}))`
      case 'some':
        return `${data}.contains(where: ${arg[0]})`
      case 'every':
        return `${data}.allSatisfy(${arg[0]})`
      case 'reduce':
        return `${data}.reduce(${arg[1]}, ${arg[0]})`
      case 'findIndex':
        return `Int(${data}.firstIndex(where: ${arg[0]}) ?? -1)`
      case 'flat':
        // flattening a non-nested list is a shallow copy (JS `[1,2,3].flat()` is `[1,2,3]`)
        return `SeedList(${data})`
      case 'unshift':
        return `${target}.unshifting(${arg[0]})`
      case 'shift':
        return `${target}.shifting()`
      case 'splice':
        return `${target}.splicing(${arg[0]}, ${arg[1]}, [${arg.slice(2).join(', ')}])`
      default:
        return ''
    }
  }

  // JavaScript's string methods over swift's String (see backend.ts, STRING_METHODS). Positions count Characters;
  // a read past the end is empty (charAt) or 0 (charCodeAt), never a trap. Foundation is imported by the prelude.
  const stringExpr = (op: string, t: string, a: string[]): string => {
    switch (op) {
      case 'charAt':
      case 'at':
        return `({ () -> String in let c = Array(${t}); let i = Int(${a[0]}); return i >= 0 && i < c.count ? String(c[i]) : "" })()`
      case 'charCodeAt':
        return `({ () -> Int in let c = Array(${t}.utf16); let i = Int(${a[0]}); return i >= 0 && i < c.count ? Int(c[i]) : 0 })()`
      case 'indexOf':
        return `({ () -> Int in let h = ${t}; let n = ${a[0]}; let f = min(max(Int(${a[1] ?? '0'}), 0), h.count); if n.isEmpty { return f }; let s = h.index(h.startIndex, offsetBy: f); if let r = h.range(of: n, range: s..<h.endIndex) { return h.distance(from: h.startIndex, to: r.lowerBound) }; return -1 })()`
      case 'lastIndexOf':
        return `({ () -> Int in let h = ${t}; if let r = h.range(of: ${a[0]}, options: .backwards) { return h.distance(from: h.startIndex, to: r.lowerBound) }; return -1 })()`
      case 'split':
        return `({ () -> SeedList<String> in let d = ${a[0]}; return SeedList(d.isEmpty ? ${t}.map { String($0) } : ${t}.components(separatedBy: d)) })()`
      case 'substring':
      case 'slice':
        return `({ () -> String in let s = ${t}; let n = s.count; var x = min(max(Int(${a[0]}), 0), n); var y = min(max(Int(${a[1] ?? 'n'}), 0), n); if x > y { swap(&x, &y) }; return String(s[s.index(s.startIndex, offsetBy: x)..<s.index(s.startIndex, offsetBy: y)]) })()`
      case 'toLowerCase':
        return `${t}.lowercased()`
      case 'toUpperCase':
        return `${t}.uppercased()`
      case 'startsWith':
        return `${t}.hasPrefix(${a[0]})`
      case 'endsWith':
        return `${t}.hasSuffix(${a[0]})`
      case 'trim':
        return `${t}.trimmingCharacters(in: .whitespacesAndNewlines)`
      case 'trimStart':
        return `String(${t}.drop(while: { $0.isWhitespace }))`
      case 'trimEnd':
        return `String(String(${t}.reversed()).drop(while: { $0.isWhitespace }).reversed())`
      case 'padStart':
        return `({ () -> String in var o = ${t}; let f = ${a[1]}; while o.count < Int(${a[0]}) && !f.isEmpty { o = f + o }; return o })()`
      case 'padEnd':
        return `({ () -> String in var o = ${t}; let f = ${a[1]}; while o.count < Int(${a[0]}) && !f.isEmpty { o = o + f }; return o })()`
      case 'replace':
        return `({ () -> String in var s = ${t}; if let r = s.range(of: ${a[0]}) { s.replaceSubrange(r, with: ${a[1]}) }; return s })()`
      case 'replaceAll':
        return `${t}.replacingOccurrences(of: ${a[0]}, with: ${a[1]})`
      case 'includes':
        return `${t}.contains(${a[0]})`
      case 'concat':
        return `(${t} + ${a[0]})`
      case 'repeat':
        return `String(repeating: ${t}, count: max(Int(${a[0]}), 0))`
      default:
        return ''
    }
  }

  const block = (
    body: Statement[],
    d: number,
    bind: Bindings,
  ): string =>
    body
      .map(s => `${pad(d)}${stmt(s, d, bind)}`)
      .filter(Boolean)
      .join('\n')

  // a `switch` case with no statement in its body (Term's `fork case, ... / case none` with nothing under it, a
  // real and common shape: `maybe`'s `none` arm, an ignored variant) is a Swift compile error --
  // "'case' label in a 'switch' must have at least one executable statement" -- unlike `if`/`while`, which accept
  // an empty `{ }` block fine. `block` alone can't tell an arm from an ordinary block, so every match-arm body
  // goes through this instead, which falls back to an explicit `break` only when the arm itself is empty.
  const armBlock = (body: Statement[], d: number, bind: Bindings): string =>
    block(body, d, bind) || `${pad(d)}break`

  const stmt = (node: Statement, d: number, bind: Bindings): string => {
    switch (node.form) {
      case 'let': {
        // a valueless typed module slot (`host current, like context`, filled later by a `save`): an
        // implicitly-unwrapped optional, so reads carry the declared class type
        if (node.init.form === 'unit' && node.type?.kind === 'named' && node.type.name) {
          return `var ${vname(node.name)}: ${swiftType(node.type)}!`
        }

        // the gradual boundary on a binding: a boxed dynamic re-typed at a declared FORM casts
        if (
          node.type?.kind === 'named' &&
          node.init.form === 'member' &&
          recordFields.has(node.type.name) &&
          (node.init.type?.kind === 'unknown' ||
            node.init.type?.kind === 'dynamic')
        ) {
          return `${node.mutable || assignedAnywhere.has(node.name) ? 'var' : 'let'} ${vname(node.name)} = ${expr(node.init, bind)} as! ${swiftType(node.type)}`
        }

        // annotate an ADT binding so leading-dot construction has a type to infer from. An anonymous record's
        // type is `named ''` (a nested `host` constant) and cannot be spelled: no annotation, Swift infers.
        // A call (or awaited call) carries its own type, so no annotation there either: inside a nested
        // closure the checker can lose an enclosing generic and record a defaulted argument (`Maybe<Int>`
        // for `Maybe<T>`), and the call's native type is the correct one.
        const carriesOwnType =
          node.init.form === 'call' ||
          (node.init.form === 'await' && node.init.expr.form === 'call')
        const annotation =
          node.type?.kind === 'named' && node.type.name && !carriesOwnType
            ? `: ${swiftType(node.type)}`
            : ''

        return `${node.mutable || assignedAnywhere.has(node.name) ? 'var' : 'let'} ${vname(
          node.name,
        )}${annotation} = ${expr(node.init, bind)}`
      }

      case 'assign':
        return node.op === '='
          ? `${expr(node.target, bind)} = ${expr(node.value, bind)}`
          : `${expr(node.target, bind)} ${node.op} ${expr(
              node.value,
              bind,
            )}`
      case 'expression': {
        const rendered = expr(node.expr, bind)

        // a VALUED call in statement position discards explicitly, or swiftc warns (and the gates treat
        // warnings as failures)
        if (
          node.expr.form === 'call' &&
          node.expr.type &&
          node.expr.type.kind !== 'unit'
        ) {
          return `_ = ${rendered}`
        }

        return rendered
      }
      case 'return':
        if (!node.value) {
          return currentResult?.kind === 'unknown' ? 'return ()' : 'return'
        }

        // a list-returning function that returns a native dock call directly wraps the shim's plain Array
        if (fnReturnsArray && isNativeCall(node.value)) {
          return `return SeedList(${expr(node.value, bind)})`
        }

        // the gradual boundary: an unknown-typed value returned at a DECLARED FORM type casts explicitly.
        // Only for a form the program declares: a generic letter (`like t`) is not a cast target.
        const valueKind = node.value.type?.kind
        const cast =
          node.value.form === 'member' &&
          (valueKind === 'unknown' || valueKind === 'dynamic') &&
          currentResult?.kind === 'named' &&
          currentResult.name &&
          recordFields.has(currentResult.name)
            ? ` as! ${swiftType(currentResult)}`
            : ''

        return `return ${expr(node.value, bind)}${cast}`
      case 'throw': {
        // a raise carries the record whole in a TermException; a text raises `failure`; a caught value passes on.
        // When the program has the stdlib hive, a NEW carrier tells it before unwinding (a pass-on does not re-tell).
        const tellPart = hasHiveTell
          ? '; hiveTell(HiveEntry(host: told.host, kind: "exception", name: told.form, site: "", base: told))'
          : ''

        return node.value.form === 'string'
          ? `throw ({ () -> TermException in let told = TermException(host: "", form: "failure", note: ${expr(node.value, bind)}, code: "", time: 0, link: nil, base: nil)${tellPart}; return told })()`
          : node.value.form === 'record' && exceptionForms.has(node.value.name)
            ? `throw try ({ () throws -> TermException in let raised = ${expr(node.value, bind)}; let told = TermException(host: raised.host, form: raised.form, note: raised.note, code: raised.code, time: raised.time, link: raised.link, base: raised)${tellPart}; return told })()`
            : `throw termException(${expr(node.value, bind)})`
      }
      case 'while':
        return `while ${expr(node.cond, bind)} {\n${block(
          node.body,
          d + 1,
          bind,
        )}\n${pad(d)}}`
      case 'guard': {
        // `note unsafe` / `halt take`: a do with its catch. Calls in the body are `try`, and the caught value is a
        // TermException: a raise passes through, a foreign error is wrapped as `failure`
        guardDepth++
        const body = block(node.body, d + 1, bind)
        guardDepth--
        const handler = node.catch
          ? `catch {\n${pad(d + 1)}let ${camel(node.catch.name)} = termException(error)\n${block(
              node.catch.body,
              d + 1,
              bind,
            )}\n${pad(d)}}`
          : 'catch {}'

        return `do {\n${body}\n${pad(d)}} ${handler}`
      }

      case 'for-each': {
        // a list is a SeedList; iterate its backing `.data` Array
        const iterable =
          node.iterable.type?.kind === 'array'
            ? `${expr(node.iterable, bind)}.data`
            : expr(node.iterable, bind)

        return `for ${vname(node.item)} in ${iterable} {\n${block(
          node.body,
          d + 1,
          bind,
        )}\n${pad(d)}}`
      }

      case 'match': {
        // a native `switch`: the compiler checks exhaustiveness, so no fallthrough-return is needed. Each variant's
        // fields bind to locals; field access on the subject inside the branch rewrites to those locals.
        const subject = expr(node.subject, bind)
        // a fork case over a caught TermException: switch on `form`, the record recovered from `base` by its form
        if (node.exceptionArms) {
          const arms = node.cases.map(b => {
            const arm = node.exceptionArms![b.label]!
            const bodyText = armBlock(b.body, d + 2, bind)
            const locals = armLocals([...arm.shared, ...arm.link], b.binds)
              .filter(({ local }) => new RegExp(`\\b${camel(local).replace(/[^\w$]/g, '\\$&')}\\b`).test(bodyText))
              .map(({ field, local }) =>
                arm.link.includes(field)
                  ? `${pad(d + 2)}let ${camel(local)} = (${subject}.base as! ${pascal(b.label)}).link.${camel(field)}`
                  : `${pad(d + 2)}let ${camel(local)} = ${subject}.${camel(field)}`,
              )

            return `${pad(d + 1)}case ${JSON.stringify(b.label)}:\n${[...locals, bodyText].join('\n')}`
          })
          // the checker holds the arms to the guarded body's raise set, so the default cannot be reached; it ends the
          // program with the form and note, which also tells Swift every path answers
          arms.push(`${pad(d + 1)}default:${node.otherwise ? `\n${block(node.otherwise, d + 2, bind)}` : `\n${pad(d + 2)}fatalError("\\(${subject}.form): \\(${subject}.note)")`}`)

          return `switch ${subject}.form {\n${arms.join('\n')}\n${pad(d)}}`
        }

        // a `fork case` over a TEXT subject (`fork case, read kind` with `case home` arms): the labels are
        // string values, matched by literal (a `default` keeps the switch exhaustive)
        if (node.subject.type?.kind === 'string') {
          const arms = node.cases.map(
            b =>
              `${pad(d + 1)}case ${JSON.stringify(b.label)}:\n${armBlock(
                b.body,
                d + 2,
                bind,
              )}`,
          )

          arms.push(
            `${pad(d + 1)}default:${
              node.otherwise
                ? `\n${block(node.otherwise, d + 2, bind)}`
                : '\n' + pad(d + 2) + 'break'
            }`,
          )

          return `switch ${subject} {\n${arms.join('\n')}\n${pad(d)}}`
        }

        const subjectVar =
          node.subject.form === 'variable'
            ? node.subject.name
            : undefined

        // a match whose labels are only true/false is a switch over a NATIVE Bool (booleans lower to `Bool` here,
        // not an enum), so the patterns are the literals `true` / `false`, not leading-dot cases.
        const labels = node.cases.map(branch => branch.label)
        const booleans =
          labels.length > 0 &&
          labels.every(label => label === 'true' || label === 'false')

        const arms = node.cases.map(b => {
          if (booleans) {
            return `${pad(d + 1)}case ${b.label}:\n${armBlock(
              b.body,
              d + 2,
              bind,
            )}`
          }

          const fields = variantFields.get(b.label) ?? []
          const branchBind: Bindings = new Map(bind)

          if (subjectVar && fields.length > 0) {
            branchBind.set(subjectVar, new Set(fields))
          }

          // every field binds, positionally, under the local name the arm's `link` lines give it (see check/arm.ts)
          const locals = new Map(
            armLocals(fields, b.binds).map(({ field, local }) => [field, local]),
          )
          const pattern =
            fields.length > 0
              ? `case let .${camel(b.label)}(${fields
                  .map(field => camel(locals.get(field) ?? field))
                  .join(', ')}):`
              : `case .${camel(b.label)}:`

          return `${pad(d + 1)}${pattern}\n${armBlock(
            b.body,
            d + 2,
            branchBind,
          )}`
        })

        if (node.otherwise) {
          arms.push(
            `${pad(d + 1)}default:\n${armBlock(
              node.otherwise,
              d + 2,
              bind,
            )}`,
          )
        } else if (booleans && node.cases.length < 2) {
          // a Bool switch with a single literal arm still has to be exhaustive
          arms.push(`${pad(d + 1)}default:\n${pad(d + 2)}break`)
        }

        return `switch ${subject} {\n${arms.join('\n')}\n${pad(d)}}`
      }

      case 'if': {
        let out = ''
        node.branches.forEach((b, i) => {
          out += `${i ? ' else ' : ''}if ${expr(
            b.cond,
            bind,
          )} {\n${block(b.body, d + 1, bind)}\n${pad(d)}}`
        })

        if (node.otherwise) {
          out += ` else {\n${block(node.otherwise, d + 1, bind)}\n${pad(
            d,
          )}}`
        }

        return out
      }

      case 'break':
        return 'break'
      case 'continue':
        return 'continue'
      case 'exit':
        return 'exit(0)'
      case 'debug':
        return '// breakpoint'

      case 'function': {
        const generics = genericClause(node) // sets varNames for the param/result/body emission that follows
        // a function-typed parameter is `@escaping`: the callee may store it (a hive ear, a route handler), and
        // marking one that is only called is harmless
        const params = node.params
          .map(
            p =>
              `_ ${vname(p.name)}: ${p.type?.kind === 'function' ? '@escaping ' : ''}${swiftType(p.type)}`,
          )
          .join(', ')

        const asyncMark = node.async ? ' async' : ''
        const throwsMark = throwingFns.has(node.name) || bodyThrows(node.body) ? ' throws' : ''
        currentThrows = throwsMark !== ''
        // a reassigned parameter is shadowed by a mutable local (Swift parameters are immutable)
        const mutated = new Set<string>()
        reassigned(node.body, mutated)

        const shadows = node.params
          .filter(p => mutated.has(p.name))
          .map(
            p => `${pad(d + 1)}var ${vname(p.name)} = ${vname(p.name)}`,
          )

        const previousReturnsArray = fnReturnsArray
        fnReturnsArray = node.result?.kind === 'array'

        // a task with no declared result but a valued `send back` (a dock forward) is Any, not Void
        const result =
          node.result && node.result.kind !== 'unit'
            ? node.result
            : hasValuedReturn(node.body)
              ? ({ kind: 'unknown' } as Type)
              : node.result

        currentResult = result

        // a valued task whose body ends in branching that returns from every live path: swift cannot always
        // see the coverage (an if chain with no else), so the fall-through traps
        const last = node.body[node.body.length - 1]
        const unreachable =
          (last?.form === 'if' ||
            last?.form === 'while' ||
            last?.form === 'match') &&
          node.result &&
          node.result.kind !== 'unit'
            ? `${pad(d + 1)}fatalError("unreachable")`
            : ''

        // a signature-only stub compiles: its body is the not-implemented trap
        const bodyText =
          node.body.length === 0
            ? `${pad(d + 1)}fatalError(${JSON.stringify(`stub: ${node.name}`)})`
            : [
                ...shadows,
                block(node.body, d + 1, new Map()),
                unreachable,
              ]
                .filter(Boolean)
                .join('\n')

        fnReturnsArray = previousReturnsArray


        return `func ${camel(
          node.name,
        )}${generics}(${params})${asyncMark}${throwsMark} -> ${swiftType(
          result,
        )} {\n${bodyText}\n${pad(d)}}`
      }

      case 'record-type': {
        // a generic that flows into a map key inside the fields must be `Hashable` (the SeedMap wrapper requires it)
        const keys = formKeyIndices.get(node.name)
        const generics = node.params.length
          ? `<${node.params
              .map((p, i) =>
                keys?.has(i)
                  ? `${p.toUpperCase()}: Hashable`
                  : p.toUpperCase(),
              )
              .join(', ')}>`
          : ''

        if (node.variants.length > 0) {
          // a native enum: each variant a case, its fields the associated values
          const cases = node.variants.map(v => {
            const fields = v.fields.map(
              f => `${camel(f.name)}: ${swiftType(f.type)}`,
            )

            return `${pad(d + 1)}case ${camel(v.name)}${
              fields.length > 0 ? `(${fields.join(', ')})` : ''
            }`
          })

          // `indirect` lets a variant hold its own enum (a linked list's `next`); harmless when nothing recurses
          return `indirect enum ${pascal(node.name)}${generics} {\n${cases.join(
            '\n',
          )}\n${pad(d)}}`
        }

        const fields = node.fields.map(
          f =>
            `${pad(d + 1)}var ${camel(f.name)}: ${swiftType(f.type)}`,
        )

        return `struct ${pascal(node.name)}${generics}${exceptionForms.has(node.name) ? ': Error' : ''} {\n${fields.join(
          '\n',
        )}\n${pad(d)}}`
      }

      case 'mask': {
        // a protocol whose method requirements are derived from any implementing instance's signature
        const target = instanceTargets.get(node.name)?.[0]
        const methods = target
          ? node.methods
              .map(
                m =>
                  `${pad(d + 1)}${protocolMethod(
                    implFn.get(`${target}:${m}`),
                    target,
                  )}`,
              )
              .filter(line => line.trim())
          : []

        return `protocol ${pascal(node.name)} {${
          methods.length ? `\n${methods.join('\n')}\n${pad(d)}` : ''
        }}`
      }

      case 'instance': {
        // a conformance extension whose methods delegate to the free implementation functions
        const methods = node.methods
          .map(m =>
            extensionMethod(
              implFn.get(`${node.target}:${m}`),
              node.target,
            ),
          )
          .filter(Boolean)
          .map(line => `${pad(d + 1)}${line}`)

        return `extension ${pascal(node.target)}: ${pascal(node.mask)} {${
          methods.length ? `\n${methods.join('\n')}\n${pad(d)}` : ''
        }}`
      }

      case 'hold':
        return '// hold: verified at compile time'
      case 'native':
        return ''
      case 'bind':
      case 'view':
      case 'dock':
      case 'tell':
      case 'roll':
        return '' // view / routing DSLs are lowered by the dedicated zone compiler, not this backend
      default:
        return exhausted(node)
    }
  }

  // a `<global:X>` binding (e.g. the linked `io` runtime namespace) needs no import: it is already in scope. A `type`
  // dock is an inline type reference, not an importable module.
  const imports = program
    .filter(
      (n): n is Extract<Statement, { form: 'native' }> =>
        n.form === 'native' &&
        n.kind !== 'type' &&
        !n.module.startsWith('global:'),
    )
    .map(n => `import ${n.module.replace(/^[a-z]+:/, '')}`)

  // a DOTTED opaque handle type (`dock type / load <SwiftUI.AnyView>`) names its module, which must be
  // imported for the type to resolve.
  //
  // UNLESS the first segment is a SHIM NAMESPACE. `dock type / load <runtime.Running>` beside
  // `dock load / load <global:server>, name runtime` names a type inside the prepended shim's `enum runtime`,
  // which is already in scope and is not a module: importing it is `no such module 'runtime'` on a file whose
  // prelude defines it 190 lines above. Every handle type a runtime shim owns is dotted this way, so the whole
  // asynchronous file and server surface tripped it at once.
  const shimNames = new Set(
    program
      .filter(
        (n): n is Extract<Statement, { form: 'native' }> =>
          n.form === 'native' && n.module.startsWith('global:'),
      )
      .map(n => n.alias),
  )

  for (const n of program) {
    if (n.form === 'native' && n.kind === 'type' && n.module.includes('.')) {
      const head = n.module.split('.')[0]!

      if (shimNames.has(head)) {
        continue
      }

      const importLine = `import ${head}`

      if (!imports.includes(importLine)) {
        imports.push(importLine)
      }
    }
  }

  // a declarative binding's swift expression may need a module imported (e.g. `Foundation.pow`)
  for (const need of bindImports(
    referencedBinds(program, binds),
    'swift',
  )) {
    const line = `import ${need.module.replace(/^[a-z]+:/, '')}`

    if (!imports.includes(line)) {
      imports.push(line)
    }
  }

  // the string API lowers to Foundation methods (`range(of:)`, case transforms): import it always, rather than
  // relying on a prelude shim to have done so (a module with no shim got no Foundation and failed on its first
  // string search). A duplicate import is harmless.
  if (!imports.includes('import Foundation')) {
    imports.unshift('import Foundation')
  }

  // a module-level `host` data tree is an ANONYMOUS nested record: with no name it emits as a labelled tuple,
  // and a single-field tuple is not valid Swift. Synthesize one struct per record node, named by the binding
  // and the field path (HostRange, HostRangeH), and rename the record nodes so the construction uses the
  // memberwise init.
  const hostStructDefs: string[] = []
  const swiftHostLeaf = (v: Expression): string =>
    v.form === 'integer'
      ? 'Int'
      : v.form === 'float'
        ? 'Double'
        : v.form === 'string'
          ? 'String'
          : v.form === 'boolean'
            ? 'Bool'
            : 'Int'
  const nameHostRecord = (
    node: Extract<Expression, { form: 'record' }>,
    base: string,
  ): string => {
    node.name = base

    const fields = node.fields.map(f => {
      const type =
        f.value.form === 'record' && f.value.name === ''
          ? nameHostRecord(f.value, `${base}${pascal(f.name)}`)
          : swiftHostLeaf(f.value)

      return `var ${camel(f.name)}: ${type}`
    })

    hostStructDefs.push(`struct ${base} { ${fields.join('; ')} }`)

    return base
  }

  for (const node of program) {
    if (
      node.form === 'let' &&
      node.init.form === 'record' &&
      node.init.name === ''
    ) {
      nameHostRecord(node.init, `Host${pascal(node.name)}`)
    }
  }

  // an abstract module's signature-only declaration and the platform module's implementation share a name by
  // design (platform dispatch): the stub yields to the implementation instead of redeclaring it
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
      .map(n => stmt(n, 0, new Map())),
  ].filter(Boolean)

  const prelude: string[] = []

  if (body.some(b => b.includes('SeedError('))) {
    prelude.push(
      'struct SeedError: Error { let message: String; init(_ m: String) { message = m } }',
    )
  }

  // the one exception value of a Term program on this backend (note/term/hive/11-native-exceptions.md)
  if (body.some(b => b.includes('TermException(') || b.includes('termException('))) {
    prelude.push(
      'struct TermException: Error { let host: String; let form: String; let note: String; let code: String; let time: Int; let link: Any?; let base: Any? }',
      'func termException(_ thrown: Any) -> TermException { if let e = thrown as? TermException { return e }; return TermException(host: "", form: "failure", note: "\\(thrown)", code: "", time: 0, link: nil, base: thrown) }',
    )
  }

  // the reference wrapper for maps (a class so mutation persists across a struct copy); emitted only when used
  if (body.some(b => b.includes('SeedMap'))) {
    prelude.push(
      [
        'final class SeedMap<K: Hashable, V> {',
        '    var data: [K: V]',
        '    init(_ data: [K: V] = [:]) { self.data = data }',
        '    @discardableResult func setting(_ key: K, _ value: V) -> SeedMap<K, V> { data[key] = value; return self }',
        '    @discardableResult func removing(_ key: K) -> Bool { let had = data[key] != nil; data.removeValue(forKey: key); return had }',
        '}',
      ].join('\n'),
    )
  }

  // the reference wrapper for lists (a class so an in-place `push` persists across a copy); emitted only when used
  if (body.some(b => b.includes('SeedList'))) {
    prelude.push(
      [
        'final class SeedList<T> {',
        '    var data: [T]',
        '    init(_ data: [T] = []) { self.data = data }',
        '    @discardableResult func appending(_ item: T) -> Int { data.append(item); return data.count }',
        '    @discardableResult func popping() -> T { return data.removeLast() }',
        '    @discardableResult func unshifting(_ item: T) -> Int { data.insert(item, at: 0); return data.count }',
        '    @discardableResult func shifting() -> T { return data.removeFirst() }',
        '    @discardableResult func splicing(_ start: Int, _ count: Int, _ items: [T]) -> Int { data.replaceSubrange(start..<(start + count), with: items); return data.count }',
        '}',
      ].join('\n'),
    )
  }

  // the wake chain: one `hiveWake` per deck with its static entries, when the program has the stdlib hive and
  // the compile driver handed over the roll. A static entry's `base` is the declaration as JSON text; an entry
  // with a `ref` (a declared kind's constant) binds the live module constant. See note/term/hive/05-hive.md.
  const wake: string[] = []

  if (
    options?.wake?.length &&
    program.some(n => n.form === 'function' && n.name === 'hive-wake')
  ) {
    const entryText = (entry: Record<string, unknown>): string => {
      const { ref, base, ...own } = entry
      const boxed =
        typeof ref === 'string'
          ? camel(ref)
          : JSON.stringify(JSON.stringify(base ?? {}))

      return `HiveEntry(host: ${JSON.stringify(String(own.host ?? ''))}, kind: ${JSON.stringify(String(own.kind ?? ''))}, name: ${JSON.stringify(String(own.name ?? ''))}, site: ${JSON.stringify(String(own.site ?? ''))}, base: ${boxed})`
    }

    const calls = options.wake
      .map(
        group =>
          `  hiveWake(${JSON.stringify(group.deck)}, SeedList<HiveEntry>([${group.entries.map(entryText).join(', ')}]))`,
      )
      .join('\n')

    wake.push(`func wakeHive() -> Void {\n${calls}\n}`)
  }

  return [...imports, ...prelude, ...body, ...swiftFormWalk(fillSpecs, meltSpecs), ...wake].join('\n\n') + '\n'
}

// does a function body contain a throw? (then its Swift signature needs `throws`)
function bodyThrows(body: Statement[]): boolean {
  return body.some(s => {
    switch (s.form) {
      case 'throw':
        return true
      case 'if':
        return (
          s.branches.some(b => bodyThrows(b.body)) ||
          (s.otherwise ? bodyThrows(s.otherwise) : false)
        )
      case 'match':
        return (
          s.cases.some(c => bodyThrows(c.body)) ||
          (s.otherwise ? bodyThrows(s.otherwise) : false)
        )
      case 'while':
      case 'for-each':
        return bodyThrows(s.body)
      default:
        return false
    }
  })
}

// ---- filling a form from data on swift ----

// the walkers a module's `fill` / `melt` with a form need: helpers over the package's data enum (spelled
// `DataForm` here, since `Data` is Foundation's), then a function per form. A value that does not fit is fatal,
// which is what a thrown SeedError is on this backend too, with the path and reason of the package's
// `data-mismatch`.
function swiftFormWalk(fills: Map<string, FormSpec>, melts: Map<string, FormSpec>): string[] {
  if (fills.size === 0 && melts.size === 0) {
    return []
  }

  const out: string[] = [SWIFT_FORM_HELPERS]

  const fillOf = (kind: FormKind, value: string, path: string, optional: boolean): string => {
    switch (kind.kind) {
      case 'text':
        return `__termText(${value}, ${path}, ${optional})`
      case 'number':
        return `__termNumber(${value}, ${path}, ${optional})`
      case 'decimal':
        return `__termDecimal(${value}, ${path}, ${optional})`
      case 'flag':
        return `__termFlag(${value}, ${path}, ${optional})`
      case 'data':
        return `__termData(${value}, ${path}, ${optional})`
      case 'list':
        return `__termList(${value}, ${path}, ${optional}) { d, p in ${fillOf(kind.item, 'd', 'p', false)} }`
      case 'form':
        return `__fill${pascal(kind.spec.form)}(__termData(${value}, ${path}, ${optional}), ${path})`
      default:
        return '0'
    }
  }

  for (const spec of fills.values()) {
    const known = spec.fields.map(f => JSON.stringify(f.name)).join(', ')
    const fields = spec.fields
      .map(f => `${camel(f.name)}: ${fillOf(f.kind, `find(${JSON.stringify(f.name)})`, `__termPath(path, ${JSON.stringify(f.name)})`, f.optional)}`)
      .join(', ')

    out.push(
      `func __fill${pascal(spec.form)}(_ value: DataForm, _ path: String) -> ${pascal(spec.form)} {\n` +
        `  let entries = __termEntries(value, path)\n` +
        `  let known: Set<String> = [${known}]\n` +
        `  for e in entries.data { if !known.contains(e.name) { __termMismatch(__termPath(path, e.name), "is not in the form") } }\n` +
        `  func find(_ name: String) -> DataForm? { return entries.data.first { $0.name == name }?.base }\n` +
        `  return ${pascal(spec.form)}(${fields})\n}`,
    )
  }

  const meltOf = (kind: FormKind, value: string): string => {
    switch (kind.kind) {
      case 'text':
        return `.text(value: ${value})`
      case 'number':
        return `.number(value: ${value})`
      case 'decimal':
        return `.decimal(value: ${value})`
      case 'flag':
        return `.flag(value: ${value})`
      case 'data':
        return value
      case 'list':
        return `.array(list: SeedList((${value}).data.map { x in ${meltOf(kind.item, 'x')} }))`
      case 'form':
        return `__melt${pascal(kind.spec.form)}(${value})`
      default:
        return '.blank'
    }
  }

  const emptyTest = (kind: FormKind, value: string): string | undefined => {
    switch (kind.kind) {
      case 'text':
        return `(${value}).isEmpty`
      case 'list':
        return `(${value}).data.isEmpty`
      case 'data':
        return `__termIsBlank(${value})`
      default:
        return undefined
    }
  }

  for (const spec of melts.values()) {
    const lines = spec.fields.map(f => {
      const value = `value.${camel(f.name)}`
      const entry = `list.append(DataEntry(name: ${JSON.stringify(f.name)}, base: ${meltOf(f.kind, value)}))`
      const empty = f.optional ? emptyTest(f.kind, value) : undefined

      return empty ? `  if !${empty} { ${entry} }` : `  ${entry}`
    })

    out.push(
      `func __melt${pascal(spec.form)}(_ value: ${pascal(spec.form)}) -> DataForm {\n  var list: [DataEntry] = []\n${lines.join('\n')}\n  return .hash(list: SeedList(list))\n}`,
    )
  }

  return out
}

const SWIFT_FORM_HELPERS = `func __termMismatch(_ path: String, _ reason: String) -> Never {
  fatalError("data-mismatch: Data does not fit the shape: \\(path.isEmpty ? "." : path) \\(reason)")
}
func __termPath(_ path: String, _ key: String) -> String { return path.isEmpty ? key : path + "/" + key }
func __termKind(_ value: DataForm) -> String {
  switch value { case .hash: return "a map"; case .array: return "a list"; case .blank: return "void"; case .text: return "text"; case .number: return "number"; case .decimal: return "decimal"; case .flag: return "flag"; case .graft: return "a fuse" }
}
func __termIsBlank(_ value: DataForm) -> Bool { if case .blank = value { return true }; return false }
func __termEntries(_ value: DataForm, _ path: String) -> SeedList<DataEntry> {
  if case .hash(let list) = value { return list }
  __termMismatch(path, "is \\(__termKind(value)) where a map belongs")
}
func __termText(_ value: DataForm?, _ path: String, _ optional: Bool) -> String {
  switch value { case .some(.text(let value)): return value; case .none, .some(.blank): if optional { return "" }; __termMismatch(path, "is missing"); case .some(let other): __termMismatch(path, "is \\(__termKind(other)) where text belongs") }
}
func __termNumber(_ value: DataForm?, _ path: String, _ optional: Bool) -> Int {
  switch value { case .some(.number(let value)): return value; case .none, .some(.blank): if optional { return 0 }; __termMismatch(path, "is missing"); case .some(let other): __termMismatch(path, "is \\(__termKind(other)) where number belongs") }
}
func __termDecimal(_ value: DataForm?, _ path: String, _ optional: Bool) -> Double {
  switch value { case .some(.decimal(let value)): return value; case .some(.number(let value)): return Double(value); case .none, .some(.blank): if optional { return 0.0 }; __termMismatch(path, "is missing"); case .some(let other): __termMismatch(path, "is \\(__termKind(other)) where decimal belongs") }
}
func __termFlag(_ value: DataForm?, _ path: String, _ optional: Bool) -> Bool {
  switch value { case .some(.flag(let value)): return value; case .none, .some(.blank): if optional { return false }; __termMismatch(path, "is missing"); case .some(let other): __termMismatch(path, "is \\(__termKind(other)) where flag belongs") }
}
func __termData(_ value: DataForm?, _ path: String, _ optional: Bool) -> DataForm {
  if let value = value { return value }
  if optional { return .blank }
  __termMismatch(path, "is missing")
}
func __termList<T>(_ value: DataForm?, _ path: String, _ optional: Bool, _ item: (DataForm, String) -> T) -> SeedList<T> {
  switch value {
  case .some(.array(let list)): return SeedList(list.data.enumerated().map { (i, d) in item(d, __termPath(path, String(i))) })
  case .none, .some(.blank): if optional { return SeedList() }; __termMismatch(path, "is missing")
  case .some(let other): __termMismatch(path, "is \\(__termKind(other)) where a list belongs")
  }
}`
