// THE SOLE DECLARATION IS EARNED (term/affine-kinds-0008, decision note/project/term/affine-kinds/decision/
// 001-many-by-default-sole-and-hide-declared-per-form.md, section earned).
//
// Copyability is declared per form, never derived from its fields: a form is copyable unless it says `mark sole`. So a
// form that HOLDS a sole value and does not say so would be copied with its permit inside, which is a second use of
// the permit. It is refused as `sole-unearned`, at the form, naming the field: a `link` or `slot` field, or any case's
// field, whose type is a sole form directly or through another form that holds one (walked with a visited set, so a
// recursive form ends). The same form with `mark sole` added builds. This is Bend's `book_valid` walk, on fields.
//
// A sole type inside a list, a hash or a type argument is check/sole.ts `sole-generic`, not this.

import type { Program, Statement, Type } from '@term/make/code/compile/node'
import { diagnose } from '@term/make/code/parser/diagnostic'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'

type Form = Extract<Statement, { form: 'record-type' }>

const fieldsOf = (form: Form): { name: string; type: Type; span?: Form['span'] | null }[] => [
  ...form.fields,
  ...(form.variants ?? []).flatMap(v => v.fields),
]

export function checkSoleEarned(program: Program, file: string): Diagnostic[] {
  const forms = new Map<string, Form>()

  for (const s of program) {
    if (s.form === 'record-type') {
      forms.set(s.name, s)
    }
  }

  if (![...forms.values()].some(f => f.sole)) {
    return []
  }

  // the path of fields from `form` to a sole form it holds, or nothing. A field typed by a sole form ends the path; a
  // field typed by another form is walked into
  const pathToSole = (form: Form, seen: Set<string>): { path: string[]; sole: string } | undefined => {
    for (const field of fieldsOf(form)) {
      const type = field.type

      if (type?.kind !== 'named') {
        continue
      }

      const inner = forms.get(type.name)

      if (!inner) {
        continue
      }

      if (inner.sole) {
        return { path: [field.name], sole: inner.name }
      }

      if (!seen.has(inner.name)) {
        seen.add(inner.name)
        const deeper = pathToSole(inner, seen)

        if (deeper) {
          return { path: [field.name, ...deeper.path], sole: deeper.sole }
        }
      }
    }

    return undefined
  }

  const diagnostics: Diagnostic[] = []

  for (const form of forms.values()) {
    if (form.sole) {
      continue
    }

    const found = pathToSole(form, new Set([form.name]))

    if (!found) {
      continue
    }

    const from = form.span.file ?? file
    const field = fieldsOf(form).find(f => f.name === found.path[0])
    const span = { ...(field?.span ?? form.span), file: from }
    const through = found.path.length > 1 ? ` (through ${found.path.join('/')})` : ''

    diagnostics.push(
      diagnose('sole-unearned', {
        file: from,
        span,
        message: `the form "${form.name}" holds the \`mark sole\` form "${found.sole}" in its field "${found.path[0]}"${through}, so a copy of a ${form.name} would copy the ${found.sole}`,
        markers: [{ span }],
        hint: `add \`mark sole\` to ${form.name}: a form that holds a sole value is sole itself`,
      }),
    )
  }

  return diagnostics
}
