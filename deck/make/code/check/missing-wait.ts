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
//
// A BIND is the other host code that answers a promise. One marked `mark async` is waited like an async task
// (decision 053 of note/project/term/self-host/change/001-finish-self-host, check/async-resolve.tree), so its calls
// are awaits by now. One left unmarked may hand its promise on as a VALUE to more host code (a work queue, a promise
// kept and waited later), which is right, so the bind itself is never refused. What is never right is reading a FIELD
// off its promise, which is how `term make --merged` died (traps T-0334). `checkUnwaitedBindReads` refuses that read
// where it can tell: the bind's TypeScript-family text answers a promise by its outermost shape (`promiseText`), and
// the field is read off the call, off a local saved from it, or off a call to a task that is not async and hands such
// a call `back`, to a fixed point. Anything else that answers a promise is known only by its `mark async`.

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
  return [...checkPromiseModuleCalls(program, file), ...checkUnwaitedBindReads(program, file)]
}

// the host environments whose bind text is TypeScript, where a promise is a value the text can answer
const SCRIPT_ENVS = new Set(['node', 'browser', 'javascript', 'cloudflare', 'typescript', 'deno', 'bun', 'worker'])

// a promise's own members, which are read off a promise on purpose
const PROMISE_MEMBERS = new Set(['then', 'catch', 'finally'])

// the index of the bracket that closes the one opened at `open`, skipping quoted text, or -1
function closing(text: string, open: number): number {
  let depth = 0
  let quote = ''

  for (let i = open; i < text.length; i++) {
    const c = text[i]

    if (quote) {
      if (c === '\\') {
        i++
      } else if (c === quote) {
        quote = ''
      }

      continue
    }

    if (c === '"' || c === "'" || c === '`') {
      quote = c
    } else if (c === '(' || c === '[' || c === '{') {
      depth++
    } else if (c === ')' || c === ']' || c === '}') {
      depth--

      if (depth === 0) {
        return i
      }
    }
  }

  return -1
}

// the index of the bracket that opens the one closing at `close`, skipping quoted text, or -1
function opening(text: string, close: number): number {
  let depth = 0
  let quote = ''

  for (let i = close; i >= 0; i--) {
    const c = text[i]

    if (quote) {
      if (c === quote && text[i - 1] !== '\\') {
        quote = ''
      }

      continue
    }

    if (c === '"' || c === "'" || c === '`') {
      quote = c
    } else if (c === ')' || c === ']' || c === '}') {
      depth++
    } else if (c === '(' || c === '[' || c === '{') {
      depth--

      if (depth === 0) {
        return i
      }
    }
  }

  return -1
}

// Whether a bind's host text answers a promise, by its outermost shape: `new Promise(...)`, `Promise.resolve(...)` and
// its siblings, `fetch(...)`, `import(...)`, or a chain whose last call is `.then`, `.catch` or `.finally`. A text in
// parentheses is read inside them. A text that starts with `void` answers nothing, and one that starts with `await`
// answers what it waited for. Anything else is not known to answer a promise
export function promiseText(text: string): boolean {
  const t = text.trim()

  if (t === '' || /^(void|await)\b/.test(t)) {
    return false
  }

  if (t.startsWith('(') && closing(t, 0) === t.length - 1) {
    return promiseText(t.slice(1, -1))
  }

  if (!t.endsWith(')')) {
    return false
  }

  const open = opening(t, t.length - 1)

  if (open <= 0) {
    return false
  }

  const head = t.slice(0, open).trimEnd()

  if (/^(new\s+Promise|Promise\.(resolve|reject|all|allSettled|race|any)|fetch|import)$/.test(head)) {
    return true
  }

  return /\.\s*(then|catch|finally)$/.test(head)
}

type Bound = Extract<Statement, { form: 'bind' }>

