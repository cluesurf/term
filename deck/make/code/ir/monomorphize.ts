// Monomorphization: specialize each generic function at the concrete types it is called with, then drop the
// generic originals. The monomorphic targets (WGSL on the GPU, HVM) have no type parameters, so every call must resolve
// to a concrete function. The instantiation is read off the (now fully resolved) argument types. The TypeScript, Rust,
// Swift, and Kotlin backends keep generics natively, so this pass is optional and runs only ahead of the monomorphic
// backends. See
// note/research/vibe/computation/plans/05-ir.md. Pure and browser-safe.

import type {
  Expression,
  Program,
  Statement,
  Type,
} from '@cluesurf/make/code/compile/node'

type Fn = Extract<Statement, { form: 'function' }>

// bind generic names by matching a declared (possibly generic) type against a concrete one
function matchType(
  declared: Type | undefined,
  actual: Type | undefined,
  generics: Set<string>,
  subst: Map<string, Type>,
): void {
  if (!declared || !actual) {
    return
  }

  if (declared.kind === 'named' && generics.has(declared.name)) {
    subst.set(declared.name, actual)

    return
  }

  if (declared.kind === 'array' && actual.kind === 'array') {
    matchType(declared.element, actual.element, generics, subst)
  } else if (declared.kind === 'map' && actual.kind === 'map') {
    matchType(declared.key, actual.key, generics, subst)
    matchType(declared.value, actual.value, generics, subst)
  } else if (
    declared.kind === 'function' &&
    actual.kind === 'function'
  ) {
    declared.params.forEach((p, i) =>
      matchType(p, actual.params[i], generics, subst),
    )
    matchType(declared.result, actual.result, generics, subst)
  }
}

// replace generic names in a type with their concrete bindings
function substituteType(
  type: Type | undefined,
  subst: Map<string, Type>,
): Type | undefined {
  if (!type) {
    return type
  }

  switch (type.kind) {
    case 'named':
      return subst.get(type.name) ?? type
    case 'array':
      return {
        kind: 'array',
        element: substituteType(type.element, subst)!,
      }
    case 'map':
      return {
        kind: 'map',
        key: substituteType(type.key, subst)!,
        value: substituteType(type.value, subst)!,
      }
    case 'function':
      return {
        kind: 'function',
        params: type.params.map(p => substituteType(p, subst)!),
        result: substituteType(type.result, subst)!,
        effects: type.effects,
      }
    default:
      return type
  }
}

function typeKey(type: Type | undefined): string {
  if (!type) {
    return 'unknown'
  }

  switch (type.kind) {
    case 'named':
      return type.name
    case 'array':
      return `array_${typeKey(type.element)}`
    case 'map':
      return `map_${typeKey(type.key)}_${typeKey(type.value)}`
    case 'function':
      return `fn_${type.params.map(typeKey).join('_')}_to_${typeKey(
        type.result,
      )}`
    default:
      return type.kind
  }
}

// visit every call expression in a body, in place
function visitCalls(
  body: Statement[],
  onCall: (node: Extract<Expression, { form: 'call' }>) => void,
): void {
  const expr = (node: Expression): void => {
    switch (node.form) {
      case 'call':
        onCall(node)
        expr(node.callee)
        node.args.forEach(expr)
        break
      case 'binary':
        expr(node.left)
        expr(node.right)
        break
      case 'unary':
        expr(node.operand)
        break
      case 'member':
        expr(node.target)
        break
      case 'await':
        expr(node.expr)
        break
      case 'array':
        node.items.forEach(expr)
        break
      case 'map':
        node.entries.forEach(e => {
          expr(e.key)
          expr(e.value)
        })
        break
      case 'record':
        node.fields.forEach(f => expr(f.value))
        break
      case 'conditional':
        node.branches.forEach(b => {
          expr(b.cond)
          expr(b.value)
        })

        if (node.otherwise) {
          expr(node.otherwise)
        }

        break
      default:
        break
    }
  }

  const stmt = (node: Statement): void => {
    switch (node.form) {
      case 'let':
        expr(node.init)
        break
      case 'assign':
        expr(node.target)
        expr(node.value)
        break
      case 'expression':
      case 'hold':
        expr(node.expr)
        break
      case 'return':
        if (node.value) {
          expr(node.value)
        }

        break
      case 'throw':
        expr(node.value)
        break
      case 'while':
        expr(node.cond)
        node.body.forEach(stmt)
        break
      case 'for-each':
        expr(node.iterable)
        node.body.forEach(stmt)
        break
      case 'if':
        node.branches.forEach(b => {
          expr(b.cond)
          b.body.forEach(stmt)
        })
        node.otherwise?.forEach(stmt)
        break
      case 'match':
        expr(node.subject)
        node.cases.forEach(c => c.body.forEach(stmt))
        node.otherwise?.forEach(stmt)
        break
      default:
        break
    }
  }

  body.forEach(stmt)
}

