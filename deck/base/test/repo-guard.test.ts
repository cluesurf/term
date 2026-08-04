import { describe, it, expect } from 'vitest'
import { record, text } from '@term/base/code/base/make'
import { datasetOf } from '@term/base/code/diff/change'
import { form, property, hold, roleBase } from '@term/base/code/form/form'
import { MemoryChunkStore } from '@term/base/code/store/chunk-store'
import { MemoryRefStore } from '@term/base/code/store/ref-store'
import { Repository } from '@term/base/code/repo/repo'
import { AccessPolicy } from '@term/base/code/access/policy'

const M1 = '11111111-1111-4111-8111-111111111111'
const wordForm = form('word', [
  property('term', { base: 'text' }, { constraints: [hold('need')] }),
])

describe('repository access control', () => {
  it('blocks a commit from a user without commit rights', () => {
    const policy = new AccessPolicy()
    policy.grant('alice', 'commit', 'branch:main')
    const repo = new Repository(new MemoryChunkStore(), new MemoryRefStore(), undefined, {
      policy,
    })
    const ds = datasetOf([record({ type: 'word', mark: M1, fields: { term: text('x') } })])

    const denied = repo.commit('main', { author: 'bob', time: 1, message: 'x', user: 'bob' }, ds)
    expect(denied.ok).toBe(false)

    const allowed = repo.commit('main', { author: 'alice', time: 1, message: 'x', user: 'alice' }, ds)
    expect(allowed.ok).toBe(true)
  })
})

describe('repository auto-mark', () => {
  it('auto-marks unmarked base-form instances on commit', () => {
    const role = roleBase([wordForm])
    const repo = new Repository(new MemoryChunkStore(), new MemoryRefStore(), role, {
      autoMark: true,
    })
    // an unmarked record (would normally fail the mark lint)
    const ds = new Map([['tmp', record({ type: 'word', fields: { term: text('foo') } })]])
    const res = repo.commit('main', { author: 'a', time: 1, message: 'x' }, ds)
    expect(res.ok).toBe(true)
    // it landed with a real mark
    const all = [...repo.checkoutBranch('main').values()]
    expect(all.length).toBe(1)
    expect(all[0]!.mark).toBeDefined()
  })
})
