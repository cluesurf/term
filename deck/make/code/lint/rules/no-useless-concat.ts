// L021: concatenating two string literals (`text <a>` + `text <b>`) can always be written as one literal. The split
// adds a runtime concat and reads worse.

import type { Rule } from '@cluesurf/make/code/lint/rule'

export const noUselessConcat: Rule = {
  name: 'no-useless-concat',
  code: 'L021',
  severity: 'warning',
  docs: 'two string literals concatenated; write them as a single literal',
  fixable: true,
  check(target, context) {
    if (target.kind !== 'expression') return
    const node = target.node
    if (
      node.form === 'binary' &&
      node.op === '+' &&
      node.left.form === 'string' &&
      node.right.form === 'string'
    ) {
      const merged = `${node.left.value}${node.right.value}`
      // only offer the fix when the merged text has no `<` / `>`, which would break the `text <...>` delimiter
      const fixable = !merged.includes('<') && !merged.includes('>')

      context.report({
        message: `these two string literals can be written as one`,
        span: node.span,
        fix: fixable ? { span: node.span, text: `text <${merged}>` } : undefined,
      })
    }
  },
}
