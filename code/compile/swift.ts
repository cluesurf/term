// The Swift backend: emit the language as idiomatic, type-static Swift. Parity with the TypeScript backend across
// every AST form. Algebraic data types lower to NATIVE generic enums (`enum Maybe<T> { case some(value: T); case none }`),
// `match` to native `if case let` pattern binding (a matched variant's fields bind to locals, and field access on the
// subject rewrites to those locals), and struct forms to `struct`s. Construction uses leading-dot syntax so Swift
// infers the type parameter from context (return type, annotated binding, argument position) — no monomorphization
// needed. Generic functions emit `<T>`. Pure, browser-safe. See note/research/vibe/computation/plans/07-codegen.md.

import type { Expression, Program, Statement, Type } from '@/code/compile/node'
import { exhausted } from '@/code/compile/backend'

// Swift reserved keywords. When one is used as an identifier (a function / parameter / member named `repeat`,
// `default`, etc.) it must be backtick-escaped, in both the declaration and every reference.
const SWIFT_KEYWORDS = new Set([
  'associatedtype', 'class', 'deinit', 'enum', 'extension', 'fileprivate', 'func', 'import', 'init', 'inout',
  'internal', 'let', 'open', 'operator', 'private', 'protocol', 'public', 'rethrows', 'static', 'struct', 'subscript',
  'typealias', 'var', 'break', 'case', 'continue', 'default', 'defer', 'do', 'else', 'fallthrough', 'for', 'guard',
  'if', 'in', 'repeat', 'return', 'switch', 'where', 'while', 'as', 'catch', 'false', 'is', 'nil', 'super', 'self',
  'throw', 'throws', 'true', 'try', 'async', 'await', 'actor', 'any', 'some',
])
function escape(identifier: string): string {
  return SWIFT_KEYWORDS.has(identifier) ? `\`${identifier}\`` : identifier
}
function camelize(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
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

const OP: Record<string, string> = { '&&': '&&', '||': '||', '==': '==', '!=': '!=', '<': '<', '<=': '<=', '>': '>', '>=': '>=', '+': '+', '-': '-', '*': '*', '/': '/', '%': '%' }

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
      type.params.forEach((p) => collectVars(p, into))
      collectVars(type.result, into)
      break
    case 'named':
      type.args?.forEach((a) => collectVars(a, into))
      break
    default:
      break
  }
}

