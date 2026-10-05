// A task named like one of the compiler's own words is passed over at every call, and said so nowhere.
//
// `add`, `subtract`, `is-equal`, `not` and the rest are folded to operators where they are written
// (`foldBuiltin` in compile/mint-bridge.ts), before any name is bound, so a file's own `task add` taking `a` and `b`
// and multiplying them builds clean and `add(2, 3)` is 5 (guides: language/naming, 2026-10-04). Whether the words
// stay global is a decision of its own (plan: "The compiler's own words are global"); until it is made, the task
// that can never be reached by name is warned about where it is declared.

import type { Program } from '@term/make/code/compile/node'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import { BINARY_BUILTIN, UNARY_BUILTIN } from '@term/make/code/compile/surface'

export function checkBuiltinShadow(program: Program, file: string): Diagnostic[] {
  const found: Diagnostic[] = []

  for (const node of program) {
    if (node.form !== 'function' || node.method || node.span.file !== file) {
      continue
    }

    if (!(node.name in BINARY_BUILTIN) && !UNARY_BUILTIN.has(node.name)) {
      continue
    }

    found.push(
      diagnose('builtin-shadow', {
        file,
        span: node.span,
        message: `a task named "${node.name}" is never called by that name: \`${node.name}(...)\` is the compiler's own word, folded before names are bound`,
      }),
    )
  }

  return found
}
