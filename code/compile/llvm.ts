// The LLVM backend: emit textual LLVM IR for the native (AOT) target. Functions become `define`s; the scalar
// imperative fragment (immutable + mutable locals, reassignment, `if`, `while`) is lowered the way clang -O0 does it:
// every local gets a stack slot (`alloca`), reads `load` and writes `store`, so mutation and loops need no SSA phi
// nodes (mem2reg recovers SSA). The backend is TYPE-AWARE: numbers and booleans are i64 (comparisons compute as i1
// then zero-extend), and strings are pointers (`ptr`) into a small managed runtime (see compile/llvm-runtime.ts) that
// provides allocation, concatenation, comparison, length, and printing. String literals become module-level
// constants. Remaining aggregates (arrays, maps, records, closures) and exceptions still need runtime support and are
// marked SEED-UNSUPPORTED rather than silently miscompiled. Run monomorphization first (generic functions are dropped
// here). Pure, browser-safe. See note/research/vibe/computation/plans/07-codegen.md.

import type { Expression, Program, Statement, Type } from '@/code/compile/node'
import { exhausted, unsupported } from '@/code/compile/backend'

function mangle(name: string): string {
  return name.replace(/-/g, '_')
}

const ARITH: Record<string, string> = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'sdiv', '%': 'srem' }
const PRED: Record<string, string> = { '==': 'eq', '!=': 'ne', '<': 'slt', '<=': 'sle', '>': 'sgt', '>=': 'sge' }

type LlvmType = 'i64' | 'ptr' | 'void'
// the LLVM representation of a checked type: strings are managed pointers, unit is void, everything else is a word
function llty(type: Type | undefined): LlvmType {
  if (type?.kind === 'string') return 'ptr'
  if (type?.kind === 'unit') return 'void'
  return 'i64'
}

// the runtime the emitted IR calls for string operations (declared at the top of every module)
const RUNTIME_DECLS = [
  'declare ptr @seed_str_concat(ptr, ptr)',
  'declare i64 @seed_str_length(ptr)',
  'declare i64 @seed_str_equal(ptr, ptr)',
  'declare void @seed_print_str(ptr)',
  'declare void @seed_print_int(i64)',
]

export function emitLlvm(program: Program): string {
  // module-level string constants, interned by content
  const globals: Array<string> = []
  const interned = new Map<string, string>()
  const internString = (value: string): string => {
    const existing = interned.get(value)
    if (existing) return existing
    const name = `@.str.${interned.size}`
    const bytes = [...Buffer.from(value, 'utf8')]
    const escaped = bytes.map((b) => (b >= 0x20 && b < 0x7f && b !== 0x22 && b !== 0x5c ? String.fromCharCode(b) : `\\${b.toString(16).padStart(2, '0')}`)).join('')
    globals.push(`${name} = private unnamed_addr constant [${bytes.length + 1} x i8] c"${escaped}\\00"`)
    interned.set(value, name)
    return name
  }

  const functions: Array<string> = []
  for (const s of program) {
    if (s.form !== 'function' || s.generics.length > 0) continue // generic functions are removed by monomorphization
    functions.push(emitFunction(s, internString))
  }
  return [...RUNTIME_DECLS, '', ...globals, globals.length ? '' : null, ...functions].filter((l) => l !== null).join('\n') + '\n'
}

