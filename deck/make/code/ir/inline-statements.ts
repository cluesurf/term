// The statement-level inliner (note/term/codegen/passes.md, F6). The simplifier inlines a task that is one expression
// (`smallBody`); this inlines a small task of STATEMENTS where its call is a statement of its own, the value of a `let`,
// or an argument of such a call, so the caller holds the callee's work in one body. That is what lets a backend see an
// unboxed node built again in the same task (Towers' `move-top`: `push-disk(piles, pop-disk(piles, from), to)`, the
// popped node's box free to hold the pushed one) where across the call it could not.
//
// That reuse is the only thing it was measured to buy, and every backend's own compiler already inlines a small call
// for speed, so it inlines only a task that opens or builds a node of a REUSABLE RECURSIVE FORM (a form that is not
// generic, has a field-less case, and has a field of its own type: Towers' `stack`). Everything else keeps its call.
//
// A task is inlined when it is that, and small (at most SIZE nodes), defined once, not generic, not async, not a
// method, a stub, a claim, a theorem or a render-runtime helper the view lowering calls after this pass, never named except as the callee of a direct call,
// calls itself nowhere, holds no closure, guard, loop or nested task, binds no name one of its parameters has, writes
// no variable it does not bind, writes no field of a parameter that is not a list or a hash (a record is a value, so a
// call gives the callee its own copy, which a substitution would not), and returns only in tail position (the last
// statement of its body, or of a branch or a case that is itself last). Its call becomes:
//   - each parameter: the argument itself where the argument is a variable or a literal and the body never writes the
//     parameter (so a list lent to the task is still the caller's own, never moved into a new name), else a `let` of
//     a fresh name
//   - every name the body binds renamed fresh, so nothing in the caller is shadowed or captured; an arm that reads its
//     fields by their own names is given them renamed, in the fields' order
//   - each tail `return v`: for a call that is a statement, `v` evaluated for what it does (nothing, for a variable or
//     a literal); for a `let x = f(...)`, `x = v`, the `let x` first given its type's zero, which only a number, a
//     decimal, a flag or a text has. A task whose value is anything else is inlined only as a statement
// A call that is an argument is first taken out into a `let` of its own, where every argument before it is a variable
// or a literal, so nothing it does can change what they read. A raise stays a raise. The names inlined are answered,
// and `simplify` drops each one that is no root and that nothing references any more (`dropDeadFunctions`, which
// counts every kind of reference). A compile that names no roots keeps every definition, since anything may call it

import type { Expression, Program, Statement, Type } from '@term/make/code/compile/node'
import { RENDER, RENDER_SUPPORT } from '@term/make/code/compile/render-names'

type Fn = Extract<Statement, { form: 'function' }>
type Call = Extract<Expression, { form: 'call' }>
type Loose = Record<string, unknown> & { form?: string; name?: string }

// the most nodes an inlined task may hold
const SIZE = 80

// the tasks the view lowering calls after this pass, which must keep their definitions and their calls
const RUNTIME = new Set<string>([...Object.values(RENDER), ...RENDER_SUPPORT])

// the forms whose literal a parameter may be substituted with
const LITERALS = new Set(['integer', 'float', 'boolean', 'string'])

// THE NAMES AN INLINING MAKES. Every name the callee binds gets a fresh one in the caller: its own spelling and a
// number, `size-2`, which every backend writes as its own idiom (`size_2` on Rust, `size2` on Swift), where a
// `size__in7` was a name rustc warns about. Fresh by construction: the number is the first that makes a name no node in
// the program carries, and every name made joins the set. A name made from one an earlier inlining made starts again
// from that one's spelling (`size-2` inlined again is `size-5`, never `size-2-5`), and a hoisted argument is named for
// the task that answers it (`pop-disk-1`)
type Names = { used: Set<string>; made: Map<string, string> }

// a name as every backend's spelling sees it: `size-2`, `size_2` and `size2` are one name to Swift's camel case
const spelled = (name: string): string => name.replace(/[-_]/g, '').toLowerCase()

