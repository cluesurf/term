// L015: a record literal (`make <form>`) that sets the same field twice. The later value silently wins, so the
// earlier one is dead -- almost always a copy-paste or a typo.

import type { Rule } from '@cluesurf/make/code/lint/rule'

export const noDuplicateKeys: Rule = {
  name: 'no-duplicate-keys',
  code: 'L015',
  severity: 'warning',
  docs: 'a record literal sets the same field twice; the later value wins',
  fixable: false,
  check(target, context) {
    if (target.kind !== 'expression') return
    const node = target.node
    if (node.form !== 'record') return

    const seen = new Set<string>()
    for (const field of node.fields) {
      if (seen.has(field.name)) {
        context.report({
          message: `the field "${field.name}" is set twice; the later value wins`,
          span: field.value.span,
        })
      } else {
        seen.add(field.name)
      }
    }
  },
}
