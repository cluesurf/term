import { describe, it, expect } from 'vitest'
import { record, text } from '@term/base/code/base/make'
import { datasetOf } from '@term/base/code/diff/change'
import { MemoryChunkStore } from '@term/base/code/store/chunk-store'
import { MemoryRefStore } from '@term/base/code/store/ref-store'
import { MemoryRefLog } from '@term/base/code/reflog/reflog'
import { Repository } from '@term/base/code/repo/repo'
import { removeMatching } from '@term/base/code/erase/erase'

const A = '11111111-1111-4111-8111-111111111111'
const SECRET_MARK = '22222222-2222-4222-8222-222222222222'
const SECRET = 'SSN-123-45-6789'
const meta = (t: number, m: string) => ({ author: 'a', time: t, message: m })

function noChunkContains(chunks: MemoryChunkStore, needle: string): boolean {
  return chunks.keys().every(k => !chunks.get(k)!.includes(needle))
}

describe('reflog is a GC root (recovery)', () => {
  it('a commit a branch was reset off of survives GC and is recoverable', () => {
    const chunks = new MemoryChunkStore()
    const repo = new Repository(chunks, new MemoryRefStore(), undefined, {
      reflog: new MemoryRefLog(),
    })

    const c1 = repo.commit('main', meta(1, 'c1'), datasetOf([
      record({ type: 'word', mark: A, fields: { term: text('one') } }),
    ]))
    if (!c1.ok) throw new Error('c1 failed')
    const good = c1.commit

    const c2 = repo.commit('main', meta(2, 'c2'), datasetOf([
      record({ type: 'word', mark: A, fields: { term: text('two') } }),
    ]))
    if (!c2.ok) throw new Error('c2 failed')

    // a bad reset moves main off `good`'s successor back... actually reset to c2 then
    // simulate losing it: reset main to c1 (good), orphaning c2
    repo.resetBranch('main', good)

    // c2 is now unreachable from the head, but the reflog names it — GC must keep it
    repo.gc()
    expect(chunks.has(c2.commit)).toBe(true)

    // and recovery works: reset back to c2
    expect(repo.resetBranch('main', c2.commit)).toBe(true)
    expect(repo.checkoutBranch('main').get(A)!.fields.get('term')).toEqual(text('two'))
  })
})

describe('erase purges the reflog so erased content cannot be recovered', () => {
  it('after erase + gc, no chunk contains the secret even with a reflog', () => {
    const chunks = new MemoryChunkStore()
    const repo = new Repository(chunks, new MemoryRefStore(), undefined, {
      reflog: new MemoryRefLog(),
    })

    repo.commit('main', meta(1, 'c1'), datasetOf([
      record({ type: 'word', mark: A, fields: { term: text('keep') } }),
    ]))
    repo.commit('main', meta(2, 'c2'), datasetOf([
      record({ type: 'word', mark: A, fields: { term: text('keep') } }),
      record({ type: 'person', mark: SECRET_MARK, fields: { ssn: text(SECRET) } }),
    ]))

    const report = repo.eraseFromHistory(removeMatching(n => n.type === 'person'))
    expect(report.erasedOccurrences).toBeGreaterThan(0)

    // the reflog entry for the erase would otherwise root the pre-erase (secret) head
    expect(noChunkContains(chunks, SECRET)).toBe(true)

    // an explicit second GC must also not resurrect it via a reflog root
    repo.gc()
    expect(noChunkContains(chunks, SECRET)).toBe(true)
  })
})