// every name a node of the program carries, as spelled
function namesOf(program: Program): Set<string> {
  const used = new Set<string>()
  const add = (name: unknown): void => {
    if (typeof name === 'string') used.add(spelled(name))
  }

  each(program, node => {
    add(node.name)
    add(node.item)
    add(node.index)
    if (Array.isArray(node.binds)) node.binds.forEach(add)
    if (Array.isArray(node.params)) (node.params as { name?: string }[]).forEach(p => add(p.name))
  })

  return used
}

function freshName(names: Names, name: string): string {
  const base = names.made.get(name) ?? name

  for (let k = 1; ; k++) {
    const candidate = `${base}-${k}`

    if (!names.used.has(spelled(candidate))) {
      names.used.add(spelled(candidate))
      names.made.set(candidate, base)

      return candidate
    }
  }
}

const clone = <T>(value: T): T => structuredClone(value)

// every child of a node that is part of the program, the types and spans left out
const children = (node: Loose): [string, unknown][] => Object.entries(node).filter(([key]) => key !== 'type' && key !== 'span')

// whether a predicate holds of any node in a value
function some(value: unknown, test: (node: Loose) => boolean): boolean {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  if (Array.isArray(value)) {
    return value.some(v => some(v, test))
  }

  const node = value as Loose

  return test(node) || children(node).some(([, child]) => some(child, test))
}

// every node in a value, parents before children
function each(value: unknown, visit: (node: Loose) => void): void {
  if (typeof value !== 'object' || value === null) {
    return
  }

  if (Array.isArray(value)) {
    value.forEach(v => each(v, visit))

    return
  }

  visit(value as Loose)
  children(value as Loose).forEach(([, child]) => each(child, visit))
}

function countNodes(value: unknown): number {
  let count = 0
  each(value, node => {
    if (node.form) count++
  })

  return count
}

const hasReturn = (value: unknown): boolean => some(value, node => node.form === 'return')

// whether every `return` in a statement list is in tail position: the last statement of the list, or inside a last
// `if` or `match` whose bodies are themselves so. A return anywhere else (before the end, inside a loop) refuses
function tailOnly(body: Statement[]): boolean {
  return body.every((s, at) => {
    const last = at === body.length - 1
    const node = s as unknown as Loose

    if (node.form === 'return') {
      return last
    }

    if (node.form === 'if' || node.form === 'match') {
      const arms = node.form === 'if' ? (node.branches as { body: Statement[] }[]) : (node.cases as { body: Statement[] }[])
      const lists = [...arms.map(a => a.body), ...(node.otherwise ? [node.otherwise as Statement[]] : [])]

      return last ? lists.every(tailOnly) : !lists.some(hasReturn)
    }

    return !hasReturn(node)
  })
}

// the variable a write lands in: `xs` for `xs/{i}/count`
function rootOf(node: Loose): Loose | undefined {
  if (node.form === 'variable') {
    return node
  }

  if (node.form === 'member') {
    return rootOf(node.target as Loose)
  }

  return undefined
}

// a type's zero, for a result local declared before the body assigns it; only the scalars have one
function zero(type: Type | undefined, span: unknown): Expression | undefined {
  const literal = (form: string, value: unknown): Expression => ({ form, value, span, type }) as unknown as Expression

  switch (type?.kind) {
    case 'number':
      return literal('integer', 0)
    case 'float':
      return literal('float', 0)
    case 'boolean':
      return literal('boolean', false)
    case 'string':
      return literal('string', '')
    default:
      return undefined
  }
}

// a few rounds, bottom up: a task that calls an inlinable one is inlined into after its callee was inlined into it.
// Answers the program and every task some call to which was inlined
export function inlineStatements(program: Program): { program: Program; inlined: Set<string> } {
  const inlined = new Set<string>()
  // the program's names, read once and only when something is inlined (`freshName`)
  const holder: { names?: Names } = {}
  let out = program

  for (let round = 0; round < 3; round++) {
    const next = inlineRound(out, inlined, holder)

    if (next === out) {
      break
    }

    out = next
  }

  return { program: out, inlined }
}

