// THE GRADUAL SEAM. Whether an `unknown` may flow into a place that wants a type of its own, as TypeScript's `any`
// does (the switch off), or must be narrowed first by a `sift` over its type, as TypeScript's `unknown` must (on). Off
// until the repository is moved and the decision is made (note/term/plan/decisions-2026-10.md, D1), and on for a census
// with TERM_UNKNOWN_SEAM=1. A `dynamic`, the FFI's `any`, flows both ways either way. test/compile/unknown-narrow.ts.
//
// Its own module, asked after `expectType` (check/expect.ts and its port) has unified the two sides: the switch is
// module state, which the ported assertion does not hold.

import { diagnose } from '@term/make/code/parser/diagnostic'
import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'
import type { Expression, Type } from '@term/make/code/compile/node'
import { showType } from '@term/make/code/compile/type-text'
import { resolveType } from '@term/make/code/check/substitution'
import type { Substitution } from '@term/make/code/check/substitution'

let on = process.env.TERM_UNKNOWN_SEAM === '1'

export function setUnknownSeam(seam: boolean): void {
  on = seam
}

// whether the seam is on: part of every compile cache key, since it decides what the checker refuses
export function unknownSeamOn(): boolean {
  return on
}

// the types an arm of a `sift` over an `unknown` can name, which every backend can tell apart in its dynamic value
const NARROWABLE = ['number', 'float', 'text', 'boolean']

// THE TESTS THAT NARROW AN `unknown` in the branch they guard, each to the `sift` arm it is the same as:
// `fork test, is-text(value)` is `sift value / case text` (check/infer.ts `narrowsUnknown`). They have no definition:
// the resolver lets one through only as a branch's whole test of one local (check/resolve.ts), and the checker
// rewrites it there, or refuses it
export const TYPE_TESTS = new Map(NARROWABLE.map(type => [`is-${type}`, type]))

// a branch test that is one of them applied to one local, `is-text(value)`, by its name and the local's
export function typeTestOf(cond: Expression): { test: string; label: string; subject: string } | undefined {
  const subject = cond.form === 'call' && cond.args.length === 1 ? cond.args[0] : undefined

  if (cond.form !== 'call' || cond.callee.form !== 'variable' || subject?.form !== 'variable') {
    return undefined
  }

  // an overload renamed by arity or type keeps its written name before the suffix (check/overload.ts)
  const test = cond.callee.name.replace(/__\d+(__\d+)?$/, '')
  const label = TYPE_TESTS.get(test)

  return label ? { test, label, subject: subject.name } : undefined
}

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
