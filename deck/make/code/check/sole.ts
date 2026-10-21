// UNCOPYABLE. A value of a `mark sole` form has one owner: it is used AT MOST ONCE (term-affine-kinds-0001, decision
// note/project/term/affine-kinds/decision/001-many-by-default-sole-and-hide-declared-per-form.md, section sole).
//
// One pass over the checked program, so TypeScript, Rust, Swift and Kotlin refuse a second use the same way, before
// any of them emits a line. A local, a parameter or a field read whose type is a sole form is CONSUMED by any use that
// hands it on: an argument, a `bind` into a `make`, a `send back`, a `save` into another name, an element of a list.
// Reading a field that is not itself sole (`read permit/note`) does not consume it, and neither does matching on it.
//
//   sole-reused     a use after a consuming use on the same path, naming both lines. A `fork` (and a `sift`) joins
//                   by the MAXIMUM of its arms, never the sum, so a permit spent once in each arm is spent once. A path
//                   that leaves (`back`, `halt`, a raise) joins nothing. A consuming use inside a `walk` of a name
//                   bound outside it is refused too: the loop may run twice
//   sole-captured   a closure (or a task written inside a task) that names a sole value bound outside it. No
//                   once-closures in this version
//   sole-generic    a sole type as a type argument or an element (`like list, like permit`): what a list does with its
//                   elements is not one use. Composition by meet is a later item
//   sole-unknown    a sole value handed to a parameter typed `unknown` or `dynamic`, where nothing tracks it
//
// It is affine, not linear: a value never used is fine, so an error path need not spend its permit.

import type { Expression, Program, Statement, Type } from '@term/make/code/compile/node'
import { diagnose } from '@term/make/code/parser/diagnostic'
import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'

type Task = Extract<Statement, { form: 'function' }>

type Slot = { uses: Span[]; depth: number }

// the uses on one path so far. A dead path (one that has left by `back`, `halt` or a raise) joins nothing
type State = { dead: boolean; vars: Map<string, Slot> }

const fresh = (): State => ({ dead: false, vars: new Map() })

const copy = (state: State): State => ({
  dead: state.dead,
  vars: new Map([...state.vars].map(([name, slot]) => [name, { uses: [...slot.uses], depth: slot.depth }])),
})

// the paths meet: each name carries the most uses any live arm made of it, never the sum
function join(states: State[]): State {
  const live = states.filter(s => !s.dead)

  if (live.length === 0) {
    return { dead: true, vars: states[0]?.vars ?? new Map() }
  }

  const vars = new Map<string, Slot>()

  for (const state of live) {
    for (const [name, slot] of state.vars) {
      const had = vars.get(name)

      if (!had || slot.uses.length > had.uses.length) {
        vars.set(name, { uses: [...slot.uses], depth: had?.depth ?? slot.depth })
      }
    }
  }

  return { dead: false, vars }
}

const line = (span: Span): number => span.start.line + 1

