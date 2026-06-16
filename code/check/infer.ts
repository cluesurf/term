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

  // where each inference variable was first fixed to a concrete type, for blame tracking
  const origin = new Map<number, { span: Span; type: Type }>()

  // unify two types. returns true on success. `unknown` (gradual) is consistent with anything. When a variable is
  // solved to a concrete type and a span is given, remember it (so a later conflict can point back here).
  function unify(a: Type, b: Type, span?: Span): boolean {
    const x = resolve(a)
    const y = resolve(b)
    if (x.kind === 'unknown' || y.kind === 'unknown') return true
    if (x.kind === 'variable') {
      if (y.kind === 'variable' && y.id === x.id) return true
      if (occurs(x.id, y)) return false
      substitution.set(x.id, y)
      if (span && y.kind !== 'variable') origin.set(x.id, { span, type: y })
      return true
    }
    if (y.kind === 'variable') {
      if (occurs(y.id, x)) return false
      substitution.set(y.id, x)
      if (span && x.kind !== 'variable') origin.set(y.id, { span, type: x })
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
    // remember which sides were still inference variables, so we can blame where they were first fixed
    const suspects: Array<number> = []
    if (actual.kind === 'variable') suspects.push(actual.id)
    if (wanted.kind === 'variable') suspects.push(wanted.id)
    if (!unify(actual, wanted, span)) {
      const markers = [{ span }]
      for (const id of suspects) {
        const where = origin.get(id)
        if (where) markers.push({ span: where.span, label: `first used as ${showType(where.type)} here` })
      }
      diagnostics.push(
        diagnose('type-mismatch', {
          file,
          span,
          message: `${what}: expected ${showType(resolve(wanted))}, found ${showType(resolve(actual))}`,
          markers,
        }),
      )
    }
  }

  // a declared type, with generic names mapped to their variables and unknown names left to inference
  function seedType(type: Type | undefined, generics: Map<string, Type>): Type {
    if (!type) return fresh()
    if (type.kind === 'named') {
      const generic = generics.get(type.name)
      if (generic) return generic
      if (records.has(type.name)) return type
      return fresh() // an unrecognized name: infer it from usage rather than forcing a mismatch
    }
    if (type.kind === 'array') return { kind: 'array', element: seedType(type.element, generics) }
    return type
  }

  // function name -> its signature, with the ids of its generic (quantified) variables for per-call instantiation
  const functions = new Map<string, { generics: Set<number>; genericNames: Map<number, string>; params: Array<Type>; result: Type }>()
  for (const statement of program) {
    if (statement.form !== 'function') continue
    const genericVars = new Map<string, Type>()
    const genericIds = new Set<number>()
    const genericNames = new Map<number, string>()
    for (const g of statement.generics) {
      const variable = fresh()
      genericVars.set(g.name, variable)
      if (variable.kind === 'variable') {
        genericIds.add(variable.id)
        genericNames.set(variable.id, g.name)
      }
    }
    functions.set(statement.name, {
      generics: genericIds,
      genericNames,
      params: statement.params.map((p) => seedType(p.type, genericVars)),
      result: seedType(statement.result, genericVars),
    })
  }

  // instantiate a signature, freshening its generic variables (Hindley-Milner let-polymorphism), so a generic
  // function can be called at different types in the same program
  function instantiate(signature: { generics: Set<number>; params: Array<Type>; result: Type }): { params: Array<Type>; result: Type } {
    if (signature.generics.size === 0) return { params: signature.params, result: signature.result }
    const map = new Map<number, Type>()
    for (const id of signature.generics) map.set(id, fresh())
    const subst = (type: Type): Type => {
      const r = resolve(type)
      if (r.kind === 'variable') return map.get(r.id) ?? r
      if (r.kind === 'array') return { kind: 'array', element: subst(r.element) }
      if (r.kind === 'function') return { kind: 'function', params: r.params.map(subst), result: subst(r.result) }
      return r
    }
    return { params: signature.params.map(subst), result: subst(signature.result) }
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
        if (target.kind === 'named' && records.has(target.name)) {
          const field = records.get(target.name)!.get(node.name)
          if (field) {
            type = field
          } else {
            diagnostics.push(diagnose('unknown-name', { file, span: node.span, message: `"${target.name}" has no field "${node.name}"` }))
            type = UNKNOWN
          }
        } else {
          type = UNKNOWN
        }
        break
      }
      case 'call': {
        const args = node.args.map((arg) => inferExpression(arg, env))
        if (node.callee.form === 'variable' && functions.has(node.callee.name)) {
          // instantiate generics fresh for this call (let-polymorphism)
          const signature = instantiate(functions.get(node.callee.name)!)
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
      case 'hold':
        expect(inferExpression(node.expr, env), BOOLEAN, node.span, 'hold condition')
        break
      case 'throw':
        inferExpression(node.value, env) // a throw has no result type (it is bottom)
        break
      case 'break':
      case 'continue':
      case 'record-type':
      case 'mask':
      case 'instance':
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

  const topLevelSkip = new Set(['record-type', 'mask', 'instance'])
  for (const statement of program) {
    if (statement.form === 'function') checkFunction(statement)
    else if (!topLevelSkip.has(statement.form)) checkStatement(statement, new Map(), UNKNOWN)
  }

  // deeply resolve, mapping a function's still-unsolved generic variables back to their declared names (so a
  // generic function emits `<T>(x: T): T` rather than a defaulted concrete type)
  function zonkGeneric(type: Type, names: Map<number, string>): Type {
    const r = resolve(type)
    if (r.kind === 'variable') {
      const name = names.get(r.id)
      return name ? { kind: 'named', name } : r
    }
    if (r.kind === 'array') return { kind: 'array', element: zonkGeneric(r.element, names) }
    if (r.kind === 'function') return { kind: 'function', params: r.params.map((t) => zonkGeneric(t, names)), result: zonkGeneric(r.result, names) }
    return r
  }

  // final pass: record fully resolved types (cross-function constraints from call sites are now known)
  for (const statement of program) {
    if (statement.form === 'function') {
      const signature = functions.get(statement.name)!
      statement.result = zonkGeneric(signature.result, signature.genericNames)
      statement.params.forEach((param, i) => (param.type = zonkGeneric(signature.params[i]!, signature.genericNames)))
    }
  }

  return diagnostics
}
