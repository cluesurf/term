// The GPU backend: emit the numeric functional + imperative fragment as WGSL (the WebGPU shading language). WGSL is
// the data-parallel target: structured, C-like, monomorphic (run monomorphization first), and numeric (no strings,
// no closures). Numbers map to i32, booleans to bool. See note/research/vibe/computation/plans/07-codegen.md.
// Pure, browser-safe.

import type { Expression, Program, Statement, Type } from '@/code/compile/node'

function snake(name: string): string {
  return name.replace(/-/g, '_')
}

function wgslType(type: Type | undefined): string {
  switch (type?.kind) {
    case 'boolean':
      return 'bool'
    case 'array':
      return `array<${wgslType(type.element)}>`
    case 'number':
      return 'i32'
    default:
      return 'i32'
  }
}

const OP: Record<string, string> = { '&&': '&&', '||': '||', '==': '==', '!=': '!=', '<': '<', '<=': '<=', '>': '>', '>=': '>=', '+': '+', '-': '-', '*': '*', '/': '/', '%': '%' }

export function emitWgsl(program: Program): string {
  const pad = (d: number) => '  '.repeat(d)

  const expr = (node: Expression): string => {
    switch (node.form) {
      case 'integer':
        return String(node.value)
      case 'float':
        return String(node.value)
      case 'boolean':
        return node.value ? 'true' : 'false'
      case 'variable':
      case 'hole':
        return snake(node.name)
      case 'unary':
        return `${node.op}${expr(node.operand)}`
      case 'binary':
        return `(${expr(node.left)} ${OP[node.op]} ${expr(node.right)})`
      case 'call':
        return `${expr(node.callee)}(${node.args.map(expr).join(', ')})`
      default:
        return '0' // strings / records / closures are not in the GPU fragment
    }
  }

  const block = (body: Array<Statement>, d: number): string => body.map((s) => `${pad(d)}${stmt(s, d)}`).filter(Boolean).join('\n')

  const stmt = (node: Statement, d: number): string => {
    switch (node.form) {
      case 'let':
        return `${node.mutable ? 'var' : 'let'} ${snake(node.name)} = ${expr(node.init)};`
      case 'assign':
        return node.op === '=' ? `${expr(node.target)} = ${expr(node.value)};` : `${expr(node.target)} ${node.op} ${expr(node.value)};`
      case 'expression':
        return `${expr(node.expr)};`
      case 'return':
        return node.value ? `return ${expr(node.value)};` : 'return;'
      case 'while':
        return `while (${expr(node.cond)}) {\n${block(node.body, d + 1)}\n${pad(d)}}`
      case 'if': {
        let out = ''
        node.branches.forEach((b, i) => {
          out += `${i ? ' else ' : ''}if (${expr(b.cond)}) {\n${block(b.body, d + 1)}\n${pad(d)}}`
        })
        if (node.otherwise) out += ` else {\n${block(node.otherwise, d + 1)}\n${pad(d)}}`
        return out
      }
      case 'break':
        return 'break;'
      case 'continue':
        return 'continue;'
      default:
        return '' // throw / for-each / match: outside the GPU fragment
    }
  }

  const out: Array<string> = []
  for (const s of program) {
    if (s.form !== 'function') continue
    if (s.generics.length > 0) continue // WGSL is monomorphic: run monomorphization first
    const params = s.params.map((p) => `${snake(p.name)}: ${wgslType(p.type)}`).join(', ')
    const result = s.result && s.result.kind !== 'unit' ? ` -> ${wgslType(s.result)}` : ''
    out.push(`fn ${snake(s.name)}(${params})${result} {\n${block(s.body, 1)}\n}`)
  }
  return out.join('\n\n') + '\n'
}
