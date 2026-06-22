// L008: a native module binding (`dock load / load <node:fs/promises>, name fs`) whose alias is never referenced is
// dead weight, and on a strict backend it can pull in a module that need not be linked at all. The driver collects
// every name read anywhere in the program (including inside callback bodies) once and hands it in as
// `context.referenced`; if the alias is absent, nothing uses the import. Report only: the safe fix (delete the line,
// and the enclosing `dock load` if it becomes empty) is the author's call.

import type { Rule } from '@cluesurf/make/code/lint/rule'

export const noUnusedLoad: Rule = {
  name: 'no-unused-load',
  code: 'L008',
  severity: 'warning',
  docs: 'a native import (`dock load`) whose alias is never used should be removed',
  fixable: false,
  check(target, context) {
    if (target.kind !== 'statement') {return}

    const node = target.node

    if (node.form !== 'native') {return}

    if (context.referenced.has(node.alias)) {return}

    context.report({
      message: `the import "${node.alias}" (${node.module}) is never used`,
      span: node.span,
    })
  },
}
