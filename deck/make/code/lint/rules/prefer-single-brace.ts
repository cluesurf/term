// L043: an interpolation in a text literal is written `{x}`, not `{{x}}`. There is one brace syntax and the compiler
// decides when it is filled (compile time for a module constant that folds, run time for anything else), so the
// double brace is the older spelling of the same thing and the fix only drops a brace on each side.
//
// Text literals only. A brace in a NAME (`load .../native/{platform}/...`, `is-{name}`) is a template or platform
// slot, and the two spellings are not interchangeable there in every reader, so it is left alone.

import type { Rule } from '@term/make/code/lint/rule'
import { tokenize } from '@term/make/code/parser/token'
import type { Token } from '@term/make/code/parser/token'

export const preferSingleBrace: Rule = {
  name: 'prefer-single-brace',
  code: 'L043',
  severity: 'warning',
  docs: 'an interpolation is written `{x}`, not `{{x}}`',
  fixable: true,
  check() {},
  checkSource(_tree, context) {
    const tokens = tokenize({ file: context.file, text: context.source })

    if (tokens.diagnostics.length > 0) {
      return
    }

    let text = 0
    // the open braces inside the current text literal, outermost first
    const open: Token[] = []

    for (const token of tokens.tokens.list) {
      switch (token.kind) {
        case 'open-angle':
          if (open.length === 0) {
            text++
          }

          break
        case 'close-angle':
          if (open.length === 0 && text > 0) {
            text--
          }

          break
        case 'open-brace':
          if (text > 0) {
            open.push(token)
          }

          break
        case 'close-brace': {
          const start = open.pop()

          if (
            !start ||
            open.length > 0 ||
            start.text !== '{{' ||
            token.text !== '}}' ||
            start.span.start.line !== token.span.end.line
          ) {
            break
          }

          const line = context.source.split('\n')[start.span.start.line] ?? ''
          const inner = line.slice(start.span.end.column, token.span.start.column)

          context.report({
            message: `\`{{${inner}}}\` is written \`{${inner}}\`: one brace interpolates, and the compiler decides when it is filled`,
            span: { start: start.span.start, end: token.span.end },
            fix: { span: { start: start.span.start, end: token.span.end }, text: `{${inner}}` },
          })

          break
        }
        default:
          break
      }
    }
  },
}