export function checkSoleUses(program: Program, file: string): Diagnostic[] {
  const sole = new Set<string>()

  for (const s of program) {
    if (s.form === 'record-type' && s.sole) {
      sole.add(s.name)
    }
  }

  if (sole.size === 0) {
    return []
  }

  const isSole = (type: Type | undefined | null): boolean => type?.kind === 'named' && sole.has(type.name)

  const tasks = new Map<string, Task>()

  for (const s of program) {
    if (s.form === 'function') {
      tasks.set(s.name, s)
    }
  }

  const diagnostics: Diagnostic[] = []
  const told = new Set<string>()

  const report = (name: string, key: string, from: string, at: Span, build: () => Diagnostic): void => {
    const id = `${name}\u0000${from}\u0000${key}\u0000${at.start.line}\u0000${at.start.column}`

    if (!told.has(id)) {
      told.add(id)
      diagnostics.push(build())
    }
  }

  const typeName = (type: Type | undefined | null): string => (type?.kind === 'named' ? type.name : 'sole value')

  // one body: a task's, a closure's or a nested task's, with its own parameters
  const walkBody = (body: Statement[], params: string[], from: string): void => {
    let depth = 0
    const state = fresh()

    for (const name of params) {
      state.vars.set(name, { uses: [], depth: 0 })
    }

    const bind = (s: State, name: string): void => {
      s.vars.set(name, { uses: [], depth })
    }

    const consume = (s: State, variable: Extract<Expression, { form: 'variable' }>): void => {
      if (s.dead) {
        return
      }

      const slot = s.vars.get(variable.name) ?? { uses: [], depth: 0 }
      const at = { ...variable.span, file: from }
      const sort = typeName(variable.type)

      if (slot.uses.length > 0) {
        const first = slot.uses[0]!
        report(variable.name, 'reused', from, at, () =>
          diagnose('sole-reused', {
            file: from,
            span: at,
            message: `"${variable.name}" is a \`mark sole\` ${sort}, used here again after it was handed on at line ${line(first)}`,
            markers: [{ span: at }, { span: { ...first, file: from }, label: `"${variable.name}" handed on here` }],
            hint: `a ${sort} has one owner: hand it on once, or take a fresh one for the second use`,
          }),
        )
      } else if (depth > slot.depth) {
        report(variable.name, 'loop', from, at, () =>
          diagnose('sole-reused', {
            file: from,
            span: at,
            message: `"${variable.name}" is a \`mark sole\` ${sort} bound outside this walk, and a walk may run its body twice`,
            markers: [{ span: at }],
            hint: `make or take the ${sort} inside the walk, or hand it on after the walk ends`,
          }),
        )
      }

      slot.uses.push(variable.span)
      s.vars.set(variable.name, slot)
    }

    // a read that hands nothing on (a plain field, a match) is still a use of a value already handed on: what was moved
    // is gone, as on Rust
    const touch = (s: State, variable: Extract<Expression, { form: 'variable' }>): void => {
      const first = s.dead ? undefined : s.vars.get(variable.name)?.uses[0]

      if (!first) {
        return
      }

      const at = { ...variable.span, file: from }
      const sort = typeName(variable.type)
      report(variable.name, 'read', from, at, () =>
        diagnose('sole-reused', {
          file: from,
          span: at,
          message: `"${variable.name}" is a \`mark sole\` ${sort}, read here after it was handed on at line ${line(first)}`,
          markers: [{ span: at }, { span: { ...first, file: from }, label: `"${variable.name}" handed on here` }],
          hint: `read what you need of the ${sort} before handing it on`,
        }),
      )
    }

    const soleVariable = (e: Expression): e is Extract<Expression, { form: 'variable' }> =>
      e.form === 'variable' &&
      (e.binding?.kind === 'local' || e.binding?.kind === 'parameter') &&
      isSole(e.type)

    const expr = (s: State, e: Expression | undefined | null, consuming: boolean): State => {
      if (!e || s.dead) {
        return s
      }

      switch (e.form) {
        case 'variable':
          if (soleVariable(e)) {
            if (consuming) {
              consume(s, e)
            } else {
              touch(s, e)
            }
          }

          return s

        case 'member':
          if (e.index) {
            expr(s, e.index, true)
          }

          // a sole field handed on is its holder handed on; any other field is a read
          return expr(s, e.target, consuming && isSole(e.type))

        case 'call': {
          expr(s, e.callee, false)
          const callee = e.callee.form === 'variable' && e.callee.binding?.kind === 'function' ? tasks.get(e.callee.name) : undefined

          e.args.forEach((arg, i) => {
            const param = callee?.params[i]?.type

            if (param && (param.kind === 'unknown' || param.kind === 'dynamic') && isSole(arg.type)) {
              const at = { ...arg.span, file: from }
              report(callee!.name, 'unknown', from, at, () =>
                diagnose('sole-unknown', {
                  file: from,
                  span: at,
                  message: `a \`mark sole\` ${typeName(arg.type)} cannot be handed to "${callee!.name.replace(/__.*$/, '')}", whose parameter is \`like ${param.kind}\`: nothing would track its one use`,
                  markers: [{ span: at }],
                  hint: `give the parameter the type ${typeName(arg.type)}`,
                }),
              )
            }

            expr(s, arg, true)
          })

          return s
        }

        case 'binary':
          expr(s, e.left, true)

          return expr(s, e.right, true)

        case 'unary':
          return expr(s, e.operand, true)

        case 'array':
          for (const item of e.items) {
            expr(s, item, true)
          }

          return s

        case 'map':
          for (const entry of e.entries) {
            expr(s, entry.key, true)
            expr(s, entry.value, true)
          }

          return s

        case 'record':
          for (const field of e.fields) {
            expr(s, field.value, true)
          }

          for (const item of e.positional ?? []) {
            expr(s, item, true)
          }

          return s

        case 'template':
          for (const part of e.parts) {
            if (part.form === 'value') {
              expr(s, part.value, true)
            }
          }

          return s

        case 'await':
          return expr(s, e.expr, consuming)

        case 'closure':
          closure(e.params.map(p => p.name), e.body, from, s)

          return s

        case 'conditional': {
          const arms: State[] = []
          let at = s

          for (const branch of e.branches) {
            at = expr(at, branch.cond, true)
            arms.push(expr(copy(at), branch.value, consuming))
          }

          arms.push(e.otherwise ? expr(copy(at), e.otherwise, consuming) : at)

          return assign(s, join(arms))
        }

        default:
          return s
      }
    }

    // write `next` into `s` in place, so callers holding `s` see the joined state
    const assign = (s: State, next: State): State => {
      s.dead = next.dead
      s.vars = next.vars

      return s
    }

    const block = (s: State, statements: Statement[] | undefined | null): State => {
      for (const statement of statements ?? []) {
        if (s.dead) {
          return s
        }

        stmt(s, statement)
      }

      return s
    }

    const stmt = (s: State, st: Statement): State => {
      switch (st.form) {
        case 'let':
          expr(s, st.init, true)
          bind(s, st.name)

          return s

        case 'assign':
          expr(s, st.value, true)

          if (st.target.form === 'variable') {
            // a new value under the old name: nothing of it is spent yet
            const slot = s.vars.get(st.target.name)
            s.vars.set(st.target.name, { uses: [], depth: slot?.depth ?? depth })
          } else if (st.target.form === 'member' && st.target.index) {
            expr(s, st.target.index, true)
          }

          return s

        case 'expression':
          return expr(s, st.expr, true)

        case 'if': {
          const arms: State[] = []
          let at = s

          for (const branch of st.branches) {
            at = expr(at, branch.cond, true)
            arms.push(block(copy(at), branch.body))
          }

          arms.push(st.otherwise ? block(copy(at), st.otherwise) : at)

          return assign(s, join(arms))
        }

        case 'match': {
          expr(s, st.subject, false)
          const arms: State[] = []

          for (const arm of st.cases) {
            const one = copy(s)

            for (const name of arm.binds ?? []) {
              bind(one, name)
            }

            arms.push(block(one, arm.body))
          }

          arms.push(st.otherwise ? block(copy(s), st.otherwise) : s)

          return assign(s, join(arms))
        }

        case 'while': {
          depth++
          const turn = copy(s)
          expr(turn, st.cond, true)
          block(turn, st.body)
          depth--

          return assign(s, join([s, { ...turn, dead: false }]))
        }

        case 'for-each': {
          expr(s, st.iterable, true)
          depth++
          const turn = copy(s)
          bind(turn, st.item)

          if (st.index) {
            bind(turn, st.index)
          }

          block(turn, st.body)
          depth--

          return assign(s, join([s, { ...turn, dead: false }]))
        }

        case 'return':
          expr(s, st.value, true)
          s.dead = true

          return s

        case 'throw':
          expr(s, st.value, true)
          s.dead = true

          return s

        case 'break':
        case 'continue':
        case 'exit':
          s.dead = true

          return s

        case 'guard': {
          const body = block(copy(s), st.body)

          if (!st.catch) {
            return assign(s, join([body]))
          }

          // the handler runs after any part of the body: everything the body handed on may be gone
          const handler = copy({ ...body, dead: false })
          bind(handler, st.catch.name)
          block(handler, st.catch.body)

          return assign(s, join([body, handler]))
        }

        case 'function':
          closure(st.params.map(p => p.name), st.body, from, s)

          return s

        default:
          return s
      }
    }

    block(state, body)
  }

  // a closure is a body of its own, and names nothing sole from outside it
  const closure = (params: string[], body: Statement[], from: string, outer: State): void => {
    const inside = new Set(params)

    collect(body, node => {
      if (node.form === 'let' && typeof node.name === 'string') {
        inside.add(node.name)
      }

      if (node.form === 'for-each') {
        inside.add(node.item as string)

        if (typeof node.index === 'string') {
          inside.add(node.index)
        }
      }

      if (Array.isArray(node.binds)) {
        for (const name of node.binds as string[]) {
          inside.add(name)
        }
      }

      if (node.form === 'closure' || node.form === 'function') {
        for (const p of (node.params as { name: string }[] | undefined) ?? []) {
          inside.add(p.name)
        }
      }

      if (typeof node.name === 'string' && Array.isArray(node.body) && node.span && !node.form) {
        inside.add(node.name)
      }
    })

    collect(body, node => {
      const e = node as Expression

      if (
        e.form === 'variable' &&
        (e.binding?.kind === 'local' || e.binding?.kind === 'parameter') &&
        isSole(e.type) &&
        !inside.has(e.name) &&
        outer.vars.has(e.name)
      ) {
        const at = { ...e.span, file: from }
        report(e.name, 'captured', from, at, () =>
          diagnose('sole-captured', {
            file: from,
            span: at,
            message: `"${e.name}" is a \`mark sole\` ${typeName(e.type)}, and a closure that names it could use it any number of times`,
            markers: [{ span: at }],
            hint: `pass the ${typeName(e.type)} to the closure as a parameter, or use it outside the closure`,
          }),
        )
      }
    })

    walkBody(body, params, from)
  }

  for (const top of program) {
    if (top.form === 'function' && !top.stub) {
      walkBody(top.body, top.params.map(p => p.name), top.span.file ?? file)
    }
  }

  return diagnostics
}