// every expression in a body, for in-place rewrites (type substitution, trait-call resolution)
function visitExpressions(
  body: Statement[],
  onExpr: (node: Expression) => void,
): void {
  const expr = (node: Expression): void => {
    onExpr(node)

    switch (node.form) {
      case 'call':
        expr(node.callee)
        node.args.forEach(expr)
        break
      case 'binary':
        expr(node.left)
        expr(node.right)
        break
      case 'unary':
        expr(node.operand)
        break
      case 'member':
        expr(node.target)
        break
      case 'await':
        expr(node.expr)
        break
      case 'array':
        node.items.forEach(expr)
        break
      case 'map':
        node.entries.forEach(e => {
          expr(e.key)
          expr(e.value)
        })
        break
      case 'record':
        node.fields.forEach(f => expr(f.value))
        break
      case 'conditional':
        node.branches.forEach(b => {
          expr(b.cond)
          expr(b.value)
        })

        if (node.otherwise) {
          expr(node.otherwise)
        }

        break
      case 'closure':
        stmts(node.body)
        break
      default:
        break
    }
  }

  const stmts = (list: Statement[]): void => {
    for (const node of list) {
      switch (node.form) {
        case 'let':
          expr(node.init)
          break
        case 'assign':
          expr(node.target)
          expr(node.value)
          break
        case 'expression':
        case 'hold':
          expr(node.expr)
          break
        case 'return':
          if (node.value) {
            expr(node.value)
          }

          break
        case 'throw':
          expr(node.value)
          break
        case 'while':
          expr(node.cond)
          stmts(node.body)
          break
        case 'for-each':
          expr(node.iterable)
          stmts(node.body)
          break
        case 'if':
          node.branches.forEach(b => {
            expr(b.cond)
            stmts(b.body)
          })

          if (node.otherwise) {
            stmts(node.otherwise)
          }

          break
        case 'match':
          expr(node.subject)
          node.cases.forEach(c => stmts(c.body))

          if (node.otherwise) {
            stmts(node.otherwise)
          }

          break
        default:
          break
      }
    }
  }

  stmts(body)
}

export function monomorphize(program: Program): Program {
  const generics = new Map<string, Fn>()

  for (const statement of program) {
    if (
      statement.form === 'function' &&
      statement.generics.length > 0
    ) {
      generics.set(statement.name, statement)
    }
  }

  // the monomorphic backends have no traits, so a trait-method call must resolve to the concrete instance's function.
  // After specialization every receiver type is concrete, so a `measure(x)` with x: box becomes a call to `box_measure`.
  // Built from the masks + the instance methods (each a `<target>_<method>` function tagged with `method`).
  const maskMethods = new Set<string>()

  for (const statement of program) {
    if (statement.form === 'mask') {
      for (const m of statement.methods) {
        maskMethods.add(m)
      }
    }
  }

  const implFn = new Map<string, string>()

  for (const statement of program) {
    if (statement.form === 'function' && statement.method) {
      implFn.set(
        `${statement.method.form}:${statement.method.name}`,
        statement.name,
      )
    }
  }

  if (generics.size === 0) {
    if (maskMethods.size > 0) {
      resolveTraitCalls(program)
    }

    return program
  }

  // resolve every concrete trait-method call (receiver type now known) to the instance's implementation function
  function resolveTraitCalls(prog: Program): void {
    for (const statement of prog) {
      if (statement.form !== 'function') {
        continue
      }

      visitExpressions(statement.body, node => {
        if (node.form !== 'call' || node.callee.form !== 'variable') {
          return
        }

        if (!maskMethods.has(node.callee.name)) {
          return
        }

        const receiver = node.args[0]?.type

        if (receiver?.kind !== 'named') {
          return
        }

        const fn = implFn.get(`${receiver.name}:${node.callee.name}`)

        // a fresh callee node, not an in-place rename: an inlined body can share one callee object across several call
        // sites (the inliner aliases nodes), so mutating it would mis-resolve the others to the first one's instance
        if (fn) {
          node.callee = {
            form: 'variable',
            name: fn,
            span: node.callee.span,
          }
        }
      })
    }
  }

  const specials = new Map<string, Fn>() // mangled name -> specialized function

  // rewrite generic calls in a body to their specialized names, creating specializations as needed
  function rewrite(body: Statement[]): void {
    visitCalls(body, node => {
      if (node.callee.form !== 'variable') {
        return
      }

      const fn = generics.get(node.callee.name)

      if (!fn) {
        return
      }

      const genericNames = new Set(fn.generics.map(g => g.name))
      const subst = new Map<string, Type>()
      fn.params.forEach((param, i) =>
        matchType(param.type, node.args[i]?.type, genericNames, subst),
      )

      const mangled = `${fn.name}__${fn.generics
        .map(g => typeKey(subst.get(g.name)))
        .join('__')}`

      if (!specials.has(mangled)) {
        const spec = structuredClone(fn)
        spec.name = mangled
        spec.generics = []
        spec.params = spec.params.map(p => ({
          ...p,
          type: substituteType(p.type, subst),
        }))
        spec.result = substituteType(spec.result, subst)
        // make the body's expression types concrete too, so a trait-method call inside the spec sees the receiver's
        // real type and resolves to its instance function
        visitExpressions(spec.body, e => {
          if (e.type) {
            e.type = substituteType(e.type, subst)
          }
        })
        specials.set(mangled, spec)
        rewrite(spec.body) // a spec may call other generics
      }

      node.callee.name = mangled
    })
  }

  // non-generic functions are kept (with their generic calls rewritten); generic originals are dropped
  const out: Program = []

  for (const statement of program) {
    if (
      statement.form === 'function' &&
      statement.generics.length > 0
    ) {
      continue
    }

    const clone = structuredClone(statement)

    if (clone.form === 'function') {
      rewrite(clone.body)
    }

    out.push(clone)
  }

  for (const spec of specials.values()) {
    out.push(spec)
  }

  // with every function now monomorphic, resolve concrete trait-method calls to their instance implementations
  if (maskMethods.size > 0) {
    resolveTraitCalls(out)
  }

  return out
}
