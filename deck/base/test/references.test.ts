import { describe, it, expect } from 'vitest'
import { record, text, ref, list, item, nested } from '@/base/make'
import { datasetOf } from '@/diff/change'
import { validateReferences } from '@/form/references'
import { errors } from '@/form/validate'
import { removeWithAction } from '@/identity/lifecycle'
import {
  MemoryOffHistoryStore,
  putOffHistory,
} from '@/offhistory/store'

const A = 'aaaaaaaa-1111-4111-8111-111111111111'
const B = 'bbbbbbbb-2222-4222-8222-222222222222'
const S = 'cccccccc-3333-4333-8333-333333333333'

describe('referential integrity', () => {
  it('finds no dangling references in a consistent dataset', () => {
    const ds = datasetOf([
      record({ type: 'word', mark: A, fields: { term: text('a') } }),
      record({ type: 'word', mark: B, fields: { term: text('b'), root: ref(A) } }),
    ])
    expect(validateReferences(ds)).toEqual([])
  })

  it('flags a reference left dangling by a dangle removal', () => {
    const ds = datasetOf([
      record({ type: 'word', mark: A, fields: { term: text('a') } }),
      record({ type: 'word', mark: B, fields: { term: text('b'), root: ref(A) } }),
    ])
    const after = removeWithAction(ds, A, 'dangle')
    expect(after.ok).toBe(true)
    if (after.ok) {
      const diags = validateReferences(after.dataset)
      expect(diags.length).toBe(1)
      expect(diags[0]!.message).toContain('dangling')
      expect(diags[0]!.mark).toBe(B)
      // it is a warning by default, not a blocking error
      expect(errors(diags)).toEqual([])
    }
  })

  it('escalates to an error when asked', () => {
    const ds = datasetOf([record({ type: 'word', mark: B, fields: { root: ref(A) } })])
    const diags = validateReferences(ds, { severity: 'hold' })
    expect(errors(diags).length).toBe(1)
  })

  it('finds references inside collections and nested records', () => {
    const ds = datasetOf([
      record({
        type: 'word',
        mark: B,
        fields: {
          senses: list([
            item(nested(record({ type: 'sense', mark: S, fields: { source: ref(A) } })), S),
          ]),
        },
      }),
    ])
    const diags = validateReferences(ds)
    expect(diags.length).toBe(1)
    expect(diags[0]!.message).toContain(A)
  })

  it('flags off-history content that has been deleted', () => {
    const store = new MemoryOffHistoryStore()
    const refValue = putOffHistory(store, 'sensitive')
    const ds = datasetOf([record({ type: 'person', mark: A, fields: { note: refValue } })])
    // present: no diagnostic
    expect(validateReferences(ds, { offHistory: store })).toEqual([])
    // delete the content: now flagged
    const id = (refValue.kind === 'blob' ? refValue.hash.split(':')[1] : '')!
    store.delete(id)
    const diags = validateReferences(ds, { offHistory: store })
    expect(diags.length).toBe(1)
    expect(diags[0]!.message).toContain('absent')
  })
})
