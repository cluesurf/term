// L036: a map literal (`make find`) that sets the same key twice. As with a duplicate record field, the later value
// silently wins, so the earlier entry is dead -- almost always a copy-paste or a typo. The record-literal analog is
// no-duplicate-keys (L015); this covers the map (`make find`) literal, whose keys are constant strings. Report only:
// the author decides which entry to keep.

import type { Rule } from '@cluesurf/make/code/lint/rule'

export const noDuplicateMapKey: Rule = {
  name: 'no-duplicate-map-key',
  code: 'L036',
  severity: 'warning',
  docs: 'a map literal sets the same key twice; the later value wins',
  fixable: false,
  check(target, context) {
    if (target.kind !== 'expression') {return}

    const node = target.node

    if (node.form !== 'map') {return}

    const seen = new Set<string>()

    for (const entry of node.entries) {
      // only constant string / integer keys can be compared for an exact duplicate; a computed key is left alone
      const key =
        entry.key.form === 'string'
          ? `s:${entry.key.value}`
          : entry.key.form === 'integer'
            ? `n:${String(entry.key.value)}`
            : undefined

      if (key === undefined) {continue}

      if (seen.has(key)) {
        context.report({
          message: `this map key is set twice; the later value wins`,
          span: entry.value.span,
        })
      } else {
        seen.add(key)
      }
    }
  },
}
