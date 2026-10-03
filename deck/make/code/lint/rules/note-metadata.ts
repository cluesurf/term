// L053: metadata is written `mark`, and `note <word>` is the old spelling (`note async`, `note unsafe`, `note draft`,
// ...). The two are read the same, so the fix only swaps the word. Which `note` is metadata is decided once, by form,
// in check/note-metadata.ts, which the compiler's `note-metadata` warning and `pnpm term:mark-metadata` also read.
// note/term/plan/await-by-default-and-mark-metadata.md, section 4.

import type { Rule } from '@term/make/code/lint/rule'
import { noteMetadataSites } from '@term/make/code/check/note-metadata'

export const noteMetadata: Rule = {
  name: 'note-metadata',
  code: 'L053',
  severity: 'warning',
  docs: 'metadata is `mark async`, not `note async`: `note` is the old spelling, and is left for documentation',
  fixable: true,
  check() {},
  checkSource(tree, context) {
    for (const site of noteMetadataSites(tree)) {
      const end = { line: site.span.start.line, column: site.span.start.column + 'note'.length }

      context.report({
        message: `\`note ${site.word}\` is the old spelling of \`mark ${site.word}\`: metadata is \`mark\``,
        span: { start: site.span.start, end },
        fix: { span: { start: site.span.start, end }, text: 'mark' },
      })
    }
  },
}
