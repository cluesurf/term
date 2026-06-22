// Trait-instance dictionary passing: the lowering that makes generic trait-bounded dispatch real. A generic function
// bounded by a trait (`head t, need sizer`) cannot resolve a trait-method call (`call measure / read x`, x: t) to a
// concrete instance, because the concrete type is only known at the call site. This pass threads the instance as a
// hidden value (the "dictionary"): each bounded function gains one dictionary parameter per bound, every trait-method
// call inside its body becomes a member call through that dictionary, and every call site passes the concrete instance
// (or forwards its own dictionary when the argument is still bound by the same trait). The result is ordinary code --
// records of functions, member calls, extra parameters -- so every backend emits it through machinery it already has,
// with no per-backend trait support. Concrete dispatch (a trait-method call on a known form) is already resolved by
// the checker, so this pass only fires when a program actually has trait-bounded generic functions; otherwise it
// returns the program untouched. See note/research/vibe/computation/plans/05-ir.md and code/check/traits.ts. Pure
// and browser-safe.

import type {
  Expression,
  Program,
  Statement,
  Type,
} from '@cluesurf/make/code/compile/node'

type Fn = Extract<Statement, { form: 'function' }>

// bind generic names by matching a declared (possibly generic) type against a concrete one (same shape rule the
// monomorphizer uses)
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
    if (!subst.has(declared.name)) {
      subst.set(declared.name, actual)
    }

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

// synthetic, kebab so the casing helpers in the emitters render them like any other identifier
const dictConst = (mask: string, target: string): string =>
  `trait-dict-${mask}-${target}`

const dictParam = (generic: string, mask: string): string =>
  `trait-arg-${mask}-${generic}`

