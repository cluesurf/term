import { describe, it, expect } from 'vitest'
import { head, changes, state, readRecord, history, commit, branches, statusOf, ROUTES } from '@term/base/code/api/routes'
import { record, text } from '@term/base/code/base/make'
import { datasetOf } from '@term/base/code/diff/change'
import { form, property, hold, roleBase } from '@term/base/code/form/form'
import { MemoryChunkStore } from '@term/base/code/store/chunk-store'
import { MemoryRefStore } from '@term/base/code/store/ref-store'
import { Repository } from '@term/base/code/repo/repo'

const M1 = '11111111-1111-4111-8111-111111111111'
const wordForm = form('word', [
  property('term', { base: 'text' }, { constraints: [hold('need')] }),
  property('gloss', { base: 'text' }),
])

function setup() {
  const repo = new Repository(
    new MemoryChunkStore(),
    new MemoryRefStore(),
    roleBase([wordForm]),
  )
  repo.commit('main', { author: 'a', time: 1, message: 'c1' },
    datasetOf([record({ type: 'word', mark: M1, fields: { term: text('one') } })]))
  const first = repo.head('main')!
  repo.commit('main', { author: 'a', time: 2, message: 'c2' },
    datasetOf([record({ type: 'word', mark: M1, fields: { term: text('two') } })]))
  return { repo, first, second: repo.head('main')! }
}

describe('head', () => {
  it('reports where a branch points', () => {
    const { repo, second } = setup()
    expect(head(repo, 'main')).toEqual({ ok: true, value: { branch: 'main', commit: second } })
  })

  it('reports an unknown branch as absent rather than failing', () => {
    const { repo } = setup()
    const r = head(repo, 'nope')
    expect(r.ok && r.value.commit).toBeUndefined()
  })
})

describe('changes', () => {
  it('returns the field-level delta between two commits', () => {
    const { repo, first, second } = setup()
    const r = changes(repo, { branch: 'main', from: first, to: second })
    expect(r.ok).toBe(true)
    expect(r.ok && r.value.changes.length).toBeGreaterThan(0)
    expect(r.ok && r.value.to).toBe(second)
  })

  it('returns the whole state as changes when there is no from', () => {
    const { repo } = setup()
    const r = changes(repo, { branch: 'main' })
    expect(r.ok && r.value.from).toBeUndefined()
    expect(r.ok && r.value.changes.length).toBeGreaterThan(0)
  })

  it('faults on an unknown from rather than silently resending everything', () => {
    const { repo } = setup()
    const r = changes(repo, { branch: 'main', from: 'sha256:' + '0'.repeat(64) })
    expect(r).toMatchObject({ ok: false, fault: 'no-commit' })
  })

  it('faults on an unknown branch', () => {
    const { repo } = setup()
    expect(changes(repo, { branch: 'nope' })).toMatchObject({ ok: false, fault: 'no-branch' })
  })
})

describe('state', () => {
  it('returns every record at the head', () => {
    const { repo, second } = setup()
    const r = state(repo, { branch: 'main' })
    expect(r.ok && r.value.commit).toBe(second)
    expect(r.ok && r.value.records).toHaveLength(1)
  })

  it('returns the state at an older commit', () => {
    const { repo, first } = setup()
    const r = state(repo, { branch: 'main', commit: first })
    expect(r.ok && r.value.records[0]?.fields.get('term')).toEqual(text('one'))
  })
})

describe('readRecord', () => {
  it('returns one record', () => {
    const { repo } = setup()
    const r = readRecord(repo, { branch: 'main', mark: M1 })
    expect(r.ok && r.value.record.fields.get('term')).toEqual(text('two'))
  })

  it('faults on an unknown mark', () => {
    const { repo } = setup()
    expect(readRecord(repo, { branch: 'main', mark: '22222222-2222-4222-8222-222222222222' }))
      .toMatchObject({ ok: false, fault: 'no-record' })
  })
})

describe('history', () => {
  it('returns the versions a projection cannot answer for', () => {
    const { repo } = setup()
    const r = history(repo, { branch: 'main', mark: M1 })
    expect(r.ok).toBe(true)
    expect(r.ok && r.value.versions.length).toBeGreaterThan(1)
  })
})

describe('ROUTES', () => {
  it('follows the platform path conventions', () => {
    for (const route of ROUTES) {
      expect(route.path).not.toContain('/api/')
      expect(route.path).toMatch(/^\/repositories\//)
      if (route.method === 'POST') expect(route.path).toMatch(/!$/)
    }
  })
})

describe('commit', () => {
  const M2 = '22222222-2222-4222-8222-222222222222'

  it('applies a change set and advances the branch', () => {
    const { repo, second } = setup()
    const r = commit(repo, {
      branch: 'main', author: 'a', message: 'add', time: 3,
      changes: [{ type: 'record.add', mark: M2,
        value: record({ type: 'word', mark: M2, fields: { term: text('three') } }) }],
    })

    expect(r.ok).toBe(true)
    expect(r.ok && r.value.commit).not.toBe(second)
    expect(state(repo, { branch: 'main' })).toMatchObject({ ok: true })
    const s = state(repo, { branch: 'main' })
    expect(s.ok && s.value.records).toHaveLength(2)
  })

  it('leaves records the change set does not mention alone', () => {
    // the reason the API takes changes rather than a dataset: a writer describing only
    // its own record must not erase everyone else's by omission
    const { repo } = setup()
    commit(repo, {
      branch: 'main', author: 'a', message: 'add', time: 3,
      changes: [{ type: 'record.add', mark: M2,
        value: record({ type: 'word', mark: M2, fields: { term: text('three') } }) }],
    })

    const r = readRecord(repo, { branch: 'main', mark: M1 })
    expect(r.ok && r.value.record.fields.get('term')).toEqual(text('two'))
  })

  it('rejects a change that violates the form, with diagnostics', () => {
    const { repo } = setup()
    const r = commit(repo, {
      branch: 'main', author: 'a', message: 'bad', time: 3,
      // `term` is `need`, so removing it must not be committable
      changes: [{ type: 'field.remove', mark: M1, field: 'term', before: text('two') }],
    })

    expect(r).toMatchObject({ ok: false, fault: 'rejected' })
    expect(r.ok === false && r.fault === 'rejected' && r.diagnostics.length)
      .toBeGreaterThan(0)
  })

  it('commits onto a branch that does not exist yet', () => {
    const { repo } = setup()
    const r = commit(repo, {
      branch: 'fresh', author: 'a', message: 'first', time: 3,
      changes: [{ type: 'record.add', mark: M2,
        value: record({ type: 'word', mark: M2, fields: { term: text('x') } }) }],
    })

    expect(r.ok).toBe(true)
    expect(head(repo, 'fresh')).toMatchObject({ ok: true })
  })
})

describe('branches', () => {
  it('lists every branch and where it points', () => {
    const { repo, second } = setup()
    const r = branches(repo)
    expect(r.ok && r.value).toEqual([{ branch: 'main', commit: second }])
  })
})

describe('statusOf', () => {
  it('separates a rejected write from a missing resource', () => {
    expect(statusOf({ ok: true })).toBe(200)
    expect(statusOf({ ok: false, fault: 'no-branch' } as never)).toBe(404)
    expect(statusOf({ ok: false, fault: 'rejected' } as never)).toBe(422)
  })
})
