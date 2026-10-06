// The lint driver: walk the type-checked AST exactly once and dispatch every enabled rule per node, so N rules cost
// one traversal (the ESLint/Ruff visitor-multiplexing model). Findings are returned with their fixes attached, ready
// for the language server to render and apply. Pure and browser-safe. See plans/19-format-and-lint.

import type {
  Severity,
  Span,
} from '@term/make/code/parser/diagnostic'
import type {
  Expression,
  Program,
  Statement,
} from '@term/make/code/compile/node'
import type {
  Finding,
  LintContext,
  LintMemo,
  Rule,
} from '@term/make/code/lint/rule'
import { dataGrammar } from '@term/make/code/lint/rules/data-grammar'
import { lineLayout } from '@term/make/code/lint/rules/line-layout'
import { parse } from '@term/make/code/parser/tree'
import type { RootNode } from '@term/make/code/parser/tree'
import * as ruleCheck from '@term/make/code/lint/rule-check'

// A rule ported to Term (lint/rule-check.tree), as the driver's `Rule`. The Term side answers its reports, and a fix
// that copies source text names the span to copy, which this slices: the parser's columns are UTF-16 units here, and
// Term's text counts code points. The facts it reads are built once per lint call, in the shared memo.
export function portedRule(name: ruleCheck.PortedRule): Rule {
  const meta = ruleCheck.metaOf(name)

  return {
    name: meta.name,
    code: meta.code,
    severity: meta.severity,
    docs: meta.docs,
    fixable: meta.fixable,
    check(target, context) {
      const facts = (context.memo.facts ??= {
        referenced: [...context.referenced],
        duplicateLoads: [...context.duplicateLoads],
        reassigned: [...context.reassigned],
        program: context.program,
        raises: { filled: false, sets: new Map() },
        tells: { filled: false, decides: false, rootOf: new Map(), reachable: new Map(), told: new Map() },
      }) as ruleCheck.LintFacts
      const reports =
        target.kind === 'statement'
          ? ruleCheck.checkStatement(name, target.node, facts)
          : ruleCheck.checkExpression(name, target.node, facts)

      reportAll(reports, context)
    },
    // only a rule that reads the concrete tree and the source has this, so the driver parses only when one is on
    ...(ruleCheck.readsSource(name)
      ? { checkSource: (tree: RootNode, context: LintContext) => reportAll(ruleCheck.checkSource(name, tree, context.source, context.lean, context.program), context) }
      : {}),
  }
}

// a ported rule's reports, through the driver's context: a fix that copies source text is sliced here, and a
// `put-where` fix is offered only where the source at its span reads what the rule expected
function reportAll(reports: ruleCheck.RuleReport[], context: LintContext): void {
  for (const report of reports) {
    const fix = report.fix
    const offered = fix && (fix.form !== 'put-where' || context.slice(fix.span) === fix.written) ? fix : undefined

    context.report({
      message: report.message,
      span: report.span,
      ...(offered
        ? { fix: { span: offered.span, text: offered.form === 'copy' ? offered.prefix + context.slice(offered.from) : offered.text } }
        : {}),
    })
  }
}

// the line-length limit enforced by the formatter and the max-line-length lint rule (L019)
const MAX_LINE_LENGTH = 84

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

// EVERY lint finding the driver can report, one entry each: the AST and source rules, the line rules, and the run of
// blank lines, which the driver reports inline. `term show kink L019` reads this, so a code printed by `term lint` can
// always be looked up. The manifest findings (L050 to L055) need the file system and are listed beside their check,
// in call/code/lint.ts
export function lintCatalog(): { code: string; name: string; severity: Severity; docs: string; fixable: boolean }[] {
  return [
    ...RULES.map(rule => ({ code: rule.code, name: rule.name, severity: rule.severity, docs: rule.docs, fixable: rule.fixable })),
    ...LINE_RULES.map(rule => ({ code: rule.code, name: rule.name, severity: 'warning' as const, docs: rule.message, fixable: false })),
    { code: 'L030', name: 'no-multiple-empty-lines', severity: 'warning', docs: 'more than two consecutive blank lines', fixable: false },
  ]
}

// the default rule set, keyed by stable code for config and suppression
export const RULES: Rule[] = [
  portedRule('kebab-names'),
  portedRule('no-redundant-arithmetic'),
  portedRule('prefer-host-for-constant'),
  portedRule('no-empty-block'),
  portedRule('no-constant-condition'),
  portedRule('no-self-comparison'),
  portedRule('no-unused-load'),
  portedRule('no-duplicate-branch-condition'),
  portedRule('no-self-assignment'),
  portedRule('no-unreachable-code'),
  portedRule('no-identical-branches'),
  portedRule('no-duplicate-case'),
  portedRule('no-constant-binary-expression'),
  portedRule('no-duplicate-keys'),
  portedRule('no-double-negation'),
  portedRule('no-boolean-literal-comparison'),
  portedRule('prefer-direct-return'),
  portedRule('no-useless-concat'),
  portedRule('no-redundant-continue'),
  portedRule('no-else-return'),
  portedRule('no-duplicate-load'),
  portedRule('no-negated-condition'),
  portedRule('no-lonely-if'),
  portedRule('consistent-return'),
  portedRule('no-useless-return'),
  portedRule('no-redundant-boolean'),
  portedRule('no-redundant-conditional'),
  portedRule('no-negated-equality'),
  portedRule('prefer-is-empty'),
  portedRule('no-empty-fork-case'),
  portedRule('no-duplicate-map-key'),
  dataGrammar,
  portedRule('prefer-sift'),
  portedRule('prefer-single-brace'),
  lineLayout,
  portedRule('note-metadata'),
  portedRule('redundant-wait'),
  portedRule('tell-missing'),
  portedRule('tell-of-failure'),
  portedRule('tell-reveals'),
  portedRule('unhandled-raise'),
]