export function passDictionaries(program: Program): Program {
  // masks: name -> declared method names
  const masks = new Map<string, string[]>()

  for (const statement of program) {
    if (statement.form === 'mask') {
      masks.set(statement.name, statement.methods)
    }
  }

  if (masks.size === 0) {
    return program
  }

  // the functions this pass exists for: generics carrying a real trait bound. With none, the program is left exactly
  // as it was (the common case: stdlib defines masks and concrete instances but no trait-bounded generics).
  const ordered = (fn: Fn): { name: string; mask: string }[] =>
    fn.generics
      .filter(g => g.need !== undefined && masks.has(g.need))
      .map(g => ({ name: g.name, mask: g.need! }))

  const bounded = program.filter(
    (s): s is Fn => s.form === 'function' && ordered(s).length > 0,
  )

  if (bounded.length === 0) {
    return program
  }

  // instance dictionaries: `${mask}:${target}` -> (methodName -> implementing function name). An instance's method
  // bodies were already desugared to `function`s tagged with `method = { form: target, name }`.
  const instanceMethods = new Map<string, Map<string, string>>()

  for (const statement of program) {
    if (statement.form !== 'instance') {
      continue
    }

    const methods = new Map<string, string>()

    for (const method of statement.methods) {
      const fn = program.find(
        (f): f is Fn =>
          f.form === 'function' &&
          f.method?.form === statement.target &&
          f.method.name === method,
      )

      if (fn) {
        methods.set(method, fn.name)
      }
    }

    instanceMethods.set(
      `${statement.mask}:${statement.target}`,
      methods,
    )
  }

  // method name -> the trait(s) that declare it (to recognise a trait-method call site)
  const methodMasks = new Map<string, Set<string>>()

  for (const [mask, methods] of masks) {
    for (const method of methods) {
      let set = methodMasks.get(method)

      if (!set) {
        methodMasks.set(method, (set = new Set()))
      }

      set.add(mask)
    }
  }

  // captured before we mutate params: original parameter types + the per-function bound list and dictionary-parameter
  // map (generic name -> mask -> param name), used by both the body rewrite and the call-site rewrite (forwarding)
  const boundsOf = new Map<string, { name: string; mask: string }[]>()

  const origParams = new Map<string, (Type | undefined)[]>()
  const paramOf = new Map<string, Map<string, Map<string, string>>>()

  for (const fn of bounded) {
    boundsOf.set(fn.name, ordered(fn))
    origParams.set(
      fn.name,
      fn.params.map(p => p.type),
    )
  }

  const neededDicts = new Set<string>() // `${mask}:${target}`

  // 1. give each bounded function its dictionary parameters and rewrite the trait-method calls in its body
  for (const fn of bounded) {
    const perGeneric = new Map<string, Map<string, string>>()

    for (const bound of boundsOf.get(fn.name)!) {
      const pname = dictParam(bound.name, bound.mask)

      let byMask = perGeneric.get(bound.name)

      if (!byMask) {
        perGeneric.set(bound.name, (byMask = new Map()))
      }

      byMask.set(bound.mask, pname)
      fn.params.push({
        name: pname,
        type: { kind: 'named', name: bound.mask },
      })
    }

    paramOf.set(fn.name, perGeneric)
    rewriteTraitCalls(fn.body, perGeneric)
  }

  // 2. rewrite every call site of a bounded function to pass the dictionary argument(s)
  for (const statement of program) {
    if (statement.form !== 'function') {
      continue
    }

    rewriteCallSites(statement.body, statement)
  }

  // 3. materialise the instance dictionaries actually used, as top-level constants. They reference the (hoisted)
  // instance-method functions, so placing them ahead of everything is safe on every backend.
  const consts: Statement[] = []

  for (const key of neededDicts) {
    const [mask, target] = key.split(':') as [string, string]
    const methods = instanceMethods.get(key)

    if (!methods) {
      continue
    }

    consts.push({
      form: 'let',
      name: dictConst(mask, target),
      mutable: false,
      span: zeroSpan,
      init: {
        form: 'record',
        name: mask,
        span: zeroSpan,
        fields: [...methods].map(([method, fnName]) => ({
          name: method,
          value: { form: 'variable', name: fnName, span: zeroSpan },
        })),
      },
    })
  }

  return [...consts, ...program]

  // --- helpers (closures over the maps above) ---

  // inside a bounded function: a call `m(recv, ...)` where `m` is a trait method and `recv`'s type is one of this
  // function's bounded generics becomes `<dict>.m(recv, ...)`
  function rewriteTraitCalls(
    body: Statement[],
    perGeneric: Map<string, Map<string, string>>,
  ): void {
    walkExpressions(body, node => {
      if (node.form !== 'call' || node.callee.form !== 'variable') {
        return
      }

      const declaring = methodMasks.get(node.callee.name)

      if (!declaring) {
        return
      }

      const receiver = node.args[0]?.type

      if (receiver?.kind !== 'named') {
        return
      }

      const byMask = perGeneric.get(receiver.name)

      if (!byMask) {
        return
      }

      // pick the bound trait that declares this method
      let dict: string | undefined

      for (const mask of declaring) {
        const found = byMask.get(mask)

        if (found) {
          dict = found
          break
        }
      }

      if (!dict) {
        return
      }

      node.callee = {
        form: 'member',
        target: {
          form: 'variable',
          name: dict,
          span: node.callee.span,
        },
        name: node.callee.name,
        span: node.callee.span,
      }
    })
  }

  // at any call to a bounded function, append one dictionary argument per bound: the concrete instance's constant
  // when the type argument is a known form, or the enclosing function's own dictionary parameter when the argument is
  // itself still bound by the same trait (forwarding through a generic call chain)
  function rewriteCallSites(body: Statement[], enclosing: Fn): void {
    const enclosingBounds = boundsOf.get(enclosing.name)
    const enclosingParams = paramOf.get(enclosing.name)
    walkExpressions(body, node => {
      if (node.form !== 'call' || node.callee.form !== 'variable') {
        return
      }

      const bounds = boundsOf.get(node.callee.name)

      if (!bounds) {
        return
      }

      const params = origParams.get(node.callee.name)!
      const genericNames = new Set(bounds.map(b => b.name))
      const subst = new Map<string, Type>()
      params.forEach((p, i) =>
        matchType(p, node.args[i]?.type, genericNames, subst),
      )

      for (const bound of bounds) {
        const concrete = subst.get(bound.name)
        const arg = dictArgument(
          bound.mask,
          concrete,
          enclosingBounds,
          enclosingParams,
          node.span,
        )

        node.args.push(arg)
      }
    })
  }

  function dictArgument(
    mask: string,
    concrete: Type | undefined,
    enclosingBounds: { name: string; mask: string }[] | undefined,
    enclosingParams: Map<string, Map<string, string>> | undefined,
    span: Expression['span'],
  ): Expression {
    if (concrete?.kind === 'named') {
      // forwarding: the type argument is still one of the enclosing function's trait-bounded generics
      const forwarded = enclosingBounds?.some(
        b => b.name === concrete.name && b.mask === mask,
      )

      if (forwarded) {
        const pname = enclosingParams?.get(concrete.name)?.get(mask)

        if (pname) {
          return { form: 'variable', name: pname, span }
        }
      }

      // concrete instance: pass its dictionary constant
      const key = `${mask}:${concrete.name}`

      if (instanceMethods.has(key)) {
        neededDicts.add(key)

        return {
          form: 'variable',
          name: dictConst(mask, concrete.name),
          span,
        }
      }
    }

    // unresolved (no concrete type and not forwardable): leave a hole so the gap is visible rather than silently
    // dropping an argument
    return { form: 'hole', name: `trait-${mask}`, span }
  }
}

const zeroSpan = {
  start: { line: 0, column: 0, offset: 0 },
  end: { line: 0, column: 0, offset: 0 },
}

// walk every expression in a body, invoking `visit` on each (callee and args are visited after the node itself, so a
// rewritten callee is not re-walked as the original)
function walkExpressions(
  body: Statement[],
  visit: (node: Expression) => void,
): void {
  const expr = (node: Expression): void => {
    visit(node)

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

  const stmts = (body: Statement[]): void => {
    for (const node of body) {
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