// Refuse a field read off the promise an unmarked bind answers (the header above, decision 053)
export function checkUnwaitedBindReads(program: Program, file?: string): Diagnostic[] {
  // the unmarked binds whose text answers a promise on a TypeScript-family host
  const promising = new Set<string>()

  for (const statement of program) {
    if (statement.form !== 'bind') {
      continue
    }

    const bind = statement as Bound

    if (!bind.async && bind.targets.some(t => SCRIPT_ENVS.has(t.env) && promiseText(t.expression))) {
      promising.add(bind.name)
    }
  }

  if (promising.size === 0) {
    return []
  }

  const calleeName = (value: unknown): string | undefined => {
    if (!isNode(value) || value.form !== 'call' || value.background) {
      return undefined
    }

    const callee = value.callee

    return isNode(callee) && callee.form === 'variable' && typeof callee.name === 'string' ? callee.name : undefined
  }

  // what hands on such a promise: the binds, then each task that is not async and gives `back` a call to one, to a
  // fixed point (the T-0334 shape: a plain task answering `pool-after(...)`)
  const handsBack = (value: unknown, names: Set<string>): boolean => {
    if (Array.isArray(value)) {
      return value.some(v => handsBack(v, names))
    }

    if (!isNode(value) || value.form === 'closure' || value.form === 'function') {
      return false
    }

    if (value.form === 'return') {
      const name = calleeName(value.value)

      return name !== undefined && names.has(name)
    }

    return Object.entries(value).some(([key, child]) => key !== 'span' && key !== 'type' && handsBack(child, names))
  }

  const promised = new Set(promising)
  let changed = true

  while (changed) {
    changed = false

    for (const statement of program) {
      if (statement.form === 'function' && !statement.async && !promised.has(statement.name) && handsBack(statement.body, promised)) {
        promised.add(statement.name)
        changed = true
      }
    }
  }

  const out: Diagnostic[] = []

  // a call to one of `promised`, unawaited, and not shadowed by a local or parameter of its name
  const promiseCall = (value: unknown, shadow: Set<string>): string | undefined => {
    const name = calleeName(value)

    return name !== undefined && promised.has(name) && !shadow.has(name) ? name : undefined
  }

  // `held` maps a local saved from such a call to the name of what it called
  const walk = (value: unknown, at: string, shadow: Set<string>, held: Map<string, string>): void => {
    if (Array.isArray(value)) {
      value.forEach(v => walk(v, at, shadow, held))
      return
    }

    if (!isNode(value)) {
      return
    }

    switch (value.form) {
      case 'function':
      case 'closure': {
        const inner = new Set([...shadow, ...bound(value.params)])
        const at2 = value.form === 'function' ? (value.span as Span | undefined)?.file || at : at
        walk(value.body, at2, inner, new Map())
        return
      }

      case 'let': {
        walk(value.init, at, shadow, held)

        if (typeof value.name === 'string') {
          const from = promiseCall(value.init, shadow)

          if (from) {
            held.set(value.name, from)
          } else {
            held.delete(value.name)
          }
        }

        return
      }

      case 'assign': {
        walk(value.value, at, shadow, held)

        const target = value.target

        if (isNode(target) && target.form === 'variable' && typeof target.name === 'string') {
          const from = promiseCall(value.value, shadow)

          if (from) {
            held.set(target.name, from)
          } else {
            held.delete(target.name)
          }
        }

        return
      }

      case 'member': {
        const target = value.target
        let from: string | undefined

        if (isNode(target) && target.form === 'variable' && typeof target.name === 'string') {
          from = held.get(target.name)
        } else {
          from = promiseCall(target, shadow)
        }

        if (from && typeof value.name === 'string' && !PROMISE_MEMBERS.has(value.name)) {
          out.push(
            diagnose('missing-wait', {
              file: at || file || '',
              span: value.span as Span,
              message: `"${value.name}" is read off the promise "${from}" answers, and nothing waits for it, so the read finds nothing. Mark the bind that answers the promise \`mark async\`, so every call to it is waited, or write \`wait\` on the call`,
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

      walk(child, at, shadow, held)
    }
  }

  for (const statement of program) {
    if (statement.form === 'function') {
      walk(statement, '', new Set<string>(), new Map())
    }
  }

  return out
}

// the names a body binds, which shadow a module's alias or a bind's name inside it
function bound(params: unknown): Set<string> {
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

// a call into a `.../promises` dock module, neither waited nor ticked (the header above, decision 004)
function checkPromiseModuleCalls(program: Program, file?: string): Diagnostic[] {
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
