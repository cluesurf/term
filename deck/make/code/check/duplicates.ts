// One file defines a task once per signature.
//
// Two tasks of one name and one parameter list in one file both built, the last silently replaced the first, and the
// build said nothing (guides: language/tasks, 2026-10-03). The same thing across two files is deliberate, a
// `native/<env>/` shim overriding a shared task, and is left to the overload binder. Inside one file there is nothing it
// can mean but a copy, so it is refused at the second definition. Tasks that differ in arity or in a written
// parameter type are overloads and are left alone.

import type { Program, Statement, Type } from '@term/make/code/compile/node'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'

type Task = Extract<Statement, { form: 'function' }>

// a parameter list as written, so two declarations compare equal only when every type is the same
function signatureOf(task: Task): string {
  const types = (task.declared?.params ?? task.params.map(p => p.type)).map((type: Type | undefined) =>
    JSON.stringify(type ?? null, (key, value) => (key === 'span' ? undefined : value)),
  )

  return `${task.method?.form ?? ''}|${task.name}|${types.join(',')}`
}

export function checkDuplicateTasks(program: Program, file: string): Diagnostic[] {
  const first = new Map<string, Task>()
  const out: Diagnostic[] = []

  for (const s of program) {
    if (s.form !== 'function' || s.span.file !== file || s.body.length === 0 || s.stub || s.claim) {
      continue
    }

    const key = signatureOf(s)
    const earlier = first.get(key)

    if (!earlier) {
      first.set(key, s)
      continue
    }

    out.push(
      diagnose('duplicate-definition', {
        file,
        span: s.span,
        message: `\`${s.method?.name ?? s.name}\` is defined twice in this file with the same parameters, first on line ${
          earlier.span.start.line + 1
        }, and only one of them could ever be called`,
        hint: 'remove one, or give them different parameters if both are meant',
      }),
    )
  }

  return out
}
