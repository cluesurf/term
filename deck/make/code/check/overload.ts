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
} from '@cluesurf/make/code/compile/node'

export function disambiguateOverloads(program: Program): void {
  // every arity each function name is defined at
  const arities = new Map<string, Set<number>>()

  for (const s of program)
    {if (s.form === 'function') {
      const set = arities.get(s.name) ?? new Set<number>()
      set.add(s.params.length)
      arities.set(s.name, set)
    }}

  // a name is overloaded when it is defined at more than one arity
  const overloaded = new Set<string>()

  for (const [name, set] of arities)
    {if (set.size > 1) {overloaded.add(name)}}

  if (overloaded.size === 0) {return}

  const mangle = (name: string, arity: number): string =>
    overloaded.has(name) ? `${name}__${arity}` : name

  // rename each overloaded definition by its parameter count
  for (const s of program)
    {if (s.form === 'function' && overloaded.has(s.name))
      {s.name = mangle(s.name, s.params.length)}}

  // rewrite every call to an overloaded name to the overload matching its argument count
  const expr = (node: Expression): void => {
    switch (node.form) {
      case 'call':
        if (
          node.callee.form === 'variable' &&
          overloaded.has(node.callee.name)
        )
          {node.callee.name = mangle(node.callee.name, node.args.length)}

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

        if (node.otherwise) {expr(node.otherwise)}

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
        if (node.value) {expr(node.value)}

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

  for (const s of program) {stmt(s)}
}
