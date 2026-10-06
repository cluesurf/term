// The lint driver: walk the type-checked AST exactly once and dispatch every enabled rule per node, so N rules cost
// one traversal (the ESLint/Ruff visitor-multiplexing model). Findings are returned with their fixes attached, ready
// for the language server to render and apply. Pure and browser-safe. See plans/19-format-and-lint.
//
// What the driver does around the dispatch is Term, lint/lint-lines.tree (self-hosting, 2026-10-06): the nodes the walk
// meets, the names written and read, the modules loaded twice, the text under a span, the line rules and the run of
// blank lines, and the fixes written back. The dispatch stays here: a rule is a TypeScript object with `check` and
// `checkSource` closures, the seam plugin rules drop in through (lint/seed-rule.ts), and each rule's context holds
// sets, a memo the rule writes, and the `report` and `slice` closures.

import type {
  Severity,
  Span,
} from '@term/make/code/parser/diagnostic'
import type { Program } from '@term/make/code/compile/node'
import * as lines_ from '@term/make/code/lint/lint-lines'
import type {
  Finding,
  LintContext,
  LintMemo,
  LintNode,
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

// EVERY lint finding the driver can report, one entry each: the AST and source rules, then the line rules (the
// line length the formatter keeps, a tab, trailing whitespace) and the run of blank lines, which are about layout
// rather than structure and so are not node rules. `term show kink L019` reads this, so a code printed by `term lint`
// can always be looked up. The manifest findings (L050 to L055) need the file system and are listed beside their
// check, in call/code/lint.ts
export function lintCatalog(): { code: string; name: string; severity: Severity; docs: string; fixable: boolean }[] {
  return [
    ...RULES.map(rule => ({ code: rule.code, name: rule.name, severity: rule.severity, docs: rule.docs, fixable: rule.fixable })),
    ...lines_.lineRuleEntries().map(rule => ({ code: rule.code, name: rule.name, severity: 'warning' as const, docs: rule.message, fixable: false })),
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
  // every name assigned somewhere (prefer-host-for-constant), every name read, a closure's body included
  // (no-unused-load), and the native modules loaded more than once (no-duplicate-load)
  const reassigned = new Set(lines_.reassignedNames(program))
  const referenced = new Set(lines_.referencedNames(program))
  const duplicateLoads = new Set(lines_.duplicateLoads(program))
  const lines = source.split('\n')
  const slice = (span: Span): string => lines_.sliceSpan(lines, span)

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

  for (const target of lines_.lintTargets(program) as LintNode[]) {
    for (let i = 0; i < enabled.length; i++) {
      enabled[i]!.check({ kind: target.kind, node: target.node } as LintNode, contexts[i]!)
    }
  }

  // the rules about how a line is WRITTEN read the concrete tree, once per file. Parsed only when one is enabled,
  // and skipped when the source does not parse (the program could not have milled either)
  if (enabled.some(rule => rule.checkSource)) {
    const parsed = parse({ file, text: source })

    if (parsed.ok) {
      enabled.forEach((rule, i) => rule.checkSource?.(parsed.tree, contexts[i]!))
    }
  }

  // the line rules and the run of blank lines, each code as configured
  findings.push(
    ...(lines_.lineFindings(
      source,
      code => config.severity?.[code] ?? '',
      (line, code) => config.suppress?.get(line)?.has(code) ?? false,
    ) as Finding[]),
  )

  return findings
}

// apply the fixes carried by `findings` to the source, returning the fixed text. Edits are applied back-to-front so an
// earlier edit never shifts a later span; overlapping edits are skipped (the outer one wins) so the result is always
// well-defined. Run the formatter afterward to normalize layout. Idempotent on already-fixed source.
export function applyFixes(
  source: string,
  findings: Finding[],
): string {
  return lines_.applyFixes(source, findings as never)
}
