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
import { noConstantCondition } from '@cluesurf/make/code/lint/rules/no-constant-condition'
import { noSelfComparison } from '@cluesurf/make/code/lint/rules/no-self-comparison'
import { noUnusedLoad } from '@cluesurf/make/code/lint/rules/no-unused-load'
import { noDuplicateBranchCondition } from '@cluesurf/make/code/lint/rules/no-duplicate-branch-condition'
import { noSelfAssignment } from '@cluesurf/make/code/lint/rules/no-self-assignment'
import { noUnreachableCode } from '@cluesurf/make/code/lint/rules/no-unreachable-code'
import { noIdenticalBranches } from '@cluesurf/make/code/lint/rules/no-identical-branches'
import { noDuplicateCase } from '@cluesurf/make/code/lint/rules/no-duplicate-case'
import { noConstantBinaryExpression } from '@cluesurf/make/code/lint/rules/no-constant-binary-expression'
import { noDuplicateKeys } from '@cluesurf/make/code/lint/rules/no-duplicate-keys'
import { noDoubleNegation } from '@cluesurf/make/code/lint/rules/no-double-negation'
import { noBooleanLiteralComparison } from '@cluesurf/make/code/lint/rules/no-boolean-literal-comparison'
import { preferDirectReturn } from '@cluesurf/make/code/lint/rules/prefer-direct-return'
import { noUselessConcat } from '@cluesurf/make/code/lint/rules/no-useless-concat'
import { noRedundantContinue } from '@cluesurf/make/code/lint/rules/no-redundant-continue'
import { noElseReturn } from '@cluesurf/make/code/lint/rules/no-else-return'
import { noDuplicateLoad } from '@cluesurf/make/code/lint/rules/no-duplicate-load'
import { noNegatedCondition } from '@cluesurf/make/code/lint/rules/no-negated-condition'
import { noLonelyIf } from '@cluesurf/make/code/lint/rules/no-lonely-if'
import { consistentReturn } from '@cluesurf/make/code/lint/rules/consistent-return'
import { noUselessReturn } from '@cluesurf/make/code/lint/rules/no-useless-return'

// the line-length limit enforced by the formatter and the max-line-length lint rule (L019)
const MAX_LINE_LENGTH = 84

