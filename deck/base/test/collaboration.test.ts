import { describe, it, expect } from 'vitest'
import { record, text, integer, ref } from '@/base/make'
import { datasetOf, type Dataset } from '@/diff/change'
import { canonicalizeRecord } from '@/canon/canonicalize'
import { form, property, hold, roleBase } from '@/form/form'
import { mergeDataset } from '@/merge/merge'
import { policyResolver } from '@/merge/policy'
import { MemoryChunkStore } from '@/store/chunk-store'
import { MemoryRefStore } from '@/store/ref-store'
import { Repository } from '@/repo/repo'
import { diffSemantic, summarizeSemantic } from '@/diff/semantic'
import { moveRecord, applyMoves, mergeTree, recoverOrphans, parentOf, type TreeMove } from '@/identity/tree'
import { orderKeyBetween, orderKeyAfter, orderKeyBefore } from '@/base/order'
import { PresenceChannel, LeaseRegistry } from '@/live/presence'
import type { Hlc } from '@/merge/clock'

const M1 = '11111111-1111-4111-8111-111111111111'
const M2 = '22222222-2222-4222-8222-222222222222'
const A = 'aaaaaaaa-1111-4111-8111-111111111111'
const B = 'bbbbbbbb-2222-4222-8222-222222222222'
const R1 = 'dddddddd-4444-4444-8444-444444444444'
const R2 = 'eeeeeeee-5555-4555-8555-555555555555'
const meta = (t: number, m: string, author = 'a') => ({ author, time: t, message: m })

describe('field-specific merge policy', () => {
  const role = roleBase([
    form('page', [
      property('votes', { base: 'integer' }, { merge: 'counter' }),
      property('title', { base: 'text' }, { merge: 'pick' }),
      property('meaning', { base: 'text' }, { merge: 'multi' }),
      property('note', { base: 'text' }), // default: conflict
    ]),
  ])
  const resolve = { policy: policyResolver(role) }

  function ds(fields: Record<string, ReturnType<typeof text>>) {
    return datasetOf([record({ type: 'page', mark: M1, fields })])
  }

  it('composes concurrent increments with a counter policy', () => {
    const base = datasetOf([record({ type: 'page', mark: M1, fields: { votes: integer(5) } })])
    const ours = datasetOf([record({ type: 'page', mark: M1, fields: { votes: integer(7) } })]) // +2
    const theirs = datasetOf([record({ type: 'page', mark: M1, fields: { votes: integer(9) } })]) // +4
    const { merged, conflicts } = mergeDataset(base, ours, theirs, resolve)
    expect(conflicts).toEqual([])
    expect(merged.get(M1)!.fields.get('votes')).toEqual(integer(11)) // 5 + 2 + 4
  })

  it('auto-resolves a pick policy deterministically', () => {
    const base = ds({ title: text('base') })
    const ours = ds({ title: text('ours') })
    const theirs = ds({ title: text('theirs') })
    const ab = mergeDataset(base, ours, theirs, resolve)
    const ba = mergeDataset(base, theirs, ours, resolve)
    expect(ab.conflicts).toEqual([])
    // order-independent winner
    expect(ab.merged.get(M1)!.fields.get('title')).toEqual(ba.merged.get(M1)!.fields.get('title'))
  })

  it('keeps both values with a multi policy', () => {
    const base = ds({ meaning: text('a') })
    const ours = ds({ meaning: text('b') })
    const theirs = ds({ meaning: text('c') })
    const { merged, conflicts } = mergeDataset(base, ours, theirs, resolve)
    expect(conflicts).toEqual([])
    const v = merged.get(M1)!.fields.get('meaning')!
    expect(v.kind).toBe('collection')
    if (v.kind === 'collection') expect(v.items.length).toBe(2)
  })

  it('still conflicts on a default field', () => {
    const base = ds({ note: text('base') })
    const ours = ds({ note: text('ours') })
    const theirs = ds({ note: text('theirs') })
    const { conflicts } = mergeDataset(base, ours, theirs, resolve)
    expect(conflicts.length).toBe(1)
  })
})

