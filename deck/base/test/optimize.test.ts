import { describe, it, expect } from 'vitest'
import { record, text, list, nested, item } from '@/base/make'
import type { RecordNode } from '@/base/type'
import { datasetOf } from '@/diff/change'
import { form, property, hold, roleBase } from '@/form/form'
import { validateDataset, errors } from '@/form/validate'
import { MemoryChunkStore } from '@/store/chunk-store'
import { MemoryRefStore } from '@/store/ref-store'
import { Repository } from '@/repo/repo'

const M1 = '11111111-1111-4111-8111-111111111111'
const S1 = '22222222-2222-4222-8222-222222222222'
const meta = (m: string) => ({ author: 'a', time: 1, message: m })

function markOf(i: number): string {
  return `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
}

describe('incremental commit', () => {
  it('does not re-store every record when one changes', () => {
    const chunks = new MemoryChunkStore()
    const repo = new Repository(chunks, new MemoryRefStore())

    const records: Array<RecordNode> = []
    for (let i = 0; i < 100; i++) {
      records.push(record({ type: 'word', mark: markOf(i), fields: { term: text(`w${i}`) } }))
    }
    repo.commit('main', meta('base'), datasetOf(records))
    const afterBase = chunks.size()

    // change exactly one record and commit
    const next = new Map(repo.checkoutBranch('main'))
    next.set(markOf(50), record({ type: 'word', mark: markOf(50), fields: { term: text('changed') } }))
    repo.commit('main', meta('one change'), next)
    const added = chunks.size() - afterBase

    // one new record chunk, plus the commit and the few tree nodes on its path,
    // not another 100 record chunks
    expect(added).toBeGreaterThan(0)
    expect(added).toBeLessThan(15)
    // and the result is correct
    expect(repo.checkoutBranch('main').get(markOf(50))!.fields.get('term')).toEqual(text('changed'))
  })
})

describe('recursive validation', () => {
  it('flags a missing required field inside a nested collection record', () => {
    const senseForm = form('sense', [
      property('gloss', { base: 'text' }, { constraints: [hold('need')] }),
    ])
    const wordForm = form('word', [
      property('senses', { record: 'sense' }, { collection: 'list' }),
    ])
    const role = roleBase([wordForm, senseForm])
    const ds = datasetOf([
      record({
        type: 'word',
        mark: M1,
        fields: {
          // a sense with no gloss
          senses: list([item(nested(record({ type: 'sense', mark: S1, fields: {} })), S1)]),
        },
      }),
    ])
    const diags = validateDataset(ds, role)
    expect(errors(diags).some(d => d.message.includes('missing required'))).toBe(true)
  })

  it('passes when the nested record is complete', () => {
    const senseForm = form('sense', [
      property('gloss', { base: 'text' }, { constraints: [hold('need')] }),
    ])
    const wordForm = form('word', [
      property('senses', { record: 'sense' }, { collection: 'list' }),
    ])
    const role = roleBase([wordForm, senseForm])
    const ds = datasetOf([
      record({
        type: 'word',
        mark: M1,
        fields: {
          senses: list([
            item(nested(record({ type: 'sense', mark: S1, fields: { gloss: text('g') } })), S1),
          ]),
        },
      }),
    ])
    expect(errors(validateDataset(ds, role))).toEqual([])
  })
})
