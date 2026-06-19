// The LLVM backend: emit textual LLVM IR for the native (AOT) target. Functions become `define`s; the full scalar
// imperative fragment is supported: immutable and mutable locals, reassignment, `if`, and `while`, all lowered the
// way clang -O0 does it. Every local (parameter, `let`, or reassigned name) gets a stack slot (`alloca`); reads
// `load` and writes `store`, so mutation and loops need no SSA phi nodes (mem2reg recovers SSA later). Values are
// uniformly i64: comparisons and booleans are computed as i1 then zero-extended, so a slot never mixes widths.
// Aggregates, strings, closures, records, and exceptions need a managed runtime and are marked SEED-UNSUPPORTED
// rather than silently miscompiled. Run monomorphization first (generic functions are dropped here). Pure,
// browser-safe. See note/research/vibe/computation/plans/07-codegen.md.

import type { Expression, Program, Statement } from '@/code/compile/node'
import { exhausted, unsupported } from '@/code/compile/backend'

function mangle(name: string): string {
  return name.replace(/-/g, '_')
}

const ARITH: Record<string, string> = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'sdiv', '%': 'srem' }
const PRED: Record<string, string> = { '==': 'eq', '!=': 'ne', '<': 'slt', '<=': 'sle', '>': 'sgt', '>=': 'sge' }

