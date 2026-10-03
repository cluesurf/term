// A write a task makes through a record parameter reaches somebody.
//
// A form's value is a value on every backend: a task handed a record writes its own copy (Rust and Swift pass a
// struct, TypeScript passes a spread since D1, codegen-performance-0028). So `bump` below changed nothing its caller
// could see, and nothing said so (guides: parsers/cursor, 2026-10-03):
//
//   task bump
//     take box, like counter
//     save box/count, add(box/count, 1)
//
// The write is lost exactly when the task gives back nothing and nothing reads that parameter after the write: there
// is no way out for the copy. That is refused here, naming the two fixes: send the record back, or make the form
// `mark shared`, one object every binding sees. A task that reads its copy after writing it (to compute a value, or
// in a `hold` about it) is using the copy, and is left alone.

import type { Program, Statement, Type } from '@term/make/code/compile/node'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'

type Task = Extract<Statement, { form: 'function' }>

function returnsNothing(task: Task): boolean {
  const result = task.result

  return (
    result === undefined ||
    result.kind === 'unit' ||
    (result.kind === 'named' && (result.name === 'void' || result.name === 'unit'))
  )
}

// a written field path, `box/inner/count`, as its root parameter and the fields read on the way to the one written
// (`inner`), or nothing when the target is not a plain field path
function writtenPath(target: unknown): { root: string; through: string[] } | undefined {
  let node = target as { form?: string; target?: unknown; name?: string; index?: unknown }

  if (node?.form !== 'member' || node.index) {
    return undefined
  }

  const names: string[] = []

  while (node?.form === 'member') {
    names.unshift(node.name ?? '')
    node = node.target as typeof node
  }

  return node?.form === 'variable' && node.name ? { root: node.name, through: names.slice(0, -1) } : undefined
}

export function checkLostWrites(program: Program, file: string): Diagnostic[] {
  const shared = new Set<string>()
  const forms = new Map<string, Map<string, Type>>()

  for (const s of program) {
    if (s.form === 'record-type') {
      forms.set(s.name, new Map(s.fields.map(f => [f.name, f.type])))

      if (s.shared) {
        shared.add(s.name)
      }
    }
  }

  // The write stays inside the copy only while every container on its path is a value form. A path through a field
  // that is not one (an opaque `link handle, mark private`, a `mark shared` form, a list or a hash) reaches an object
  // the caller holds too: `save node/handle/text, read value` on a view writes the one element both bindings name
  const staysInCopy = (form: string, through: string[]): boolean => {
    let current = form

    for (const name of through) {
      const type = forms.get(current)?.get(name)

      if (type?.kind !== 'named' || !forms.has(type.name) || shared.has(type.name)) {
        return false
      }

      current = type.name
    }

    return true
  }

  const out: Diagnostic[] = []

  for (const task of program) {
    if (task.form !== 'function' || task.span.file !== file || task.body.length === 0 || !returnsNothing(task)) {
      continue
    }

    // the record parameters of a value form
    const values = new Map<string, string>()

    task.params.forEach((param, i) => {
      const type = (task.declared?.params[i] ?? param.type) as Type | undefined

      if (type?.kind === 'named' && forms.has(type.name) && !shared.has(type.name)) {
        values.set(param.name, type.name)
      }
    })

    if (values.size === 0) {
      continue
    }

    // In source order: the first write to each parameter's copy, and the last place each parameter is read. An
    // assignment's value is read before its write lands (`save box/count, add(box/count, 1)` reads the old count), so
    // it is visited first. A copy read after it was written is in use (a `hold` on it, or a value computed from it),
    // and only a write nothing reads afterwards is lost
    const firstWrite = new Map<string, { at: number; span: Diagnostic['span'] }>()
    const lastRead = new Map<string, number>()
    let clock = 0

    const visit = (node: unknown): void => {
      if (node === null || typeof node !== 'object') {
        return
      }

      if (Array.isArray(node)) {
        node.forEach(visit)

        return
      }

      const record = node as Record<string, unknown>

      // a closure or a nested task has parameters of its own
      if (record.form === 'closure' || record.form === 'function') {
        return
      }

      if (record.form === 'assign') {
        visit(record.value)

        const path = writtenPath(record.target)
        const root = path?.root

        if (path && root !== undefined && values.has(root) && staysInCopy(values.get(root)!, path.through)) {
          if (!firstWrite.has(root)) {
            firstWrite.set(root, { at: clock, span: record.span as Diagnostic['span'] })
          }
        } else {
          visit(record.target)
        }

        clock++

        return
      }

      if (record.form === 'variable' && typeof record.name === 'string' && values.has(record.name)) {
        lastRead.set(record.name, clock)
      }

      clock++

      for (const [key, child] of Object.entries(record)) {
        if (key !== 'span' && key !== 'type') {
          visit(child)
        }
      }
    }

    visit(task.body)

    for (const [root, write] of firstWrite) {
      if ((lastRead.get(root) ?? -1) > write.at) {
        continue
      }

      out.push(
        diagnose('type-mismatch', {
          file,
          span: write.span,
          message: `this writes \`${root}\`'s own copy: a ${values.get(root)} is a value, and \`${task.method?.name ?? task.name}\` sends nothing back, so the caller never sees the change`,
          hint: `send \`${root}\` back and use what comes back, or make \`${values.get(root)}\` \`mark shared\` so every binding sees one object`,
        }),
      )
    }
  }

  return out
}
