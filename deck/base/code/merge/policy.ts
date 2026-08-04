import type { Value } from '@term/base/code/base/type'
import { canonicalizeValue } from '@term/base/code/canon/canonicalize'
import { set as setValue, item } from '@term/base/code/base/make'
import type { MergePolicy, RoleBase } from '@term/base/code/form/form'

// Per-field merge policy: the concurrency contract a form declares for a property, so
// not every field is treated the same when two branches change it. The default is to
// surface a conflict (no silent last-writer-wins), but a form can opt a field into a
// deterministic auto-resolution that fits its meaning: pick one side, keep both, or add
// concurrent increments. This is what turns "the merge converged" into "the merge did
// the right thing for this field". `concurrent` conflicts, `pick` keeps one side by
// canonical order, `multi` keeps both as a set, `counter` composes integer deltas.
//
// See note/library/base/design/collaboration-correctness.md.

export type { MergePolicy }

// Resolve a same-field concurrent change under a policy, or undefined to fall through to
// the default conflict. Only called when both sides changed the field differently.
export function applyFieldPolicy(
  policy: MergePolicy,
  base: Value | undefined,
  a: Value | undefined,
  b: Value | undefined,
): Value | undefined {
  switch (policy) {
    case 'counter': {
      // compose the two independent deltas from the base: base + (a-base) + (b-base)
      if (a?.kind === 'integer' && b?.kind === 'integer') {
        const baseVal = base?.kind === 'integer' ? base.value : 0n
        return { kind: 'integer', value: baseVal + (a.value - baseVal) + (b.value - baseVal) }
      }
      return undefined
    }
    case 'pick': {
      if (a === undefined) return b
      if (b === undefined) return a
      return canonicalizeValue(a) >= canonicalizeValue(b) ? a : b
    }
    case 'multi': {
      const values: Array<Value> = []
      const seen = new Set<string>()
      for (const v of [a, b]) {
        if (v === undefined) continue
        const c = canonicalizeValue(v)
        if (!seen.has(c)) {
          seen.add(c)
          values.push(v)
        }
      }
      return setValue(values.map(v => item(v)))
    }
    default:
      return undefined // 'concurrent'
  }
}

export type FieldPolicyResolver = (type: string, field: string) => MergePolicy | undefined

// Build a resolver that reads each property's declared merge policy from a role base.
export function policyResolver(role: RoleBase): FieldPolicyResolver {
  return (type, field) => {
    const form = role.forms.get(type)
    return form?.properties.find(p => p.name === field)?.merge
  }
}
