// A `host` is written once.
//
// Inside a task, `host limit, 10` and then `save limit, 20` compiled, and the TypeScript declared `const limit` twice,
// which is a syntax error JavaScript reports at load, far from the line that caused it (guides: language/values,
// 2026-10-03). A `host` binds a constant: any later `save` of the same name in the same task, or a second `host` of
// it, is refused here, at the line that writes it. A closure or a nested task that binds the name as a parameter is
// its own scope and is left alone.

import type { Program, Statement } from '@term/make/code/compile/node'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'

export function checkConstants(program: Program, file: string): Diagnostic[] {
  const out: Diagnostic[] = []

  const walk = (body: Statement[], constants: Set<string>): void => {
    for (const s of body) {
      if (s.form === 'let') {
        if (constants.has(s.name)) {
          out.push(
            diagnose('type-mismatch', {
              file,
              span: s.span,
              message: `"${s.name}" is a \`host\`, a constant, and is bound again here`,
              hint: 'give the second value its own name, or make the first a `save`',
            }),
          )
        }

        if (!s.mutable) {
          constants.add(s.name)
        }
      }

      if (s.form === 'assign' && s.target.form === 'variable' && constants.has(s.target.name)) {
        out.push(
          diagnose('type-mismatch', {
            file,
            span: s.span,
            message: `"${s.target.name}" is a \`host\`, a constant, and is written here`,
            hint: 'give the new value its own name, or make the first a `save`',
          }),
        )
      }

      // every nested statement list is the same task: a constant bound before it is still one inside it
      for (const nested of nestedBodies(s)) {
        walk(nested, new Set(constants))
      }
    }
  }

  for (const s of program) {
    if (s.form === 'function' && s.span.file === file && !s.stub) {
      walk(s.body, new Set())
    }
  }

  return out
}

function nestedBodies(s: Statement): Statement[][] {
  switch (s.form) {
    case 'if':
      return [...s.branches.map(b => b.body), ...(s.otherwise ? [s.otherwise] : [])]
    case 'while':
    case 'for-each':
      return [s.body]
    case 'match':
      return [...s.cases.map(c => c.body), ...(s.otherwise ? [s.otherwise] : [])]
    case 'guard':
      return [s.body, ...(s.catch ? [s.catch.body] : [])]
    default:
      return []
  }
}