function inlineRound(program: Program, inlinedNames: Set<string>, holder: { names?: Names }): Program {
  const statements = program as Statement[]
  const fns = statements.filter((n): n is Fn => n.form === 'function')
  const defined = new Map<string, number>()

  for (const fn of fns) {
    defined.set(fn.name, (defined.get(fn.name) ?? 0) + 1)
  }

  // the names used other than as a direct call's callee: a task held as a value is never inlined
  const named = new Set<string>()
  const references = (value: unknown, callee: boolean): void => {
    if (typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(v => references(v, false))

      return
    }

    const node = value as Loose
    const kind = (node.binding as { kind?: string } | undefined)?.kind

    if (node.form === 'variable' && !callee && kind !== 'local' && kind !== 'parameter') {
      named.add(node.name as string)
    }

    for (const [key, child] of children(node)) {
      references(child, node.form === 'call' && key === 'callee')
    }
  }

  references(statements, false)

  // each variant's fields in order, for an arm that reads them by their own names, and the reusable recursive forms
  const fieldsOf = new Map<string, string[]>()
  const recursive = new Set<string>()

  for (const node of statements) {
    if (node.form === 'record-type') {
      for (const v of node.variants) {
        fieldsOf.set(v.name, v.fields.map(f => f.name))
      }

      const own = node.variants.some(v => v.fields.some(f => some(f.type, t => (t as Loose).kind === 'named' && t.name === node.name)))

      if (node.params.length === 0 && node.variants.some(v => v.fields.length === 0) && own) {
        recursive.add(node.name)
        node.variants.forEach(v => recursive.add(v.name))
      }
    }
  }

  // whether a body opens or builds a node of a reusable recursive form
  const reuses = (body: Statement[]): boolean =>
    some(body, node => {
      const type = (node.form === 'match' ? (node.subject as Loose)?.type : node.form === 'record' ? node.type : undefined) as Loose | undefined

      return (type?.kind === 'named' && recursive.has(type.name as string)) || (node.form === 'record' && recursive.has(node.name as string))
    })

  // every name a body binds: its `let`s and the names its arms read their fields by
  const bindsOf = (body: Statement[]): Set<string> => {
    const names = new Set<string>()
    each(body, node => {
      if (node.form === 'let') names.add(node.name as string)
      if (node.form === 'match') {
        for (const c of node.cases as { label: string; binds?: string[] }[]) {
          ;(c.binds && c.binds.length > 0 ? c.binds : (fieldsOf.get(c.label) ?? [])).forEach(b => names.add(b))
        }
      }
    })

    return names
  }

  // whether every write in a body lands in a name it binds, or in a list or a hash it was handed
  const writesOwn = (fn: Fn, binds: Set<string>): boolean => {
    const params = new Map(fn.params.map(p => [p.name, p]))

    return !some(fn.body, node => {
      if (node.form !== 'assign') return false
      const root = rootOf(node.target as Loose)
      const name = root?.name as string | undefined

      if (!root || !name) return true
      if (binds.has(name)) return false
      if (!params.has(name)) return true

      // a whole parameter written is a `let` of its own; a field of one is written through, which only a list or a
      // hash shares with the caller
      const kind = params.get(name)!.type?.kind

      return root !== node.target && kind !== 'array' && kind !== 'map'
    })
  }

  const inlinable = new Map<string, Fn>()

  for (const fn of fns) {
    if (
      defined.get(fn.name) !== 1 ||
      RUNTIME.has(fn.name) ||
      named.has(fn.name) ||
      !Array.isArray(fn.body) ||
      fn.body.length === 0 ||
      fn.async ||
      fn.method ||
      fn.stub ||
      fn.claim ||
      fn.theorem ||
      fn.axiom ||
      fn.roam ||
      fn.generics.length > 0 ||
      countNodes(fn.body) > SIZE ||
      !reuses(fn.body) ||
      !tailOnly(fn.body) ||
      some(fn.body, node => ['closure', 'guard', 'while', 'for-each', 'function', 'view'].includes(node.form ?? '')) ||
      some(fn.body, node => node.form === 'call' && (node.callee as Loose).form === 'variable' && (node.callee as Loose).name === fn.name)
    ) {
      continue
    }

    const binds = bindsOf(fn.body)

    if (fn.params.some(p => binds.has(p.name)) || !writesOwn(fn, binds)) {
      continue
    }

    inlinable.set(fn.name, fn)
  }

  if (inlinable.size === 0) {
    return program
  }

  holder.names ??= { used: namesOf(program), made: new Map() }
  const names = holder.names
  let changed = false

  // the callee's body with its parameters bound and its names renamed, and each tail return handed to `back`
  const expand = (callee: Fn, args: Expression[], back: (value: Expression, span: unknown) => Statement[]): Statement[] => {
    const body = clone(callee.body)
    const rename = new Map<string, string>()
    const substitute = new Map<string, Expression>()
    const before: Statement[] = []
    const written = new Set<string>()

    each(body, node => {
      if (node.form === 'assign' && (node.target as Loose).form === 'variable') written.add((node.target as Loose).name as string)
    })

    callee.params.forEach((p, i) => {
      const arg = args[i]!
      const kind = (arg as unknown as Loose).binding as { kind?: string } | undefined
      const plain = LITERALS.has(arg.form) || (arg.form === 'variable' && kind?.kind !== 'function' && kind?.kind !== 'builtin' && kind?.kind !== 'deferred')

      if (plain && !written.has(p.name)) {
        substitute.set(p.name, arg)
      } else {
        const name = freshName(names, p.name)
        rename.set(p.name, name)
        before.push({ form: 'let', name, init: arg, mutable: written.has(p.name), span: arg.span, type: p.type } as unknown as Statement)
      }
    })

    // every name the body binds, renamed; an arm reading its fields by their own names given them renamed
    const bind = (name: string): string => {
      if (!rename.has(name)) {
        rename.set(name, freshName(names, name))
      }

      return rename.get(name)!
    }

    each(body, node => {
      if (node.form === 'let') {
        node.name = bind(node.name as string)
      }

      if (node.form === 'match') {
        for (const c of node.cases as { label: string; binds?: string[] }[]) {
          const fields = fieldsOf.get(c.label) ?? []
          // the names the arm binds: its own, else every field by its name, in order
          const names = c.binds && c.binds.length > 0 && !c.binds.every(b => fields.includes(b)) ? c.binds : fields
          c.binds = names.map(bind)
        }
      }
    })

    // every read and write of a renamed or substituted name
    const rewrite = (value: unknown): unknown => {
      if (typeof value !== 'object' || value === null) return value
      if (Array.isArray(value)) return value.map(rewrite)
      const node = value as Loose

      if (node.form === 'variable') {
        const name = node.name as string
        const kind = (node.binding as { kind?: string } | undefined)?.kind

        // a task or a global keeps its name; a parameter or a local of the callee is the caller's now
        if (kind === 'function' || kind === 'builtin' || kind === 'deferred') {
          return node
        }

        if (substitute.has(name)) {
          return clone(substitute.get(name)!)
        }

        if (rename.has(name)) {
          return { ...node, name: rename.get(name)!, binding: { kind: 'local' } }
        }

        return node
      }

      for (const [key, child] of children(node)) {
        node[key] = rewrite(child)
      }

      return node
    }

    const renamed = rewrite(body) as Statement[]

    // each tail return handed back
    const tails = (list: Statement[]): Statement[] =>
      list.flatMap((s, at) => {
        const node = s as unknown as Loose

        if (at !== list.length - 1) {
          return [s]
        }

        if (node.form === 'return') {
          return node.value ? back(node.value as Expression, node.span) : []
        }

        if (node.form === 'if') {
          ;(node.branches as { body: Statement[] }[]).forEach(b => (b.body = tails(b.body)))
          if (node.otherwise) node.otherwise = tails(node.otherwise as Statement[])
        }

        if (node.form === 'match') {
          ;(node.cases as { body: Statement[] }[]).forEach(c => (c.body = tails(c.body)))
          if (node.otherwise) node.otherwise = tails(node.otherwise as Statement[])
        }

        return [s]
      })

    changed = true
    inlinedNames.add(callee.name)

    return [...before, ...tails(renamed)]
  }

  // a call to an inlinable task
  const target = (e: Expression | undefined, owner: string): Fn | undefined => {
    const callee = e?.form === 'call' && e.callee.form === 'variable' ? inlinable.get(e.callee.name) : undefined

    return callee && callee.name !== owner ? callee : undefined
  }

  // a call's arguments with any inlinable call among them taken out into a `let` first, when every argument before it
  // is a variable or a literal; answers the statements to put before and the call with its arguments replaced
  const hoist = (call: Call, owner: string): { before: Statement[]; call: Call } => {
    const before: Statement[] = []
    const args = call.args.map((a, i) => {
      const plainBefore = call.args.slice(0, i).every(p => p.form === 'variable' || LITERALS.has(p.form))
      const callee = target(a, owner)

      if (callee && plainBefore && zero(a.type, a.span)) {
        const name = freshName(names, callee.name)
        before.push(...inlineLet(name, a as Call, callee, owner))

        return { form: 'variable', name, binding: { kind: 'local' }, span: a.span, type: a.type } as unknown as Expression
      }

      return a
    })

    return { before, call: { ...call, args } }
  }

  // `let name = callee(args)`: the result declared at its zero, then the body, each tail return assigning it
  const inlineLet = (name: string, call: Call, callee: Fn, owner: string): Statement[] => {
    const start = zero(call.type, call.span)!
    const { before, call: hoisted } = hoist(call, owner)
    const variable = { form: 'variable', name, binding: { kind: 'local' }, span: call.span, type: call.type } as unknown as Expression

    return [
      ...before,
      { form: 'let', name, init: start, mutable: true, span: call.span, type: call.type } as unknown as Statement,
      ...expand(callee, hoisted.args, value => [{ form: 'assign', target: clone(variable), op: '=', value, span: call.span } as unknown as Statement]),
    ]
  }

  // a tail value evaluated for what it does: a variable or a literal does nothing, and is left out
  const effect = (value: Expression, span: unknown): Statement[] =>
    value.form === 'variable' || LITERALS.has(value.form) ? [] : [{ form: 'expression', expr: value, span } as unknown as Statement]

  const walkBody = (body: Statement[], owner: string): Statement[] =>
    body.flatMap(s => {
      const node = s as unknown as Loose

      // nested statement lists first
      for (const key of ['body', 'otherwise']) {
        if (Array.isArray(node[key])) node[key] = walkBody(node[key] as Statement[], owner)
      }

      if (node.form === 'if') {
        ;(node.branches as { body: Statement[] }[]).forEach(b => (b.body = walkBody(b.body, owner)))
      }

      if (node.form === 'match') {
        ;(node.cases as { body: Statement[] }[]).forEach(c => (c.body = walkBody(c.body, owner)))
      }

      if (node.form === 'guard' && node.catch) {
        const handler = node.catch as { body: Statement[] }
        handler.body = walkBody(handler.body, owner)
      }

      // a call that is a statement of its own
      if (node.form === 'expression' && (node.expr as Loose).form === 'call') {
        const { before, call } = hoist(node.expr as Call, owner)
        const callee = target(call, owner)

        if (callee) {
          return [...before, ...expand(callee, call.args, effect)]
        }

        if (before.length) {
          return [...before, { ...s, expr: call } as Statement]
        }
      }

      // `let x = f(...)` with a scalar result
      if (node.form === 'let') {
        const callee = target(node.init as Expression, owner)

        if (callee && zero((node.init as Loose).type as Type, node.span)) {
          return inlineLet(node.name as string, node.init as Call, callee, owner)
        }
      }

      return [s]
    })

  // every task is inlined into, the inlinable ones too (their callees first), the inlinable bodies read as they were at
  // the round's start
  const out = statements.map(node =>
    node.form === 'function' && Array.isArray(node.body) ? { ...node, body: walkBody(clone(node.body), node.name) } : node,
  )

  return changed ? (out as Program) : program
}
