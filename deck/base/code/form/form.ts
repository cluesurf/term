import type { CollectionKind } from '@/base/type'
import type { Granularity } from '@/text/diff'

// The concurrency contract a property declares for concurrent edits. Defined here (with
// the rest of the schema) so the merge layer can depend on the schema without a cycle.
export type MergePolicy = 'concurrent' | 'pick' | 'multi' | 'counter'

// A form is the schema, restricted to data: properties with types and constraints,
// never functions. A base form has no tasks and no traits. Constraints come in two
// severities: `hold` blocks a commit, `want` only warns.
//
// See note/library/base/06-schema-and-validation.md and
// note/library/base/design/constraint-vocabulary.md.

export type Severity = 'hold' | 'want'

// The type of a property. A base scalar, a reference to another form, a nested
// record of a form, or a collection of one of those.
export type Like =
  | { base: 'text' | 'integer' | 'decimal' | 'boolean' | 'date' | 'uuid' }
  | { ref: string }
  | { record: string }

// The closed, declarative constraint set. Each is checkable without running code.
export type Constraint =
  | { severity: Severity; kind: 'need' }
  | { severity: Severity; kind: 'sole'; scope: 'form' | 'global' }
  | { severity: Severity; kind: 'sort' }
  | { severity: Severity; kind: 'span'; min?: number; max?: number }
  | { severity: Severity; kind: 'face'; pattern: string }
  | { severity: Severity; kind: 'pick'; options: Array<string> }
  | { severity: Severity; kind: 'mark' }
  | { severity: Severity; kind: 'seal' }

export type Property = {
  name: string
  like: Like
  // if set, this property is a collection of `like` with the given kind
  collection?: CollectionKind
  // the merge policy for concurrent edits to this field (default: conflict)
  merge?: MergePolicy
  constraints: Array<Constraint>
}

export type Form = {
  name: string
  properties: Array<Property>
}

// A per-pattern text-diff rule: which files to diff at which granularity.
export type FileRule = { match: string; granularity?: Granularity }

// How a `role base` treats non-record files that live alongside the data. `opaque`
// patterns are generated or derived output (a `.tree` site compiled to `build/**`, or
// `.js`/`.css` bundles): they are stored and versioned as whole blobs and never text
// diffed or line merged, since diffing generated output is noise. `diff` sets the
// granularity for the files that are diffed (default `line`).
export type FileConfig = {
  opaque?: Array<string>
  diff?: Array<FileRule>
}

// A `role base` registration: the set of forms that are versioned base schemas, plus
// optional file-handling rules. A form is unmodified to become a base form; membership
// here is what marks it.
export type RoleBase = {
  forms: Map<string, Form>
  files?: FileConfig
}

export function roleBase(
  forms: Array<Form>,
  opts?: { files?: FileConfig },
): RoleBase {
  const map = new Map<string, Form>()
  for (const f of forms) {
    map.set(f.name, f)
  }
  const role: RoleBase = { forms: map }
  if (opts?.files !== undefined) {
    role.files = opts.files
  }
  return role
}

// Builder helpers.

export function hold(kind: Constraint['kind'], extra?: object): Constraint {
  return { severity: 'hold', kind, ...(extra ?? {}) } as Constraint
}

export function want(kind: Constraint['kind'], extra?: object): Constraint {
  return { severity: 'want', kind, ...(extra ?? {}) } as Constraint
}

export function property(
  name: string,
  like: Like,
  opts?: {
    collection?: CollectionKind
    constraints?: Array<Constraint>
    merge?: MergePolicy
  },
): Property {
  const p: Property = { name, like, constraints: opts?.constraints ?? [] }
  if (opts?.collection) {
    p.collection = opts.collection
  }
  if (opts?.merge) {
    p.merge = opts.merge
  }
  return p
}

export function form(name: string, properties: Array<Property>): Form {
  return { name, properties }
}
