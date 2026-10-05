// A closed set of texts (`mark text`, D9) is only texts: each case IS its text on TypeScript, so a case cannot carry a
// field, and two cases cannot share a text, or a value would not say which case it is. Both are refused at the form,
// naming the case.

import type { Program } from '@term/make/code/compile/node'
import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'

export function checkTextForms(program: Program, file: string): Diagnostic[] {
  const out: Diagnostic[] = []

  for (const form of program) {
    if (form.form !== 'record-type' || !form.text || form.span.file !== file) {
      continue
    }

    const seen = new Map<string, string>()

    for (const variant of form.variants) {
      const text = variant.text ?? variant.name

      if (variant.fields.length > 0) {
        out.push(
          diagnose('type-mismatch', {
            file,
            span: (variant.fields[0]!.span ?? form.span) as Span,
            message: `\`${form.name}\` is \`mark text\`, a closed set of texts, so its case \`${variant.name}\` cannot hold a value`,
            hint: `drop the field, or drop \`mark text\` and make \`${form.name}\` an ordinary form`,
          }),
        )
      }

      if (seen.has(text)) {
        out.push(
          diagnose('type-mismatch', {
            file,
            span: form.span as Span,
            message: `\`${form.name}\` gives the text "${text}" to both \`${seen.get(text)}\` and \`${variant.name}\`, so a value cannot say which case it is`,
            hint: `give \`${variant.name}\` its own text, \`case ${variant.name}, text <...>\``,
          }),
        )
      }

      seen.set(text, variant.name)
    }
  }

  return out
}
