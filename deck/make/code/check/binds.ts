// A `bind` has a case for every backend it is emitted for.
//
// A `bind` with only `node` and `browser` cases passed `term make`, and on Rust it emitted an undefined name,
// `SEED_UNSUPPORTED_BIND_now_ms`, so the failure arrived at `rustc` naming nothing a reader wrote (guides:
// language/native, 2026-10-03). Two halves:
//
//   emitting for an env      every bind the program calls has a case for it (or one it borrows through the fallback
//                            chain, `ios` reaching `swift`), or the build is refused naming the bind and the env
//   `term make`, no env      a bind written outside a `native/<env>/` file with two to four of the five backends is
//                            an error naming the ones it leaves out. A native file's bind is for its own env, and
//                            so is a bind with one case
//
// Only the file being compiled is warned about. Every call is read, wherever it is, since the emit is the program.

import type { Program, Statement } from '@term/make/code/compile/node'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import { bindTargetOf } from '@term/make/code/compile/bind'

type Bind = Extract<Statement, { form: 'bind' }>

const BACKENDS = ['node', 'browser', 'rust', 'swift', 'kotlin']

function calledNames(program: Program): Set<string> {
  const out = new Set<string>()
  const stack: unknown[] = [program]

  while (stack.length > 0) {
    const node = stack.pop()

    if (node === null || typeof node !== 'object') {
      continue
    }

    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }

    const record = node as Record<string, unknown>
    const callee = record.callee as { form?: string; name?: string } | undefined

    if (record.form === 'call' && callee?.form === 'variable' && callee.name) {
      out.add(callee.name)
    }

    for (const [key, child] of Object.entries(record)) {
      if (key !== 'span' && key !== 'type') {
        stack.push(child)
      }
    }
  }

  return out
}

// `env` is the env being emitted for, the empty text for `term make` with none (check/binds.tree)
export function checkBindTargets(
  program: Program,
  file: string,
  env: string,
): { errors: Diagnostic[]; warnings: Diagnostic[] } {
  const binds = program.filter((s): s is Bind => s.form === 'bind')
  const errors: Diagnostic[] = []
  const warnings: Diagnostic[] = []

  if (env !== '') {
    const called = calledNames(program)

    for (const bind of binds) {
      if (called.has(bind.name) && bindTargetOf(bind, env).form === 'none') {
        errors.push(
          diagnose('unknown-name', {
            file: bind.span.file ?? file,
            span: bind.span,
            message: `\`${bind.name}\` is called, and this bind has no \`case ${env}\`, so there is nothing to emit for it on ${env}`,
            hint: `add \`case ${env}\` to the bind, or call it only where a case exists`,
          }),
        )
      }
    }
  }

  for (const bind of binds) {
    if (bind.span.file !== file || /\/native\/[a-z]+\//.test(file)) {
      continue
    }

    const missing = BACKENDS.filter(backend => bindTargetOf(bind, backend).form === 'none')

    // an ERROR since 2026-10-05: as a warning the bind built for the backends it had, and a program calling it failed
    // only once it was built for another, far from the bind. Every shared bind in the standard library covers all five.
    // A bind with ONE case is written for that platform, the way a `native/<env>/` file's is (zone's `case node`
    // tools): a call to it from a program built elsewhere is refused by the half above. Two to four cases is a bind
    // meant to be portable that left backends out, which is what this refuses
    if (missing.length > 0 && missing.length < BACKENDS.length - 1) {
      errors.push(
        diagnose('unknown-name', {
          file,
          span: bind.span,
          message: `the bind \`${bind.name}\` has no case for ${missing.join(', ')}, so a program that calls it does not build there`,
          hint: `give it a \`case\` for each, or move it into the \`native/<backend>/\` files of the backends that have it`,
        }),
      )
    }
  }

  return { errors, warnings }
}
