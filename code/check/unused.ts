// Unused-binding warnings: a `let`/`save` binding that is never read is reported as a warning (not an error, so
// it does not fail compilation). A usability nicety. See note/research/vibe/computation/plans/04-typecheck.md.

import type { Diagnostic } from '@/code/parser/diagnostic'
import { diagnose } from '@/code/parser/diagnostic'
import type {
  Expression,
  Program,
  Statement,
} from '@/code/compile/node'

function collectReads(expr: Expression, read: Set<string>): void {
  switch (expr.form) {
    case 'variable':
      read.add(expr.name)
      break
    case 'binary':
      collectReads(expr.left, read)
      collectReads(expr.right, read)
      break
    case 'unary':
      collectReads(expr.operand, read)
      break
    case 'await':
      collectReads(expr.expr, read)
      break
    case 'member':
      collectReads(expr.target, read)
      break
    case 'call':
      collectReads(expr.callee, read)
      for (const arg of expr.args) collectReads(arg, read)
      break
    case 'array':
      for (const item of expr.items) collectReads(item, read)
      break
    case 'map':
      for (const entry of expr.entries) {
        collectReads(entry.key, read)
        collectReads(entry.value, read)
      }
      break
    case 'record':
      for (const field of expr.fields) collectReads(field.value, read)
      break
    default:
      break
  }
}

function walk(
  body: Array<Statement>,
  declared: Map<string, Statement>,
  read: Set<string>,
): void {
  for (const statement of body) {
    switch (statement.form) {
      case 'let':
        collectReads(statement.init, read)
        // a re-`save` to an existing name counts as a use of the binding's slot; only record first declaration
        if (!declared.has(statement.name))
          declared.set(statement.name, statement)
        break
      case 'assign':
        collectReads(statement.target, read)
        collectReads(statement.value, read)
        break
      case 'expression':
        collectReads(statement.expr, read)
        break
      case 'return':
        if (statement.value) collectReads(statement.value, read)
        break
      case 'throw':
        collectReads(statement.value, read)
        break
      case 'hold':
        collectReads(statement.expr, read)
        break
      case 'while':
        collectReads(statement.cond, read)
        walk(statement.body, declared, read)
        break
      case 'for-each':
        collectReads(statement.iterable, read)
        walk(statement.body, declared, read)
        break
      case 'match':
        collectReads(statement.subject, read)
        for (const branch of statement.cases)
          walk(branch.body, declared, read)
        if (statement.otherwise)
          walk(statement.otherwise, declared, read)
        break
      case 'if':
        for (const branch of statement.branches) {
          collectReads(branch.cond, read)
          walk(branch.body, declared, read)
        }
        if (statement.otherwise)
          walk(statement.otherwise, declared, read)
        break
      default:
        break
    }
  }
}

export function findUnused(
  program: Program,
  file: string,
): Array<Diagnostic> {
  const warnings: Array<Diagnostic> = []
  for (const statement of program) {
    if (statement.form !== 'function') continue
    const declared = new Map<string, Statement>()
    const read = new Set<string>()
    walk(statement.body, declared, read)
    for (const [name, decl] of declared) {
      if (!read.has(name)) {
        warnings.push(
          diagnose('unused-binding', {
            file,
            span: decl.span,
            message: `"${name}" is never used`,
          }),
        )
      }
    }
  }
  return warnings
}
