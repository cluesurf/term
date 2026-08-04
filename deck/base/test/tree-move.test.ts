import { describe, it, expect } from 'vitest'
import { record, text, ref } from '@term/base/code/base/make'
import { datasetOf, type Dataset } from '@term/base/code/diff/change'
import { canonicalizeRecord } from '@term/base/code/canon/canonicalize'
import {
  parentOf,
  moveRecord,
  childrenOf,
  diffMoves,
  applyMoves,
  mergeTree,
  type TreeMove,
} from '@term/base/code/identity/tree'
import type { Hlc } from '@term/base/code/merge/clock'

const A = 'aaaaaaaa-1111-4111-8111-111111111111'
const B = 'bbbbbbbb-2222-4222-8222-222222222222'
const C = 'cccccccc-3333-4333-8333-333333333333'
const R1 = 'dddddddd-4444-4444-8444-444444444444'
const R2 = 'eeeeeeee-5555-4555-8555-555555555555'

const hlc = (n: number): Hlc => ({ wall: n, count: 0, node: 'x' })

function forest(): Dataset {
  return datasetOf([
    record({ type: 'node', mark: R1, fields: { term: text('root1') } }),
    record({ type: 'node', mark: R2, fields: { term: text('root2') } }),
    record({ type: 'node', mark: A, fields: { term: text('a'), '~parent': ref(R1) } }),
    record({ type: 'node', mark: B, fields: { term: text('b'), '~parent': ref(A) } }),
  ])
}

describe('move-aware hierarchy', () => {
  it('moves a record while keeping its mark (not delete+recreate)', () => {
    const ds = forest()
    const moved = moveRecord(ds, A, R2)
    expect(parentOf(moved.get(A)!)).toBe(R2)
    // identity preserved: same mark, same other fields
    expect(moved.get(A)!.fields.get('term')).toEqual(text('a'))
    expect(childrenOf(moved, R2)).toEqual([A])
    expect(childrenOf(moved, R1)).toEqual([])
  })

  it('reports a parent change as a move, not an add/remove', () => {
    const before = forest()
    const after = moveRecord(before, B, R2)
    const moves = diffMoves(before, after)
    expect(moves).toEqual([{ mark: B, from: A, to: R2 }])
  })
})

describe('op-based move CRDT (cycle-safe)', () => {
  it('applies concurrent moves deterministically regardless of arrival order', () => {
    const ds = forest()
    const m1: TreeMove = { mark: A, parent: R2, time: hlc(1), actor: 'x' }
    const m2: TreeMove = { mark: B, parent: R1, time: hlc(2), actor: 'y' }
    const forward = applyMoves(ds, [m1, m2])
    const reverse = applyMoves(ds, [m2, m1])
    expect(canonicalizeRecord(forward.get(A)!)).toBe(canonicalizeRecord(reverse.get(A)!))
    expect(canonicalizeRecord(forward.get(B)!)).toBe(canonicalizeRecord(reverse.get(B)!))
    expect(parentOf(forward.get(A)!)).toBe(R2)
    expect(parentOf(forward.get(B)!)).toBe(R1)
  })

  it('skips a move that would create a cycle', () => {
    const ds = forest() // B under A under R1
    // concurrently: move A under B (cycle A->B->A), and it must be skipped
    const moves: Array<TreeMove> = [
      { mark: A, parent: B, time: hlc(5), actor: 'x' }, // would form a cycle
    ]
    const out = applyMoves(ds, moves)
    // A keeps its original parent; no cycle formed
    expect(parentOf(out.get(A)!)).toBe(R1)
    // B still under A
    expect(parentOf(out.get(B)!)).toBe(A)
  })
})

describe('state-based tree merge', () => {
  it('keeps a single parent and resolves concurrent moves deterministically', () => {
    const base = forest()
    const ours = moveRecord(base, B, R1) // we move B to R1
    const theirs = moveRecord(base, B, R2) // they move B to R2
    const merged = mergeTree(base, ours, theirs)
    // exactly one parent wins, deterministically, and it is the same either way
    const flipped = mergeTree(base, theirs, ours)
    expect(parentOf(merged.get(B)!)).toBe(parentOf(flipped.get(B)!))
    // B is under exactly one of the two targets
    expect([R1, R2]).toContain(parentOf(merged.get(B)!))
  })

  it('breaks a cycle introduced by concurrent moves', () => {
    const base = datasetOf([
      record({ type: 'node', mark: A, fields: { term: text('a') } }),
      record({ type: 'node', mark: B, fields: { term: text('b') } }),
    ])
    const ours = moveRecord(base, A, B) // A under B
    const theirs = moveRecord(base, B, A) // B under A  -> together a cycle
    const merged = mergeTree(base, ours, theirs)
    // the result is acyclic: walking parents from either node terminates
    const walk = (start: string): boolean => {
      const seen = new Set<string>()
      let cur: string | undefined = start
      while (cur !== undefined) {
        if (seen.has(cur)) return false
        seen.add(cur)
        cur = parentOf(merged.get(cur)!)
      }
      return true
    }
    expect(walk(A)).toBe(true)
    expect(walk(B)).toBe(true)
  })
})
