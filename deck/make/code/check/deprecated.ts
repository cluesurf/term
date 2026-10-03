// A call to a task marked `mark deprecated` is warned about.
//
// The mark was read by nothing, so a deprecated task was called with no word to the caller (guides: language/notes,
// 2026-10-03). A call from the file that defines the task is its own business and is left alone; a call from any other
// file in the file being compiled is a warning at the call, naming the task.

import type { Program, Span } from '@term/make/code/compile/node'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'

export function warnDeprecated(program: Program, file: string): Diagnostic[] {
  const deprecated = new Map<string, string | undefined>()

  for (const s of program) {
    if (s.form === 'function' && s.deprecated) {
      deprecated.set(s.name, s.span.file)
    }
  }

  if (deprecated.size === 0) {
    return []
  }

  const out: Diagnostic[] = []

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit)

      return
    }

    if (node === null || typeof node !== 'object') {
      return
    }

    const record = node as Record<string, unknown>
    const callee = record.callee as { form?: string; name?: string } | undefined

    if (
      record.form === 'call' &&
      callee?.form === 'variable' &&
      callee.name &&
      deprecated.has(callee.name) &&
      deprecated.get(callee.name) !== file
    ) {
      out.push({
        ...diagnose('unknown-name', {
          file,
          span: record.span as Span,
          message: `"${callee.name}" is marked deprecated`,
          hint: 'its definition says what to use instead',
        }),
        severity: 'warning',
      })
    }

    for (const [key, child] of Object.entries(record)) {
      if (key !== 'span' && key !== 'type') {
        visit(child)
      }
    }
  }

  for (const s of program) {
    if (s.form === 'function' && s.span.file === file) {
      visit(s.body)
    }
  }

  return out
}
