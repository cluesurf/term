// Keep a task apart from a docked module of the same name, for the backends where the two cannot share one.
//
// `native/<platform>/log.tree` docks its runtime module as `log` and calls `log/write-warn`, and `console` defines a
// task `log`. Rust holds both (a module and a function live in different namespaces), and TypeScript emits the dock
// under its import. Swift refuses `enum log` beside `func log` ("invalid redeclaration"), and Kotlin reads `log.writeInfo`
// on the function `log`. So a program loading `console`'s `log` beside `log`'s `warn` built on node and Rust and failed
// on Swift and Kotlin (guides: library/processes, 2026-10-04).
//
// The task is renamed, never the module: the module's name is its runtime shim's, fixed in the prelude. A reference is
// renamed where it is a call's callee or the checker bound it to the task (`binding.kind` 'function'), so a dock
// reference, always the target of a member, keeps its name.
// `__task` cannot collide with a Term name, which never holds an underscore.

import type { Program } from '@term/make/code/compile/node'

export function keepDocksApart(program: Program): Program {
  const docks = new Set(
    program.flatMap(s => (s.form === 'native' && s.kind !== 'type' ? [s.alias] : [])),
  )
  const clashing = new Set(
    program.flatMap(s => (s.form === 'function' && docks.has(s.name) ? [s.name] : [])),
  )

  if (clashing.size === 0) {
    return program
  }

  const renamed = (name: string): string => `${name}__task`

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(walk)
    }

    if (typeof value !== 'object' || value === null) {
      return value
    }

    const node = value as Record<string, unknown> & { form?: string; name?: unknown; binding?: { kind?: string } }
    const out: Record<string, unknown> = {}

    for (const [key, child] of Object.entries(node)) {
      out[key] = key === 'span' ? child : walk(child)
    }

    if (typeof node.name === 'string' && clashing.has(node.name)) {
      if (node.form === 'function' || (node.form === 'variable' && node.binding?.kind === 'function')) {
        out.name = renamed(node.name)
      }
    }

    // a call's callee is the task: a dock is reached only through a member (`log/write-warn`), never called itself,
    // and a callee does not always carry its binding
    const callee = node.form === 'call' ? (out.callee as { form?: string; name?: unknown } | undefined) : undefined

    if (callee?.form === 'variable' && typeof callee.name === 'string' && clashing.has(callee.name)) {
      out.callee = { ...callee, name: renamed(callee.name) }
    }

    return out
  }

  return walk(program) as Program
}
