// L001: declared names are kebab-case (lowercase words joined by single dashes), the house identifier convention.
// No camelCase, no underscores, no abbreviations enforced here (that needs a dictionary) but the shape is. Report
// only: a rename fix would have to update every reference, which is a refactor, not a local edit.

import type { Rule } from '@term/make/code/lint/rule'

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

function offenders(names: string[]): string[] {
  return names.filter(n => n.length > 0 && !KEBAB.test(n))
}

export const kebabNames: Rule = {
  name: 'kebab-names',
  code: 'L001',
  severity: 'warning',
  docs: 'declared names should be kebab-case (e.g. find-fibonacci, not findFibonacci or find_fibonacci)',
  fixable: false,
  check(target, context) {
    if (target.kind !== 'statement') {
      return
    }

    const s = target.node

    let names: string[] = []

    if (s.form === 'let') {
      names = [s.name]
    } else if (s.form === 'function') {
      names = [s.name, ...s.params.map(p => p.name)]
    } else if (s.form === 'record-type') {
      names = [s.name]
    } else {
      return
    }

    for (const name of offenders(names)) {
      context.report({
        message: `the name "${name}" should be kebab-case`,
        span: s.span,
      })
    }
  },
}
