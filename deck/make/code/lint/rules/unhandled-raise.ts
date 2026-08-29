// L041: a call to a task that can raise, outside any guard, with no `halt kink` under it. The call passes the callee's
// exception on to the caller without saying so; `halt kink` says so, and `note unsafe` / `halt take` handles it
// (note/term/hive/04-reach.md, the open diagnostic; note/term/hive/11-native-exceptions.md). Advice, not an error:
// the stdlib was written before the word existed, so the count on it is the measure of the migration, and a call
// whose only exception is `failure` (a native shim's, which any foreign call can raise) is left alone.

import type { Program, Statement, Expression } from '@term/make/code/compile/node'
import type { LintContext, LintNode, Rule } from '@term/make/code/lint/rule'
import { raiseSets } from '@term/make/code/check/effects'
import { EXCEPTION_FORM } from '@term/make/code/check/extend'

type Raises = Map<string, Set<string>>

const raisesOf = new WeakMap<Program, Raises>()

function raises(program: Program): Raises {
  const known = raisesOf.get(program)

  if (known) {
    return known
  }

  const exceptions = new Set<string>()

  for (const s of program) {
    if (s.form === 'record-type' && s.chain?.includes(EXCEPTION_FORM)) {
      exceptions.add(s.name)
    }
  }

  const sets = raiseSets(program, exceptions).raises
  raisesOf.set(program, sets)

  return sets
}

export const unhandledRaise: Rule = {
  name: 'unhandled-raise',
  code: 'L041',
  severity: 'warning',
  docs: 'a call to a task that can raise, outside a guard and without `halt kink`, passes the exception on without saying so',
  fixable: false,
  check(target: LintNode, context: LintContext): void {
    if (target.kind !== 'statement' || target.node.form !== 'function') {
      return
    }

    const sets = raises(context.program)

    const visitExpression = (node: Expression, guarded: boolean): void => {
      switch (node.form) {
        case 'call': {
          if (node.callee.form === 'variable' && !guarded && !node.propagate) {
            const set = sets.get(node.callee.name)
            const named = set ? [...set].filter(e => e !== 'failure').sort() : []

            if (named.length > 0) {
              context.report({
                message: `"${node.callee.name}" can raise ${named.join(', ')}: handle it with note unsafe / halt take, or pass it on with halt kink`,
                span: node.span,
              })
            }
          }

          visitExpression(node.callee, guarded)
          node.args.forEach(a => visitExpression(a, guarded))
          break
        }
        case 'binary':
          visitExpression(node.left, guarded)
          visitExpression(node.right, guarded)
          break
        case 'unary':
          visitExpression(node.operand, guarded)
          break
        case 'member':
          visitExpression(node.target, guarded)
          break
        case 'await':
          visitExpression(node.expr, guarded)
          break
        case 'array':
          node.items.forEach(i => visitExpression(i, guarded))
          break
        case 'map':
          node.entries.forEach(e => {
            visitExpression(e.key, guarded)
            visitExpression(e.value, guarded)
          })
          break
        case 'record':
          node.fields.forEach(f => visitExpression(f.value, guarded))
          break
        case 'template':
          node.parts.forEach(p => {
            if (typeof p !== 'string') {
              visitExpression(p, guarded)
            }
          })
          break
        case 'conditional':
          node.branches.forEach(b => {
            visitExpression(b.cond, guarded)
            visitExpression(b.value, guarded)
          })

          if (node.otherwise) {
            visitExpression(node.otherwise, guarded)
          }

          break
        case 'closure':
          // a closure runs later, under whoever calls it: its own calls are judged there
          break
        default:
          break
      }
    }

    const visitStatements = (body: Statement[], guarded: boolean): void => {
      for (const s of body) {
        switch (s.form) {
          case 'let':
            visitExpression(s.init, guarded)
            break
          case 'assign':
            visitExpression(s.target, guarded)
            visitExpression(s.value, guarded)
            break
          case 'expression':
            visitExpression(s.expr, guarded)
            break
          case 'return':
            if (s.value) {
              visitExpression(s.value, guarded)
            }

            break
          case 'throw':
            visitExpression(s.value, guarded)
            break
          case 'hold':
            visitExpression(s.expr, guarded)
            break
          case 'while':
            visitExpression(s.cond, guarded)
            visitStatements(s.body, guarded)
            break
          case 'for-each':
            visitExpression(s.iterable, guarded)
            visitStatements(s.body, guarded)
            break
          case 'if':
            s.branches.forEach(b => {
              visitExpression(b.cond, guarded)
              visitStatements(b.body, guarded)
            })
            if (s.otherwise) {
              visitStatements(s.otherwise, guarded)
            }

            break
          case 'match':
            visitExpression(s.subject, guarded)
            s.cases.forEach(c => visitStatements(c.body, guarded))

            if (s.otherwise) {
              visitStatements(s.otherwise, guarded)
            }

            break
          case 'guard':
            // the body is handled by the handler, or by nothing (a guard with no handler catches everything)
            visitStatements(s.body, true)

            if (s.catch) {
              visitStatements(s.catch.body, guarded)
            }

            break
          default:
            break
        }
      }
    }

    visitStatements(target.node.body, false)
  },
}
