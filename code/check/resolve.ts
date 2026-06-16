// The resolver: bind every name to its definition. Walks the compile AST with a scope stack, attaches a binding
// to each variable, handles forward references to functions, and reports unknown names with a did-you-mean. An
// unresolved name that is not legally runtime-deferred becomes an unknown-name diagnostic. This is the hole-filling
// pass (the part that fills name and import holes). See note/research/vibe/computation/plans/11-elaboration.md.

import type { Diagnostic } from '@/code/parser/diagnostic'
import { diagnose, nearest } from '@/code/parser/diagnostic'
import type { Binding, Expression, Program, Statement } from '@/code/compile/node'

type Scope = Map<string, Binding>

export function resolve(program: Program, file: string): Array<Diagnostic> {
  const diagnostics: Array<Diagnostic> = []

  // global scope: top-level functions, collected first so forward references resolve
  const global: Scope = new Map()
  for (const statement of program) {
    if (statement.form === 'function') {
      global.set(statement.name, { kind: 'function', arity: statement.params.length })
    }
  }

  const stack: Array<Scope> = [global]

  const look = (name: string): Binding | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const found = stack[i]!.get(name)
      if (found) return found
    }
    return undefined
  }

  const known = (): Array<string> => {
    const names = new Set<string>()
    for (const scope of stack) for (const name of scope.keys()) names.add(name)
    return [...names]
  }

  const declare = (name: string, binding: Binding) => {
    stack[stack.length - 1]!.set(name, binding)
  }

  function resolveExpression(node: Expression): void {
    switch (node.form) {
      case 'variable': {
        const binding = look(node.name)
        if (binding) {
          node.binding = binding
        } else {
          const suggestion = nearest(node.name, known())
          diagnostics.push(
            diagnose('unknown-name', {
              file,
              span: node.span,
              message: `the name "${node.name}" is not defined`,
              hint: suggestion ? `did you mean "${suggestion}"?` : undefined,
            }),
          )
        }
        break
      }
      case 'binary':
        resolveExpression(node.left)
        resolveExpression(node.right)
        break
      case 'unary':
        resolveExpression(node.operand)
        break
      case 'call':
        resolveExpression(node.callee)
        for (const arg of node.args) resolveExpression(arg)
        break
      case 'array':
        for (const item of node.items) resolveExpression(item)
        break
      case 'map':
        for (const entry of node.entries) {
          resolveExpression(entry.key)
          resolveExpression(entry.value)
        }
        break
      case 'record':
        for (const field of node.fields) resolveExpression(field.value)
        break
      case 'member':
        resolveExpression(node.target)
        break
      default:
        break
    }
  }

  function resolveBody(body: Array<Statement>): void {
    stack.push(new Map())
    for (const statement of body) resolveStatement(statement)
    stack.pop()
  }

  function resolveStatement(node: Statement): void {
    switch (node.form) {
      case 'let':
        resolveExpression(node.init)
        declare(node.name, { kind: 'local' })
        break
      case 'assign':
        resolveExpression(node.target)
        resolveExpression(node.value)
        break
      case 'expression':
        resolveExpression(node.expr)
        break
      case 'return':
        if (node.value) resolveExpression(node.value)
        break
      case 'while':
        resolveExpression(node.cond)
        resolveBody(node.body)
        break
      case 'if':
        for (const branch of node.branches) {
          resolveExpression(branch.cond)
          resolveBody(branch.body)
        }
        if (node.otherwise) resolveBody(node.otherwise)
        break
      case 'for-each':
        resolveExpression(node.iterable)
        stack.push(new Map())
        declare(node.item, { kind: 'local' })
        for (const statement of node.body) resolveStatement(statement)
        stack.pop()
        break
      case 'break':
      case 'continue':
      case 'record-type':
        break
      case 'function': {
        stack.push(new Map())
        for (const param of node.params) declare(param.name, { kind: 'parameter' })
        for (const statement of node.body) resolveStatement(statement)
        stack.pop()
        break
      }
    }
  }

  for (const statement of program) resolveStatement(statement)

  return diagnostics
}
