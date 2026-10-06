// A ticked call's VALUE is a job (deck/base/code/task.tree): `save work, tick fetch(x)` is `spawn` of that call, a
// `handle` of what it answers, read back with `wait`. A tick as a statement is fire and forget and is left alone.
//
// Until 2026-10-05 the value had no type of its own: a `Promise` on TypeScript, the binding left to inference, and on
// Rust, Swift and Kotlin the unit their fire-and-forget calls answer, so `save work, tick fetch(x)` built and handed on
// nothing natively. A job is the pending value every backend already has, with `wait`, `wait-within`, `cancel` and
// `alive`, and it starts the call at once and runs it to its first wait, exactly as a tick does. So the value is that.
//
// Runs before names are bound, so the inserted `spawn` binds as the program's own calls do. A program that ticks a
// value and does not load the task module is refused, naming what to load.
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import type { Expression, Program, Statement, Type } from '@term/make/code/compile/node'

type Call = Extract<Expression, { form: 'call' }>

const ticked = (value: Expression | undefined): value is Call => value?.form === 'call' && value.background === true

// whether a type names one of `generics`, which only the call's own inference can fill
function mentions(type: Type, generics: Set<string>): boolean {
  switch (type.kind) {
    case 'named':
      return generics.has(type.name) || (type.args ?? []).some(arg => mentions(arg, generics))
    case 'array':
      return mentions(type.element, generics)
    case 'map':
      return mentions(type.key, generics) || mentions(type.value, generics)
    case 'function':
      return type.params.some(p => mentions(p, generics)) || mentions(type.result, generics)
    default:
      return false
  }
}

// the program it rewrote (in place, here) beside the refusals: the Term port hands the rewritten program back, since a
// native value is a copy, and compile.ts takes it from the answer either way
export function pendingValues(program: Program, file: string): { program: Program; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const canSpawn = program.some(n => n.form === 'function' && n.name === 'spawn' && n.params.length === 1)
  const tasks = new Map<string, Extract<Statement, { form: 'function' }>[]>()

  for (const n of program) {
    if (n.form === 'function') {
      tasks.set(n.name, [...(tasks.get(n.name) ?? []), n])
    }
  }

  // what the ticked call answers, when it calls one task whose declared result is concrete: the closure says so, so
  // the job's `handle r` is pinned. A closure with no result is read as answering the unknown
  const answerOf = (call: Call): Type | undefined => {
    const named = call.callee.form === 'variable' ? tasks.get(call.callee.name) : undefined
    const one = named?.length === 1 ? named[0] : undefined

    return one?.result && !mentions(one.result, new Set(one.generics.map(g => g.name))) ? structuredClone(one.result) : undefined
  }

  // `spawn(task / mark async / back <the call>)`
  const spawnOf = (call: Call): Expression => {
    const started: Call = { ...call, background: false }
    const result = answerOf(call)

    return {
      form: 'call',
      callee: { form: 'variable', name: 'spawn', span: call.span },
      args: [
        {
          form: 'closure',
          params: [],
          // awaited as written: outside every task (a ticked `host`) nothing awaits a closure's calls for it, and
          // inside one this is the await resolution would write
          body: [{ form: 'return', value: { form: 'await', expr: started, span: call.span }, span: call.span }],
          ...(result ? { result } : {}),
          async: true,
          span: call.span,
        },
      ],
      span: call.span,
    }
  }

  // the value at a position, the pending job where it is a tick
  const value = (expr: Expression): Expression => {
    walkExpression(expr)

    if (!ticked(expr)) {
      return expr
    }

    if (!canSpawn) {
      diagnostics.push(
        diagnose('unknown-name', {
          file,
          span: expr.span,
          message: 'a ticked call used as a value is the pending job, a `handle` of its answer: load @term/base/task and find spawn',
          hint: 'or tick it on a line of its own, where nothing waits for it',
        }),
      )

      return expr
    }

    return spawnOf(expr)
  }

  function walkExpression(expr: Expression): void {
    switch (expr.form) {
      case 'call':
        expr.args = expr.args.map(value)
        walkExpression(expr.callee)
        break
      case 'binary':
        walkExpression(expr.left)
        walkExpression(expr.right)
        break
      case 'unary':
        walkExpression(expr.operand)
        break
      case 'array':
        expr.items = expr.items.map(value)
        break
      case 'map':
        expr.entries = expr.entries.map(entry => ({ ...entry, value: value(entry.value) }))
        break
      case 'record':
        expr.fields = expr.fields.map(field => ({ ...field, value: value(field.value) }))
        break
      case 'member':
        walkExpression(expr.target)
        break
      case 'await':
        walkExpression(expr.expr)
        break
      case 'closure':
        walkBody(expr.body)
        break
      case 'conditional':
        for (const branch of expr.branches) {
          walkExpression(branch.cond)
          walkExpression(branch.value)
        }

        if (expr.otherwise) {
          walkExpression(expr.otherwise)
        }

        break
      default:
        break
    }
  }

  function walkBody(body: Statement[]): void {
    for (const statement of body) {
      walkStatement(statement)
    }
  }

  function walkStatement(statement: Statement): void {
    switch (statement.form) {
      case 'let':
        statement.init = value(statement.init)
        break
      case 'assign':
        statement.value = value(statement.value)
        break
      case 'return':
        if (statement.value) {
          statement.value = value(statement.value)
        }

        break
      // a tick on a line of its own is fire and forget: only what it is handed is looked at
      case 'expression':
        walkExpression(statement.expr)
        break
      case 'if':
        statement.branches.forEach(branch => {
          walkExpression(branch.cond)
          walkBody(branch.body)
        })

        if (statement.otherwise) {
          walkBody(statement.otherwise)
        }

        break
      case 'while':
        walkExpression(statement.cond)
        walkBody(statement.body)
        break
      case 'for-each':
        walkExpression(statement.iterable)
        walkBody(statement.body)
        break
      case 'match':
        walkExpression(statement.subject)
        statement.cases.forEach(arm => walkBody(arm.body))

        if (statement.otherwise) {
          walkBody(statement.otherwise)
        }

        break
      case 'guard':
        walkBody(statement.body)

        if (statement.catch) {
          walkBody(statement.catch.body)
        }

        break
      case 'function':
        walkBody(statement.body)
        break
      default:
        break
    }
  }

  walkBody(program)

  return { program, diagnostics }
}
