// The first IR transformation pass: a mid-level simplifier over the compile AST. Constant folding and algebraic
// identities, so the emitted code is leaner. This is the start of the IR pipeline (see
// note/research/vibe/computation/plans/05-ir.md); more passes (CFG, monomorphization, Perceus reuse) layer on.
// Pure and browser-safe.

import type { Expression, Program, Statement } from '@/code/compile/node'

type Folded = { kind: 'integer'; value: number } | { kind: 'boolean'; value: boolean } | undefined

function foldArithmetic(op: string, a: number, b: number): Folded {
  switch (op) {
    case '+':
      return { kind: 'integer', value: a + b }
    case '-':
      return { kind: 'integer', value: a - b }
    case '*':
      return { kind: 'integer', value: a * b }
    case '/':
      return b === 0 ? undefined : { kind: 'integer', value: Math.trunc(a / b) }
    case '%':
      return b === 0 ? undefined : { kind: 'integer', value: a % b }
    case '==':
      return { kind: 'boolean', value: a === b }
    case '!=':
      return { kind: 'boolean', value: a !== b }
    case '<':
      return { kind: 'boolean', value: a < b }
    case '<=':
      return { kind: 'boolean', value: a <= b }
    case '>':
      return { kind: 'boolean', value: a > b }
    case '>=':
      return { kind: 'boolean', value: a >= b }
    default:
      return undefined
  }
}

function isInteger(node: Expression, value: number): boolean {
  return node.form === 'integer' && Number(node.value) === value
}

function simplifyExpression(node: Expression): Expression {
  switch (node.form) {
    case 'binary': {
      const left = simplifyExpression(node.left)
      const right = simplifyExpression(node.right)

      // constant folding
      if (left.form === 'integer' && right.form === 'integer') {
        const folded = foldArithmetic(node.op, Number(left.value), Number(right.value))
        if (folded) return { ...folded, form: folded.kind, span: node.span } as Expression
      }

      // algebraic identities
      switch (node.op) {
        case '+':
          if (isInteger(right, 0)) return left
          if (isInteger(left, 0)) return right
          break
        case '-':
          if (isInteger(right, 0)) return left
          break
        case '*':
          if (isInteger(right, 1)) return left
          if (isInteger(left, 1)) return right
          if (isInteger(right, 0) || isInteger(left, 0)) return { form: 'integer', value: 0, span: node.span }
          break
        case '/':
          if (isInteger(right, 1)) return left
          break
        default:
          break
      }

      return { ...node, left, right }
    }
    case 'unary':
      return { ...node, operand: simplifyExpression(node.operand) }
    case 'call':
      return { ...node, callee: simplifyExpression(node.callee), args: node.args.map(simplifyExpression) }
    case 'array':
      return { ...node, items: node.items.map(simplifyExpression) }
    case 'member':
      return { ...node, target: simplifyExpression(node.target) }
    case 'record':
      return { ...node, fields: node.fields.map((f) => ({ name: f.name, value: simplifyExpression(f.value) })) }
    case 'map':
      return { ...node, entries: node.entries.map((e) => ({ key: simplifyExpression(e.key), value: simplifyExpression(e.value) })) }
    default:
      return node
  }
}

function simplifyBody(body: Array<Statement>): Array<Statement> {
  return body.map(simplifyStatement)
}

function simplifyStatement(node: Statement): Statement {
  switch (node.form) {
    case 'let':
      return { ...node, init: simplifyExpression(node.init) }
    case 'assign':
      return { ...node, target: simplifyExpression(node.target), value: simplifyExpression(node.value) }
    case 'expression':
      return { ...node, expr: simplifyExpression(node.expr) }
    case 'return':
      return { ...node, value: node.value ? simplifyExpression(node.value) : undefined }
    case 'while':
      return { ...node, cond: simplifyExpression(node.cond), body: simplifyBody(node.body) }
    case 'for-each':
      return { ...node, iterable: simplifyExpression(node.iterable), body: simplifyBody(node.body) }
    case 'if':
      return {
        ...node,
        branches: node.branches.map((b) => ({ cond: simplifyExpression(b.cond), body: simplifyBody(b.body) })),
        otherwise: node.otherwise ? simplifyBody(node.otherwise) : undefined,
      }
    case 'function':
      return { ...node, body: simplifyBody(node.body) }
    default:
      return node
  }
}

// run the simplifier over a whole program
export function simplify(program: Program): Program {
  return program.map(simplifyStatement)
}
