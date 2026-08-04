// The static rule engine: run security rules over the milled Term AST to flag dangerous patterns in first-party
// code (the code-scanning / Semgrep equivalent, complementing the dependency audit). A rule inspects a milled
// program and returns findings. This module provides the rule contract and the AST-walking helpers rules share;
// the concrete rules live under `rule/`.

import type {
  Program,
  Statement,
  Expression,
} from '@term/make/code/compile/node'
import type { CodeFinding, SourcePoint } from './form'

export type Rule = {
  id: string
  // a one-line description of what the rule catches (used in SARIF rule metadata)
  description: string
  check(program: Program, file: string): CodeFinding[]
}

// internal spans are 0-based line and column; source points and SARIF are 1-based.
export function pointOf(
  file: string,
  span: { start: { line: number; column: number } },
): SourcePoint {
  return {
    file,
    line: span.start.line + 1,
    column: span.start.column + 1,
  }
}

// visit every expression in an expression tree (pre-order), including nested calls, members, closures, and the
// expressions inside a closure body's statements.
export function walkExpression(
  expression: Expression,
  visit: (expression: Expression) => void,
): void {
  visit(expression)

  switch (expression.form) {
    case 'binary':
      walkExpression(expression.left, visit)
      walkExpression(expression.right, visit)
      break
    case 'unary':
      walkExpression(expression.operand, visit)
      break
    case 'call':
      walkExpression(expression.callee, visit)
      expression.args.forEach(a => walkExpression(a, visit))
      break
    case 'member':
      walkExpression(expression.target, visit)
      break
    case 'array':
      expression.items.forEach(i => walkExpression(i, visit))
      break
    case 'map':
      expression.entries.forEach(e => {
        walkExpression(e.key, visit)
        walkExpression(e.value, visit)
      })
      break
    case 'record':
      expression.fields.forEach(f => walkExpression(f.value, visit))
      break
    case 'await':
      walkExpression(expression.expr, visit)
      break
    case 'closure':
      walkStatements(expression.body, () => {}, visit)
      break
    case 'conditional':
      expression.branches.forEach(b => {
        walkExpression(b.cond, visit)
        walkExpression(b.value, visit)
      })

      if (expression.otherwise) {
        walkExpression(expression.otherwise, visit)
      }

      break
    default:
      break
  }
}

// visit every statement (pre-order) and, via `visitExpression`, every expression inside it.
export function walkStatements(
  statements: Statement[],
  visitStatement: (statement: Statement) => void,
  visitExpression: (expression: Expression) => void,
): void {
  for (const statement of statements) {
    visitStatement(statement)

    switch (statement.form) {
      case 'let':
        walkExpression(statement.init, visitExpression)
        break
      case 'assign':
        walkExpression(statement.target, visitExpression)
        walkExpression(statement.value, visitExpression)
        break
      case 'expression':
      case 'hold':
        walkExpression(statement.expr, visitExpression)
        break
      case 'return':
        if (statement.value) {
          walkExpression(statement.value, visitExpression)
        }

        break
      case 'throw':
        walkExpression(statement.value, visitExpression)
        break
      case 'if':
        statement.branches.forEach(b => {
          walkExpression(b.cond, visitExpression)
          walkStatements(b.body, visitStatement, visitExpression)
        })

        if (statement.otherwise) {
          walkStatements(
            statement.otherwise,
            visitStatement,
            visitExpression,
          )
        }

        break
      case 'while':
        walkExpression(statement.cond, visitExpression)
        walkStatements(statement.body, visitStatement, visitExpression)
        break
      case 'match':
        walkExpression(statement.subject, visitExpression)
        statement.cases.forEach(c =>
          walkStatements(c.body, visitStatement, visitExpression),
        )

        if (statement.otherwise) {
          walkStatements(
            statement.otherwise,
            visitStatement,
            visitExpression,
          )
        }

        break
      case 'for-each':
        walkExpression(statement.iterable, visitExpression)
        walkStatements(statement.body, visitStatement, visitExpression)
        break
      case 'function':
        walkStatements(statement.body, visitStatement, visitExpression)
        break
      default:
        break
    }
  }
}

// the `native` alias -> module map for a program (from `dock load <module>, name alias`). Rules use it to know
// which local names are FFI handles onto which host module.
export function nativeModules(program: Program): Map<string, string> {
  const map = new Map<string, string>()

  for (const statement of program) {
    if (statement.form === 'native' && statement.kind === 'module') {
      map.set(statement.alias, statement.module)
    }
  }

  return map
}

// run a set of rules over a program, concatenating their findings.
export function runRules(
  program: Program,
  file: string,
  rules: Rule[],
): CodeFinding[] {
  const findings: CodeFinding[] = []

  for (const rule of rules) {
    findings.push(...rule.check(program, file))
  }

  return findings
}
