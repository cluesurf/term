// Rule scan/native-danger: flag `dock load` of host modules that give arbitrary command or code execution. Importing
// these is not always a bug, but every use is worth a security review, so the rule surfaces the import site. This is
// the structural, always-correct half of the code scan (the taint rule adds data-flow reasoning on top).

import type { Program } from '@cluesurf/make/code/compile/node'
import type { CodeFinding, Severity } from '../form'
import type { Rule } from '../rule'
import { pointOf } from '../rule'

// host modules that grant command / code execution, with the severity of importing them.
const DANGEROUS: { test: (module: string) => boolean; severity: Severity; what: string }[] =
  [
    {
      test: m => /(^|[:/])child_process$/.test(m),
      severity: 'high',
      what: 'runs host commands (child_process)',
    },
    {
      test: m => /(^|[:/])vm$/.test(m),
      severity: 'high',
      what: 'evaluates code in a VM context',
    },
    {
      test: m => /(^|[:.])eval$/i.test(m) || /(^|[:.])Function$/.test(m),
      severity: 'critical',
      what: 'evaluates arbitrary code (eval / Function)',
    },
  ]

export const nativeDangerRule: Rule = {
  id: 'scan/native-danger',
  description:
    'A dock-loaded host module grants command or code execution and warrants review.',
  check(program: Program, file: string): CodeFinding[] {
    const findings: CodeFinding[] = []

    for (const statement of program) {
      if (statement.form !== 'native' || statement.kind !== 'module') {
        continue
      }

      const danger = DANGEROUS.find(d => d.test(statement.module))

      if (!danger) {
        continue
      }

      findings.push({
        kind: 'code',
        ruleId: this.id,
        severity: danger.severity,
        message: `imports "${statement.module}", which ${danger.what}. Review every use for untrusted input`,
        at: pointOf(file, statement.span),
      })
    }

    return findings
  },
}
