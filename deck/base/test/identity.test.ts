import { describe, it, expect } from 'vitest'
import { record, text, ref } from '@/base/make'
import { datasetOf } from '@/diff/change'
import {
  referrers,
  isRedirect,
  redirectTarget,
  resolveMark,
  mergeRecords,
  splitRecord,
  removeWithAction,
} from '@/identity/lifecycle'

const A = 'aaaaaaaa-1111-4111-8111-111111111111'
const B = 'bbbbbbbb-2222-4222-8222-222222222222'
const C = 'cccccccc-3333-4333-8333-333333333333'
const P1 = 'dddddddd-4444-4444-8444-444444444444'
const P2 = 'eeeeeeee-5555-4555-8555-555555555555'

describe('identity lifecycle', () => {
  it('finds referrers of a mark', () => {
    const ds = datasetOf([
      record({ type: 'word', mark: A, fields: { term: text('a') } }),
      record({ type: 'word', mark: B, fields: { term: text('b'), root: ref(A) } }),
    ])
    expect(referrers(ds, A)).toEqual([B])
    expect(referrers(ds, B)).toEqual([])
  })

  it('merges a loser into a winner as a redirect, keeping references resolvable', () => {
    const ds = datasetOf([
      record({ type: 'word', mark: A, fields: { term: text('a'), extra: text('keep') } }),
      record({ type: 'word', mark: B, fields: { term: text('b') } }),
      record({ type: 'word', mark: C, fields: { term: text('c'), root: ref(A) } }),
    ])
    const out = mergeRecords(ds, A, B)
    // loser is now a redirect
    expect(isRedirect(out.get(A)!)).toBe(true)
    expect(redirectTarget(out.get(A)!)).toBe(B)
    // winner absorbed the loser's unique field
    expect(out.get(B)!.fields.get('extra')).toEqual(text('keep'))
    // winner keeps its own field
    expect(out.get(B)!.fields.get('term')).toEqual(text('b'))
    // inbound reference rewritten to the winner
    expect(out.get(C)!.fields.get('root')).toEqual(ref(B))
    // resolveMark follows the redirect
    expect(resolveMark(out, A)).toBe(B)
    expect(resolveMark(out, B)).toBe(B)
  })

  it('follows a redirect chain to the final live mark', () => {
    const ds = datasetOf([
      record({ type: 'word', mark: A, fields: { term: text('a') } }),
      record({ type: 'word', mark: B, fields: { term: text('b') } }),
      record({ type: 'word', mark: C, fields: { term: text('c') } }),
    ])
    // merge A into B, then B into C: A -> B -> C
    let out = mergeRecords(ds, A, B, { rewriteRefs: false })
    out = mergeRecords(out, B, C, { rewriteRefs: false })
    expect(resolveMark(out, A)).toBe(C)
    expect(resolveMark(out, B)).toBe(C)
    expect(resolveMark(out, C)).toBe(C)
  })

  it('splits a record into parts, leaving a split marker', () => {
    const ds = datasetOf([record({ type: 'word', mark: A, fields: { term: text('bank') } })])
    const parts = [
      record({ type: 'word', mark: P1, fields: { term: text('bank-money') } }),
      record({ type: 'word', mark: P2, fields: { term: text('bank-river') } }),
    ]
    const out = splitRecord(ds, A, parts)
    expect(out.get(P1)!.fields.get('term')).toEqual(text('bank-money'))
    expect(out.get(P2)!.fields.get('term')).toEqual(text('bank-river'))
    // source now carries a split marker referencing the parts
    const marker = out.get(A)!.fields.get('~split')!
    expect(marker.kind).toBe('collection')
  })

  it('applies referential actions on removal', () => {
    const ds = datasetOf([
      record({ type: 'word', mark: A, fields: { term: text('a') } }),
      record({ type: 'word', mark: B, fields: { term: text('b'), root: ref(A) } }),
    ])
    // restrict refuses while a referrer exists
    const restricted = removeWithAction(ds, A, 'restrict')
    expect(restricted.ok).toBe(false)
    if (!restricted.ok) {
      expect(restricted.blockedBy).toEqual([B])
    }
    // cascade removes the referrer too
    const cascaded = removeWithAction(ds, A, 'cascade')
    expect(cascaded.ok).toBe(true)
    if (cascaded.ok) {
      expect(cascaded.dataset.has(A)).toBe(false)
      expect(cascaded.dataset.has(B)).toBe(false)
    }
    // dangle removes only the target, leaving the reference to be flagged
    const dangled = removeWithAction(ds, A, 'dangle')
    expect(dangled.ok).toBe(true)
    if (dangled.ok) {
      expect(dangled.dataset.has(A)).toBe(false)
      expect(dangled.dataset.has(B)).toBe(true)
    }
  })
})
