// WHAT A TASK CAN TOUCH: the native modules (`dock load <node:fs/promises>`) its calls reach, through every task it
// calls, in its own deck and in every deck it loads. The roll says what a task can RAISE, and this says what it can DO,
// so `term roll --diff` can report that a change gave a task the file system or the network, which is the question a
// reviewer of code they did not write needs answered first.
//
// Read off each file milled alone (make/code/analyze.ts), followed by MODULE SCOPE: a call binds to the file's own
// definition of the name, else to the definition in the module its `find` came from (through that module's `bear`
// chain), with `{platform}` filled for node as `term make` fills it. Two things make it an OVER-approximation, which is
// the safe direction for a capability report: a name with several definitions in one module (an arity overload) reaches
// what any of them reaches, and a method called on a value (`x/send()`) reaches what every method of that name does in
// the modules the file loads, since which form the value has is the checker's to say.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { analyze } from '@term/make/code/analyze'
import type { Program, Statement } from '@term/make/code/compile/node'
import { importFindsOf, makeParseMemo } from '@term/make/code/compile/load'
import type { Resolver } from '@term/make/code/compile/load'
import { withNativeEnv } from '@term/make/code/compile/native'
import { forEachExpression } from '@term/flow/code/symbols'
import { projectResolver } from '@term/call/code/make'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'

type Task = Extract<Statement, { form: 'function' }>

// one file as the graph reads it: its tasks by name, the native modules it docks by alias, and what each found name
// came from
type Module = {
  file: string
  tasks: Map<string, Task[]>
  // a method's own name to the tasks that define it, for a call on a value
  methods: Map<string, Task[]>
  natives: Map<string, string>
  // a name as this file uses it to the module path and the name that module defines it under
  finds: Map<string, { path: string; real: string }>
  // the modules this file passes on with `bear`, whose names it answers for
  bears: string[]
  // every module this file loads, where a method called on a value may be defined
  loads: string[]
}

export type ReachGraph = {
  // the native modules the task defined at a line of a file reaches (one-based, as a roll site counts), sorted. A line
  // no task starts on reaches nothing
  reachAt(file: string, line: number): string[]
}

export function reachGraph(root: string): ReachGraph {
  const roleOf = projectRoleOf(root)
  const leanOf = projectLeanOf(root)
  const resolve: Resolver = withNativeEnv('node', projectResolver(root, 'node', root))
  const parsed = makeParseMemo()
  const modules = new Map<string, Module | undefined>()

  const moduleOf = (file: string, given?: string): Module | undefined => {
    if (modules.has(file)) {
      return modules.get(file)
    }

    // marked before it is read, so a cycle of loads meets an empty answer rather than recursing
    modules.set(file, undefined)

    let text = given

    try {
      text ??= readFileSync(file, 'utf8')
    } catch {
      return undefined
    }

    const program: Program | null = analyze({ file, text }, { role: roleOf(file), lean: leanOf(file) ?? false }).program

    if (!program) {
      return undefined
    }

    const one: Module = { file, tasks: new Map(), methods: new Map(), natives: new Map(), finds: new Map(), bears: [], loads: [] }

    for (const statement of program) {
      if (statement.form === 'function') {
        one.tasks.set(statement.name, [...(one.tasks.get(statement.name) ?? []), statement])

        if (statement.method) {
          one.methods.set(statement.method.name, [...(one.methods.get(statement.method.name) ?? []), statement])
        }
      } else if (statement.form === 'native') {
        one.natives.set(statement.alias, statement.module)
      }
    }

    for (const find of importFindsOf({ file, text }, parsed)) {
      one.loads.push(find.path)

      if (find.bear) {
        one.bears.push(find.path)
      }

      // under the alias it was found by and under its own name, which is what the mill writes an aliased call as
      find.names.forEach((real, at) => {
        one.finds.set(find.aliases[at] ?? real, { path: find.path, real })

        if (!one.finds.has(real)) {
          one.finds.set(real, { path: find.path, real })
        }
      })
    }

    modules.set(file, one)

    return one
  }

  const loaded = (importPath: string, from: string): Module | undefined => {
    const source = resolve(importPath, from)

    return source ? moduleOf(source.file, source.text) : undefined
  }

  // the tasks a module answers for under `name`: its own, else what its `bear` chain passes on
  const answering = (one: Module, name: string, depth = 0): { module: Module; tasks: Task[] }[] => {
    const own = one.tasks.get(name)

    if (own?.length) {
      return [{ module: one, tasks: own }]
    }

    if (depth > 16) {
      return []
    }

    return one.bears.flatMap(bear => {
      const next = loaded(bear, one.file)

      return next ? answering(next, name, depth + 1) : []
    })
  }

  // where a call of `name` in a file lands: the file's own definition, else the one its `find` reached
  const callees = (one: Module, name: string): { module: Module; tasks: Task[] }[] => {
    const own = one.tasks.get(name)

    if (own?.length) {
      return [{ module: one, tasks: own }]
    }

    const find = one.finds.get(name)
    const from = find ? loaded(find.path, one.file) : undefined

    return from && find ? answering(from, find.real) : []
  }

  // where a method called on a value may land: a method of that name in the file or in any module it loads
  const methodCallees = (one: Module, name: string): { module: Module; tasks: Task[] }[] => {
    const found: { module: Module; tasks: Task[] }[] = []
    const own = one.methods.get(name)

    if (own?.length) {
      found.push({ module: one, tasks: own })
    }

    for (const load of one.loads) {
      const next = loaded(load, one.file)
      const there = next?.methods.get(name)

      if (next && there?.length) {
        found.push({ module: next, tasks: there })
      }
    }

    return found
  }

  return {
    reachAt(file: string, line: number): string[] {
      const start = moduleOf(file)

      if (!start) {
        return []
      }

      const reached = new Set<string>()
      const visited = new Set<string>()
      const queue: { module: Module; task: Task }[] = [...start.tasks.values()]
        .flat()
        .filter(one => one.span.start.line + 1 === line)
        .map(one => ({ module: start, task: one }))

      while (queue.length) {
        const { module, task: current } = queue.pop()!
        const key = `${module.file}\0${current.name}\0${current.span.start.line}`

        if (visited.has(key)) {
          continue
        }

        visited.add(key)

        const follow = (found: { module: Module; tasks: Task[] }[]): void => {
          for (const each of found) {
            for (const next of each.tasks) {
              queue.push({ module: each.module, task: next })
            }
          }
        }

        forEachExpression([current], node => {
          // a docked module named anywhere in the body: called, read off, or passed on
          if (node.form === 'variable' && module.natives.has(node.name)) {
            reached.add(module.natives.get(node.name)!)

            return
          }

          if (node.form === 'call' && node.callee.form === 'variable' && !module.natives.has(node.callee.name)) {
            follow(callees(module, node.callee.name))
          } else if (node.form === 'call' && node.callee.form === 'member' && !(node.callee.target.form === 'variable' && module.natives.has(node.callee.target.name))) {
            follow(methodCallees(module, node.callee.name))
          } else if (node.form === 'variable') {
            // a task passed as a value is a task that may be called
            follow(callees(module, node.name))
          }
        })
      }

      return [...reached].sort()
    },
  }
}

// the file a roll site names (`code/save.tree:12:1`), under the root it is relative to
export function siteFile(root: string, site: string): { file: string; line: number } | undefined {
  const match = /^(.*):(\d+):(\d+)$/.exec(site)

  return match ? { file: path.resolve(root, match[1]!), line: Number(match[2]) } : undefined
}
