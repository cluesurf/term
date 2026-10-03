// Every path through a task that promises a value ends by sending one back.
//
// A task whose `like` names a value, with a `hook hold` that returns and no `hook miss`, built clean, and the
// TypeScript it emitted fell out of the bottom: the caller got `undefined` where the type said text (guides:
// language/branching, 2026-10-03). Rust closes such a body with `unreachable!()`, so there it stopped at run time
// instead. Now the build refuses it as `missing-back`.
//
// A path ends when it returns, raises, stops the program, loops forever, or calls a task that itself never returns
// (one whose every path raises, such as a `refuse-...` helper). The analysis is syntactic over the built program, the
// same reading a host compiler's own return check makes, so it agrees with what each backend will accept.

import type { Program, Statement, Expression } from '@term/make/code/compile/node'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'

type Task = Extract<Statement, { form: 'function' }>

// a result type that is a value: anything but the unit
function promisesValue(task: Task): boolean {
  const result = task.result

  return (
    result !== undefined &&
    result.kind !== 'unit' &&
    !(result.kind === 'named' && (result.name === 'void' || result.name === 'unit'))
  )
}

// does a loop body leave its own loop by `halt`, at its own depth (a `halt` inside a nested loop leaves that one)
function breaksOut(body: Statement[]): boolean {
  for (const s of body) {
    switch (s.form) {
      case 'break':
        return true
      case 'if':
        if (s.branches.some(b => breaksOut(b.body)) || (s.otherwise && breaksOut(s.otherwise))) {
          return true
        }

        break
      case 'match':
        if (s.cases.some(c => breaksOut(c.body)) || (s.otherwise && breaksOut(s.otherwise))) {
          return true
        }

        break
      case 'guard':
        if (breaksOut(s.body) || (s.catch && breaksOut(s.catch.body))) {
          return true
        }

        break
      default:
        break
    }
  }

  return false
}

function calledName(expr: Expression): string | undefined {
  const inner = expr.form === 'await' ? expr.expr : expr

  return inner.form === 'call' && inner.callee.form === 'variable' ? inner.callee.name : undefined
}

// does this statement list end every path through it, given the tasks known never to return
function leaves(body: Statement[], never: Set<string>): boolean {
  return body.some(s => statementLeaves(s, never))
}

function statementLeaves(s: Statement, never: Set<string>): boolean {
  switch (s.form) {
    case 'return':
    case 'throw':
    case 'exit':
      return true
    case 'if':
      return s.otherwise !== undefined && s.branches.every(b => leaves(b.body, never)) && leaves(s.otherwise, never)
    case 'match':
      // a `fork case` with no `otherwise` names every variant, or the build already refused it as non-exhaustive.
      // A match on a caught exception is open: an exception it does not name passes on, which also leaves
      return s.cases.every(c => leaves(c.body, never)) && (s.otherwise === undefined || leaves(s.otherwise, never))
    case 'while':
      return s.cond.form === 'boolean' && s.cond.value && !breaksOut(s.body)
    case 'guard':
      return leaves(s.body, never) && (s.catch === undefined || leaves(s.catch.body, never))
    case 'expression': {
      const name = calledName(s.expr)

      return name !== undefined && never.has(name)
    }
    default:
      return false
  }
}

// tasks that never return a value: every path raises or stops, and none sends anything back
function neverReturning(program: Program): Set<string> {
  const never = new Set<string>()
  const tasks = program.filter((s): s is Task => s.form === 'function' && !s.stub && s.body.length > 0)
  let grew = true

  while (grew) {
    grew = false

    for (const task of tasks) {
      if (!never.has(task.name) && leaves(task.body, never) && !containsReturn(task.body)) {
        never.add(task.name)
        grew = true
      }
    }
  }

  return never
}

function containsReturn(body: Statement[]): boolean {
  const stack: unknown[] = [body]

  while (stack.length > 0) {
    const node = stack.pop()

    if (node === null || typeof node !== 'object') {
      continue
    }

    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }

    const record = node as Record<string, unknown>

    // a closure's or a nested task's return is its own
    if (record.form === 'closure' || record.form === 'function') {
      continue
    }

    if (record.form === 'return') {
      return true
    }

    for (const [key, child] of Object.entries(record)) {
      if (key !== 'span' && key !== 'type') {
        stack.push(child)
      }
    }
  }

  return false
}

export function checkMissingBacks(program: Program, file: string): Diagnostic[] {
  const never = neverReturning(program)
  const out: Diagnostic[] = []

  for (const s of program) {
    if (
      s.form !== 'function' ||
      s.span.file !== file ||
      s.stub ||
      s.claim ||
      s.theorem ||
      s.roam ||
      s.body.length === 0 ||
      !promisesValue(s) ||
      leaves(s.body, never)
    ) {
      continue
    }

    out.push(
      diagnose('missing-back', {
        file,
        span: s.span,
        message: `a path through \`${s.method?.name ?? s.name}\` ends without sending a value back, though it promises one`,
      }),
    )
  }

  return out
}