export type LintConfig = {
  // per-rule severity override; `off` disables the rule
  severity?: Record<string, Severity | 'off'>
  // codes suppressed on a given zero-based line (from `# lint off Lxxx` comments)
  suppress?: Map<number, Set<string>>
  // the file's role rule carries `mark lean` (projectLeanOf in call/code/role-of.ts)
  lean?: boolean
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
    case 'template':
      for (const part of expr.parts) {
        if (part.form === 'value') {
          eachExpression(part.value, visit)
        }
      }

      break
    case 'conditional':
      expr.branches.forEach(b => {
        eachExpression(b.cond, visit)
        eachExpression(b.value, visit)
      })

      if (expr.otherwise) {
        eachExpression(expr.otherwise, visit)
      }

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

      if (stmt.otherwise) {
        block(stmt.otherwise)
      }

      break
    case 'while':
      eachExpression(stmt.cond, onExpression)
      block(stmt.body)
      break
    case 'match':
      eachExpression(stmt.subject, onExpression)
      stmt.cases.forEach(c => block(c.body))

      if (stmt.otherwise) {
        block(stmt.otherwise)
      }

      break
    case 'guard':
      block(stmt.body)

      if (stmt.catch) {
        block(stmt.catch.body)
      }

      break
    case 'for-each':
      eachExpression(stmt.iterable, onExpression)
      block(stmt.body)
      break
    case 'return':
      if (stmt.value) {
        eachExpression(stmt.value, onExpression)
      }

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
    if (s.form === 'assign' && s.target.form === 'variable') {
      names.add(s.target.name)
    }
  }

  for (const s of program) {
    eachStatement(s, onStatement, onExpression)
  }

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
    if (e.form === 'variable') {
      names.add(e.name)
    }

    if (e.form === 'closure') {
      for (const s of e.body) {
        eachStatement(s, onStatement, onExpression)
      }
    }
  }

  for (const s of program) {
    eachStatement(s, onStatement, onExpression)
  }

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
    if (s.form === 'native') {
      loadCounts.set(s.module, (loadCounts.get(s.module) ?? 0) + 1)
    }
  }
  const duplicateLoads = new Set(
    [...loadCounts]
      .filter(([, count]) => count > 1)
      .map(([module]) => module),
  )

  const lines = source.split('\n')

  const slice = (span: Span): string => {
    if (span.start.line === span.end.line) {
      return (lines[span.start.line] ?? '').slice(
        span.start.column,
        span.end.column,
      )
    }

    const first = (lines[span.start.line] ?? '').slice(
      span.start.column,
    )

    const middle = lines.slice(span.start.line + 1, span.end.line)
    const last = (lines[span.end.line] ?? '').slice(0, span.end.column)

    return [first, ...middle, last].join('\n')
  }

  const enabled = rules.filter(r => config.severity?.[r.code] !== 'off')

  // ONE per lint call, shared by reference into every context below, so a whole-program analysis a rule needs is
  // computed at most once no matter how many rules or nodes ask for it
  const memo: LintMemo = {}

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
      program,
      memo,
      lean: config.lean ?? false,
      slice,
      report(finding) {
        // honor inline suppression (`# lint off Lxxx` on the line above the node)
        if (
          config.suppress?.get(finding.span.start.line)?.has(rule.code)
        ) {
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

  // the rules about how a line is WRITTEN read the concrete tree, once per file. Parsed only when one is enabled,
  // and skipped when the source does not parse (the program could not have milled either)
  if (enabled.some(rule => rule.checkSource)) {
    const parsed = parse({ file, text: source })

    if (parsed.ok) {
      enabled.forEach((rule, i) => rule.checkSource?.(parsed.tree, contexts[i]!))
    }
  }

  for (const lr of LINE_RULES) {
    if (config.severity?.[lr.code] === 'off') {
      continue
    }

    const severity =
      (config.severity?.[lr.code] as Severity | undefined) ?? 'warning'

    lines.forEach((line, i) => {
      if (!lr.hit(line)) {
        return
      }

      if (config.suppress?.get(i)?.has(lr.code)) {
        return
      }

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
export function applyFixes(
  source: string,
  findings: Finding[],
): string {
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
    if (edit.end > appliedStart) {
      continue
    } // overlaps an already-applied edit; skip

    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
    appliedStart = edit.start
  }

  return out
}
