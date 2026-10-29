// The lint driver: walk the type-checked AST exactly once and dispatch every enabled rule per node, so N rules cost
// one traversal (the ESLint/Ruff visitor-multiplexing model). Findings are returned with their fixes attached, ready
// for the language server to render and apply. Pure and browser-safe. See plans/19-format-and-lint.
//
// The driver is Term, lint/rule-check-dispatch.tree (item term-self-host-001-0078): the rule set and its order, the
// one walk and its dispatch, the facts the rules share, the concrete-tree rules and the line rules, around
// lint/lint-lines.tree and lint/rule-check.tree. A rule was an object here, with `check` and `checkSource` closures and
// the seam plugin rules drop in through (lint/seed-rule.ts), which decision 029 retires. This face keeps the names
// callers import and turns a config's severities into the table the port reads.

import type { Severity } from '@term/make/code/parser/diagnostic'
import type { Program } from '@term/make/code/compile/node'
import type { Finding, Rule } from '@term/make/code/lint/rule'
import * as port from '@term/make/code/lint/rule-check-dispatch'

export { applyFixes } from '@term/make/code/lint/lint-lines'

// EVERY lint finding the driver can report, one entry each, for `term show kink`
export { listLintCatalog as lintCatalog } from '@term/make/code/lint/rule-check-dispatch'

// the default rule set's metadata, keyed by stable code for config and suppression
export const RULES = port.listLintRules()

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
  // Read by nothing since item 0078: plugin rules stop loading (decision 029), and REMOVE batch 2 drops the parameter
  _rules?: Rule[],
): Finding[] {
  return port.lintProgram(program as never, file, source, {
    severity:
      config.severity === undefined
        ? undefined
        : new Map(Object.entries(config.severity)),
    suppress: config.suppress as never,
    lean: config.lean,
  }) as Finding[]
}
