import type { CollectionKind } from '@cluesurf/save/base/type'
import type { Granularity } from '@cluesurf/save/text/diff'

// The concurrency contract a property declares for concurrent edits. Defined here (with
// the rest of the schema) so the merge layer can depend on the schema without a cycle.
export type MergePolicy = 'concurrent' | 'pick' | 'multi' | 'counter'

// A form is the schema, restricted to data: properties with types and constraints,
// never functions. A base form has no tasks and no traits. Constraints come in two
// severities: `hold` blocks a commit, `want` only warns.
//
// See note/project/base/design/06-schema-and-validation.md and
// note/project/base/design/constraint-vocabulary.md.

export type Severity = 'hold' | 'want'

// The type of a property. A base scalar, a reference to another form, a nested
// record of a form, one of several of those, or a collection of one of them.
//
// `any` is a union: the value fits when any arm fits. A schema written for JSON
// needs it constantly (a slot that takes a string, a number, or a node), and a form
// without it has to widen such a property to text and lose the check.
export type Like =
  | { base: 'text' | 'integer' | 'decimal' | 'boolean' | 'date' | 'uuid' }
  | { ref: string }
  | { record: string }
  | { any: Array<Like> }

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

// Whether a form's records travel with a package or are queried remotely. `definition` records are
// small, bounded configuration that is cloned on install (a handful of enum or settings rows).
// `data` records are unbounded bulk (language strings, font records) that stay remote and are
// queried per-record. The default is `data`. See note/project/base/design/packages-and-installation.md.
export type FormTier = 'definition' | 'data'

export type Form = {
  name: string
  properties: Array<Property>
  // the package tier of this form's records; absent means `data`
  tier?: FormTier
  // A UNION FORM: a record under `{ record: <this form> }` is an instance of one of
  // these forms rather than of this one, and this form declares no properties of its
  // own. `key` names the discriminant, the property every arm declares with a
  // one-option `pick`, and it is what picks the arm when a value is lifted from data.
  // Without a union form a slot accepting sixty node kinds would carry a sixty-name
  // `any` at every place it appears.
  arms?: Array<string>
  key?: string
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

// The moves that brought a form's records from one version to the next, keyed by the
// property each produces. The vocabulary is `form/convert.ts`; stated structurally here
// so the schema module depends on nothing above it.
export type FormConversion = Record<string, Record<string, unknown>>

// A `role base` registration: the set of forms that are versioned base schemas, plus
// optional file-handling rules. A form is unmodified to become a base form; membership
// here is what marks it.
//
// `conversions` are the stored moves of every version of each form, oldest first. A
// branch that is BEHIND a form (its records fit an older version) converts when it
// merges: a record the newest version refuses is put through the moves in order and
// checked again, so a merge does not fail on records that were right when they were
// written. See note/project/base/design/record-conversion.md.
export type RoleBase = {
  forms: Map<string, Form>
  files?: FileConfig
  conversions?: Map<string, Array<FormConversion>>
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

export function form(
  name: string,
  properties: Array<Property>,
  opts?: { tier?: FormTier },
): Form {
  const f: Form = { name, properties }
  if (opts?.tier !== undefined) {
    f.tier = opts.tier
  }
  return f
}

/** The default discriminant of a union form, the key a JSON node names its kind under. */
export const UNION_KEY = 'form'

/**
 * A union form: no properties, only the names of its arms.
 *
 * `key` defaults to `form`, which is what a JSON content node carries its kind under.
 * Each arm is expected to declare that property with a one-option `pick`, so the arm a
 * value belongs to is readable off the value.
 */
export function union(
  name: string,
  arms: Array<string>,
  opts?: { key?: string; tier?: FormTier },
): Form {
  const f: Form = { name, properties: [], arms, key: opts?.key ?? UNION_KEY }
  if (opts?.tier !== undefined) {
    f.tier = opts.tier
  }
  return f
}

/** The arm of a union form a discriminant value names, or nothing. */
export function armOf(
  role: RoleBase,
  form: Form,
  tag: string,
): Form | undefined {
  const key = form.key ?? UNION_KEY

  for (const name of form.arms ?? []) {
    const arm = role.forms.get(name)

    if (!arm) {
      continue
    }

    const property = arm.properties.find(p => p.name === key)
    const picks = property?.constraints.some(
      c => c.kind === 'pick' && c.options.includes(tag),
    )

    if (picks) {
      return arm
    }
  }

  return undefined
}

/** A form's package tier, defaulting to `data` (queried remotely, not cloned on install). */
export function tierOf(form: Form): FormTier {
  return form.tier ?? 'data'
}