// every object under a node, each once, types and spans aside
function collect(node: unknown, visit: (record: Record<string, unknown>) => void, seen: WeakSet<object> = new WeakSet()): void {
  if (!node || typeof node !== 'object' || seen.has(node)) {
    return
  }

  seen.add(node)

  if (Array.isArray(node)) {
    for (const item of node) {
      collect(item, visit, seen)
    }

    return
  }

  const record = node as Record<string, unknown>
  visit(record)

  for (const [key, value] of Object.entries(record)) {
    if (key !== 'span' && key !== 'type' && key !== 'result' && key !== 'declared' && key !== 'stubBody' && key !== 'stubShape') {
      collect(value, visit, seen)
    }
  }
}

// a sole type as a type argument or an element, in a type written on a signature or a form's field
function soleInside(type: Type | undefined | null, sole: Set<string>, top: boolean): string | undefined {
  if (!type || typeof type !== 'object') {
    return undefined
  }

  switch (type.kind) {
    case 'named':
      if (!top && sole.has(type.name)) {
        return type.name
      }

      for (const arg of type.args ?? []) {
        const found = soleInside(arg, sole, false)

        if (found) {
          return found
        }
      }

      return undefined

    case 'array':
      return soleInside(type.element, sole, false)

    case 'map':
      return soleInside(type.key, sole, false) ?? soleInside(type.value, sole, false)

    case 'function':
      for (const param of type.params ?? []) {
        const found = soleInside(param, sole, true)

        if (found) {
          return found
        }
      }

      return soleInside(type.result, sole, true)

    default:
      return undefined
  }
}

