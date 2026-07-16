/**
 * Codegen from verification results: turn a synthesized expression
 * into REAL Seed `.tree` source - a compilable `task`. This is the
 * "codegen system from that results" the system is for: a spec goes
 * in, a verified body is synthesized, and here it comes out as actual
 * Seed code the compiler accepts. The loop closes on real source, not
 * an internal representation.
 *
 * The emitter lowers the expression grammar to Seed: `add`/`subtract`
 * are global calls, `max`/`min` resolve through the math module (so it
 * emits the matching `load`), `ite` lowers to `fork test`. Literals are
 * `mark`, variables are `read <param>`.
 */

import type { Expr, Cond } from './synthesize'

const INDENT = '  '

/** A synthesized function to emit: a name, parameter names, and a body. */
export type SeedTask = {
  name: string
  params: string[]
  body: Expr
}

/** Emit an expression as indented `.tree` lines at the given depth. */
function emitExpr(expr: Expr, depth: number, names: string[]): string[] {
  const pad = INDENT.repeat(depth)

  switch (expr.form) {
    case 'var':
      return [`${pad}read ${names[expr.index]}`]
    case 'const':
      return [`${pad}mark ${expr.value}`]
    case 'add':
      return [`${pad}call add`, ...emitExpr(expr.left, depth + 1, names), ...emitExpr(expr.right, depth + 1, names)]
    case 'sub':
      return [`${pad}call subtract`, ...emitExpr(expr.left, depth + 1, names), ...emitExpr(expr.right, depth + 1, names)]
    case 'max':
      return [`${pad}call maximum`, ...emitExpr(expr.left, depth + 1, names), ...emitExpr(expr.right, depth + 1, names)]
    case 'min':
      return [`${pad}call minimum`, ...emitExpr(expr.left, depth + 1, names), ...emitExpr(expr.right, depth + 1, names)]
    case 'ite':
      return [
        `${pad}fork test`,
        `${pad}${INDENT}hook test`,
        ...emitCond(expr.test, depth + 2, names),
        `${pad}${INDENT}hook hold`,
        ...emitExpr(expr.then, depth + 2, names),
        `${pad}${INDENT}hook miss`,
        ...emitExpr(expr.else, depth + 2, names),
      ]
  }
}

function emitCond(cond: Cond, depth: number, names: string[]): string[] {
  const pad = INDENT.repeat(depth)
  const fn = cond.form === 'ge' ? 'is-minimum' : cond.form === 'gt' ? 'is-above' : 'is-equal'
  return [`${pad}call ${fn}`, ...emitExpr(cond.left, depth + 1, names), ...emitExpr(cond.right, depth + 1, names)]
}

/** Which math-module functions an expression uses (so we emit the load). */
function mathUses(expr: Expr, out: Set<string>): void {
  switch (expr.form) {
    case 'max':
      out.add('maximum')
      mathUses(expr.left, out)
      mathUses(expr.right, out)
      break
    case 'min':
      out.add('minimum')
      mathUses(expr.left, out)
      mathUses(expr.right, out)
      break
    case 'add':
    case 'sub':
      mathUses(expr.left, out)
      mathUses(expr.right, out)
      break
    case 'ite':
      mathUses(expr.then, out)
      mathUses(expr.else, out)
      mathUses(expr.test.left, out)
      mathUses(expr.test.right, out)
      break
    default:
      break
  }
}

/**
 * Emit a complete, compilable Seed `.tree` source for a synthesized
 * task. Includes the math `load` when needed. The body goes on its own
 * line under `send back` (the convention for complex values).
 */
export function emitSeed(task: SeedTask): string {
  const lines: string[] = []

  const uses = new Set<string>()
  mathUses(task.body, uses)
  if (uses.size > 0) {
    lines.push('load @cluesurf/seed/code/math')
    for (const fn of [...uses].sort()) lines.push(`${INDENT}find ${fn}`)
    lines.push('')
  }

  lines.push(`task ${task.name}`)
  for (const param of task.params) lines.push(`${INDENT}take ${param}, like number`)
  lines.push(`${INDENT}like number`)
  lines.push(`${INDENT}send back`)
  lines.push(...emitExpr(task.body, 2, task.params))

  return lines.join('\n') + '\n'
}
