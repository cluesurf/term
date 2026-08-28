// Arity overloading: two functions may share a name if they take different numbers of parameters (e.g. `to-string` and
// `to-string(radix)`). This pass disambiguates them BEFORE resolution and type checking, purely structurally (a call's
// arity is its argument count, known without inference): each overloaded definition is renamed `name__<arity>`, and
// every call to it is rewritten to the matching arity. Downstream (resolve, check, every backend) then sees unique
// names and needs no overloading logic. Same-name same-arity definitions are NOT renamed, so a genuine duplicate is
// still reported by the checker. Pure, browser-safe; mutates the program in place.

import type {
  Expression,
  Program,
  Statement,
} from '@term/make/code/compile/node'
import { showType } from '@term/make/code/compile/node'

// same-name, same-arity overloads: the first candidate's (mangled) name -> every candidate's name. Filled here,
// read by the checker, which picks the candidate whose parameter types fit the arguments (check/infer.ts,
// chooseOverload). A call is mangled to the first candidate so the resolver finds a definition; the checker
// re-targets it once the argument types are known.
export const overloadGroups = new Map<string, string[]>()

export function disambiguateOverloads(program: Program): void {
  overloadGroups.clear()

  type Definition = Extract<Statement, { form: 'function' }>

  // every definition of each name
  const definitions = new Map<string, Definition[]>()

  for (const s of program) {
    if (s.form === 'function') {
      const list = definitions.get(s.name) ?? []
      list.push(s)
      definitions.set(s.name, list)
    }
  }

  // a parameter's shape for comparing two same-arity definitions. An untyped parameter and `unknown` are the same
  // wildcard, so a per-environment shim that re-declares a task with a looser or tighter type is an OVERRIDE (the
  // last one wins, as before), never an overload.
  const shape = (d: Definition): (string | undefined)[] =>
    d.params.map(p =>
      p.type && p.type.kind !== 'unknown' ? showType(p.type) : undefined,
    )

  const differ = (a: Definition, b: Definition): boolean => {
    const sa = shape(a)
    const sb = shape(b)

    return sa.some((t, i) => t !== undefined && sb[i] !== undefined && t !== sb[i])
  }

  // a name is overloaded when it is defined at more than one arity, or more than once at one arity with parameter
  // types that differ at some position
  const overloaded = new Set<string>()
  const typed = new Set<string>()

  for (const [name, list] of definitions) {
    const arities = new Set(list.map(d => d.params.length))

    if (arities.size > 1) {
      overloaded.add(name)
    }

    for (const arity of arities) {
      const same = list.filter(d => d.params.length === arity)

      if (same.some((a, i) => same.slice(i + 1).some(b => differ(a, b)))) {
        overloaded.add(name)
        typed.add(`${name}__${arity}`)
      }
    }
  }

  if (overloaded.size === 0) {
    return
  }

  const mangle = (name: string, arity: number): string =>
    overloaded.has(name) ? `${name}__${arity}` : name

  // rename each overloaded definition by its parameter count, and a same-arity typed overload by its index too
  const seen = new Map<string, number>()
  // each definition's final name with its accepted argument range, for the call rewrite below
  const ranges = new Map<string, { name: string; min: number; max: number; group?: string }[]>()

  for (const s of program) {
    if (s.form === 'function' && overloaded.has(s.name)) {
      const original = s.name
      const base = mangle(s.name, s.params.length)
      let group: string | undefined

      if (typed.has(base)) {
        const index = seen.get(base) ?? 0
        seen.set(base, index + 1)
        s.name = `${base}__${index}`
        group = `${base}__0`

        const list = overloadGroups.get(group) ?? []
        list.push(s.name)
        overloadGroups.set(group, list)
      } else {
        s.name = base
      }

      const list = ranges.get(original) ?? []
      list.push({
        name: s.name,
        min: s.params.filter(p => !p.optional).length,
        max: s.params.length,
        group,
      })
      ranges.set(original, list)
    }
  }

  // the definition a call with `arity` arguments targets: the one whose accepted range holds it, an exact arity
  // winning a tie; a typed same-arity group targets its first candidate until the checker re-targets it
  const target = (name: string, arity: number): string => {
    const list = ranges.get(name) ?? []
    const fits = list.filter(r => arity >= r.min && arity <= r.max)
    const exact = fits.find(r => r.max === arity)
    const pick = exact ?? fits[0]

    if (!pick) {
      return mangle(name, arity)
    }

    return pick.group ?? pick.name
  }

  // rewrite every call to an overloaded name to the overload matching its argument count
  const expr = (node: Expression): void => {
    switch (node.form) {
      case 'call':
        if (
          node.callee.form === 'variable' &&
          overloaded.has(node.callee.name)
        ) {
          node.callee.name = target(node.callee.name, node.args.length)
        }

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
        node.body.forEach(stmt)
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
      case 'hold':
        expr(node.expr)
        break
      case 'while':
        expr(node.cond)
        node.body.forEach(stmt)
        break
      case 'guard':
        node.body.forEach(stmt)
        node.catch?.body.forEach(stmt)
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
      case 'function':
        node.body.forEach(stmt)
        break
      default:
        break
    }
  }

  for (const s of program) {
    stmt(s)
  }
}
