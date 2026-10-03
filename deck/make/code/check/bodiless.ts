// A call reaches a task that something in the build defines.
//
// A task with no body built, and natively it emitted a stub (`TODO`, `fatalError`, `unimplemented!`), so a
// declaration-only module compiled and failed only when a program called into it, at run time (guides:
// language/native, 2026-10-03). A declaration on its own is fine: it is how a signature is written ahead of its
// body, and how a shared module names a task each platform's `native/<env>/` file fills. What is refused is a CALL,
// from the file being compiled, to a name that has no body anywhere in the build (no task with a body, no `bind`, no
// native declaration) and that ANOTHER file declares. That call could only ever reach the stub, and nothing in the
// calling file says so.
//
// A file that declares a body-less task and calls it itself is left alone: its author can see there is no body, and
// it is how a proof states an uninterpreted constant (a higher inductive type's path constructor, `loop` in
// test/check/circle.ts) and how the soundness suite models a call the prover may assume nothing about.

import type { Program, Statement, Span } from '@term/make/code/compile/node'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'

type Task = Extract<Statement, { form: 'function' }>

export function checkBodilessCalls(program: Program, file: string): Diagnostic[] {
  const bodied = new Set<string>()
  const declared = new Set<string>()
  // where each body-less name is declared, so a declaration in the calling file itself is not refused
  const declaredIn = new Map<string, Set<string>>()

  for (const s of program) {
    if (s.form === 'function') {
      // a claim is its own gate (`open-claim-used`), and a stub stands in for a body another unit has
      if (s.body.length > 0 || s.stub || s.claim || s.axiom) {
        bodied.add(s.name)
      } else {
        declared.add(s.name)
        declaredIn.set(s.name, (declaredIn.get(s.name) ?? new Set()).add(s.span.file))
      }
    }

    if (s.form === 'bind' || s.form === 'native') {
      const name = (s as { name?: string; alias?: string }).name ?? (s as { alias?: string }).alias

      if (name) {
        bodied.add(name)
      }
    }
  }

  const unfilled = new Set([...declared].filter(name => !bodied.has(name) && !declaredIn.get(name)?.has(file)))

  if (unfilled.size === 0) {
    return []
  }

  const out: Diagnostic[] = []
  const reported = new Set<string>()

  const visit = (node: unknown, owner: Task): void => {
    if (Array.isArray(node)) {
      node.forEach(child => visit(child, owner))

      return
    }

    if (node === null || typeof node !== 'object') {
      return
    }

    const record = node as Record<string, unknown>
    const callee = record.callee as { form?: string; name?: string } | undefined

    if (record.form === 'call' && callee?.form === 'variable' && callee.name && unfilled.has(callee.name)) {
      const span = record.span as Span
      const key = `${span.start.line}:${span.start.column}`

      if (!reported.has(key)) {
        reported.add(key)
        out.push(
          diagnose('unknown-name', {
            file,
            span,
            message: `"${callee.name}" is declared with no body in ${[...(declaredIn.get(callee.name) ?? [])].join(', ')}, and nothing in this build defines it, so this call could only reach a stub`,
            hint: `give \`${callee.name}\` a body, or load the module that implements it`,
          }),
        )
      }
    }

    for (const [key, child] of Object.entries(record)) {
      if (key !== 'span' && key !== 'type') {
        visit(child, owner)
      }
    }
  }

  for (const s of program) {
    if (s.form === 'function' && s.span.file === file && s.body.length > 0) {
      visit(s.body, s)
    }
  }

  return out
}
