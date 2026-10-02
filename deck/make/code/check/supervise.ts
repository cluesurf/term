// Supervision trees checked before they run (deck/base/code/supervisor.tree, note/term/research/beam-otp-lessons.md
// design 4). OTP validates a supervisor's flags when it starts and documents the rest. Most of that is structural in
// Term already: a strategy and a restart type are variant forms, so a wrong one cannot be written, a nested supervisor
// has no shutdown to get wrong, and `make-supervisor` owes `intensity >= 0` and `period > 0` to the prover at every
// call. What is left needs the raise sets, and lives here:
//
//   a `transient` worker restarts only when its work raises, so one whose work can raise NOTHING never restarts. OTP
//   runs it and never says so. Here the build refuses it.
//
// Reads every `make worker` the program builds whose `restart` is `make transient` and whose `work` is a task literal.
// A work given by name rather than written in place is not judged, since what it raises is the named task's set and a
// worker built from a parameter can be anything.

import type { Expression, Program, Statement } from '@term/make/code/compile/node'
import { diagnose } from '@term/make/code/parser/diagnostic'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { raiseSets } from '@term/make/code/check/effects'

type Record = Extract<Expression, { form: 'record' }>
type Closure = Extract<Expression, { form: 'closure' }>

// every record literal anywhere under a node
function recordsIn(node: unknown, into: Record[]): void {
  if (!node || typeof node !== 'object') {
    return
  }

  if (Array.isArray(node)) {
    node.forEach(n => recordsIn(n, into))

    return
  }

  const value = node as { form?: string } & Partial<Record>

  if (value.form === 'record') {
    into.push(value as Record)
  }

  for (const [key, child] of Object.entries(value)) {
    if (key !== 'type' && key !== 'span') {
      recordsIn(child, into)
    }
  }
}

const field = (record: Record, name: string): Expression | undefined =>
  record.fields.find(f => f.name === name)?.value

export function checkSupervision(program: Program, file: string): Diagnostic[] {
  // only a program that has the stdlib supervisor's own worker variant: a `worker` of some other form is not this
  const supervised = program.some(
    s =>
      s.form === 'record-type' &&
      s.name === 'child' &&
      s.variants.some(v => v.name === 'worker'),
  )

  if (!supervised) {
    return []
  }

  const workers: { record: Record; work: Closure }[] = []
  const found: Record[] = []

  for (const statement of program) {
    if (statement.form === 'function') {
      recordsIn(statement.body, found)
    }
  }

  for (const record of found) {
    const restart = field(record, 'restart')
    const work = field(record, 'work')

    if (
      record.name === 'worker' &&
      restart?.form === 'record' &&
      restart.name === 'transient' &&
      work?.form === 'closure'
    ) {
      workers.push({ record, work })
    }
  }

  if (workers.length === 0) {
    return []
  }

  // each work's raise set: the closure's body as a task of its own, so its direct raises and its callees' are read
  // by the same fixed point every other raise set is
  const exceptions = new Set(
    program
      .filter((s): s is Extract<Statement, { form: 'record-type' }> => s.form === 'record-type' && Boolean(s.chain?.includes('exception')))
      .map(s => s.name),
  )
  const probes = workers.map(
    ({ work }, i): Extract<Statement, { form: 'function' }> => ({
      form: 'function',
      name: `__supervised-work-${i}`,
      params: [],
      body: work.body,
      span: work.span,
    }) as Extract<Statement, { form: 'function' }>,
  )
  const sets = raiseSets([...program, ...probes], exceptions)
  const diagnostics: Diagnostic[] = []

  workers.forEach(({ record }, i) => {
    if ((sets.raises.get(probes[i]!.name)?.size ?? 0) > 0) {
      return
    }

    const name = field(record, 'name')
    const label = name?.form === 'string' ? `"${name.value}"` : 'this'

    diagnostics.push(
      diagnose('dead-restart', {
        file: record.span.file ?? file,
        span: record.span,
        message: `the transient worker ${label} can raise nothing, so it is never restarted: a transient worker restarts only when its work raises`,
      }),
    )
  })

  return diagnostics
}
