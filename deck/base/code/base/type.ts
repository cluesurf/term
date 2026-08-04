// The canonical semantic model. base versions a typed, identified record graph,
// not text and not JSON. Every other layer (canonical serialization, diff, merge,
// forms, store, projection) is defined in terms of these types.
//
// See note/library/base/01-record-model.md.

// A mark is the durable identity of a record or nested entity: a random,
// time-independent UUID (version 4), written literally into the data. A node
// with a mark is shared, versioned, and mergeable. A node without one is
// volatile: local working data, never merged by identity.
export type Mark = string

// The kind of a collection determines how it diffs and merges, so it is explicit,
// never inferred (see note/library/base/design/merge-formal-spec.md):
//   list  ordered, order is meaningful
//   set   unordered, order incidental, add-wins
//   map   addressed by key
//   log   append-only, entries only ever added (provenance, audit)
export type CollectionKind = 'list' | 'set' | 'map' | 'log'

// A value at a field path. Scalars are typed explicitly (no implicit typing).
// Numbers are never IEEE floats: integers are bigint, decimals are canonical
// strings, so hashing is deterministic. A ref points at a record by mark; a blob
// references binary content by hash. A collection holds items; a record nests.
export type Value =
  | { kind: 'text'; value: string }
  | { kind: 'integer'; value: bigint }
  | { kind: 'decimal'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'date'; value: string }
  | { kind: 'null' }
  | { kind: 'ref'; target: Mark }
  | { kind: 'blob'; hash: string }
  | { kind: 'collection'; order: CollectionKind; items: Array<Item> }
  | { kind: 'record'; record: RecordNode }

// One member of a collection. `mark` gives it stable identity so it merges by
// identity rather than by position; `key` names it inside a map.
export type Item = {
  mark?: Mark
  key?: string
  value: Value
}

// A record or nested entity. `mark` is the identity (absent means volatile).
// `type` is the form name. `label` is the readable header value (a headword),
// which is not the identity. `fields` are the typed properties by name.
export type RecordNode = {
  mark?: Mark
  type: string
  label?: string
  fields: Map<string, Value>
}

// The scalar value kinds, for validation and canonical ordering.
export const SCALAR_KINDS = [
  'text',
  'integer',
  'decimal',
  'boolean',
  'date',
  'null',
  'ref',
  'blob',
] as const

export type ScalarKind = (typeof SCALAR_KINDS)[number]
