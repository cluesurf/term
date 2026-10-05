// A pattern literal is read when the program is built (regex-engine-0007).
//
// `make pattern, <...>` with a text literal is read by @term/base/pattern's own reader and analysis, through the
// ported check/pattern-literal.tree, so the build and the program read it identically:
//
//   not a pattern                      refused, `pattern-mismatch`, at the literal, naming the position and why. It
//                                      built, and the program raised the same thing the first time it ran
//   lands on the backtracking tier     a warning, `pattern-backtracks`, naming what put it there (a back reference,
//                                      an atomic group, a possessive repetition the analysis could not rewrite)
//
// Only the stdlib's `pattern` form is read, never a form of the same name a program declares, and only the file
// being compiled. A pattern built at run time is the program's to handle.

import type { Expression, Program } from '@term/make/code/compile/node'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import { readLiteralPattern } from '@term/make/code/check/pattern-literal'

const STDLIB_PATTERN = /deck\/base\/code\/pattern\.tree$|@term\/base\/pattern$/

// the literal text a `make pattern` record holds, by position or by `bind text`, when it is a plain literal
function literalOf(record: Extract<Expression, { form: 'record' }>): Extract<Expression, { form: 'string' }> | undefined {
  const value = record.positional?.[0] ?? record.fields.find(f => f.name === 'text')?.value

  return value?.form === 'string' ? value : undefined
}

export function checkPatterns(program: Program, file: string): { errors: Diagnostic[]; warnings: Diagnostic[] } {
  const errors: Diagnostic[] = []
  const warnings: Diagnostic[] = []
  // the names the stdlib's `pattern` form goes by in this program: its own, or the one binding by file gave it
  const names = new Set(
    program.filter(s => s.form === 'record-type' && STDLIB_PATTERN.test(s.span.file ?? '') && /^pattern(__in\w+)?$/.test(s.name)).map(s => (s as { name: string }).name),
  )

  if (names.size === 0) {
    return { errors, warnings }
  }

  // one reading per distinct text: a literal repeated across a file is read once
  const read = new Map<string, ReturnType<typeof readLiteralPattern>>()

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit)

      return
    }

    if (node === null || typeof node !== 'object') {
      return
    }

    const record = node as Record<string, unknown>

    if (record.form === 'record' && names.has(record.name as string)) {
      const literal = literalOf(record as Extract<Expression, { form: 'record' }>)

      if (literal) {
        let reading = read.get(literal.value)

        if (!reading) {
          reading = readLiteralPattern(literal.value)
          read.set(literal.value, reading)
        }

        const shown = literal.value.length > 60 ? `${literal.value.slice(0, 57)}...` : literal.value

        if (reading.refused) {
          errors.push(
            diagnose('pattern-mismatch', {
              file,
              span: literal.span,
              message: `\`${shown}\` is not a pattern: ${reading.reason}${reading.at >= 0 ? `, at code point ${reading.at}` : ''}`,
            }),
          )
        } else if (reading.backtracks.length > 0) {
          warnings.push(
            diagnose('pattern-backtracks', {
              file,
              span: literal.span,
              message: `\`${shown}\` needs a backtracking matcher, because of ${reading.backtracks}: where the platform's engine cannot run it safely (Rust always) it runs on tier C, which allows 64 steps per instruction per code point of the input and raises \`pattern-budget\` past that`,
            }),
          )
        }
      }
    }

    for (const [key, child] of Object.entries(record)) {
      if (key !== 'span' && key !== 'type') {
        visit(child)
      }
    }
  }

  // every statement of the file: a task's body, and a top-level `host` constant holding a pattern
  for (const s of program) {
    if (s.span.file === file) {
      visit(s)
    }
  }

  return { errors, warnings }
}
