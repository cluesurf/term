// A MISSING `wait` ON A HOST CALL THAT ANSWERS A PROMISE (term/compiler decision 004, guides: language/async gap 151,
// architecture/language/async gap 56).
//
// The build cannot see inside a host module, so a call into a `dock load` module is awaited only where the program
// says so: `wait` on the call, `mark async` under the module's load line, or `find <name>` / `mark async` for one
// function. Left out, the promise itself was handed on as the answer, and the program printed `undefined` where a
// length belonged, with nothing said.
//
// What the build CAN know is a module that answers promises from every function by its own name: Node's
// `<node:fs/promises>`, `<node:timers/promises>`, `<node:dns/promises>` and the rest, every module path whose last
// segment is `promises`. A call into one of those is refused as `missing-wait` unless
//
//   - it is awaited (`wait`, or the load line's `mark async`, which `resolveAsync` turned into an await before this runs)
//   - it is started with `tick`, which keeps the promise on purpose
//   - it is the whole value a task or closure that is async gives `back`: an async function's own promise takes the
//     value of a promise returned from it, so `back fs/read-file(path)` in a `mark async` task answers the text
//
// A module the build cannot name this way stays the program's to mark. Runs after `resolveAsync`, on the merged
// program, so every await the inference wrote is in place.

import type { Program, Statement } from '@term/make/code/compile/node'
import { diagnose } from '@term/make/code/parser/diagnostic'
import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'

type Native = Extract<Statement, { form: 'native' }>

// a host module whose every function answers a promise, known by its path
export function answersPromises(module: string): boolean {
  const path = module.replace(/^[a-z]+:/, '')

  return path === 'promises' || path.endsWith('/promises')
}

type Node = { form?: unknown; [key: string]: unknown }

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null

export function checkMissingWaits(program: Program, file?: string): Diagnostic[] {
  // the aliases of promise modules per file, and the files where an alias names something else, so one file's `fs`
  // for `<node:fs/promises>` is never read into another file's `fs` for `<node:fs>`
  const promised = new Map<string, Set<string>>()
  const plain = new Map<string, Set<string>>()

  const add = (table: Map<string, Set<string>>, at: string, alias: string): void => {
    const set = table.get(at) ?? new Set<string>()
    set.add(alias)
    table.set(at, set)
  }

  for (const statement of program) {
    if (statement.form !== 'native' || statement.kind === 'type') {
      continue
    }

    const native = statement as Native
    const at = native.file || native.span?.file || ''
    add(native.async || !answersPromises(native.module) ? plain : promised, at, native.alias)
  }

  if (promised.size === 0) {
    return []
  }

  // the promise module an alias names in `at`: its own file's dock, else one dock anywhere when no file disagrees
  const promiseAlias = (at: string, alias: string): boolean => {
    if (promised.get(at)?.has(alias)) {
      return true
    }

    if (plain.get(at)?.has(alias)) {
      return false
    }

    return [...promised.values()].some(s => s.has(alias)) && ![...plain.values()].some(s => s.has(alias))
  }

  const out: Diagnostic[] = []

  // the alias and member a call goes into, `fs-promise/read-file`
  const target = (call: Node): { alias: string; name: string } | undefined => {
    const callee = call.callee

    if (!isNode(callee) || callee.form !== 'member' || !isNode(callee.target) || callee.target.form !== 'variable') {
      return undefined
    }

    return { alias: String(callee.target.name), name: String(callee.name) }
  }

  // the names a body binds, which shadow a module's alias inside it
  const bound = (params: unknown): Set<string> => {
    const names = new Set<string>()

    if (Array.isArray(params)) {
      for (const p of params) {
        if (isNode(p) && typeof p.name === 'string') {
          names.add(p.name)
        }
      }
    }

    return names
  }

  // `exempt` is the one call node here that may stay a promise: under an await, a tick, or an async function's `back`
  const walk = (value: unknown, at: string, async: boolean, shadow: Set<string>, exempt: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(v => walk(v, at, async, shadow, undefined))
      return
    }

    if (!isNode(value)) {
      return
    }

    switch (value.form) {
      case 'function': {
        const inner = new Set([...shadow, ...bound(value.params)])
        walk(value.body, (value.span as Span | undefined)?.file || at, Boolean(value.async), inner, undefined)
        return
      }

      case 'closure': {
        const inner = new Set([...shadow, ...bound(value.params)])
        walk(value.body, at, Boolean(value.async), inner, undefined)
        return
      }

      case 'let':
        if (typeof value.name === 'string') {
          shadow.add(value.name)
        }

        break

      case 'await':
        walk(value.expr, at, async, shadow, value.expr)
        return

      case 'return':
        walk(value.value, at, async, shadow, async ? value.value : undefined)
        return

      case 'call': {
        const into = target(value)

        if (
          into &&
          value !== exempt &&
          !value.background &&
          !shadow.has(into.alias) &&
          promiseAlias(at, into.alias)
        ) {
          out.push(
            diagnose('missing-wait', {
              // the call's own file, else the build's entry file, else none known (a diagnostic's file is a text)
              file: at || file || '',
              span: value.span as Span,
              message: `"${into.alias}/${into.name}" answers a promise, and nothing waits for it, so the promise itself is handed on as the answer. Write \`wait ${into.alias}/${into.name}(...)\`, \`tick\` to start it without waiting, or \`mark async\` under the load line of "${into.alias}"`,
            }),
          )
        }

        break
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === 'span' || key === 'type' || key === 'form') {
        continue
      }

      walk(child, at, async, shadow, undefined)
    }
  }

  for (const statement of program) {
    if (statement.form === 'function') {
      walk(statement, '', false, new Set<string>(), undefined)
    }
  }

  return out
}
