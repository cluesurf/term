import type { RecordNode, Value } from '@term/base/code/base/type'
import type { Dataset } from '@term/base/code/diff/change'

// Schema migration. A form changes and existing records must move to the new shape.
// Migrations are declarative, idempotent operations, so they can be applied lazily
// on read (upcasting a record to the current shape) or eagerly as a commit that
// rewrites the dataset. Idempotence means a migration is safe to apply to a record
// at any version, so no per-record version stamp is required.
//
// See note/library/base/design/schema-migration.md.

export type MigrationOp =
  // add a property with a default if it is absent
  | { op: 'add'; field: string; value: Value }
  // rename a property, only when the old name is present and the new one is not
  | { op: 'rename'; from: string; to: string }
  // remove a property if present
  | { op: 'drop'; field: string }
  // convert a property's value with a pure converter, if present
  | { op: 'retype'; field: string; convert: (value: Value) => Value }

// Apply a migration (a sequence of ops) to one record. Idempotent.
export function upcastRecord(
  node: RecordNode,
  ops: Array<MigrationOp>,
): RecordNode {
  const fields = new Map(node.fields)
  for (const op of ops) {
    switch (op.op) {
      case 'add':
        if (!fields.has(op.field)) {
          fields.set(op.field, op.value)
        }
        break
      case 'rename':
        if (fields.has(op.from) && !fields.has(op.to)) {
          fields.set(op.to, fields.get(op.from)!)
          fields.delete(op.from)
        }
        break
      case 'drop':
        fields.delete(op.field)
        break
      case 'retype': {
        const v = fields.get(op.field)
        if (v !== undefined) {
          fields.set(op.field, op.convert(v))
        }
        break
      }
    }
  }
  return { ...node, fields }
}

// Apply a migration to every record whose type matches (or all, if no type given).
export function upcastDataset(
  dataset: Dataset,
  ops: Array<MigrationOp>,
  type?: string,
): Dataset {
  const out: Dataset = new Map()
  for (const [mark, node] of dataset) {
    out.set(mark, type && node.type !== type ? node : upcastRecord(node, ops))
  }
  return out
}

// A migration is a named change from one form version to the next. Committing the
// upcast dataset records the migration in history like any other change.
export type Migration = {
  form: string
  from: number
  to: number
  ops: Array<MigrationOp>
}

// Apply a chain of migrations in order.
export function upcastAll(
  dataset: Dataset,
  migrations: Array<Migration>,
): Dataset {
  let out = dataset
  for (const m of [...migrations].sort((a, b) => a.from - b.from)) {
    out = upcastDataset(out, m.ops, m.form)
  }
  return out
}