export function checkSoleGenerics(program: Program, file: string): Diagnostic[] {
  const sole = new Set<string>()

  for (const s of program) {
    if (s.form === 'record-type' && s.sole) {
      sole.add(s.name)
    }
  }

  if (sole.size === 0) {
    return []
  }

  const diagnostics: Diagnostic[] = []

  const refuse = (found: string, where: string, span: Span, from: string): void => {
    diagnostics.push(
      diagnose('sole-generic', {
        file: from,
        span: { ...span, file: from },
        message: `${where} holds the \`mark sole\` form "${found}" as a type argument or an element, and what a list, a hash or a generic form does with its elements is not one use`,
        markers: [{ span: { ...span, file: from } }],
        hint: `hold one ${found} in a field of its own, or a form that is \`mark sole\` itself`,
      }),
    )
  }

  for (const s of program) {
    const from = s.span.file ?? file

    if (s.form === 'function' && !s.stub) {
      for (const param of s.params) {
        const found = soleInside(param.type ?? undefined, sole, true)

        if (found) {
          refuse(found, `the parameter "${param.name}" of "${s.name.replace(/__.*$/, '')}"`, s.span, from)
        }
      }

      const found = soleInside(s.result ?? undefined, sole, true)

      if (found) {
        refuse(found, `the result of "${s.name.replace(/__.*$/, '')}"`, s.span, from)
      }
    }

    if (s.form === 'record-type') {
      const fields = [...s.fields, ...(s.variants ?? []).flatMap(v => v.fields)]

      for (const field of fields) {
        const found = soleInside(field.type, sole, true)

        if (found) {
          refuse(found, `the field "${field.name}" of "${s.name}"`, field.span ?? s.span, from)
        }
      }
    }
  }

  return diagnostics
}
