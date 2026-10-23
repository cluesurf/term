// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): the exports deck/deck/code/read.ts had, with
// their shapes, answered by deck/deck/code/package/tree-reading.tree. The logic is Term; this file only converts shapes for TypeScript callers.
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import * as port from '@term/deck/code/package/tree-reading'


export type Form = { head: string; terms: string[]; value?: string; values: string[]; forms: Form[] }

const some = <T>(maybe: unknown): T | undefined => {
  const box = maybe as { form: string; value?: T }

  return box.form === 'some' ? box.value : undefined
}

export function readTree(input: { file: string; text: string }): { ok: true; forms: Form[] } | { ok: false; diagnostics: Diagnostic[] } {
  const read = port.readTree(input.file, input.text) as { ok: boolean; forms: Form[]; diagnostics: Diagnostic[] }

  return read.ok ? { ok: true, forms: read.forms } : { ok: false, diagnostics: read.diagnostics }
}

export const formOf = (form: Form, head: string): Form | undefined => some(port.formOf(form as never, head))
export const formsWith = (form: Form, head: string): Form[] => port.formsWith(form as never, head) as never
export const valueOf = (form: Form, head: string): string | undefined => some(port.valueOf(form as never, head))
export const termOf = (form: Form, head: string): string | undefined => some(port.termOf(form as never, head))
export const deepFormOf = (form: Form, head: string): Form | undefined => some(port.deepFormOf(form as never, head))
export const deepValueOf = (form: Form, head: string): string | undefined => some(port.deepValueOf(form as never, head))
export const termsOf = (form: Form): string => port.termsOf(form as never)
export const phraseOf = (form: Form): string => port.phraseOf(form as never)
