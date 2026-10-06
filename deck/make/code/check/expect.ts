// The `expect` assertion: unify an actual type against a wanted type, and on failure answer a type-mismatch diagnostic
// that blames where each side's variable was first fixed. Extracted from the inference closure as a component of the
// modular checker. See note/seed/plan/compilation-performance.md (Tier 2).
//
// The shape check/expect.tree has: the substitution and the transparent aliases come in, the unify is the checker's
// own (each side's aliases unfolded, the span recorded), and the diagnostics come back for the checker to add. It was
// a factory over the checker's closures.

import { diagnose } from '@term/make/code/parser/diagnostic'
import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'
import type { Type } from '@term/make/code/compile/node'
import { showType } from '@term/make/code/compile/type-text'
import { unfoldAlias } from '@term/make/code/check/alias'
import type { TypeAlias } from '@term/make/code/check/alias'
import { resolveType, unifyTypesAt } from '@term/make/code/check/substitution'
import type { Substitution } from '@term/make/code/check/substitution'

export function expectType(
  sub: Substitution,
  aliases: ReadonlyMap<string, TypeAlias>,
  actual: Type,
  wanted: Type,
  span: Span,
  what: string,
  file: string,
): Diagnostic[] {
  // remember which sides were still inference variables, so we can blame where they were first fixed
  const suspects: number[] = []

  if (actual.kind === 'variable') {
    suspects.push(actual.id)
  }

  if (wanted.kind === 'variable') {
    suspects.push(wanted.id)
  }

  const unified = unifyTypesAt(sub, unfoldAlias(actual, aliases), unfoldAlias(wanted, aliases), span)

  // `number` and `float` unify, so arithmetic can mix them, but a fraction is not a whole number: `number` is `i64`
  // on Rust, Swift and Kotlin and `float` is `f64`. A whole number where a fraction is wanted widens; a fraction
  // where a whole number is wanted was accepted, and `whole(1.5)` against `like integer` emitted `return 1.5`
  // (guides: types/inference, 2026-10-04). Asked after the unify, when both sides are what they resolved to
  if (unified && resolveType(sub, actual).kind === 'float' && resolveType(sub, wanted).kind === 'number') {
    return [
      diagnose('type-mismatch', {
        file,
        span,
        message: `${what}: expected number, a whole number, found float`,
        hint: 'make it whole with `to-number` from @term/base/float (after `round`, `round-down` or `round-up` to choose the direction), or take `like float` if a fraction is meant',
      }),
    ]
  }

  if (unified) {
    return []
  }

  const markers: { span: Span; label?: string }[] = [{ span }]

  for (const id of suspects) {
    const where = sub.origin.get(id)

    if (where) {
      markers.push({
        span: where.span,
        label: `first used as ${showType(where.type)} here`,
      })
    }
  }

  return [
    diagnose('type-mismatch', {
      file,
      span,
      message: `${what}: expected ${showType(resolveType(sub, wanted))}, found ${showType(resolveType(sub, actual))}`,
      markers,
    }),
  ]
}