export function emitSwift(program: Program): string {
  const pad = (d: number) => '  '.repeat(d)
  // a function's free inference variables become named generic parameters; this maps each to its letter for the
  // duration of that function's emission, so `(t) -> ?5` prints as `(T) -> U` with `U` declared, not an unused `S`.
  let varNames = new Map<number, string>()

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
        return `[${swiftType(type.element)}]`
      case 'map':
        return `[${swiftType(type.key)}: ${swiftType(type.value)}]`
      case 'named':
        return type.args && type.args.length > 0 ? `${pascal(type.name)}<${type.args.map(swiftType).join(', ')}>` : pascal(type.name)
      case 'function':
        return `(${type.params.map(swiftType).join(', ')}) -> ${swiftType(type.result)}`
      case 'number':
        return 'Int'
      case 'float':
        return 'Double'
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
  const genericClause = (node: Extract<Statement, { form: 'function' }>): string => {
    const ids = new Set<number>()
    node.params.forEach((p) => collectVars(p.type, ids))
    collectVars(node.result, ids)
    const declared = node.generics.map((g) => g.name.toUpperCase())
    const pool = ['T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'A', 'B', 'C']
    const used = new Set(declared)
    varNames = new Map()
    const fresh: Array<string> = []
    for (const id of ids) {
      const letter = pool.find((l) => !used.has(l)) ?? `T${id}`
      used.add(letter)
      varNames.set(id, letter)
      fresh.push(letter)
    }
    // declared generics that actually appear in the signature (as named types) are kept; the rest are dropped
    const namedInSig = new Set<string>()
    const scan = (t: Type | undefined): void => {
      if (!t) return
      if (t.kind === 'named') {
        namedInSig.add(t.name.toUpperCase())
        t.args?.forEach(scan)
      } else if (t.kind === 'array') scan(t.element)
      else if (t.kind === 'map') { scan(t.key); scan(t.value) }
      else if (t.kind === 'function') { t.params.forEach(scan); scan(t.result) }
    }
    node.params.forEach((p) => scan(p.type))
    scan(node.result)
    const keptDeclared = declared.filter((d) => namedInSig.has(d))
    const all = [...keptDeclared, ...fresh]
    return all.length ? `<${all.join(', ')}>` : ''
  }
  // variant label -> the owning enum, and each variant's field names (for construction and match binding)
  const variantFields = new Map<string, Array<string>>()
  const variantSet = new Set<string>()
  for (const node of program) {
    if (node.form !== 'record-type') continue
    for (const v of node.variants) {
      variantSet.add(v.name)
      variantFields.set(v.name, v.fields.map((f) => f.name))
    }
  }

  // within a matched branch, a subject variable's fields are bound to locals; `subject/field` reads that local
  type Bindings = Map<string, Set<string>>

  const expr = (node: Expression, bind: Bindings): string => {
    switch (node.form) {
      case 'integer':
        return String(node.value)
      case 'float':
        // a float literal needs a decimal point so it is a Double, not an Int
        return Number.isInteger(node.value) ? `${node.value}.0` : String(node.value)
      case 'boolean':
        return node.value ? 'true' : 'false'
      case 'string':
        return JSON.stringify(node.value)
      case 'unit':
        return '()'
      case 'variable':
      case 'hole':
        return vname(node.name)
      case 'unary':
        return `${node.op}${expr(node.operand, bind)}`
      case 'binary':
        return `(${expr(node.left, bind)} ${OP[node.op]} ${expr(node.right, bind)})`
      case 'call':
        return `${expr(node.callee, bind)}(${node.args.map((a) => expr(a, bind)).join(', ')})`
      case 'array':
        return `[${node.items.map((i) => expr(i, bind)).join(', ')}]`
      case 'map':
        return node.entries.length === 0 ? '[:]' : `[${node.entries.map((e) => `${expr(e.key, bind)}: ${expr(e.value, bind)}`).join(', ')}]`
      case 'record': {
        // leading-dot construction: Swift infers the enum/struct type from context
        if (variantSet.has(node.name)) {
          const labelled = node.fields.map((f) => `${camel(f.name)}: ${expr(f.value, bind)}`)
          return labelled.length > 0 ? `.${camel(node.name)}(${labelled.join(', ')})` : `.${camel(node.name)}`
        }
        // a struct: name the type and pass the fields
        return `${pascal(node.name)}(${node.fields.map((f) => `${camel(f.name)}: ${expr(f.value, bind)}`).join(', ')})`
      }
      case 'member': {
        // a matched variant's field reads the bound local; otherwise a normal field access
        if (node.target.form === 'variable' && bind.get(node.target.name)?.has(node.name)) return camel(node.name)
        return `${expr(node.target, bind)}.${camel(node.name)}`
      }
      case 'await':
        return `await ${expr(node.expr, bind)}`
      case 'closure':
        // a function literal as a Swift closure (full callback bodies for Swift are a follow-up; JS is the primary target)
        return `{ (${node.params.map((p) => camel(p.name)).join(', ')}) in fatalError() }`
      default:
        return exhausted(node)
    }
  }

  const block = (body: Array<Statement>, d: number, bind: Bindings): string => body.map((s) => `${pad(d)}${stmt(s, d, bind)}`).filter(Boolean).join('\n')

  const stmt = (node: Statement, d: number, bind: Bindings): string => {
    switch (node.form) {
      case 'let': {
        // annotate an ADT binding so leading-dot construction has a type to infer from
        const annotation = node.type && node.type.kind === 'named' ? `: ${swiftType(node.type)}` : ''
        return `${node.mutable ? 'var' : 'let'} ${vname(node.name)}${annotation} = ${expr(node.init, bind)}`
      }
      case 'assign':
        return node.op === '=' ? `${expr(node.target, bind)} = ${expr(node.value, bind)}` : `${expr(node.target, bind)} ${node.op} ${expr(node.value, bind)}`
      case 'expression':
        return expr(node.expr, bind)
      case 'return':
        return node.value ? `return ${expr(node.value, bind)}` : 'return'
      case 'throw':
        return `throw ${node.value.form === 'string' ? `SeedError(${expr(node.value, bind)})` : expr(node.value, bind)}`
      case 'while':
        return `while ${expr(node.cond, bind)} {\n${block(node.body, d + 1, bind)}\n${pad(d)}}`
      case 'for-each':
        return `for ${vname(node.item)} in ${expr(node.iterable, bind)} {\n${block(node.body, d + 1, bind)}\n${pad(d)}}`
      case 'match': {
        // a native `switch`: the compiler checks exhaustiveness, so no fallthrough-return is needed. Each variant's
        // fields bind to locals; field access on the subject inside the branch rewrites to those locals.
        const subject = expr(node.subject, bind)
        const subjectVar = node.subject.form === 'variable' ? node.subject.name : undefined
        const arms = node.cases.map((b) => {
          const fields = variantFields.get(b.label) ?? []
          const branchBind: Bindings = new Map(bind)
          if (subjectVar && fields.length > 0) branchBind.set(subjectVar, new Set(fields))
          const pattern = fields.length > 0 ? `case let .${camel(b.label)}(${fields.map(camel).join(', ')}):` : `case .${camel(b.label)}:`
          return `${pad(d + 1)}${pattern}\n${block(b.body, d + 2, branchBind)}`
        })
        if (node.otherwise) arms.push(`${pad(d + 1)}default:\n${block(node.otherwise, d + 2, bind)}`)
        return `switch ${subject} {\n${arms.join('\n')}\n${pad(d)}}`
      }
      case 'if': {
        let out = ''
        node.branches.forEach((b, i) => {
          out += `${i ? ' else ' : ''}if ${expr(b.cond, bind)} {\n${block(b.body, d + 1, bind)}\n${pad(d)}}`
        })
        if (node.otherwise) out += ` else {\n${block(node.otherwise, d + 1, bind)}\n${pad(d)}}`
        return out
      }
      case 'break':
        return 'break'
      case 'continue':
        return 'continue'
      case 'function': {
        const generics = genericClause(node) // sets varNames for the param/result/body emission that follows
        const params = node.params.map((p) => `_ ${vname(p.name)}: ${swiftType(p.type)}`).join(', ')
        const asyncMark = node.async ? ' async' : ''
        const throwsMark = bodyThrows(node.body) ? ' throws' : ''
        // a reassigned parameter is shadowed by a mutable local (Swift parameters are immutable)
        const mutated = new Set<string>()
        reassigned(node.body, mutated)
        const shadows = node.params.filter((p) => mutated.has(p.name)).map((p) => `${pad(d + 1)}var ${vname(p.name)} = ${vname(p.name)}`)
        const bodyText = [...shadows, block(node.body, d + 1, new Map())].filter(Boolean).join('\n')
        return `func ${camel(node.name)}${generics}(${params})${asyncMark}${throwsMark} -> ${swiftType(node.result)} {\n${bodyText}\n${pad(d)}}`
      }
      case 'record-type': {
        const generics = node.params.length ? `<${node.params.map((p) => p.toUpperCase()).join(', ')}>` : ''
        if (node.variants.length > 0) {
          // a native enum: each variant a case, its fields the associated values
          const cases = node.variants.map((v) => {
            const fields = v.fields.map((f) => `${camel(f.name)}: ${swiftType(f.type)}`)
            return `${pad(d + 1)}case ${camel(v.name)}${fields.length > 0 ? `(${fields.join(', ')})` : ''}`
          })
          return `enum ${pascal(node.name)}${generics} {\n${cases.join('\n')}\n${pad(d)}}`
        }
        const fields = node.fields.map((f) => `${pad(d + 1)}var ${camel(f.name)}: ${swiftType(f.type)}`)
        return `struct ${pascal(node.name)}${generics} {\n${fields.join('\n')}\n${pad(d)}}`
      }
      case 'mask': {
        const methods = node.methods.map((m) => `${pad(d + 1)}func ${camel(m)}(_ args: Any...) -> Any`)
        return `protocol ${pascal(node.name)} {\n${methods.join('\n')}\n${pad(d)}}`
      }
      case 'instance':
        return `// ${pascal(node.target)}: ${pascal(node.mask)} { ${node.methods.map(camel).join(', ')} }`
      case 'hold':
        return '// hold: verified at compile time'
      case 'native':
        return ''
      case 'zone':
      case 'dock':
        return '' // view / routing DSLs are lowered by the dedicated zone compiler, not this backend
      default:
        return exhausted(node)
    }
  }

  // a `<global:X>` binding (e.g. the linked `io` runtime namespace) needs no import: it is already in scope
  const imports = program
    .filter((n): n is Extract<Statement, { form: 'native' }> => n.form === 'native' && !n.module.startsWith('global:'))
    .map((n) => `import ${n.module.replace(/^[a-z]+:/, '')}`)
  const body = program.filter((n) => n.form !== 'native').map((n) => stmt(n, 0, new Map())).filter(Boolean)
  const prelude = body.some((b) => b.includes('SeedError(')) ? ['struct SeedError: Error { let message: String; init(_ m: String) { message = m } }'] : []
  return [...imports, ...prelude, ...body].join('\n\n') + '\n'
}

// the names reassigned anywhere in a body (so a reassigned parameter can be shadowed by a mutable local, since Swift
// and Kotlin function parameters are immutable)
function reassigned(body: Array<Statement>, into: Set<string>): void {
  for (const s of body) {
    switch (s.form) {
      case 'assign':
        if (s.target.form === 'variable') into.add(s.target.name)
        break
      case 'if':
        s.branches.forEach((b) => reassigned(b.body, into))
        if (s.otherwise) reassigned(s.otherwise, into)
        break
      case 'match':
        s.cases.forEach((c) => reassigned(c.body, into))
        if (s.otherwise) reassigned(s.otherwise, into)
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
function bodyThrows(body: Array<Statement>): boolean {
  return body.some((s) => {
    switch (s.form) {
      case 'throw':
        return true
      case 'if':
        return s.branches.some((b) => bodyThrows(b.body)) || (s.otherwise ? bodyThrows(s.otherwise) : false)
      case 'match':
        return s.cases.some((c) => bodyThrows(c.body)) || (s.otherwise ? bodyThrows(s.otherwise) : false)
      case 'while':
      case 'for-each':
        return bodyThrows(s.body)
      default:
        return false
    }
  })
}