describe('post-merge invariant validation', () => {
  it('rejects a merge that would violate a uniqueness constraint', () => {
    const role = roleBase([
      form('word', [property('slug', { base: 'text' }, { constraints: [hold('sole', { scope: 'global' })] })]),
    ])
    const r = new Repository(new MemoryChunkStore(), new MemoryRefStore(), role)
    r.commit('main', meta(1, 'base'), datasetOf([record({ type: 'word', mark: M1, fields: { slug: text('shared') } })]))
    r.createBranch('feature', { branch: 'main' })
    // each branch adds a different record with the SAME unique slug: individually valid
    r.commit('main', meta(2, 'main'), datasetOf([
      record({ type: 'word', mark: M1, fields: { slug: text('shared') } }),
      record({ type: 'word', mark: A, fields: { slug: text('dup') } }),
    ]))
    r.commit('feature', meta(3, 'feat'), datasetOf([
      record({ type: 'word', mark: M1, fields: { slug: text('shared') } }),
      record({ type: 'word', mark: B, fields: { slug: text('dup') } }),
    ]))
    // merging them would create two records with slug 'dup': the merge is rejected
    const res = r.merge('main', 'feature', meta(4, 'merge'))
    expect(res.ok).toBe(false)
  })
})

describe('semantic diff', () => {
  it('classifies create, delete, move, rename, retype, and field changes', () => {
    const before = datasetOf([
      record({ type: 'node', mark: A, label: 'A', fields: { term: text('a'), '~parent': ref(R1) } }),
      record({ type: 'node', mark: B, fields: { term: text('b') } }),
    ])
    const after = datasetOf([
      // A moved to R2, renamed, term changed
      record({ type: 'node', mark: A, label: 'Alpha', fields: { term: text('a2'), '~parent': ref(R2) } }),
      // M1 created
      record({ type: 'word', mark: M1, fields: { term: text('new') } }),
      // B deleted
    ])
    const changes = diffSemantic(before, after)
    const kinds = changes.map(c => c.kind)
    expect(kinds).toContain('created')
    expect(kinds).toContain('deleted')
    expect(kinds).toContain('moved')
    expect(kinds).toContain('renamed')
    expect(kinds).toContain('field')
    // a move is a move, not delete+add
    const move = changes.find(c => c.kind === 'moved')
    expect(move && move.kind === 'moved' && move.to).toBe(R2)
    expect(summarizeSemantic(changes).some(s => s.startsWith('moved'))).toBe(true)
  })
})

describe('actor-scoped undo', () => {
  it("undoes the actor's own last commit, not the global last", () => {
    const r = new Repository(new MemoryChunkStore(), new MemoryRefStore())
    r.commit('main', meta(1, 'c1', 'alice'), datasetOf([record({ type: 'word', mark: M1, fields: { term: text('a') } })]))
    // alice sets a value
    r.commit('main', meta(2, 'alice edit', 'alice'), datasetOf([record({ type: 'word', mark: M1, fields: { term: text('alice') } })]))
    // bob edits an unrelated record afterward
    r.commit('main', meta(3, 'bob edit', 'bob'), datasetOf([
      record({ type: 'word', mark: M1, fields: { term: text('alice') } }),
      record({ type: 'word', mark: M2, fields: { term: text('bob') } }),
    ]))
    const res = r.undoLast('main', 'alice', meta(4, 'undo', 'alice'))
    expect(res.ok).toBe(true)
    const head = r.checkoutBranch('main')
    // alice's edit is undone, bob's survives
    expect(head.get(M1)!.fields.get('term')).toEqual(text('a'))
    expect(head.get(M2)!.fields.get('term')).toEqual(text('bob'))
  })
})

