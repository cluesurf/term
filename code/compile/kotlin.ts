// The Kotlin backend: emit the language as idiomatic, type-static Kotlin. Parity with the TypeScript backend across
// every AST form. Algebraic data types lower to NATIVE sealed-class hierarchies (`sealed class Maybe<out T>` with a
// subclass per variant), `match` to an exhaustive `when (subject) { is MaybeSome -> ... }` whose smart-casts make a
// variant's fields directly accessible (no rewrite needed), and struct forms to `data class`es. A variant subclass
// carries only the generics its own fields use, filling the rest with `Nothing` (valid under `out` variance), so
// construction infers cleanly. Pure, browser-safe. See note/research/vibe/computation/plans/07-codegen.md.

import type {
  Expression,
  Program,
  Statement,
  Type,
} from '@/code/compile/node'
import { exhausted, mapCollect } from '@/code/compile/backend'

function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}
function pascal(name: string): string {
  const c = camel(name)
  return c.charAt(0).toUpperCase() + c.slice(1)
}

// gather the inference-variable ids appearing in a type (each an implicit generic parameter of its function)
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

export function emitKotlin(program: Program): string {
  const pad = (d: number) => '    '.repeat(d)
  // the Kotlin subclass for a variant label, and each variant's field names (for construction / smart-cast access)
  const variantClass = new Map<string, string>()
  const variantFieldNames = new Map<string, Array<string>>()
  for (const node of program) {
    if (node.form !== 'record-type') continue
    for (const v of node.variants) {
      variantClass.set(v.name, `${pascal(node.name)}${pascal(v.name)}`)
      variantFieldNames.set(
        v.name,
        v.fields.map(f => f.name),
      )
    }
  }

  let varNames = new Map<number, string>()

  const kotlinType = (type: Type | undefined): string => {
    switch (type?.kind) {
      case 'boolean':
        return 'Boolean'
      case 'string':
        return 'String'
      case 'unit':
      case undefined:
        return 'Unit'
      case 'array':
        return `List<${kotlinType(type.element)}>`
      case 'map':
        return `Map<${kotlinType(type.key)}, ${kotlinType(type.value)}>`
      case 'named':
        return type.args && type.args.length > 0
          ? `${pascal(type.name)}<${type.args
              .map(kotlinType)
              .join(', ')}>`
          : pascal(type.name)
      case 'function':
        return `(${type.params
          .map(kotlinType)
          .join(', ')}) -> ${kotlinType(type.result)}`
      case 'number':
        return 'Long'
      case 'float':
        return 'Double'
      case 'dynamic':
        return 'Any'
      case 'variable':
        return varNames.get(type.id) ?? 'Long'
      case 'unknown':
        return 'Long'
      default:
        return 'Long'
    }
  }

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
    const fresh: Array<string> = []
    for (const id of ids) {
      const letter = pool.find(l => !used.has(l)) ?? `T${id}`
      used.add(letter)
      varNames.set(id, letter)
      fresh.push(letter)
    }
    const namedInSig = new Set<string>()
    const scan = (t: Type | undefined): void => {
      if (!t) return
      if (t.kind === 'named') {
        namedInSig.add(t.name.toUpperCase())
        t.args?.forEach(scan)
      } else if (t.kind === 'array') scan(t.element)
      else if (t.kind === 'map') {
        scan(t.key)
        scan(t.value)
      } else if (t.kind === 'function') {
        t.params.forEach(scan)
        scan(t.result)
      }
    }
    node.params.forEach(p => scan(p.type))
    scan(node.result)
    const all = [...declared.filter(d => namedInSig.has(d)), ...fresh]
    return all.length ? `<${all.join(', ')}> ` : ''
  }

  const expr = (node: Expression): string => {
    switch (node.form) {
      case 'integer':
        return `${node.value}L`
      case 'float':
        // a float literal needs a decimal point so it is a Double, not a Long
        return Number.isInteger(node.value)
          ? `${node.value}.0`
          : String(node.value)
      case 'boolean':
        return node.value ? 'true' : 'false'
      case 'string':
        return JSON.stringify(node.value)
      case 'unit':
        return 'Unit'
      case 'variable':
      case 'hole':
        return camel(node.name)
      case 'unary':
        return `${node.op}${expr(node.operand)}`
      case 'binary':
        return `(${expr(node.left)} ${OP[node.op]} ${expr(node.right)})`
      case 'call': {
        // keys / values on a Map materialize to a List (the `.keys` / `.values` views are not Lists)
        const collected = mapCollect(node.callee)
        if (collected) {
          return `${expr(collected.target)}.${collected.name}.toList()`
        }

        return `${expr(node.callee)}(${node.args.map(expr).join(', ')})`
      }
      case 'array':
        return `listOf(${node.items.map(expr).join(', ')})`
      case 'map':
        return `mapOf(${node.entries
          .map(e => `${expr(e.key)} to ${expr(e.value)}`)
          .join(', ')})`
      case 'record': {
        const cls = variantClass.get(node.name)
        if (cls) {
          return node.fields.length > 0
            ? `${cls}(${node.fields
                .map(f => `${camel(f.name)} = ${expr(f.value)}`)
                .join(', ')})`
            : cls
        }
        return `${pascal(node.name)}(${node.fields
          .map(f => `${camel(f.name)} = ${expr(f.value)}`)
          .join(', ')})`
      }
      case 'member':
        return `${expr(node.target)}.${camel(node.name)}`
      case 'await':
        return expr(node.expr)
      case 'closure': {
        // a function literal as a Kotlin lambda. A lambda's value is its last expression, so the trailing `send back X`
        // becomes a bare `X` (an explicit `return` inside a lambda would non-locally return from the enclosing function).
        const params = node.params.map(p => camel(p.name)).join(', ')
        const last = node.body[node.body.length - 1]
        const lead = node.body
          .slice(0, -1)
          .map(s => stmt(s, 0))
          .filter(Boolean)
        const tail =
          last && last.form === 'return' && last.value
            ? expr(last.value)
            : last
              ? stmt(last, 0)
              : ''
        return `{ ${params} -> ${[...lead, tail]
          .filter(Boolean)
          .join('; ')} }`
      }
      default:
        return exhausted(node)
    }
  }

  const block = (body: Array<Statement>, d: number): string =>
    body
      .map(s => `${pad(d)}${stmt(s, d)}`)
      .filter(Boolean)
      .join('\n')

  const stmt = (node: Statement, d: number): string => {
    switch (node.form) {
      case 'let':
        return `${node.mutable ? 'var' : 'val'} ${camel(
          node.name,
        )} = ${expr(node.init)}`
      case 'assign':
        return node.op === '='
          ? `${expr(node.target)} = ${expr(node.value)}`
          : `${expr(node.target)} ${node.op} ${expr(node.value)}`
      case 'expression':
        return expr(node.expr)
      case 'return':
        return node.value ? `return ${expr(node.value)}` : 'return'
      case 'throw':
        return `throw SeedError(${
          node.value.form === 'string'
            ? expr(node.value)
            : `(${expr(node.value)}).toString()`
        })`
      case 'while':
        return `while (${expr(node.cond)}) {\n${block(
          node.body,
          d + 1,
        )}\n${pad(d)}}`
      case 'for-each':
        return `for (${camel(node.item)} in ${expr(
          node.iterable,
        )}) {\n${block(node.body, d + 1)}\n${pad(d)}}`
      case 'match': {
        // an exhaustive `when` on the sealed type: each `is` arm smart-casts the subject, so its fields are directly
        // accessible in the body with no rewrite. A return-position match becomes `return when (...)`.
        const subject = expr(node.subject)
        const arms = node.cases.map(b => {
          const cls = variantClass.get(b.label) ?? pascal(b.label)
          return `${pad(d + 1)}is ${cls} -> {\n${block(
            b.body,
            d + 2,
          )}\n${pad(d + 1)}}`
        })
        if (node.otherwise)
          arms.push(
            `${pad(d + 1)}else -> {\n${block(
              node.otherwise,
              d + 2,
            )}\n${pad(d + 1)}}`,
          )
        return `when (${subject}) {\n${arms.join('\n')}\n${pad(d)}}`
      }
      case 'if': {
        let out = ''
        node.branches.forEach((b, i) => {
          out += `${i ? ' else ' : ''}if (${expr(b.cond)}) {\n${block(
            b.body,
            d + 1,
          )}\n${pad(d)}}`
        })
        if (node.otherwise)
          out += ` else {\n${block(node.otherwise, d + 1)}\n${pad(d)}}`
        return out
      }
      case 'break':
        return 'break'
      case 'continue':
        return 'continue'
      case 'function': {
        const generics = genericClause(node)
        const params = node.params
          .map(p => `${camel(p.name)}: ${kotlinType(p.type)}`)
          .join(', ')
        const suspend = node.async ? 'suspend ' : ''
        // a reassigned parameter is shadowed by a mutable local (Kotlin parameters are immutable)
        const mutated = new Set<string>()
        reassigned(node.body, mutated)
        const shadows = node.params
          .filter(p => mutated.has(p.name))
          .map(
            p => `${pad(d + 1)}var ${camel(p.name)} = ${camel(p.name)}`,
          )
        const bodyText = [...shadows, block(node.body, d + 1)]
          .filter(Boolean)
          .join('\n')
        return `${suspend}fun ${generics}${camel(
          node.name,
        )}(${params}): ${kotlinType(node.result)} {\n${bodyText}\n${pad(
          d,
        )}}`
      }
      case 'record-type': {
        if (node.variants.length > 0) {
          const generics = node.params.length
            ? `<${node.params
                .map(p => `out ${p.toUpperCase()}`)
                .join(', ')}>`
            : ''
          const head = `sealed class ${pascal(node.name)}${generics}`
          const subclasses = node.variants.map(v => {
            const cls = `${pascal(node.name)}${pascal(v.name)}`
            // the variant carries only the generics its own fields mention; the rest of the type's params are Nothing
            const usesGeneric = (name: string) =>
              v.fields.some(f => mentions(f.type, name))
            const ownGenerics = node.params.filter(usesGeneric)
            const genericDecl = ownGenerics.length
              ? `<${ownGenerics
                  .map(p => `out ${p.toUpperCase()}`)
                  .join(', ')}>`
              : ''
            const superArgs = node.params.length
              ? `<${node.params
                  .map(p =>
                    usesGeneric(p) ? p.toUpperCase() : 'Nothing',
                  )
                  .join(', ')}>`
              : ''
            if (v.fields.length > 0) {
              const fields = v.fields
                .map(f => `val ${camel(f.name)}: ${kotlinType(f.type)}`)
                .join(', ')
              return `data class ${cls}${genericDecl}(${fields}) : ${pascal(
                node.name,
              )}${superArgs}()`
            }
            const objectSuper = node.params.length
              ? `<${node.params.map(() => 'Nothing').join(', ')}>`
              : ''
            return `object ${cls} : ${pascal(
              node.name,
            )}${objectSuper}()`
          })
          return [`${head}`, ...subclasses].join('\n')
        }
        const fields = node.fields
          .map(f => `val ${camel(f.name)}: ${kotlinType(f.type)}`)
          .join(', ')
        const generics = node.params.length
          ? `<${node.params.map(p => p.toUpperCase()).join(', ')}>`
          : ''
        return `data class ${pascal(node.name)}${generics}(${fields})`
      }
      case 'mask': {
        const methods = node.methods.map(
          m => `${pad(d + 1)}fun ${camel(m)}(vararg args: Any?): Any?`,
        )
        return `interface ${pascal(node.name)} {\n${methods.join(
          '\n',
        )}\n${pad(d)}}`
      }
      case 'instance':
        return `// ${pascal(node.target)} : ${pascal(
          node.mask,
        )} { ${node.methods.map(camel).join(', ')} }`
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

  // a `<global:X>` binding (e.g. the linked `io` runtime object) needs no import: it is already in scope
  const imports = program
    .filter(
      (n): n is Extract<Statement, { form: 'native' }> =>
        n.form === 'native' && !n.module.startsWith('global:'),
    )
    .map(
      n =>
        `import ${n.module
          .replace(/^[a-z]+:/, '')
          .replace(/\//g, '.')}`,
    )
  const body = program
    .filter(n => n.form !== 'native')
    .map(n => stmt(n, 0))
    .filter(Boolean)
  const prelude = body.some(b => b.includes('SeedError('))
    ? ['class SeedError(message: String) : RuntimeException(message)']
    : []
  return [...imports, ...prelude, ...body].join('\n\n') + '\n'
}

// the names reassigned anywhere in a body (Kotlin parameters are immutable, so a reassigned one needs a var shadow)
function reassigned(body: Array<Statement>, into: Set<string>): void {
  for (const s of body) {
    switch (s.form) {
      case 'assign':
        if (s.target.form === 'variable') into.add(s.target.name)
        break
      case 'if':
        s.branches.forEach(b => reassigned(b.body, into))
        if (s.otherwise) reassigned(s.otherwise, into)
        break
      case 'match':
        s.cases.forEach(c => reassigned(c.body, into))
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

// does a type mention a given generic parameter name?
function mentions(type: Type | undefined, name: string): boolean {
  switch (type?.kind) {
    case 'named':
      return (
        type.name === name ||
        (type.args?.some(a => mentions(a, name)) ?? false)
      )
    case 'array':
      return mentions(type.element, name)
    case 'map':
      return mentions(type.key, name) || mentions(type.value, name)
    case 'function':
      return (
        type.params.some(p => mentions(p, name)) ||
        mentions(type.result, name)
      )
    default:
      return false
  }
}
