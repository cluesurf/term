// The lint driver: walk the type-checked AST exactly once and dispatch every enabled rule per node, so N rules cost
// one traversal (the ESLint/Ruff visitor-multiplexing model). Findings are returned with their fixes attached, ready
// for the language server to render and apply. Pure and browser-safe. See plans/19-format-and-lint.

import type {
  Severity,
  Span,
} from '@cluesurf/make/code/parser/diagnostic'
import type {
  Expression,
  Program,
  Statement,
} from '@cluesurf/make/code/compile/node'
import type {
  Finding,
  LintContext,
  Rule,
} from '@cluesurf/make/code/lint/rule'
import { kebabNames } from '@cluesurf/make/code/lint/rules/kebab-names'
import { noRedundantArithmetic } from '@cluesurf/make/code/lint/rules/no-redundant-arithmetic'
import { preferHostForConstant } from '@cluesurf/make/code/lint/rules/prefer-host-for-constant'
import { noEmptyBlock } from '@cluesurf/make/code/lint/rules/no-empty-block'

// the default rule set, keyed by stable code for config and suppression
export const RULES: Rule[] = [
  kebabNames,
  noRedundantArithmetic,
  preferHostForConstant,
  noEmptyBlock,
]

export type LintConfig = {
  // per-rule severity override; `off` disables the rule
  severity?: Record<string, Severity | 'off'>
  // codes suppressed on a given zero-based line (from `# lint off Lxxx` comments)
  suppress?: Map<number, Set<string>>
}

function eachExpression(
  expr: Expression,
  visit: (e: Expression) => void,
): void {
  visit(expr)

  switch (expr.form) {
    case 'binary':
      eachExpression(expr.left, visit)
      eachExpression(expr.right, visit)
      break
    case 'unary':
      eachExpression(expr.operand, visit)
      break
    case 'call':
      eachExpression(expr.callee, visit)
      expr.args.forEach(a => eachExpression(a, visit))
      break
    case 'array':
      expr.items.forEach(i => eachExpression(i, visit))
      break
    case 'map':
      expr.entries.forEach(e => {
        eachExpression(e.key, visit)
        eachExpression(e.value, visit)
      })
      break
    case 'record':
      expr.fields.forEach(f => eachExpression(f.value, visit))
      break
    case 'member':
      eachExpression(expr.target, visit)
      break
    case 'await':
      eachExpression(expr.expr, visit)
      break
    case 'conditional':
      expr.branches.forEach(b => {
        eachExpression(b.cond, visit)
        eachExpression(b.value, visit)
      })

      if (expr.otherwise) {eachExpression(expr.otherwise, visit)}

      break
    default:
      break
  }
}

function eachStatement(
  stmt: Statement,
  onStatement: (s: Statement) => void,
  onExpression: (e: Expression) => void,
): void {
  onStatement(stmt)

  const block = (body: Statement[]) =>
    body.forEach(s => eachStatement(s, onStatement, onExpression))

  switch (stmt.form) {
    case 'let':
      eachExpression(stmt.init, onExpression)
      break
    case 'assign':
      eachExpression(stmt.target, onExpression)
      eachExpression(stmt.value, onExpression)
      break
    case 'expression':
      eachExpression(stmt.expr, onExpression)
      break
    case 'if':
      stmt.branches.forEach(b => {
        eachExpression(b.cond, onExpression)
        block(b.body)
      })

      if (stmt.otherwise) {block(stmt.otherwise)}

      break
    case 'while':
      eachExpression(stmt.cond, onExpression)
      block(stmt.body)
      break
    case 'match':
      eachExpression(stmt.subject, onExpression)
      stmt.cases.forEach(c => block(c.body))

      if (stmt.otherwise) {block(stmt.otherwise)}

      break
    case 'for-each':
      eachExpression(stmt.iterable, onExpression)
      block(stmt.body)
      break
    case 'return':
      if (stmt.value) {eachExpression(stmt.value, onExpression)}

      break
    case 'throw':
      eachExpression(stmt.value, onExpression)
      break
    case 'hold':
      eachExpression(stmt.expr, onExpression)
      break
    case 'function':
      block(stmt.body)
      break
    default:
      break
  }
}

// every name that is the target of an assignment somewhere in the program (used by prefer-host-for-constant)
function reassignedNames(program: Program): Set<string> {
  const names = new Set<string>()

  const onExpression = () => {}

  const onStatement = (s: Statement) => {
    if (s.form === 'assign' && s.target.form === 'variable')
      {names.add(s.target.name)}
  }

  for (const s of program) {eachStatement(s, onStatement, onExpression)}

  return names
}

export function lint(
  program: Program,
  file: string,
  source: string,
  config: LintConfig = {},
  // the rule set to run. Defaults to the built-ins, but the caller passes its own (built-ins plus Seed-authored plugin
  // rules loaded via code/lint/seed-rule.ts) so new rules drop in without editing this driver. This is the plugin seam.
  rules: Rule[] = RULES,
): Finding[] {
  const findings: Finding[] = []
  const reassigned = reassignedNames(program)
  const lines = source.split('\n')

  const slice = (span: Span): string => {
    if (span.start.line === span.end.line)
      {return (lines[span.start.line] ?? '').slice(
        span.start.column,
        span.end.column,
      )}

    const first = (lines[span.start.line] ?? '').slice(
      span.start.column,
    )

    const middle = lines.slice(span.start.line + 1, span.end.line)
    const last = (lines[span.end.line] ?? '').slice(0, span.end.column)

    return [first, ...middle, last].join('\n')
  }

  const enabled = rules.filter(r => config.severity?.[r.code] !== 'off')

  for (const rule of enabled) {
    const severity =
      (config.severity?.[rule.code] as Severity | undefined) ??
      rule.severity

    const context: LintContext = {
      file,
      source,
      reassigned,
      slice,
      report(finding) {
        // honor inline suppression (`# lint off Lxxx` on the line above the node)
        if (
          config.suppress?.get(finding.span.start.line)?.has(rule.code)
        )
          {return}

        findings.push({
          rule: rule.name,
          code: rule.code,
          severity,
          ...finding,
        })
      },
    }

    const onStatement = (node: Statement) =>
      rule.check({ kind: 'statement', node }, context)

    const onExpression = (node: Expression) =>
      rule.check({ kind: 'expression', node }, context)

    for (const stmt of program)
      {eachStatement(stmt, onStatement, onExpression)}
  }

  return findings
}