// the default rule set, keyed by stable code for config and suppression
export const RULES: Rule[] = [
  kebabNames,
  noRedundantArithmetic,
  preferHostForConstant,
  noEmptyBlock,
  noConstantCondition,
  noSelfComparison,
  noUnusedLoad,
  noDuplicateBranchCondition,
  noSelfAssignment,
  noUnreachableCode,
  noIdenticalBranches,
  noDuplicateCase,
  noConstantBinaryExpression,
  noDuplicateKeys,
  noDoubleNegation,
  noBooleanLiteralComparison,
  preferDirectReturn,
  noUselessConcat,
  noRedundantContinue,
  noElseReturn,
  noDuplicateLoad,
  noNegatedCondition,
  noLonelyIf,
  consistentReturn,
  noUselessReturn,
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

// every variable name read anywhere in the program (used by no-unused-load to spot import aliases that are never
// referenced). The shared expression walker does not descend into closure (callback) bodies, so this collector does
// it explicitly: a name used only inside a hook handler must still count as referenced, or the import would be
// wrongly flagged unused.
function referencedNames(program: Program): Set<string> {
  const names = new Set<string>()

  const onStatement = () => {}

  const onExpression = (e: Expression) => {
    if (e.form === 'variable') {names.add(e.name)}

    if (e.form === 'closure') {
      for (const s of e.body)
        {eachStatement(s, onStatement, onExpression)}
    }
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
  const referenced = referencedNames(program)

  // native-import modules loaded more than once (used by no-duplicate-load)
  const loadCounts = new Map<string, number>()
  for (const s of program) {
    if (s.form === 'native')
      {loadCounts.set(s.module, (loadCounts.get(s.module) ?? 0) + 1)}
  }
  const duplicateLoads = new Set(
    [...loadCounts]
      .filter(([, count]) => count > 1)
      .map(([module]) => module),
  )

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

  // one context per rule (so a finding is attributed to the right rule + severity), but a SINGLE AST traversal that
  // dispatches each node to every rule. This is N rules over one tree walk, not N separate walks.
  const contexts = enabled.map((rule): LintContext => {
    const severity =
      (config.severity?.[rule.code] as Severity | undefined) ??
      rule.severity

    return {
      file,
      source,
      reassigned,
      referenced,
      duplicateLoads,
      slice,
      report(finding) {
        // honor inline suppression (`# lint off Lxxx` on the line above the node)
        if (config.suppress?.get(finding.span.start.line)?.has(rule.code)) {
          return
        }

        findings.push({
          rule: rule.name,
          code: rule.code,
          severity,
          ...finding,
        })
      },
    }
  })

  const onStatement = (node: Statement): void => {
    for (let i = 0; i < enabled.length; i++) {
      enabled[i]!.check({ kind: 'statement', node }, contexts[i]!)
    }
  }

  const onExpression = (node: Expression): void => {
    for (let i = 0; i < enabled.length; i++) {
      enabled[i]!.check({ kind: 'expression', node }, contexts[i]!)
    }
  }

  for (const stmt of program) {
    eachStatement(stmt, onStatement, onExpression)
  }

  // line-based checks (over the raw source lines, not the AST): maximum line length and tab indentation. They cannot
  // be node rules because they are about layout, not structure.
  const LINE_RULES = [
    {
      code: 'L019',
      name: 'max-line-length',
      message: 'this line is longer than 84 characters; wrap it',
      column: (line: string) => MAX_LINE_LENGTH,
      hit: (line: string) => line.length > MAX_LINE_LENGTH,
    },
    {
      code: 'L020',
      name: 'no-tabs',
      message: 'this line uses a tab; indent with two spaces',
      column: (line: string) => line.indexOf('\t'),
      hit: (line: string) => line.includes('\t'),
    },
    {
      code: 'L029',
      name: 'no-trailing-whitespace',
      message: 'this line has trailing whitespace',
      column: (line: string) => line.trimEnd().length,
      hit: (line: string) =>
        line.length > 0 && line.trimEnd().length !== line.length,
    },
  ] as const

  for (const lr of LINE_RULES) {
    if (config.severity?.[lr.code] === 'off') {continue}

    const severity =
      (config.severity?.[lr.code] as Severity | undefined) ?? 'warning'

    lines.forEach((line, i) => {
      if (!lr.hit(line)) {return}

      if (config.suppress?.get(i)?.has(lr.code)) {return}

      findings.push({
        rule: lr.name,
        code: lr.code,
        severity,
        message: lr.message,
        span: {
          start: { line: i, column: lr.column(line) },
          end: { line: i, column: line.length },
        },
      })
    })
  }

  // no more than two consecutive blank lines (L030): reported once at the start of each over-long run of blanks
  if (config.severity?.['L030'] !== 'off') {
    let blanks = 0
    lines.forEach((line, i) => {
      if (line.trim() === '') {
        blanks++
        if (blanks === 3 && !config.suppress?.get(i)?.has('L030')) {
          findings.push({
            rule: 'no-multiple-empty-lines',
            code: 'L030',
            severity:
              (config.severity?.['L030'] as Severity | undefined) ??
              'warning',
            message: 'more than two consecutive blank lines',
            span: {
              start: { line: i, column: 0 },
              end: { line: i, column: 0 },
            },
          })
        }
      } else {
        blanks = 0
      }
    })
  }

  return findings
}

// apply the fixes carried by `findings` to the source, returning the fixed text. Edits are applied back-to-front so an
// earlier edit never shifts a later span; overlapping edits are skipped (the outer one wins) so the result is always
// well-defined. Run the formatter afterward to normalize layout. Idempotent on already-fixed source.
export function applyFixes(source: string, findings: Finding[]): string {
  const lines = source.split('\n')

  const offsetOf = (pos: { line: number; column: number }): number => {
    let offset = 0
    for (let i = 0; i < pos.line; i++) {
      offset += (lines[i]?.length ?? 0) + 1 // + the newline
    }
    return offset + pos.column
  }

  const edits = findings
    .flatMap(f => (f.fix ? [f.fix] : []))
    .map(fix => ({
      start: offsetOf(fix.span.start),
      end: offsetOf(fix.span.end),
      text: fix.text,
    }))
    .sort((a, b) => b.start - a.start) // back to front

  let out = source
  let appliedStart = source.length

  for (const edit of edits) {
    if (edit.end > appliedStart) {continue} // overlaps an already-applied edit; skip

    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
    appliedStart = edit.start
  }

  return out
}
