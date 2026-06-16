// The type checker: gradual, bidirectional inference over the compile AST. Type variables are inference holes,
// solved by unification. `unknown` is the gradual any: consistent with everything, never an error. Concrete
// mismatches are reported with spans. This is the formal type-checking pass that runs after resolution. See
// note/research/vibe/computation/plans/04-typecheck.md and 11-elaboration.md.

import type { Diagnostic, Span } from '@/code/parser/diagnostic'
import { diagnose } from '@/code/parser/diagnostic'
import type { Expression, Program, Statement, Type } from '@/code/compile/node'
import { BOOLEAN, NUMBER, STRING, UNIT, UNKNOWN, showType } from '@/code/compile/node'

export function check(program: Program, file: string): Array<Diagnostic> {
  const diagnostics: Array<Diagnostic> = []
  const substitution = new Map<number, Type>()
  let nextVariable = 0
  const fresh = (): Type => ({ kind: 'variable', id: nextVariable++ })

  // follow variable bindings to the current best type
  function resolve(type: Type): Type {
    let current = type
    while (current.kind === 'variable') {
      const bound = substitution.get(current.id)
      if (!bound) break
      current = bound
    }
    return current
  }

  function occurs(id: number, type: Type): boolean {
    const t = resolve(type)
    if (t.kind === 'variable') return t.id === id
    if (t.kind === 'function') return t.params.some((p) => occurs(id, p)) || occurs(id, t.result)
    if (t.kind === 'array') return occurs(id, t.element)
    return false
  }

  // deeply resolve a type (so array<var> becomes array<concrete> for nice output)
  function zonk(type: Type): Type {
    const t = resolve(type)
    if (t.kind === 'array') return { kind: 'array', element: zonk(t.element) }
    if (t.kind === 'function') return { kind: 'function', params: t.params.map(zonk), result: zonk(t.result) }
    return t
  }

  // record-type field maps, for member-access typing
  const records = new Map<string, Map<string, Type>>()
  for (const statement of program) {
    if (statement.form === 'record-type') {
      const fields = new Map<string, Type>()
      for (const field of statement.fields) fields.set(field.name, field.type)
      records.set(statement.name, fields)
    }
  }

  // unify two types. returns true on success. `unknown` (gradual) is consistent with anything.
  function unify(a: Type, b: Type): boolean {
    const x = resolve(a)
    const y = resolve(b)
    if (x.kind === 'unknown' || y.kind === 'unknown') return true
    if (x.kind === 'variable') {
      if (y.kind === 'variable' && y.id === x.id) return true
      if (occurs(x.id, y)) return false
      substitution.set(x.id, y)
      return true
    }
    if (y.kind === 'variable') {
      if (occurs(y.id, x)) return false
      substitution.set(y.id, x)
      return true
    }
    if (x.kind === 'function' && y.kind === 'function') {
      if (x.params.length !== y.params.length) return false
      for (let i = 0; i < x.params.length; i++) if (!unify(x.params[i]!, y.params[i]!)) return false
      return unify(x.result, y.result)
    }
    if (x.kind === 'array' && y.kind === 'array') return unify(x.element, y.element)
    if (x.kind === 'named' && y.kind === 'named') return x.name === y.name
    return x.kind === y.kind
  }

  function expect(actual: Type, wanted: Type, span: Span, what: string): void {
    if (!unify(actual, wanted)) {
      diagnostics.push(
        diagnose('type-mismatch', {
          file,
          span,
          message: `${what}: expected ${showType(resolve(wanted))}, found ${showType(resolve(actual))}`,
        }),
      )
    }
  }

  // function name -> its type, so calls (including recursion) check against a known signature
  const functions = new Map<string, { params: Array<Type>; result: Type }>()
  for (const statement of program) {
    if (statement.form === 'function') {
      functions.set(statement.name, { params: statement.params.map(() => fresh()), result: fresh() })
    }
  }

  type Env = Map<string, Type>

  function inferExpression(node: Expression, env: Env): Type {
    let type: Type
    switch (node.form) {
      case 'integer':
      case 'float':
        type = NUMBER
        break
      case 'boolean':
        type = BOOLEAN
        break
      case 'string':
        type = STRING
        break
      case 'unit':
        type = UNIT
        break
      case 'hole':
        type = UNKNOWN
        break
      case 'variable':
        type = env.get(node.name) ?? UNKNOWN
        break
      case 'unary':
        if (node.op === '-') {
          expect(inferExpression(node.operand, env), NUMBER, node.span, 'negation operand')
          type = NUMBER
        } else {
          expect(inferExpression(node.operand, env), BOOLEAN, node.span, 'not operand')
          type = BOOLEAN
        }
        break
      case 'binary': {
        const left = inferExpression(node.left, env)
        const right = inferExpression(node.right, env)
        if (node.op === '&&' || node.op === '||') {
          expect(left, BOOLEAN, node.left.span, 'logical operand')
          expect(right, BOOLEAN, node.right.span, 'logical operand')
          type = BOOLEAN
        } else if (node.op === '==' || node.op === '!=') {
          expect(right, left, node.right.span, 'comparison operands')
          type = BOOLEAN
        } else if (node.op === '<' || node.op === '<=' || node.op === '>' || node.op === '>=') {
          expect(left, NUMBER, node.left.span, 'comparison operand')
          expect(right, NUMBER, node.right.span, 'comparison operand')
          type = BOOLEAN
        } else {
          expect(left, NUMBER, node.left.span, 'arithmetic operand')
          expect(right, NUMBER, node.right.span, 'arithmetic operand')
          type = NUMBER
        }
        break
      }
      case 'array': {
        const element = fresh()
        for (const item of node.items) expect(inferExpression(item, env), element, item.span, 'array element')
        type = { kind: 'array', element }
        break
      }
      case 'map':
        for (const entry of node.entries) {
          inferExpression(entry.key, env)
          inferExpression(entry.value, env)
        }
        type = UNKNOWN
        break
      case 'record':
        for (const field of node.fields) inferExpression(field.value, env)
        type = { kind: 'named', name: node.name }
        break
      case 'member': {
        const target = resolve(inferExpression(node.target, env))
        type = target.kind === 'named' && records.has(target.name) ? records.get(target.name)!.get(node.name) ?? UNKNOWN : UNKNOWN
        break
      }
      case 'call': {
        const args = node.args.map((arg) => inferExpression(arg, env))
        if (node.callee.form === 'variable' && functions.has(node.callee.name)) {
          const signature = functions.get(node.callee.name)!
          if (args.length !== signature.params.length) {
            diagnostics.push(
              diagnose('type-mismatch', {
                file,
                span: node.span,
                message: `"${node.callee.name}" expects ${signature.params.length} arguments, found ${args.length}`,
              }),
            )
          } else {
            args.forEach((arg, i) => expect(arg, signature.params[i]!, node.args[i]!.span, 'argument'))
          }
          type = signature.result
        } else {
          inferExpression(node.callee, env)
          type = UNKNOWN
        }
        break
      }
    }
    node.type = type
    return type
  }

  function checkBody(body: Array<Statement>, env: Env, result: Type): void {
    for (const statement of body) checkStatement(statement, env, result)
  }

  function checkStatement(node: Statement, env: Env, result: Type): void {
    switch (node.form) {
      case 'let': {
        const initType = inferExpression(node.init, env)
        env.set(node.name, initType)
        node.type = initType
        break
      }
      case 'assign': {
        const valueType = inferExpression(node.value, env)
        const targetType = inferExpression(node.target, env)
        expect(valueType, targetType, node.span, 'assignment')
        break
      }
      case 'expression':
        inferExpression(node.expr, env)
        break
      case 'return':
        if (node.value) expect(inferExpression(node.value, env), result, node.span, 'return value')
        break
      case 'while':
        expect(inferExpression(node.cond, env), BOOLEAN, node.cond.span, 'loop condition')
        checkBody(node.body, env, result)
        break
      case 'if':
        for (const branch of node.branches) {
          expect(inferExpression(branch.cond, env), BOOLEAN, branch.cond.span, 'branch condition')
          checkBody(branch.body, env, result)
        }
        if (node.otherwise) checkBody(node.otherwise, env, result)
        break
      case 'for-each': {
        const element = fresh()
        expect(inferExpression(node.iterable, env), { kind: 'array', element }, node.iterable.span, 'iterable')
        const inner = new Map(env)
        inner.set(node.item, element)
        checkBody(node.body, inner, result)
        break
      }
      case 'break':
      case 'continue':
      case 'record-type':
        break
      case 'function':
        checkFunction(node)
        break
    }
  }

  function checkFunction(node: Extract<Statement, { form: 'function' }>): void {
    const signature = functions.get(node.name)!
    const env: Env = new Map()
    node.params.forEach((param, i) => env.set(param.name, signature.params[i]!))
    checkBody(node.body, env, signature.result)
  }

  for (const statement of program) {
    if (statement.form === 'function') checkFunction(statement)
    else if (statement.form !== 'record-type') checkStatement(statement, new Map(), UNKNOWN)
  }

  // final pass: record fully resolved types (cross-function constraints from call sites are now known)
  for (const statement of program) {
    if (statement.form === 'function') {
      const signature = functions.get(statement.name)!
      statement.result = zonk(signature.result)
      statement.params.forEach((param, i) => (param.type = zonk(signature.params[i]!)))
    }
  }

  return diagnostics
}
