// Trait checking: masks are records of method signatures, instances (wear/suit) are dictionaries implementing
// them. This pass checks the two real correctness properties: an instance implements every method its mask
// declares, and every `need` bound and instance refers to a mask that exists. This is the dictionary-passing
// trait model (structural, no orphan-coherence machinery). See note/research/vibe/computation/plans/04-typecheck.md.
// Resolving which instance to pass at a call site (and monomorphization) is the deeper continuation.

import type { Diagnostic } from '@/code/parser/diagnostic'
import { diagnose, nearest } from '@/code/parser/diagnostic'
import type { Program } from '@/code/compile/node'

export function checkTraits(
  program: Program,
  file: string,
): Array<Diagnostic> {
  const diagnostics: Array<Diagnostic> = []

  // register every mask and the methods it declares
  const masks = new Map<string, Array<string>>()
  for (const statement of program) {
    if (statement.form === 'mask')
      masks.set(statement.name, statement.methods)
  }
  const maskNames = [...masks.keys()]

  // coherence: a given trait may be implemented at most once for a given type (no overlapping instances)
  const seenInstances = new Set<string>()
  for (const statement of program) {
    if (statement.form !== 'instance') continue
    const key = `${statement.mask}:${statement.target}`
    if (seenInstances.has(key)) {
      diagnostics.push(
        diagnose('duplicate-instance', {
          file,
          span: statement.span,
          message: `"${statement.target}" implements "${statement.mask}" more than once`,
        }),
      )
    }
    seenInstances.add(key)
  }

  // each instance must implement every method of its mask, and its mask must exist
  for (const statement of program) {
    if (statement.form !== 'instance') continue
    const required = masks.get(statement.mask)
    if (!required) {
      const hint = nearest(statement.mask, maskNames)
      diagnostics.push(
        diagnose('unknown-name', {
          file,
          span: statement.span,
          message: `the trait "${statement.mask}" is not defined`,
          hint: hint ? `did you mean "${hint}"?` : undefined,
        }),
      )
      continue
    }
    const provided = new Set(statement.methods)
    const missing = required.filter(m => !provided.has(m))
    if (missing.length > 0) {
      diagnostics.push(
        diagnose('incomplete-instance', {
          file,
          span: statement.span,
          message: `"${statement.target}" implements "${
            statement.mask
          }" but is missing: ${missing.join(', ')}`,
        }),
      )
    }
  }

  // every `need` bound on a generic must refer to a mask that exists
  for (const statement of program) {
    if (statement.form !== 'function') continue
    for (const generic of statement.generics) {
      if (generic.need && !masks.has(generic.need)) {
        const hint = nearest(generic.need, maskNames)
        diagnostics.push(
          diagnose('unknown-name', {
            file,
            span: statement.span,
            message: `the trait bound "${generic.need}" on "${generic.name}" is not a defined trait`,
            hint: hint ? `did you mean "${hint}"?` : undefined,
          }),
        )
      }
    }
  }

  return diagnostics
}
