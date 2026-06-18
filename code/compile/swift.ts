// The Swift backend: emit the functional + imperative fragment as idiomatic Swift. Cross-platform parity with the
// TypeScript backend for functions, arithmetic, control flow, and calls. Generic functions emit `<T>`; for native
// codegen run monomorphization first. See note/research/vibe/computation/plans/07-codegen.md. Pure, browser-safe.

import type { Expression, Program, Statement, Type } from '@/code/compile/node'

function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

function swiftType(type: Type | undefined): string {
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
      return camel(type.name).replace(/^./, (c) => c.toUpperCase())
    case 'function':
      return `(${type.params.map(swiftType).join(', ')}) -> ${swiftType(type.result)}`
    case 'number':
      return 'Int'
    default:
      return 'Int'
  }
}

const OP: Record<string, string> = { '&&': '&&', '||': '||', '==': '==', '!=': '!=', '<': '<', '<=': '<=', '>': '>', '>=': '>=', '+': '+', '-': '-', '*': '*', '/': '/', '%': '%' }

export function emitSwift(program: Program): string {
  const pad = (d: number) => '  '.repeat(d)

  const expr = (node: Expression): string => {
    switch (node.form) {
      case 'integer':
      case 'float':
        return String(node.value)
      case 'boolean':
        return node.value ? 'true' : 'false'
      case 'string':
        return JSON.stringify(node.value)
      case 'unit':
        return '()'
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
        return `[${node.items.map(expr).join(', ')}]`
      case 'await':
        return `await ${expr(node.expr)}`
      case 'member':
        return `${expr(node.target)}.${node.name}`
      default:
        return '()'
    }
  }

  const block = (body: Array<Statement>, d: number): string => body.map((s) => `${pad(d)}${stmt(s, d)}`).join('\n')

  const stmt = (node: Statement, d: number): string => {
    switch (node.form) {
      case 'let':
        return `${node.mutable ? 'var' : 'let'} ${camel(node.name)} = ${expr(node.init)}`
      case 'assign':
        return node.op === '=' ? `${expr(node.target)} = ${expr(node.value)}` : `${expr(node.target)} ${node.op} ${expr(node.value)}`
      case 'expression':
        return expr(node.expr)
      case 'return':
        return node.value ? `return ${expr(node.value)}` : 'return'
      case 'throw':
        return `fatalError(${node.value.form === 'string' ? expr(node.value) : '"error"'})`
      case 'while':
        return `while ${expr(node.cond)} {\n${block(node.body, d + 1)}\n${pad(d)}}`
      case 'for-each':
        return `for ${camel(node.item)} in ${expr(node.iterable)} {\n${block(node.body, d + 1)}\n${pad(d)}}`
      case 'if': {
        let out = ''
        node.branches.forEach((b, i) => {
          out += `${i ? ' else ' : ''}if ${expr(b.cond)} {\n${block(b.body, d + 1)}\n${pad(d)}}`
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
    const generics = s.generics.length ? `<${s.generics.map((g) => g.name.toUpperCase()).join(', ')}>` : ''
    const params = s.params.map((p) => `_ ${camel(p.name)}: ${swiftType(p.type)}`).join(', ')
    const result = swiftType(s.result)
    const asyncMark = s.async ? ' async' : ''
    out.push(`func ${camel(s.name)}${generics}(${params})${asyncMark} -> ${result} {\n${block(s.body, 1)}\n}`)
  }
  return out.join('\n\n') + '\n'
}
