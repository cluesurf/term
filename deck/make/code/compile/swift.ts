// The Swift backend: emit the language as idiomatic, type-static Swift. Parity with the TypeScript backend across
// every AST form. Algebraic data types lower to NATIVE generic enums (`enum Maybe<T> { case some(value: T); case none }`),
// `match` to native `if case let` pattern binding (a matched variant's fields bind to locals, and field access on the
// subject rewrites to those locals), and struct forms to `struct`s. Construction uses leading-dot syntax so Swift
// infers the type parameter from context (return type, annotated binding, argument position) — no monomorphization
// needed. Generic functions emit `<T>`. Pure, browser-safe. See note/research/vibe/computation/plans/07-codegen.md.

import type {
  Expression,
  Program,
  Statement,
  Type,
} from '@cluesurf/make/code/compile/node'
import {
  ARRAY_OP_BOUND,
  collectionCall,
  collectionRead,
  exhausted,
} from '@cluesurf/make/code/compile/backend'
import type { CollectionOp } from '@cluesurf/make/code/compile/backend'
import {
  collectBinds,
  renderBind,
  bindGap,
  bindImports,
  referencedBinds,
} from '@cluesurf/make/code/compile/bind'

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
function pascal(name: string): string {
  const c = camelize(name)

  return c.charAt(0).toUpperCase() + c.slice(1)
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

export function emitSwift(program: Program): string {
  const pad = (d: number) => '  '.repeat(d)
  // declarative native bindings render their `case swift` template at call sites
  const binds = collectBinds(program)

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
      .map(n => [n.alias, n.module]),
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
        return `SeedMap<${swiftType(type.key)}, ${swiftType(
          type.value,
        )}>`

      case 'named': {
        const opaque = opaqueTypes.get(type.name)

        if (opaque) {
          return opaque
        }

        return type.args && type.args.length > 0
          ? `${pascal(type.name)}<${type.args
              .map(swiftType)
              .join(', ')}>`
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
        return varNames.get(type.id) ?? 'Int' // a free variable not in this function's scope: default to Int
      case 'unknown':
        return 'Int'
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

  const isNativeCall = (node: Expression): boolean => {
    if (node.form !== 'call' || node.callee.form !== 'member') {
      return false
    }

    const root = rootName(node.callee)

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

    return `${protocolMethod0(fn, target, rest)} { return ${camel(
      fn.name,
    )}(${callArgs}) }`
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
      case 'unit':
        return '()'
      case 'null':
        // null in the dynamic currency (`Any`) is Foundation's null object, the JSON-null representation
        return 'NSNull()'
      case 'variable':
      case 'hole':
        return vname(node.name)
      case 'unary':
        return `${node.op}${expr(node.operand, bind)}`
      case 'binary':
        return `(${expr(node.left, bind)} ${OP[node.op]} ${expr(
          node.right,
          bind,
        )})`

      case 'call': {
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

        return `${expr(node.callee, bind)}(${node.args
          .map(a => expr(a, bind))
          .join(', ')})`
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
        // leading-dot construction: Swift infers the enum/struct type from context
        if (variantSet.has(node.name)) {
          const labelled = node.fields.map(
            f => `${camel(f.name)}: ${expr(f.value, bind)}`,
          )

          return labelled.length > 0
            ? `.${camel(node.name)}(${labelled.join(', ')})`
            : `.${camel(node.name)}`
        }

        // a struct: name the type and pass the fields
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
        // a function literal as a Swift closure. The trailing `send back X` becomes the closure's value expression.
        const last = node.body[node.body.length - 1]
        const lead = node.body
          .slice(0, -1)
          .map(s => stmt(s, 0, bind))
          .filter(Boolean)

        const tail =
          last?.form === 'return' && last.value
            ? expr(last.value, bind)
            : last
              ? stmt(last, 0, bind)
              : ''

        // an async closure carries an explicit `(params) async -> Ret in` signature: Swift closures express async in
        // the signature (there is no async-block form), and the explicit types let `let f = { ... }` infer the async
        // function type without a separate annotation. The call site `await`s the result.
        const signature = node.async
          ? `(${node.params
              .map(p => `${camel(p.name)}: ${swiftType(p.type)}`)
              .join(', ')}) async -> ${swiftType(node.result)} in `
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
        return `${data}[${arg[0]}]`
      case 'includes':
        return `${data}.contains(${arg[0]})`
      case 'indexOf':
        return `Int(${data}.firstIndex(of: ${arg[0]}) ?? -1)`
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

  const block = (
    body: Statement[],
    d: number,
    bind: Bindings,
  ): string =>
    body
      .map(s => `${pad(d)}${stmt(s, d, bind)}`)
      .filter(Boolean)
      .join('\n')

  const stmt = (node: Statement, d: number, bind: Bindings): string => {
    switch (node.form) {
      case 'let': {
        // annotate an ADT binding so leading-dot construction has a type to infer from
        const annotation =
          node.type?.kind === 'named' ? `: ${swiftType(node.type)}` : ''

        return `${node.mutable ? 'var' : 'let'} ${vname(
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
      case 'expression':
        return expr(node.expr, bind)
      case 'return':
        if (!node.value) {
          return 'return'
        }

        // a list-returning function that returns a native dock call directly wraps the shim's plain Array
        return fnReturnsArray && isNativeCall(node.value)
          ? `return SeedList(${expr(node.value, bind)})`
          : `return ${expr(node.value, bind)}`
      case 'throw':
        return `throw ${
          node.value.form === 'string'
            ? `SeedError(${expr(node.value, bind)})`
            : expr(node.value, bind)
        }`
      case 'while':
        return `while ${expr(node.cond, bind)} {\n${block(
          node.body,
          d + 1,
          bind,
        )}\n${pad(d)}}`

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
        const subjectVar =
          node.subject.form === 'variable'
            ? node.subject.name
            : undefined

        const arms = node.cases.map(b => {
          const fields = variantFields.get(b.label) ?? []
          const branchBind: Bindings = new Map(bind)

          if (subjectVar && fields.length > 0) {
            branchBind.set(subjectVar, new Set(fields))
          }

          const pattern =
            fields.length > 0
              ? `case let .${camel(b.label)}(${fields
                  .map(camel)
                  .join(', ')}):`
              : `case .${camel(b.label)}:`

          return `${pad(d + 1)}${pattern}\n${block(
            b.body,
            d + 2,
            branchBind,
          )}`
        })

        if (node.otherwise) {
          arms.push(
            `${pad(d + 1)}default:\n${block(
              node.otherwise,
              d + 2,
              bind,
            )}`,
          )
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
        const params = node.params
          .map(p => `_ ${vname(p.name)}: ${swiftType(p.type)}`)
          .join(', ')

        const asyncMark = node.async ? ' async' : ''
        const throwsMark = bodyThrows(node.body) ? ' throws' : ''
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

        const bodyText = [
          ...shadows,
          block(node.body, d + 1, new Map()),
        ]
          .filter(Boolean)
          .join('\n')

        fnReturnsArray = previousReturnsArray

        return `func ${camel(
          node.name,
        )}${generics}(${params})${asyncMark}${throwsMark} -> ${swiftType(
          node.result,
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

          return `enum ${pascal(node.name)}${generics} {\n${cases.join(
            '\n',
          )}\n${pad(d)}}`
        }

        const fields = node.fields.map(
          f =>
            `${pad(d + 1)}var ${camel(f.name)}: ${swiftType(f.type)}`,
        )

        return `struct ${pascal(node.name)}${generics} {\n${fields.join(
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
      case 'zone':
      case 'dock':
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

  const body = program
    .filter(n => n.form !== 'native')
    .map(n => stmt(n, 0, new Map()))
    .filter(Boolean)

  const prelude: string[] = []

  if (body.some(b => b.includes('SeedError('))) {
    prelude.push(
      'struct SeedError: Error { let message: String; init(_ m: String) { message = m } }',
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

  return [...imports, ...prelude, ...body].join('\n\n') + '\n'
}

// the names reassigned anywhere in a body (so a reassigned parameter can be shadowed by a mutable local, since Swift
// and Kotlin function parameters are immutable)
function reassigned(body: Statement[], into: Set<string>): void {
  for (const s of body) {
    switch (s.form) {
      case 'assign':
        if (s.target.form === 'variable') {
          into.add(s.target.name)
        }

        break
      case 'if':
        s.branches.forEach(b => reassigned(b.body, into))

        if (s.otherwise) {
          reassigned(s.otherwise, into)
        }

        break
      case 'match':
        s.cases.forEach(c => reassigned(c.body, into))

        if (s.otherwise) {
          reassigned(s.otherwise, into)
        }

        break
      case 'while':
      case 'for-each':
        reassigned(s.body, into)
        break
      default:
        break
    }
  }
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
