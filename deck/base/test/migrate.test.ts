import { describe, it, expect } from 'vitest'
import { record, text, integer } from '@/base/make'
import { datasetOf } from '@/diff/change'
import {
  upcastRecord,
  upcastDataset,
  upcastAll,
  type MigrationOp,
  type Migration,
} from '@/migrate/migrate'

const M1 = '11111111-1111-4111-8111-111111111111'
const M2 = '22222222-2222-4222-8222-222222222222'

describe('schema migration', () => {
  it('adds a field only when absent', () => {
    const node = record({ type: 'word', mark: M1, fields: { term: text('foo') } })
    const ops: Array<MigrationOp> = [{ op: 'add', field: 'gloss', value: text('') }]
    const up = upcastRecord(node, ops)
    expect(up.fields.get('gloss')).toEqual(text(''))
    // idempotent: a second apply does not overwrite a real value
    const edited = upcastRecord(
      record({ type: 'word', mark: M1, fields: { term: text('foo'), gloss: text('real') } }),
      ops,
    )
    expect(edited.fields.get('gloss')).toEqual(text('real'))
  })

  it('renames a field only when the source is present and target is not', () => {
    const node = record({ type: 'word', mark: M1, fields: { name: text('foo') } })
    const ops: Array<MigrationOp> = [{ op: 'rename', from: 'name', to: 'term' }]
    const up = upcastRecord(node, ops)
    expect(up.fields.has('name')).toBe(false)
    expect(up.fields.get('term')).toEqual(text('foo'))
    // idempotent: applying again is a no-op
    expect(upcastRecord(up, ops)).toEqual(up)
  })

  it('drops and retypes fields', () => {
    const node = record({
      type: 'word',
      mark: M1,
      fields: { legacy: text('x'), count: text('42') },
    })
    const ops: Array<MigrationOp> = [
      { op: 'drop', field: 'legacy' },
      {
        op: 'retype',
        field: 'count',
        convert: v => (v.kind === 'text' ? integer(BigInt(v.value)) : v),
      },
    ]
    const up = upcastRecord(node, ops)
    expect(up.fields.has('legacy')).toBe(false)
    expect(up.fields.get('count')).toEqual(integer(42))
  })

  it('upcasts a whole dataset by type', () => {
    const ds = datasetOf([
      record({ type: 'word', mark: M1, fields: { term: text('a') } }),
      record({ type: 'sound', mark: M2, fields: { ipa: text('b') } }),
    ])
    const out = upcastDataset(ds, [{ op: 'add', field: 'gloss', value: text('') }], 'word')
    expect(out.get(M1)!.fields.has('gloss')).toBe(true)
    expect(out.get(M2)!.fields.has('gloss')).toBe(false)
  })

  it('applies a chain of migrations in version order', () => {
    const ds = datasetOf([record({ type: 'word', mark: M1, fields: { name: text('a') } })])
    const migrations: Array<Migration> = [
      { form: 'word', from: 2, to: 3, ops: [{ op: 'add', field: 'gloss', value: text('') }] },
      { form: 'word', from: 1, to: 2, ops: [{ op: 'rename', from: 'name', to: 'term' }] },
    ]
    const out = upcastAll(ds, migrations)
    const r = out.get(M1)!
    expect(r.fields.get('term')).toEqual(text('a'))
    expect(r.fields.has('gloss')).toBe(true)
    expect(r.fields.has('name')).toBe(false)
  })
})
