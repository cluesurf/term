// A MEMBER CALL ON A LIST OR A MAP THAT NO NATIVE BACKEND LOWERS IS REFUSED BEFORE EMIT, on Rust, Swift and Kotlin
// (note/term/plan/backends-complete.md, step 5). The emitters lower the members in compile/lowered-members.ts, and a
// list or hash method the stdlib writes in Term is dispatched to before this runs (check/infer.ts
// `bindMemberMethod`). What is left is a host method by name, `xs/for-each(f)` or `xs/sort()`, which JavaScript
// answers and which every native emitter wrote as `xs.forEach(f)` for the toolchain to refuse, far from the line that
// asked for it. On TypeScript it is the host's own method, as it always was.
//
// Read of the program the native emitter is handed (compile.ts, after `simplify` and view lowering), so what is
// refused is exactly what would have been written.

import type { Program } from '@term/make/code/compile/node'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import { LOWERED_LIST_MEMBERS, LOWERED_MAP_MEMBERS } from '@term/make/code/compile/lowered-members'

const NATIVE = new Set(['rust', 'swift', 'kotlin'])

export function checkLoweredMembers(program: Program, file: string, env: string | undefined): Diagnostic[] {
  if (!env || !NATIVE.has(env)) {
    return []
  }

  const errors: Diagnostic[] = []
  // one refusal per site: an inlined body visited twice says it once
  const seen = new Set<string>()

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit)

      return
    }

    if (node === null || typeof node !== 'object') {
      return
    }

    const record = node as Record<string, unknown>

    if (record.form === 'call') {
      const callee = record.callee as Record<string, unknown> | undefined
      const target = callee?.form === 'member' ? (callee.target as Record<string, unknown>) : undefined
      const kind = (target?.type as { kind?: string } | undefined)?.kind
      const name = callee?.name as string | undefined
      const table = kind === 'array' ? LOWERED_LIST_MEMBERS : kind === 'map' ? LOWERED_MAP_MEMBERS : undefined

      if (table && name && !callee?.index && !table.has(name)) {
        const span = (callee!.span ?? record.span) as Diagnostic['span']
        const at = `${span?.file ?? file}:${span?.start?.line}:${span?.start?.column}:${name}`

        if (!seen.has(at)) {
          seen.add(at)
          const what = kind === 'array' ? 'list' : 'hash'
          const spelled = name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)

          errors.push(
            diagnose('not-implemented', {
              file: span?.file ?? file,
              span,
              message: `\`${spelled}\` is not a method of a ${what} on ${env}: it is the host's own on JavaScript, and no native backend lowers it`,
              hint: `a native ${what} answers ${[...table].map(one => one.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)).join(', ')}, and every other method is the Term form's (@term/base/${what})`,
            }),
          )
        }
      }
    }

    for (const [key, value] of Object.entries(record)) {
      // a type is no code, and a span no node
      if (key !== 'type' && key !== 'span') {
        visit(value)
      }
    }
  }

  visit(program)

  return errors
}