function emitFunction(fn: Extract<Statement, { form: 'function' }>, internString: (value: string) => string): string {
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

  // every local lives in a typed stack slot, allocated once in the entry block
  const allocas: Array<string> = []
  const slot = new Map<string, { reg: string; ty: LlvmType }>()
  const ensureSlot = (name: string, ty: LlvmType): { reg: string; ty: LlvmType } => {
    let s = slot.get(name)
    if (!s) {
      s = { reg: `%${mangle(name)}.addr`, ty }
      slot.set(name, s)
      allocas.push(`${s.reg} = alloca ${ty}`)
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
      case 'string':
        return internString(node.value) // a global constant; its address is the string pointer
      case 'unit':
        return '0'
      case 'variable':
      case 'hole': {
        const s = slot.get(node.name)
        if (!s) return '0'
        const t = fresh()
        cur.lines.push(`${t} = load ${s.ty}, ptr ${s.reg}`)
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
        // string operands route to the runtime; numeric operands to native instructions
        if (node.left.type?.kind === 'string') {
          const l = expr(node.left)
          const r = expr(node.right)
          if (node.op === '+') {
            const t = fresh()
            cur.lines.push(`${t} = call ptr @seed_str_concat(ptr ${l}, ptr ${r})`)
            return t
          }
          if (node.op === '==' || node.op === '!=') {
            const e = fresh()
            cur.lines.push(`${e} = call i64 @seed_str_equal(ptr ${l}, ptr ${r})`)
            if (node.op === '==') return e
            const t = fresh()
            cur.lines.push(`${t} = xor i64 ${e}, 1`)
            return t
          }
          cur.lines.push(unsupported('LLVM', `string ${node.op}`, ';'))
          return '0'
        }
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
        // a couple of builtins lower straight to the runtime; everything else is a direct call, args typed by value
        const callee = node.callee.form === 'variable' ? mangle(node.callee.name) : '0'
        if ((callee === 'length' || callee === 'size') && node.args[0]?.type?.kind === 'string') {
          const t = fresh()
          cur.lines.push(`${t} = call i64 @seed_str_length(ptr ${expr(node.args[0]!)})`)
          return t
        }
        const args = node.args.map((a) => `${llty(a.type)} ${expr(a)}`)
        const retType = llty(node.type)
        if (retType === 'void') {
          cur.lines.push(`call void @${callee}(${args.join(', ')})`)
          return '0'
        }
        const t = fresh()
        cur.lines.push(`${t} = call ${retType} @${callee}(${args.join(', ')})`)
        return t
      }
      case 'array':
      case 'map':
      case 'record':
      case 'member':
      case 'await':
      case 'closure':
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
        const ty = llty(node.type ?? node.init.type)
        const s = ensureSlot(node.name, ty)
        const v = expr(node.init)
        cur.lines.push(`store ${ty} ${v}, ptr ${s.reg}`)
        break
      }
      case 'assign': {
        if (node.target.form !== 'variable') {
          cur.lines.push(unsupported('LLVM', 'assign', ';'))
          break
        }
        const ty = llty(node.value.type)
        const s = ensureSlot(node.target.name, ty)
        let v: string
        if (node.op === '=') {
          v = expr(node.value)
        } else if (s.ty === 'ptr' && node.op === '+=') {
          // string append
          const old = fresh()
          cur.lines.push(`${old} = load ptr, ptr ${s.reg}`)
          const rhs = expr(node.value)
          const t = fresh()
          cur.lines.push(`${t} = call ptr @seed_str_concat(ptr ${old}, ptr ${rhs})`)
          v = t
        } else {
          const old = fresh()
          cur.lines.push(`${old} = load i64, ptr ${s.reg}`)
          const rhs = expr(node.value)
          const t = fresh()
          cur.lines.push(`${t} = ${ARITH[node.op[0]!]} i64 ${old}, ${rhs}`)
          v = t
        }
        cur.lines.push(`store ${s.ty} ${v}, ptr ${s.reg}`)
        break
      }
      case 'return':
        if (!node.value) {
          cur.lines.push('ret void')
        } else {
          const ty = llty(node.value.type)
          cur.lines.push(`ret ${ty} ${expr(node.value)}`)
        }
        cur.done = true
        break
      case 'expression':
        expr(node.expr)
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
      case 'zone':
      case 'dock':
        break // view / routing DSLs are lowered by the dedicated zone compiler, not this backend
      default:
        exhausted(node)
    }
  }

  // parameters: spill each incoming SSA argument into its (typed) stack slot at entry
  for (const p of fn.params) {
    const ty = llty(p.type)
    const s = ensureSlot(p.name, ty)
    cur.lines.push(`store ${ty} %${mangle(p.name)}, ptr ${s.reg}`)
  }
  fn.body.forEach(stmt)
  if (!cur.done) cur.lines.push(llty(fn.result) === 'void' ? 'ret void' : 'ret i64 0')

  blocks[0]!.lines = [...allocas, ...blocks[0]!.lines]
  const params = fn.params.map((p) => `${llty(p.type)} %${mangle(p.name)}`).join(', ')
  const retType = llty(fn.result)
  const body = blocks.map((b) => `${b.name}:\n${b.lines.map((l) => `  ${l}`).join('\n')}`).join('\n')
  return `define ${retType} @${mangle(fn.name)}(${params}) {\n${body}\n}`
}
