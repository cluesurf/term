// The LLVM backend: emit textual LLVM IR for the native (AOT) target. Functions become `define`s; expressions
// become SSA temporaries; `if` becomes basic blocks wired by `br`; `return` becomes `ret`. The numeric fragment is
// typed i64 (numbers) and i1 (comparisons). Immutable `let` bindings are SSA values; mutation and loops (which need
// `alloca` / phi) are the next layer. Run monomorphization first. See plans/07-codegen.md. Pure, browser-safe.

import type { Expression, Program, Statement } from '@/code/compile/node'

function mangle(name: string): string {
  return name.replace(/-/g, '_')
}

const ARITH: Record<string, string> = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'sdiv', '%': 'srem' }
const PRED: Record<string, string> = { '==': 'eq', '!=': 'ne', '<': 'slt', '<=': 'sle', '>': 'sgt', '>=': 'sge' }

export function emitLlvm(program: Program): string {
  const out: Array<string> = []
  for (const s of program) {
    if (s.form !== 'function' || s.generics.length > 0) continue
    out.push(emitFunction(s))
  }
  return out.join('\n\n') + '\n'
}

function emitFunction(fn: Extract<Statement, { form: 'function' }>): string {
  let temp = 0
  let labelN = 0
  const fresh = () => `%t${temp++}`
  const freshLabel = (base: string) => `${base}${labelN++}`
  const blocks: Array<{ name: string; lines: Array<string>; done: boolean }> = []
  const block = (name: string) => {
    const b = { name, lines: [], done: false } as { name: string; lines: Array<string>; done: boolean }
    blocks.push(b)
    return b
  }
  let cur = block('entry')
  const vars = new Map<string, string>()
  for (const p of fn.params) vars.set(p.name, `%${mangle(p.name)}`)

  const expr = (node: Expression): string => {
    switch (node.form) {
      case 'integer':
      case 'float':
        return String(node.value)
      case 'boolean':
        return node.value ? '1' : '0'
      case 'variable':
      case 'hole':
        return vars.get(node.name) ?? `%${mangle(node.name)}`
      case 'unary': {
        if (node.op === '-') {
          const r = fresh()
          cur.lines.push(`${r} = sub i64 0, ${expr(node.operand)}`)
          return r
        }
        const r = fresh()
        cur.lines.push(`${r} = xor i1 ${expr(node.operand)}, 1`)
        return r
      }
      case 'binary': {
        const l = expr(node.left)
        const r = expr(node.right)
        const t = fresh()
        if (ARITH[node.op]) cur.lines.push(`${t} = ${ARITH[node.op]} i64 ${l}, ${r}`)
        else if (PRED[node.op]) cur.lines.push(`${t} = icmp ${PRED[node.op]} i64 ${l}, ${r}`)
        else cur.lines.push(`${t} = ${node.op === '&&' ? 'and' : 'or'} i1 ${l}, ${r}`)
        return t
      }
      case 'call': {
        const args = node.args.map((a) => `i64 ${expr(a)}`)
        const t = fresh()
        const callee = node.callee.form === 'variable' ? mangle(node.callee.name) : '0'
        cur.lines.push(`${t} = call i64 @${callee}(${args.join(', ')})`)
        return t
      }
      default:
        return '0'
    }
  }

  const stmt = (node: Statement): void => {
    if (cur.done) cur = block(freshLabel('dead'))
    switch (node.form) {
      case 'let':
        vars.set(node.name, expr(node.init))
        break
      case 'return':
        cur.lines.push(node.value ? `ret i64 ${expr(node.value)}` : 'ret void')
        cur.done = true
        break
      case 'if': {
        const merge = freshLabel('merge')
        let fellThrough = false
        const chain = (i: number): void => {
          if (i >= node.branches.length) {
            if (node.otherwise) node.otherwise.forEach(stmt)
            if (!cur.done) {
              cur.lines.push(`br label %${merge}`)
              cur.done = true
              fellThrough = true
            }
            return
          }
          const cond = expr(node.branches[i]!.cond)
          const thenL = freshLabel('then')
          const nextL = freshLabel('next')
          cur.lines.push(`br i1 ${cond}, label %${thenL}, label %${nextL}`)
          cur.done = true
          cur = block(thenL)
          node.branches[i]!.body.forEach(stmt)
          if (!cur.done) {
            cur.lines.push(`br label %${merge}`)
            cur.done = true
            fellThrough = true
          }
          cur = block(nextL)
          chain(i + 1)
        }
        chain(0)
        if (fellThrough) cur = block(merge)
        break
      }
      default:
        break // assign / while / for-each / throw / match need alloca / phi: the next layer
    }
  }

  fn.body.forEach(stmt)
  if (!cur.done) cur.lines.push('ret i64 0')

  const params = fn.params.map((p) => `i64 %${mangle(p.name)}`).join(', ')
  const retType = fn.result && fn.result.kind === 'unit' ? 'void' : 'i64'
  const body = blocks.map((b) => `${b.name}:\n${b.lines.map((l) => `  ${l}`).join('\n')}`).join('\n')
  return `define ${retType} @${mangle(fn.name)}(${params}) {\n${body}\n}`
}
