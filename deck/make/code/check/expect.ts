// The `expect` assertion: unify an actual type against a wanted type, and on failure push a type-mismatch diagnostic
// that blames where each side's variable was first fixed. Extracted from the inference closure as a component of the
// modular checker (a factory over the substitution + diagnostics sink). See note/seed/plan/compilation-performance.md (Tier 2).

import { diagnose } from '@term/make/code/parser/diagnostic'
import type {
  Diagnostic,
  Span,
} from '@term/make/code/parser/diagnostic'
import type { Type } from '@term/make/code/compile/node'
import { showType } from '@term/make/code/compile/type-text'

// THE GRADUAL SEAM. Whether an `unknown` may flow into a place that wants a type of its own, as TypeScript's `any` does
// (the switch off), or must be narrowed first by a `sift` over its type, as TypeScript's `unknown` must (on). Off until
// the repository is measured against it and the decision is made (note/term/plan/decisions-2026-10.md), and on for a
// census with TERM_UNKNOWN_SEAM=1. A `dynamic`, the FFI's `any`, flows both ways either way
let unknownSeam = process.env.TERM_UNKNOWN_SEAM === '1'

export function setUnknownSeam(on: boolean): void {
  unknownSeam = on
}

// a type a value of its own goes into: not the gradual pair, and not a variable still being solved
const typed = (type: Type): boolean => type.kind !== 'unknown' && type.kind !== 'dynamic' && type.kind !== 'variable'

export type Expect = (
  actual: Type,
  wanted: Type,
  span: Span,
  what: string,
) => void

export function makeExpect(deps: {
  unify: (a: Type, b: Type, span?: Span) => boolean
  resolve: (type: Type) => Type
  origin: Map<number, { span: Span; type: Type }>
  diagnostics: Diagnostic[]
  getFile: () => string
}): Expect {
  const { unify, resolve, origin, diagnostics, getFile } = deps

  return (actual, wanted, span, what) => {
    // defensive: a malformed program (e.g. a duplicate definition that already produced a diagnostic) can leave a
    // type undefined. Never crash on it -- the real error has been reported elsewhere.
    if (!actual || !wanted) {
      return
    }

    // remember which sides were still inference variables, so we can blame where they were first fixed
    const suspects: number[] = []

    if (actual.kind === 'variable') {
      suspects.push(actual.id)
    }

    if (wanted.kind === 'variable') {
      suspects.push(wanted.id)
    }

    const unified = unify(actual, wanted, span)

    if (unified && unknownSeam && resolve(actual).kind === 'unknown' && typed(resolve(wanted))) {
      const shown = showType(resolve(wanted))

      diagnostics.push(
        diagnose('type-mismatch', {
          file: getFile(),
          span,
          message: `${what}: an unknown value where ${/^[aeiou]/.test(shown) ? 'an' : 'a'} ${shown} is wanted. An unknown can hold any value, so it is narrowed first, by a \`sift\` over its type`,
          hint: `test what it holds: \`sift value\` with a \`case ${shown}\` arm, inside which it is ${/^[aeiou]/.test(shown) ? 'an' : 'a'} ${shown}, and a \`miss\``,
        }),
      )

      return
    }

    // `number` and `float` unify, so arithmetic can mix them, but a fraction is not a whole number: `number` is `i64`
    // on Rust, Swift and Kotlin and `float` is `f64`. A whole number where a fraction is wanted widens; a fraction
    // where a whole number is wanted was accepted, and `whole(1.5)` against `like integer` emitted `return 1.5`
    // (guides: types/inference, 2026-10-04). Asked after the unify, when both sides are what they resolved to
    if (unified && resolve(actual).kind === 'float' && resolve(wanted).kind === 'number') {
      diagnostics.push(
        diagnose('type-mismatch', {
          file: getFile(),
          span,
          message: `${what}: expected number, a whole number, found float`,
          hint: 'make it whole with `to-number` from @term/base/float (after `round`, `round-down` or `round-up` to choose the direction), or take `like float` if a fraction is meant',
        }),
      )

      return
    }

    if (!unified) {
      const markers: { span: Span; label?: string }[] = [{ span }]

      for (const id of suspects) {
        const where = origin.get(id)

        if (where) {
          markers.push({
            span: where.span,
            label: `first used as ${showType(where.type)} here`,
          })
        }
      }

      diagnostics.push(
        diagnose('type-mismatch', {
          file: getFile(),
          span,
          message: `${what}: expected ${showType(
            resolve(wanted),
          )}, found ${showType(resolve(actual))}`,
          markers,
        }),
      )
    }
  }
}