export function emitLlvm(program: Program): string {
  const out: Array<string> = []
  for (const s of program) {
    if (s.form !== 'function' || s.generics.length > 0) continue // generic functions are removed by monomorphization
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

  // every local (parameter, `let`, reassigned name) lives in a stack slot, allocated once in the entry block
  const allocas: Array<string> = []
  const slot = new Map<string, string>()
  const ensureSlot = (name: string): string => {
    let s = slot.get(name)
    if (!s) {
      s = `%${mangle(name)}.addr`
      slot.set(name, s)
      allocas.push(`${s} = alloca i64`)
    }
    return s
  }

  const expr = (node: Expression): string => {
    switch (node.form) {
      case 'integer':
      case 'float':
        return String(node.value)
      case 'boolean':
        return node.value ? '1' : '0'
      case 'variable':
      case 'hole': {
        const s = slot.get(node.name)
        if (!s) return '0' // an unbound name: a poison value (resolver would already have flagged it)
        const t = fresh()
        cur.lines.push(`${t} = load i64, ptr ${s}`)
        return t
      }
      case 'unary': {
        const v = expr(node.operand)
        const t = fresh()
        if (node.op === '-') {
          cur.lines.push(`${t} = sub i64 0, ${v}`)
        } else {
          const c = fresh()
          cur.lines.push(`${c} = icmp eq i64 ${v}, 0`)
          cur.lines.push(`${t} = zext i1 ${c} to i64`)
        }
        return t
      }
      case 'binary': {
        const l = expr(node.left)
        const r = expr(node.right)
        const t = fresh()
        if (ARITH[node.op]) {
          cur.lines.push(`${t} = ${ARITH[node.op]} i64 ${l}, ${r}`)
          return t
        }
        if (PRED[node.op]) {
          const c = fresh()
          cur.lines.push(`${c} = icmp ${PRED[node.op]} i64 ${l}, ${r}`)
          cur.lines.push(`${t} = zext i1 ${c} to i64`)
          return t
        }
        // && / || : non-zero is truth; compute on i1 then widen back to i64
        const la = fresh()
        const ra = fresh()
        const c = fresh()
        cur.lines.push(`${la} = icmp ne i64 ${l}, 0`)
        cur.lines.push(`${ra} = icmp ne i64 ${r}, 0`)
        cur.lines.push(`${c} = ${node.op === '&&' ? 'and' : 'or'} i1 ${la}, ${ra}`)
        cur.lines.push(`${t} = zext i1 ${c} to i64`)
        return t
      }
      case 'call': {
        const args = node.args.map((a) => `i64 ${expr(a)}`)
        const t = fresh()
        const callee = node.callee.form === 'variable' ? mangle(node.callee.name) : '0'
        cur.lines.push(`${t} = call i64 @${callee}(${args.join(', ')})`)
        return t
      }
      case 'string':
      case 'unit':
      case 'array':
      case 'map':
      case 'record':
      case 'member':
      case 'await':
        cur.lines.push(unsupported('LLVM', node.form, ';'))
        return '0'
      default:
        return exhausted(node)
    }
  }

  // an expression used as a branch condition, reduced to an i1 (non-zero is true)
  const condition = (node: Expression): string => {
    const v = expr(node)
    const c = fresh()
    cur.lines.push(`${c} = icmp ne i64 ${v}, 0`)
    return c
  }

  const stmt = (node: Statement): void => {
    if (cur.done) cur = block(freshLabel('dead'))
    switch (node.form) {
      case 'let': {
        const s = ensureSlot(node.name)
        const v = expr(node.init)
        cur.lines.push(`store i64 ${v}, ptr ${s}`)
        break
      }
      case 'assign': {
        if (node.target.form !== 'variable') {
          cur.lines.push(unsupported('LLVM', 'assign', ';'))
          break
        }
        const s = ensureSlot(node.target.name)
        let v: string
        if (node.op === '=') {
          v = expr(node.value)
        } else {
          const old = fresh()
          cur.lines.push(`${old} = load i64, ptr ${s}`)
          const rhs = expr(node.value)
          const t = fresh()
          cur.lines.push(`${t} = ${ARITH[node.op[0]!]} i64 ${old}, ${rhs}`)
          v = t
        }
        cur.lines.push(`store i64 ${v}, ptr ${s}`)
        break
      }
      case 'return':
        cur.lines.push(node.value ? `ret i64 ${expr(node.value)}` : 'ret void')
        cur.done = true
        break
      case 'expression':
        expr(node.expr) // evaluate for its instructions, discard the value
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
          const c = condition(node.branches[i]!.cond)
          const thenL = freshLabel('then')
          const nextL = freshLabel('next')
          cur.lines.push(`br i1 ${c}, label %${thenL}, label %${nextL}`)
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
      case 'while': {
        const condL = freshLabel('while.cond')
        const bodyL = freshLabel('while.body')
        const endL = freshLabel('while.end')
        cur.lines.push(`br label %${condL}`)
        cur.done = true
        cur = block(condL)
        const c = condition(node.cond)
        cur.lines.push(`br i1 ${c}, label %${bodyL}, label %${endL}`)
        cur.done = true
        cur = block(bodyL)
        node.body.forEach(stmt)
        if (!cur.done) cur.lines.push(`br label %${condL}`)
        cur.done = true
        cur = block(endL)
        break
      }
      case 'hold':
        cur.lines.push('; hold: verified at compile time')
        break
      // these need an iterator protocol, the tagged-record runtime, or landing pads: the next IR layer. Marked, not dropped.
      case 'for-each':
      case 'match':
      case 'throw':
      case 'break':
      case 'continue':
      case 'function':
      case 'record-type':
      case 'mask':
      case 'instance':
      case 'native':
        cur.lines.push(unsupported('LLVM', node.form, ';'))
        break
      default:
        exhausted(node)
    }
  }

  // parameters: spill each incoming SSA argument into its stack slot at entry
  for (const p of fn.params) {
    const s = ensureSlot(p.name)
    cur.lines.push(`store i64 %${mangle(p.name)}, ptr ${s}`)
  }
  fn.body.forEach(stmt)
  if (!cur.done) cur.lines.push('ret i64 0')

  // allocas must dominate every use, so they lead the entry block
  blocks[0]!.lines = [...allocas, ...blocks[0]!.lines]
  const params = fn.params.map((p) => `i64 %${mangle(p.name)}`).join(', ')
  const retType = fn.result && fn.result.kind === 'unit' ? 'void' : 'i64'
  const body = blocks.map((b) => `${b.name}:\n${b.lines.map((l) => `  ${l}`).join('\n')}`).join('\n')
  return `define ${retType} @${mangle(fn.name)}(${params}) {\n${body}\n}`
}
