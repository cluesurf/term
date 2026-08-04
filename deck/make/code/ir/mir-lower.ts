// Lower a compiler function body (`Statement[]` / `Expression`) into the Perceus MIR (`code/ir/perceus.ts`), in ANF
// (administrative normal form: every compound expression is named by a `let` temp), and classify each binding as
// heap-owned (reference-counted) or copyable. The MIR is a *liveness model* used only to place dup/drop -- it is never
// executed (the real code is the backend's), so approximations (a loop condition modeled once, an opaque expression as
// a plain value) are fine as long as heap creation and use are captured faithfully.
//
// Heap-owned: string / list (array) / map / record (named) / bytes. Copyable: number / float / boolean / unit. Only
// heap bindings get dup/drop; `perceusControl(params, insts, heap)` consumes the `heap` set this returns.

import type {
  Statement,
  Expression,
  Type,
} from '@term/make/code/compile/node'
import type { Inst } from '@term/make/code/ir/perceus'

function isHeapType(type?: Type): boolean {
  if (!type) {
    return false
  }

  return (
    type.kind === 'string' ||
    type.kind === 'array' ||
    type.kind === 'map' ||
    type.kind === 'named' ||
    type.kind === 'bytes'
  )
}

export type Lowered = { insts: Inst[]; heap: Set<string> }

export function lowerToMir(
  body: Statement[],
  params: { name: string; type?: Type }[] = [],
): Lowered {
  const heap = new Set<string>()

  let counter = 0

  const fresh = (): string => `_t${counter++}`

  const markHeap = (name: string, type?: Type): void => {
    if (isHeapType(type)) {
      heap.add(name)
    }
  }

  // a heap-typed parameter is owned on entry and must be in the RC set
  for (const p of params) {
    markHeap(p.name, p.type)
  }

  // flatten an expression to ANF: push its prefix `let`s into `out`, return the name that holds its value
  function flatten(expr: Expression, out: Inst[]): string {
    switch (expr.form) {
      case 'variable':
        return expr.name

      case 'integer':
      case 'float':
      case 'boolean':
      case 'string':
      case 'null':

      case 'unit': {
        const t = fresh()
        out.push({ op: 'let', name: t, value: { kind: 'lit' } })
        markHeap(t, expr.type) // a string literal is heap; the numeric literals are not

        return t
      }

      case 'call': {
        const fn =
          expr.callee.form === 'variable' ? expr.callee.name : 'call'

        const args = expr.args.map(a => flatten(a, out))
        const t = fresh()
        out.push({
          op: 'let',
          name: t,
          value: { kind: 'call', fn, args },
        })
        markHeap(t, expr.type)

        return t
      }

      case 'binary': {
        const left = flatten(expr.left, out)
        const right = flatten(expr.right, out)
        const t = fresh()
        out.push({
          op: 'let',
          name: t,
          value: { kind: 'call', fn: expr.op, args: [left, right] },
        })
        markHeap(t, expr.type)

        return t
      }

      case 'unary': {
        const operand = flatten(expr.operand, out)
        const t = fresh()
        out.push({
          op: 'let',
          name: t,
          value: { kind: 'call', fn: expr.op, args: [operand] },
        })
        markHeap(t, expr.type)

        return t
      }

      case 'record': {
        const args = expr.fields.map(f => flatten(f.value, out))
        const t = fresh()
        out.push({
          op: 'let',
          name: t,
          value: { kind: 'make', ctor: expr.name, args },
        })
        heap.add(t) // a record is always heap

        return t
      }

      case 'array': {
        const args = expr.items.map(i => flatten(i, out))
        const t = fresh()
        out.push({
          op: 'let',
          name: t,
          value: { kind: 'make', ctor: 'list', args },
        })
        heap.add(t) // a list is always heap

        return t
      }

      case 'member': {
        const target = flatten(expr.target, out)
        const t = fresh()
        out.push({
          op: 'let',
          name: t,
          value: { kind: 'call', fn: 'member', args: [target] },
        })
        markHeap(t, expr.type)

        return t
      }

      case 'await': {
        const inner = flatten(expr.expr, out)
        const t = fresh()
        out.push({
          op: 'let',
          name: t,
          value: { kind: 'call', fn: 'await', args: [inner] },
        })
        markHeap(t, expr.type)

        return t
      }

      default: {
        // map / conditional / closure / slot / hole: model as an opaque value, heap-classified by its type so a
        // heap-producing form is still tracked even though its internal structure is not lowered here
        const t = fresh()
        out.push({ op: 'let', name: t, value: { kind: 'lit' } })
        markHeap(t, expr.type)

        return t
      }
    }
  }

  // lower a list of statements (a block)
  function lowerBlock(stmts: Statement[]): Inst[] {
    const out: Inst[] = []

    for (const s of stmts) {
      switch (s.form) {
        case 'let': {
          const name = flatten(s.init, out)
          // preserve the source binding name; alias it to the flattened value
          out.push({
            op: 'let',
            name: s.name,
            value: { kind: 'var', name },
          })
          markHeap(s.name, s.init.type)
          break
        }

        case 'return': {
          if (s.value) {
            const name = flatten(s.value, out)
            out.push({ op: 'return', name })
          }

          break
        }

        case 'expression':
          flatten(s.expr, out) // evaluated for effect; the result is discarded
          break

        case 'assign': {
          // a reassignment consumes the new value; model it as a binding to the target name
          const name = flatten(s.value, out)

          if (s.target.form === 'variable') {
            out.push({
              op: 'let',
              name: s.target.name,
              value: { kind: 'var', name },
            })
            markHeap(s.target.name, s.value.type)
          }

          break
        }

        case 'if': {
          out.push(lowerIf(s.branches, s.otherwise, out))
          break
        }

        case 'while': {
          // the condition is a copyable boolean; model it once (the MIR is a liveness model, not executed)
          const cond = flatten(s.cond, out)
          out.push({ op: 'while', cond, body: lowerBlock(s.body) })
          break
        }

        case 'match': {
          const subject = flatten(s.subject, out)
          const arms = s.cases.map(c => lowerBlock(c.body))

          if (s.otherwise) {
            arms.push(lowerBlock(s.otherwise))
          }

          out.push({ op: 'match', subject, arms })
          break
        }

        default:
          // throw / hold / break / continue / exit / debug / function: no heap binding to track here
          break
      }
    }

    return out
  }

  // an if/else-if chain lowers to nested two-way ifs. `out` receives the prefix lets for the first condition.
  function lowerIf(
    branches: { cond: Expression; body: Statement[] }[],
    otherwise: Statement[] | undefined,
    out: Inst[],
  ): Inst {
    const [head, ...rest] = branches
    const cond = flatten(head!.cond, out)
    const then = lowerBlock(head!.body)

    let elseInsts: Inst[]

    if (rest.length > 0) {
      const nested: Inst[] = []
      nested.push(lowerIf(rest, otherwise, nested))
      elseInsts = nested
    } else {
      elseInsts = otherwise ? lowerBlock(otherwise) : []
    }

    return { op: 'if', cond, then, else: elseInsts }
  }

  return { insts: lowerBlock(body), heap }
}
