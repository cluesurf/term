// L001: declared names are kebab-case (lowercase words joined by single dashes), the house identifier convention.
// No camelCase, no underscores, no abbreviations enforced here (that needs a dictionary) but the shape is. Report
// only: a rename fix would have to update every reference, which is a refactor, not a local edit.
//
// It lints the name AS WRITTEN. A form's method is milled to a flat `<form>_<method>` name, because the merged
// program is one namespace, and linting THAT reported `task load` on `form atomic` as "the name atomic_load should be
// kebab-case" - an underscore the author never typed and cannot remove. It was 5,433 findings across the stdlib,
// @term/site, @term/face and @term/host, which is most of what this rule said. `method.name` is the written one.
//
// The second synthesis is OVERLOADS. Two tasks may share a name with different arities, and the checker separates
// them as `<name>__<arity>__<index>`, so `instantiate` became `instantiate__2__0`. The suffix is stripped the same
// way the checker strips it for its own messages (check/infer.ts), so the lint and the compiler agree about what an
// author called something.

import type { Rule } from '@term/make/code/lint/rule'

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

// the suffixes the checker appends to separate same-named definitions: `<name>__<arity>__<index>` for an overload
// group, and `<name>__<n>` where only a counter is needed
const OVERLOAD = /__\d+(__\d+)?$/

function written(name: string): string {
  return name.replace(OVERLOAD, '')
}

// A leading `__` is the compiler's own prefix for a name it invented: `__slot` is the outlet parameter the `view`
// lowering adds to every component. Nobody wrote it and nobody can rename it, so reporting it is noise.
function offenders(names: string[]): string[] {
  return names.filter(
    n => n.length > 0 && !n.startsWith('__') && !KEBAB.test(n),
  )
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
      names = [
        written(s.method ? s.method.name : s.name),
        ...s.params.map(p => p.name),
      ]
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