describe('fractional order keys', () => {
  it('generates a key strictly between two keys', () => {
    const a = orderKeyBetween('', '')
    const b = orderKeyAfter(a)
    expect(a < b).toBe(true)
    const mid = orderKeyBetween(a, b)
    expect(a < mid && mid < b).toBe(true)
  })

  it('prepends, appends, and keeps stable order under repeated insertion', () => {
    let keys = [orderKeyBetween('', '')]
    keys = [orderKeyBefore(keys[0]), ...keys, orderKeyAfter(keys[keys.length - 1]!)]
    // insert repeatedly between the first two
    for (let i = 0; i < 5; i++) {
      keys.splice(1, 0, orderKeyBetween(keys[0], keys[1]))
    }
    const sorted = [...keys].sort()
    expect(sorted).toEqual(keys) // already in order
    expect(new Set(keys).size).toBe(keys.length) // all distinct
  })
})

describe('orphan recovery', () => {
  it('reparents a record whose parent was deleted', () => {
    const ds = datasetOf([
      record({ type: 'node', mark: A, fields: { term: text('a'), '~parent': ref(R1) } }),
      // R1 (the parent) is absent from the dataset
    ])
    const { dataset, recovered } = recoverOrphans(ds, R2)
    expect(recovered).toEqual([A])
    expect(parentOf(dataset.get(A)!)).toBe(R2)
  })
})

describe('ephemeral presence and leases', () => {
  it('expires presence and holds advisory leases', () => {
    const presence = new PresenceChannel()
    presence.set({ actor: 'alice', focus: M1, updatedAt: 0, expiresAt: 100 })
    expect(presence.all(50).length).toBe(1)
    expect(presence.all(150).length).toBe(0) // lapsed

    const leases = new LeaseRegistry()
    leases.acquire({ target: M1, scope: ['x', 'y'], actor: 'alice', expiresAt: 100 })
    expect(leases.heldBy(M1, 'x', 50)).toBe('alice')
    expect(leases.heldBy(M1, 'z', 50)).toBeUndefined() // out of scope
    expect(leases.heldBy(M1, 'x', 150)).toBeUndefined() // lapsed
  })
})

describe('concurrency property harness', () => {
  const hlc = (n: number): Hlc => ({ wall: n, count: 0, node: 'x' })

  function baseForest(): Dataset {
    return datasetOf([
      record({ type: 'node', mark: R1, fields: {} }),
      record({ type: 'node', mark: R2, fields: {} }),
      record({ type: 'node', mark: A, fields: { '~parent': ref(R1) } }),
      record({ type: 'node', mark: B, fields: { '~parent': ref(A) } }),
    ])
  }

  // every permutation of a fixed move set must converge to the same acyclic forest
  it('converges under every ordering of concurrent moves, with no cycle', () => {
    const moves: Array<TreeMove> = [
      { mark: A, parent: R2, time: hlc(1), actor: 'p' },
      { mark: B, parent: R1, time: hlc(2), actor: 'q' },
      { mark: A, parent: B, time: hlc(3), actor: 'r' }, // may create a cycle depending on order
    ]
    const permutations = [
      [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
    ]
    const results = permutations.map(order => {
      const applied = applyMoves(baseForest(), order.map(i => moves[i]!))
      return [applied.get(A)!, applied.get(B)!].map(canonicalizeRecord).join('|')
    })
    // all permutations reach the same state (timestamp order, not arrival order)
    expect(new Set(results).size).toBe(1)

    // and the state is acyclic
    const applied = applyMoves(baseForest(), moves)
    const acyclic = (start: string): boolean => {
      const seen = new Set<string>()
      let cur: string | undefined = start
      while (cur !== undefined) {
        if (seen.has(cur)) return false
        seen.add(cur)
        cur = parentOf(applied.get(cur)!)
      }
      return true
    }
    expect(acyclic(A) && acyclic(B)).toBe(true)
  })

  it('state-based tree merge is order-independent', () => {
    const base = baseForest()
    const ours = moveRecord(base, A, R2)
    const theirs = moveRecord(base, B, R2)
    const ab = mergeTree(base, ours, theirs)
    const ba = mergeTree(base, theirs, ours)
    expect(parentOf(ab.get(A)!)).toBe(parentOf(ba.get(A)!))
    expect(parentOf(ab.get(B)!)).toBe(parentOf(ba.get(B)!))
  })
})
