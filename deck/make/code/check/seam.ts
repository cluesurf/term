// THE GRADUAL SEAM. Whether an `unknown` may flow into a place that wants a type of its own, as TypeScript's `any`
// does (the switch off), or must be narrowed first by a `sift` over its type, as TypeScript's `unknown` must (on). Off
// until the repository is moved and the decision is made (note/term/plan/decisions-2026-10.md, D1), and on for a census
// with TERM_UNKNOWN_SEAM=1. A `dynamic`, the FFI's `any`, flows both ways either way. test/compile/unknown-narrow.ts.
//
// Its own module, asked after `expectType` (check/expect.ts and its port) has unified the two sides: the switch is
// module state, which the ported assertion does not hold.

import { diagnose } from '@term/make/code/parser/diagnostic'
import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'
import type { Type } from '@term/make/code/compile/node'
import { showType } from '@term/make/code/compile/type-text'
import { resolveType } from '@term/make/code/check/substitution'
import type { Substitution } from '@term/make/code/check/substitution'

let on = process.env.TERM_UNKNOWN_SEAM === '1'

export function setUnknownSeam(seam: boolean): void {
  on = seam
}

// the types an arm of a `sift` over an `unknown` can name, which every backend can tell apart in its dynamic value
const NARROWABLE = ['number', 'float', 'text', 'boolean']

// a type a value of its own goes into: not the gradual pair, and not a variable still being solved
const typed = (type: Type): boolean => type.kind !== 'unknown' && type.kind !== 'dynamic' && type.kind !== 'variable'

// the refusal of an `unknown` handed to a typed place, when the seam is on and the two sides already unified
export function unknownSeam(sub: Substitution, actual: Type, wanted: Type, span: Span, what: string, file: string): Diagnostic[] {
  if (!on || resolveType(sub, actual).kind !== 'unknown' || !typed(resolveType(sub, wanted))) {
    return []
  }

  const shown = showType(resolveType(sub, wanted))
  const article = /^[aeiou]/.test(shown) ? 'an' : 'a'

  return [
    diagnose('type-mismatch', {
      file,
      span,
      message: `${what}: an unknown value where ${article} ${shown} is wanted. An unknown can hold any value, so it is narrowed first, by a \`sift\` over its type`,
      hint: NARROWABLE.includes(shown)
        ? `test what it holds: \`sift value\` with a \`case ${shown}\` arm, inside which it is ${article} ${shown}, and a \`miss\``
        : `${article} ${shown} cannot be told apart inside an unknown on every backend: take \`like ${shown}\` where the value is made, or give it a form with a case per kind it can be`,
    }),
  ]
}
