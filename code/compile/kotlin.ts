// The Kotlin backend: emit the language as Kotlin. Parity with the TypeScript and Swift backends across every AST
// form: functions, arithmetic, control flow, calls, algebraic data types, pattern match, maps, traits, throwing, and
// native imports. Algebraic types use a tagged-record model (a `form` discriminant plus stored fields) for
// cross-backend parity with the structural object model the TypeScript backend uses, so `match` and field access
// lower uniformly. A typed lowering via monomorphization is a future refinement. Pure, browser-safe.

import type { Expression, Program, Statement, Type } from '@/code/compile/node'
import { exhausted } from '@/code/compile/backend'

function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}
function pascal(name: string): string {
  const c = camel(name)
  return c.charAt(0).toUpperCase() + c.slice(1)
}

function kotlinType(type: Type | undefined): string {
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
      return pascal(type.name)
    case 'function':
      return `(${type.params.map(kotlinType).join(', ')}) -> ${kotlinType(type.result)}`
    case 'number':
      return 'Long'
    default:
      return 'Long'
  }
}

const OP: Record<string, string> = { '&&': '&&', '||': '||', '==': '==', '!=': '!=', '<': '<', '<=': '<=', '>': '>', '>=': '>=', '+': '+', '-': '-', '*': '*', '/': '/', '%': '%' }

export function emitKotlin(program: Program): string {
  const pad = (d: number) => '    '.repeat(d)
  const variantType = new Map<string, string>()
  for (const node of program) if (node.form === 'record-type') for (const v of node.variants) variantType.set(v.name, node.name)

  const expr = (node: Expression): string => {
    switch (node.form) {
      case 'integer':
        return `${node.value}L`
      case 'float':
        return String(node.value)
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
      case 'call':
        return `${expr(node.callee)}(${node.args.map(expr).join(', ')})`
      case 'array':
        return `listOf(${node.items.map(expr).join(', ')})`
      case 'map':
        return `mapOf(${node.entries.map((e) => `${expr(e.key)} to ${expr(e.value)}`).join(', ')})`
      case 'record': {
        const owner = variantType.get(node.name) ?? node.name
        const fields = [`form = ${JSON.stringify(node.name)}`, ...node.fields.map((f) => `${camel(f.name)} = ${expr(f.value)}`)]
        return `${pascal(owner)}(${fields.join(', ')})`
      }
      case 'member':
        return `${expr(node.target)}.${camel(node.name)}`
      case 'await':
        return expr(node.expr) // suspend functions await implicitly
      default:
        return exhausted(node)
    }
  }

  const block = (body: Array<Statement>, d: number): string => body.map((s) => `${pad(d)}${stmt(s, d)}`).filter(Boolean).join('\n')

  const stmt = (node: Statement, d: number): string => {
    switch (node.form) {
      case 'let':
        return `${node.mutable ? 'var' : 'val'} ${camel(node.name)} = ${expr(node.init)}`
      case 'assign':
        return node.op === '=' ? `${expr(node.target)} = ${expr(node.value)}` : `${expr(node.target)} ${node.op} ${expr(node.value)}`
      case 'expression':
        return expr(node.expr)
      case 'return':
        return node.value ? `return ${expr(node.value)}` : 'return'
      case 'throw':
        return `throw SeedError(${node.value.form === 'string' ? expr(node.value) : `(${expr(node.value)}).toString()`})`
      case 'while':
        return `while (${expr(node.cond)}) {\n${block(node.body, d + 1)}\n${pad(d)}}`
      case 'for-each':
        return `for (${camel(node.item)} in ${expr(node.iterable)}) {\n${block(node.body, d + 1)}\n${pad(d)}}`
      case 'match': {
        const subject = expr(node.subject)
        let out = ''
        node.cases.forEach((b, i) => {
          out += `${i ? ' else ' : ''}if (${subject}.form == ${JSON.stringify(b.label)}) {\n${block(b.body, d + 1)}\n${pad(d)}}`
        })
        if (node.otherwise) out += ` else {\n${block(node.otherwise, d + 1)}\n${pad(d)}}`
        return out
      }
      case 'if': {
        let out = ''
        node.branches.forEach((b, i) => {
          out += `${i ? ' else ' : ''}if (${expr(b.cond)}) {\n${block(b.body, d + 1)}\n${pad(d)}}`
        })
        if (node.otherwise) out += ` else {\n${block(node.otherwise, d + 1)}\n${pad(d)}}`
        return out
      }
      case 'break':
        return 'break'
      case 'continue':
        return 'continue'
      case 'function': {
        const generics = node.generics.length ? `<${node.generics.map((g) => g.name.toUpperCase()).join(', ')}> ` : ''
        const params = node.params.map((p) => `${camel(p.name)}: ${kotlinType(p.type)}`).join(', ')
        const suspend = node.async ? 'suspend ' : ''
        return `${suspend}fun ${generics}${camel(node.name)}(${params}): ${kotlinType(node.result)} {\n${block(node.body, d + 1)}\n${pad(d)}}`
      }
      case 'record-type': {
        const fields = new Map<string, string>()
        for (const f of node.fields) fields.set(camel(f.name), 'Any?')
        for (const v of node.variants) for (const f of v.fields) fields.set(camel(f.name), 'Any?')
        const params = ['var form: String', ...[...fields.keys()].map((name) => `var ${name}: Any? = null`)]
        return `data class ${pascal(node.name)}(${params.join(', ')})`
      }
      case 'mask': {
        const methods = node.methods.map((m) => `${pad(d + 1)}fun ${camel(m)}(vararg args: Any?): Any?`)
        return `interface ${pascal(node.name)} {\n${methods.join('\n')}\n${pad(d)}}`
      }
      case 'instance':
        return `// ${pascal(node.target)} : ${pascal(node.mask)} { ${node.methods.map(camel).join(', ')} }`
      case 'hold':
        return '// hold: verified at compile time'
      case 'native':
        return ''
      default:
        return exhausted(node)
    }
  }

  const imports = program.filter((n): n is Extract<Statement, { form: 'native' }> => n.form === 'native').map((n) => `import ${n.module.replace(/^[a-z]+:/, '').replace(/\//g, '.')}`)
  const body = program.filter((n) => n.form !== 'native').map((n) => stmt(n, 0)).filter(Boolean)
  const prelude = body.some((b) => b.includes('SeedError(')) ? ['class SeedError(message: String) : RuntimeException(message)'] : []
  return [...imports, ...prelude, ...body].join('\n\n') + '\n'
}
