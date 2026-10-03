// A number literal is one the backends can hold.
//
// `back 9007199254740993` built, and TypeScript emitted it as written, which JavaScript reads as 9007199254740992
// (guides: language/values, 2026-10-03). `number` is a 64-bit integer on Rust, Swift and Kotlin and a safe integer
// (below 2^53) on TypeScript, so:
//
//   past the 64-bit range      refused: no backend holds it
//   past 2^53, inside 64 bits  a warning naming the value TypeScript reads instead. The 64-bit integer module
//                              writes such literals on purpose, for the native backends
//
// Only the file being compiled is read, and a `float` literal is not a `number`.

import type { Program } from '@term/make/code/compile/node'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'

const SAFE = 2n ** 53n - 1n
const I64_MAX = 2n ** 63n - 1n
const I64_MIN = -(2n ** 63n)

export function checkLiterals(program: Program, file: string): { errors: Diagnostic[]; warnings: Diagnostic[] } {
  const errors: Diagnostic[] = []
  const warnings: Diagnostic[] = []

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit)

      return
    }

    if (node === null || typeof node !== 'object') {
      return
    }

    const record = node as Record<string, unknown>

    if (record.form === 'integer') {
      const raw = record.value as number | bigint
      const value = typeof raw === 'bigint' ? raw : Number.isSafeInteger(raw) ? BigInt(raw) : undefined
      const span = record.span as Diagnostic['span']

      if (value === undefined) {
        // a number the parser already could not hold exactly
        errors.push(
          diagnose('type-mismatch', {
            file,
            span,
            message: `this number literal is past every backend's range for \`number\``,
            hint: 'use `@term/base/integer/big` for an integer this large',
          }),
        )
      } else if (value > I64_MAX || value < I64_MIN) {
        errors.push(
          diagnose('type-mismatch', {
            file,
            span,
            message: `${value} is past the 64-bit range every native backend holds a \`number\` in`,
            hint: 'use `@term/base/integer/big` for an integer this large',
          }),
        )
      } else if (value > SAFE || value < -SAFE) {
        warnings.push(
          diagnose('type-mismatch', {
            file,
            span,
            message: `${value} is past 2^53, so TypeScript reads it as ${Number(value)}. Rust, Swift and Kotlin hold it exactly`,
          }),
        )
      }

      return
    }

    for (const [key, child] of Object.entries(record)) {
      if (key !== 'span' && key !== 'type') {
        visit(child)
      }
    }
  }

  for (const s of program) {
    if (s.span.file === file) {
      visit(s)
    }
  }

  // a warning is a warning: carried with its severity, never failing the build
  return { errors, warnings: warnings.map(w => ({ ...w, severity: 'warning' as const })) }
}
