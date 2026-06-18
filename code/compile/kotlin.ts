// The Kotlin backend: emit the functional + imperative fragment as idiomatic Kotlin. Cross-platform parity with
// the TypeScript and Swift backends. Generic functions emit `<T>`; run monomorphization first for monomorphic
// targets. See note/research/vibe/computation/plans/07-codegen.md. Pure, browser-safe.

import type { Expression, Program, Statement, Type } from '@/code/compile/node'

function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
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
      return camel(type.name).replace(/^./, (c) => c.toUpperCase())
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
      case 'await':
        return expr(node.expr)
      case 'member':
        return `${expr(node.target)}.${node.name}`
      default:
        return 'Unit'
    }
  }

  const block = (body: Array<Statement>, d: number): string => body.map((s) => `${pad(d)}${stmt(s, d)}`).join('\n')

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
        return `throw RuntimeException(${node.value.form === 'string' ? expr(node.value) : '"error"'})`
      case 'while':
        return `while (${expr(node.cond)}) {\n${block(node.body, d + 1)}\n${pad(d)}}`
      case 'for-each':
        return `for (${camel(node.item)} in ${expr(node.iterable)}) {\n${block(node.body, d + 1)}\n${pad(d)}}`
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
      default:
        return ''
    }
  }

  const out: Array<string> = []
  for (const s of program) {
    if (s.form !== 'function') continue
    const generics = s.generics.length ? `<${s.generics.map((g) => g.name.toUpperCase()).join(', ')}> ` : ''
    const params = s.params.map((p) => `${camel(p.name)}: ${kotlinType(p.type)}`).join(', ')
    const result = kotlinType(s.result)
    const suspend = s.async ? 'suspend ' : ''
    out.push(`${suspend}fun ${generics}${camel(s.name)}(${params}): ${result} {\n${block(s.body, 1)}\n}`)
  }
  return out.join('\n\n') + '\n'
}
