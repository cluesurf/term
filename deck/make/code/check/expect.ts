// The `expect` assertion: unify an actual type against a wanted type, and on failure push a type-mismatch diagnostic
// that blames where each side's variable was first fixed. Extracted from the inference closure as a component of the
// modular checker (a factory over the substitution + diagnostics sink). See note/seed/plan/compilation-performance.md (Tier 2).

import { diagnose } from '@cluesurf/make/code/parser/diagnostic'
import type {
  Diagnostic,
  Span,
} from '@cluesurf/make/code/parser/diagnostic'
import type { Type } from '@cluesurf/make/code/compile/node'
import { showType } from '@cluesurf/make/code/compile/node'

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

    if (!unify(actual, wanted, span)) {
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
