// The locals a `fork case` arm brings into scope. A variant's fields are visible in its arm by their own names. A
// leading run of `link <name>` lines under the `case` says which, or renames them: when every name is a field of the
// variant, the arm selects those fields by name (in any order, the others stay out of scope); otherwise the names
// rename the fields in declaration order, so a nested match on the same enum can bind both without a collision.
// The checker types the locals and the emitters declare them, from this one answer.

export type ArmLocal = { field: string; local: string }

export function armLocals(
  // the variant's field names, in declaration order
  fields: string[],
  // the arm's `link` names, in source order
  binds: string[] | undefined,
): ArmLocal[] {
  if (!binds || binds.length === 0) {
    return fields.map(field => ({ field, local: field }))
  }

  if (binds.every(name => fields.includes(name))) {
    return binds.map(name => ({ field: name, local: name }))
  }

  return fields.map((field, at) => ({ field, local: binds[at] ?? field }))
}
