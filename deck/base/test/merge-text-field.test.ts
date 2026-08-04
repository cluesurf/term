import { describe, it, expect } from 'vitest'
import { record, text } from '@term/base/code/base/make'
import { datasetOf } from '@term/base/code/diff/change'
import { mergeDataset } from '@term/base/code/merge/merge'

const M1 = '11111111-1111-4111-8111-111111111111'

function ds(term: string) {
  return datasetOf([record({ type: 'word', mark: M1, fields: { gloss: text(term) } })])
}

describe('record-level text field merge', () => {
  it('merges disjoint word edits to the same text field cleanly', () => {
    const base = ds('a medicinal compound used in ritual')
    const a = ds('a medical compound used in ritual') // edit word 2
    const b = ds('a medicinal compound used in ceremony') // edit last word
    const { merged, conflicts } = mergeDataset(base, a, b)
    expect(conflicts).toEqual([])
    expect(merged.get(M1)!.fields.get('gloss')).toEqual(text('a medical compound used in ceremony'))
  })

  it('still conflicts when both edit the same word differently', () => {
    const base = ds('the quick fox')
    const a = ds('the slow fox')
    const b = ds('the fast fox')
    const { conflicts } = mergeDataset(base, a, b)
    expect(conflicts.length).toBe(1)
    expect(conflicts[0]!.path).toBe('gloss')
  })
})
