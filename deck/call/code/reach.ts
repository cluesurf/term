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
//
// The search, those rules and the walk over a body are Term since 2026-10-06, call/code/reach-graph.tree. This face reads
// and mills each file once, keeps it, and hands the port the module a file or a load is.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { analyze } from '@term/make/code/analyze'
import type { Program, Statement } from '@term/make/code/compile/node'
import { importFindsOf, makeParseMemo } from '@term/make/code/compile/load'
import type { Resolver } from '@term/make/code/compile/load'
import { withNativeEnv } from '@term/make/code/compile/native'
import { projectResolver } from '@term/call/code/make'
import * as port from '@term/call/code/reach-graph'
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

  // the search, the scope rules and the walk over each body are Term (call/code/reach-graph.tree). It asks this face
  // for the modules, which are read and milled once here and kept
  const asked = (importPath: string, from: string): port.Maybe<port.ReachModule> => {
    const found = loaded(importPath, from)

    return found ? { form: 'some', value: found } : { form: 'none' }
  }

  return {
    reachAt(file: string, line: number): string[] {
      const start = moduleOf(file)

      return start ? port.reachAt(start, line, asked) : []
    },
  }
}

// the file a roll site names (`code/save.tree:12:1`), under the root it is relative to
export function siteFile(root: string, site: string): { file: string; line: number } | undefined {
  const parts = port.sitePartsOf(site)

  return parts.line !== '' ? { file: path.resolve(root, parts.file), line: Number(parts.line) } : undefined
}
