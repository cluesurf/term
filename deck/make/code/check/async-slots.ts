// A task written in place becomes ASYNC where it is handed to a slot that takes an async task: an argument whose
// parameter is `like task / mark async`, or an item pushed onto a list that is then handed to a parameter whose items
// are such tasks (`gather(works)`). A task that is not async may always stand where an async one is asked for, and on
// TypeScript nothing more is needed, since awaiting a value that is already there gives it back. Natively the two are
// different types, a function against one answering a future or a coroutine, and `spawn` and `gather` handed the
// work they were written for (`task work / like text / back <hello>`) did not build on Rust, Swift or Kotlin once
// their `work` was async (test/compile/roundtrip.ts, the job programs, 2026-10-05). Marking the literal async makes it
// the function its slot takes on every backend, with nothing else about it changed.
//
// Runs after type checking, before `resolveAsync`, which then treats the literal as the async closure it now is.
import type { Expression, Program, Statement, Type } from '@term/make/code/compile/node'

type Closure = Extract<Expression, { form: 'closure' }>
type Call = Extract<Expression, { form: 'call' }>
type Fn = Extract<Statement, { form: 'function' }>

const asyncTask = (type: Type | undefined): boolean => type?.kind === 'function' && Boolean(type.effects?.includes('async'))

// the item type of a list type, as declared (`like list, like task ...`)
const itemOf = (type: Type | undefined): Type | undefined =>
  type?.kind === 'array' ? type.element : type?.kind === 'named' && type.name === 'list' ? type.args?.[0] : undefined

// a function type, made async
function asyncType(type: Type | undefined): void {
  if (type?.kind === 'function' && !type.effects?.includes('async')) {
    type.effects = [...(type.effects ?? []), 'async']
  }
}

// a list type whose items are tasks, its items made async
function asyncItems(type: Type | undefined): void {
  asyncType(itemOf(type))
}

// a task literal made async, its own type with it
function made(closure: Closure): void {
  closure.async = true
  asyncType(closure.type)
}

// the types a list local carries where it is declared: the `save`, and the value it starts as
function listTypes(body: Statement[], name: string): (Type | undefined)[] {
  const found: (Type | undefined)[] = []
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(visit)

      return
    }

    const node = value as { form?: string; name?: string; type?: Type; init?: Expression }

    if (node.form === 'let' && node.name === name) {
      found.push(node.type, node.init?.type)
    }

    if (node.form === 'variable' && node.name === name) {
      found.push(node.type)
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        visit(child)
      }
    }
  }

  visit(body)

  return found
}

export function asyncSlots(program: Program): void {
  const tasks = new Map<string, Fn>(program.flatMap(n => (n.form === 'function' ? [[n.name, n] as const] : [])))

  for (const fn of tasks.values()) {
    // every task literal put into a list local of this task, by the local's name
    const pushed = new Map<string, Closure[]>()
    const calls: Call[] = []

    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') {
        return
      }

      if (Array.isArray(value)) {
        value.forEach(visit)

        return
      }

      const node = value as { form?: string }

      if (node.form === 'call') {
        const call = node as Call
        calls.push(call)

        // `works/push(task ...)`, or the method lowered to a call with the list first
        const list =
          call.callee.form === 'member' && call.callee.name === 'push' && call.callee.target.form === 'variable'
            ? call.callee.target.name
            : call.callee.form === 'variable' && /(^|-|_)push$/.test(call.callee.name) && call.args[0]?.form === 'variable'
              ? call.args[0].name
              : undefined
        const items = call.callee.form === 'member' ? call.args : call.args.slice(1)

        if (list !== undefined) {
          for (const item of items) {
            if (item.form === 'closure') {
              pushed.set(list, [...(pushed.get(list) ?? []), item])
            }
          }
        }
      }

      for (const [key, child] of Object.entries(node)) {
        if (key !== 'type' && key !== 'span') {
          visit(child)
        }
      }
    }

    visit(fn.body)

    for (const call of calls) {
      const callee = call.callee.form === 'variable' ? tasks.get(call.callee.name) : undefined

      if (!callee) {
        continue
      }

      call.args.forEach((arg, i) => {
        const slot = callee.params[i]?.type

        if (asyncTask(slot) && arg.form === 'closure') {
          made(arg)
        }

        if (asyncTask(itemOf(slot))) {
          if (arg.form === 'variable' && pushed.has(arg.name)) {
            for (const closure of pushed.get(arg.name)!) {
              made(closure)
            }

            // the list holds async tasks too: its type is what a native backend writes for it
            for (const type of listTypes(fn.body, arg.name)) {
              asyncItems(type)
            }

            asyncItems(arg.type)
          }

          if (arg.form === 'array') {
            for (const item of arg.items) {
              if (item.form === 'closure') {
                made(item)
              }
            }

            asyncItems(arg.type)
          }
        }
      })
    }
  }
}
