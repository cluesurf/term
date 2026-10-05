// L054: `wait true` under a call to an async TASK says what the call already does. A call to an async task is awaited
// with nothing written (note/term/plan/await-by-default-and-mark-metadata.md, section 1), so the marker is redundant
// and the fix removes it: the whole line when it stands alone, `, wait true` when it closes a call's line.
//
// ONLY WHERE THE CALLEE IS KNOWN ASYNC. A call into a `dock load` module is not a task the build can see, and its
// `wait true` is the only thing that awaits it, so it is not reported, unless the module's load line says
// `mark async`, which awaits every call into it. Neither is a callee a parameter or a local
// shadows, nor a `wait true` on a task DEFINITION (the older spelling of `mark async`, which says something).
//
// What this rule can know is what the file it is linting declares: the program it reads is the file's own, milled
// alone. A call to an async task imported from elsewhere is not reported here. `pnpm term:await-migrate` removes
// those across the repository, compiling each file with its imports and proving the output unchanged.

import type { Rule } from '@term/make/code/lint/rule'
import { asyncDocksOf, asyncNames } from '@term/make/code/check/async-resolve'
import { waitTrueSites } from '@term/make/code/check/note-metadata'

export const redundantWait: Rule = {
  name: 'redundant-wait',
  code: 'L054',
  severity: 'warning',
  docs: '`wait true` under a call to an async task is redundant: the call is awaited with nothing written',
  fixable: true,
  check() {},
  checkSource(tree, context) {
    const known = asyncNames(context.program)
    const docks = asyncDocksOf(context.program)
    const bound = boundNames(context.program)

    for (const site of waitTrueSites(tree, context.source)) {
      // a call into a `dock load` module marked `mark async` is awaited the same way (`fs-promise/read-file`)
      const module = site.callee.includes('/') ? site.callee.slice(0, site.callee.indexOf('/')) : undefined
      const docked = module !== undefined && docks.has(module) && !bound.has(module)

      if (site.definition || (!docked && (!known.has(site.callee) || bound.has(site.callee)))) {
        continue
      }

      context.report({
        message: docked
          ? `\`wait true\` is redundant: "${module}" is docked \`mark async\`, so the call is awaited with nothing written`
          : `\`wait true\` is redundant: "${site.callee}" is async, so the call is awaited with nothing written`,
        span: site.span,
        fix: { span: site.remove, text: '' },
      })
    }
  },
}

// every parameter and local name in the program, any of which shadows a task of the same name where it is bound
function boundNames(program: unknown): Set<string> {
  const names = new Set<string>()

  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(visit)

      return
    }

    const record = value as Record<string, unknown>

    if (record.form === 'let' && typeof record.name === 'string') {
      names.add(record.name)
    }

    if ((record.form === 'function' || record.form === 'closure') && Array.isArray(record.params)) {
      for (const param of record.params as { name: string }[]) {
        names.add(param.name)
      }
    }

    for (const [key, child] of Object.entries(record)) {
      if (key !== 'span' && key !== 'type') {
        visit(child)
      }
    }
  }

  visit(program)

  return names
}
