// A parameter or local named like a module the same file docks hides that module for the whole task. The browser
// page's `set-title` took `title`, the text, beside `dock load / load <global:title>, name title`, so `call title/set`
// read `.set` off the text and stopped every titled page with `title.set is not a function`. Nothing said so, and a
// duplicate declaration elsewhere kept the bundle from building at all, which hid it (2026-10-04, guides:
// applications/web/routes). Warned, at the binding, so the name can change before anything runs.

import type { Program, Statement } from '@term/make/code/compile/node'
import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'

type Task = Extract<Statement, { form: 'function' }>

// every local the task binds, with where: its parameters, `let`s, loop items and closure parameters
function bindings(task: Task): { name: string; span: Span }[] {
  const found = task.params.map(p => ({ name: p.name, span: p.span ?? task.span }))
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') {
      return
    }

    if (Array.isArray(node)) {
      node.forEach(visit)

      return
    }

    const record = node as Record<string, unknown>
    const span = (record.span as Span | undefined) ?? task.span

    if (record.form === 'let' && typeof record.name === 'string') {
      found.push({ name: record.name, span })
    }

    if (record.form === 'for-each' && typeof record.item === 'string') {
      found.push({ name: record.item, span })
    }

    if (record.form === 'closure' && Array.isArray(record.params)) {
      for (const p of record.params as { name: string }[]) {
        found.push({ name: p.name, span })
      }
    }

    for (const [key, value] of Object.entries(record)) {
      if (key !== 'span' && key !== 'type') {
        visit(value)
      }
    }
  }

  visit(task.body)

  return found
}

export function checkDockShadow(program: Program): Diagnostic[] {
  // the docked module names of each file
  const docked = new Map<string, Set<string>>()

  for (const node of program) {
    if (node.form === 'native' && node.kind !== 'type') {
      const file = node.file ?? node.span.file ?? ''
      const names = docked.get(file) ?? new Set<string>()
      names.add(node.alias)
      docked.set(file, names)
    }
  }

  const found: Diagnostic[] = []

  for (const node of program) {
    if (node.form !== 'function' || node.stub) {
      continue
    }

    const names = docked.get(node.span.file ?? '')

    if (!names) {
      continue
    }

    const seen = new Set<string>()

    for (const binding of bindings(node)) {
      if (names.has(binding.name) && !seen.has(binding.name)) {
        seen.add(binding.name)
        found.push(
          diagnose('dock-shadow', {
            file: binding.span.file ?? node.span.file ?? '',
            span: binding.span,
            message: `"${binding.name}" in "${node.name}" hides the module this file docks as "${binding.name}", so \`${binding.name}/...\` there reads the local`,
          }),
        )
      }
    }
  }

  return found
}
