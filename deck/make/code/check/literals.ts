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
import { WIDTHS } from '@term/make/code/check/width-range'

// A literal argument to a width-typed parameter is inside the width. `like u8` is a `number`, so a `u8` parameter
// took `300` with no message (guides: types/annotations, 2026-10-03). A computed value is owed the same range as a
// tier-0 obligation when TERM_WIDTH_RANGES is on (check/width-range.ts, D12)
function checkWidths(program: Program, file: string): Diagnostic[] {
  const widths = new Map<string, { names: string[]; widths: (string | undefined)[] }>()
  // and every width-typed field, `<form>/<field>` to its width, a case's under the case's name, which is the name its
  // construction carries. `bind os, code 300` into a `u8` field was taken with no message, as an argument once was.
  // Two definitions that give one key different widths leave it empty, which checks nothing (check/contracts.tree)
  const fields = new Map<string, string>()
  const noteField = (key: string, width: string | undefined): void => {
    if (width !== undefined && width in WIDTHS) {
      fields.set(key, fields.has(key) && fields.get(key) !== width ? '' : width)
    }
  }

  for (const s of program) {
    if (s.form === 'function' && s.params.some(p => p.width)) {
      widths.set(s.name, { names: s.params.map(p => p.name), widths: s.params.map(p => p.width) })
    }

    if (s.form === 'record-type') {
      s.fields.forEach(field => noteField(`${s.name}/${field.name}`, field.width))
      s.variants.forEach(variant => variant.fields.forEach(field => noteField(`${variant.name}/${field.name}`, field.width)))
    }
  }

  if (widths.size === 0 && fields.size === 0) {
    return []
  }

  const out: Diagnostic[] = []
  const outside = (literal: Record<string, unknown>, width: string, name: string): void => {
    // exact, past 2^53 too (compile/node.ts, `digits`)
    const digits = literal.digits as string | undefined
    const value = digits !== undefined ? BigInt(digits) : BigInt(Math.trunc(literal.value as number))
    const [low, high] = WIDTHS[width]!

    if (value < low || value > high) {
      out.push(
        diagnose('type-mismatch', {
          file,
          span: literal.span as Diagnostic['span'],
          message: `${value} is outside \`${width}\` (${low} to ${high}), the width of "${name}"`,
        }),
      )
    }
  }

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit)

      return
    }

    if (node === null || typeof node !== 'object') {
      return
    }

    const record = node as Record<string, unknown>
    const callee = record.callee as { form?: string; name?: string } | undefined
    const target = callee?.form === 'variable' && callee.name ? widths.get(callee.name) : undefined

    if (record.form === 'call' && target) {
      const args = (record.args as Record<string, unknown>[] | undefined) ?? []
      const names = (record.names as (string | undefined | null)[] | undefined) ?? []
      let position = 0

      args.forEach((arg, i) => {
        const label = names[i]
        // `''` is a positional argument (compile/node.ts, `names`)
        const index = label ? target.names.indexOf(label) : position++
        const width = target.widths[index]

        if (!width || arg.form !== 'integer') {
          return
        }

        outside(arg, width, target.names[index]!)
      })
    }

    if (record.form === 'record') {
      for (const field of (record.fields as { name: string; value: Record<string, unknown> }[] | undefined) ?? []) {
        const width = fields.get(`${record.name as string}/${field.name}`)

        if (width && field.value.form === 'integer') {
          outside(field.value, width, field.name)
        }
      }
    }

    for (const [key, child] of Object.entries(record)) {
      if (key !== 'span' && key !== 'type') {
        visit(child)
      }
    }
  }

  for (const s of program) {
    if (s.form === 'function' && s.span.file === file) {
      visit(s.body)
    }
  }

  return out
}

const SAFE = 2n ** 53n - 1n
const I64_MAX = 2n ** 63n - 1n
const I64_MIN = -(2n ** 63n)

// `env` is the build's: on a JavaScript one (node, browser, a worker) a literal past 2^53 is not the number written, so
// it is refused there, where natively it is held exactly and only warned of. A test of rationals past i64 met it on
// 2026-10-05: `4611686018427387903` ran as `...904` on TypeScript, with the warning nobody reads
export function checkLiterals(program: Program, file: string, env?: string): { errors: Diagnostic[]; warnings: Diagnostic[] } {
  const javascript = env === undefined || env === 'node' || env === 'browser' || env === 'cloudflare' || env === 'webview'
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
      // exact, past 2^53 too (compile/node.ts, `digits`)
      const raw = record.value as number
      const digits = record.digits as string | undefined
      const value = digits !== undefined ? BigInt(digits) : Number.isSafeInteger(raw) ? BigInt(raw) : undefined
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
        ;(javascript ? errors : warnings).push(
          diagnose('type-mismatch', {
            file,
            span,
            message: `${value} is past 2^53, so TypeScript reads it as ${Number(value)}. Rust, Swift and Kotlin hold it exactly`,
            hint: 'use `@term/base/integer/big` (`make-big-integer(<...>)`) for a whole number this large where it must be exact everywhere',
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

  errors.push(...checkWidths(program, file))

  // a warning is a warning: carried with its severity, never failing the build
  return { errors, warnings: warnings.map(w => ({ ...w, severity: 'warning' as const })) }
}
