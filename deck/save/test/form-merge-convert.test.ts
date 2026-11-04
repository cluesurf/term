import { describe, it, expect } from 'vitest'
import { record, text, integer } from '@cluesurf/save/base/make'
import { datasetOf } from '@cluesurf/save/diff/change'
import { property, hold, roleBase } from '@cluesurf/save/form/form'
import type { Form, RoleBase } from '@cluesurf/save/form/form'
import { MemoryChunkStore } from '@cluesurf/save/store/chunk-store'
import { MemoryRefStore } from '@cluesurf/save/store/ref-store'
import { Repository } from '@cluesurf/save/repo/repo'
import { registerForm, roleOfVersions } from '@cluesurf/save/api/form'
import type { FormStore, FormVersion } from '@cluesurf/save/api/form'

const MARK_A = '11111111-1111-4111-8111-111111111111'
const MARK_B = '22222222-2222-4222-8222-222222222222'
const MARK_C = '33333333-3333-4333-8333-333333333333'

const meta = (message: string) => ({ author: 'test', time: 1, message })

/** version 1: `word` and `gloss` */
const V1: Form = {
  name: 'entry',
  properties: [property('word', { base: 'text' }), property('gloss', { base: 'text' })],
}

/** version 2: `word` renamed to `headword` and required; `weight` an integer with a default */
const V2: Form = {
  name: 'entry',
  properties: [
    property('headword', { base: 'text' }, { constraints: [hold('need')] }),
    property('gloss', { base: 'text' }),
    property('weight', { base: 'integer' }),
  ],
}

const CONVERT = { headword: { from: 'word' }, weight: { default: 0 } }

function store(): FormStore {
  const rows: Array<FormVersion> = []

  return {
    async forms(repository) { return rows.filter(row => row.repository === repository) },
    async versions(input) {
      return rows
        .filter(row => row.repository === input.repository && row.name === input.name)
        .sort((a, b) => b.version - a.version)
    },
    async putForm(form) { rows.push(form) },
  }
}

/** A repository whose role is version 2 with the conversion from version 1 stored. */
function repoAt(role: RoleBase) {
  const chunks = new MemoryChunkStore()
  const refs = new MemoryRefStore()

  return new Repository(chunks, refs, role)
}

describe('merge-time conversion', () => {
  it('a registration stores its moves, and roleOfVersions carries them oldest first', async () => {
    const s = store()

    await registerForm(s, { repository: 'r', name: 'entry', properties: V1.properties, contracts: [], time: 1 })
    await registerForm(s, {
      repository: 'r', name: 'entry', properties: V2.properties, contracts: [], time: 2, convert: CONVERT,
    })

    const versions = await s.forms('r')
    expect(versions.find(one => one.version === 2)?.convert).toEqual(CONVERT)

    const role = roleOfVersions(versions)
    expect(role.forms.get('entry')?.properties.map(one => one.name)).toEqual(['headword', 'gloss', 'weight'])
    expect(role.conversions?.get('entry')).toEqual([CONVERT])
  })

  it('a branch behind the form converts when it merges, and the merge commit records the moves', () => {
    // main and the branch both start at version 1
    const v1 = repoAt(roleBase([V1]))
    const first = v1.commit('main', meta('first'), datasetOf([
      record({ type: 'entry', mark: MARK_A, fields: { word: text('tree'), gloss: text('a plant') } }),
    ]))
    expect(first.ok).toBe(true)

    // the branch adds a record under version 1, while main is still at version 1
    const branched = v1.commit('old', meta('branch'), datasetOf([
      record({ type: 'entry', mark: MARK_A, fields: { word: text('tree'), gloss: text('a plant') } }),
      record({ type: 'entry', mark: MARK_B, fields: { word: text('sea'), gloss: text('water') } }),
    ]))
    expect(branched.ok).toBe(true)

    // version 2 is registered, and main is converted (what registerForm's records seam does)
    const role2 = roleBase([V2])
    role2.conversions = new Map([['entry', [CONVERT]]])
    const v2 = new Repository(
      (v1 as unknown as { chunks: MemoryChunkStore }).chunks,
      (v1 as unknown as { refs: MemoryRefStore }).refs,
      role2,
    )
    const converted = v2.commit('main', meta('form entry version 2'), datasetOf([
      record({ type: 'entry', mark: MARK_A, fields: { headword: text('tree'), gloss: text('a plant'), weight: integer(0) } }),
    ]))
    expect(converted.ok).toBe(true)

    // the branch is behind: its record B has `word`, not `headword`. Without conversion
    // the merge would violate `need` on headword; with it, B arrives converted.
    const merged = v2.merge('main', 'old', meta('merge old'))
    expect(merged.ok).toBe(true)

    if (!merged.ok) {
      return
    }

    const head = v2.checkout(merged.commit)
    expect(head.get(MARK_B)?.fields.get('headword')).toEqual(text('sea'))
    expect(head.get(MARK_B)?.fields.has('word')).toBe(false)
    expect(head.get(MARK_B)?.fields.get('weight')).toEqual(integer(0))
    // the record main already converted is untouched
    expect(head.get(MARK_A)?.fields.get('headword')).toEqual(text('tree'))

    // the merge commit's change set names the conversion of B beside its arrival
    const changes = v2.commitChangeset(merged.commit) ?? []
    expect(changes.some(one => one.type === 'record.add' && one.mark === MARK_B)).toBe(true)
  })

  it('a record no stored conversion can bring forward still blocks the merge', () => {
    const v1 = repoAt(roleBase([V1]))
    v1.commit('main', meta('first'), datasetOf([
      record({ type: 'entry', mark: MARK_A, fields: { word: text('tree') } }),
    ]))
    // a record with neither `word` nor `headword`: nothing to rename from
    v1.commit('old', meta('branch'), datasetOf([
      record({ type: 'entry', mark: MARK_A, fields: { word: text('tree') } }),
      record({ type: 'entry', mark: MARK_C, fields: { gloss: text('?') } }),
    ]))

    const role2 = roleBase([V2])
    role2.conversions = new Map([['entry', [CONVERT]]])
    const v2 = new Repository(
      (v1 as unknown as { chunks: MemoryChunkStore }).chunks,
      (v1 as unknown as { refs: MemoryRefStore }).refs,
      role2,
    )
    v2.commit('main', meta('form entry version 2'), datasetOf([
      record({ type: 'entry', mark: MARK_A, fields: { headword: text('tree'), weight: integer(0) } }),
    ]))

    const merged = v2.merge('main', 'old', meta('merge old'))
    expect(merged.ok).toBe(false)
  })

  it('a lost race on commit converts the other writer\'s records the same way', () => {
    // A ref store that lets an old-version writer land between a new-version writer's
    // read of the head and its compare-and-swap: the race the commit loop exists for.
    let racer: (() => void) | undefined

    class RacingRefStore extends MemoryRefStore {
      override compareAndSwap(name: string, expected: string | undefined, next: string): boolean {
        if (racer) {
          const run = racer

          racer = undefined
          run()
        }

        return super.compareAndSwap(name, expected, next)
      }
    }

    const chunks = new MemoryChunkStore()
    const refs = new RacingRefStore()
    const v1 = new Repository(chunks, refs, roleBase([V1]))

    v1.commit('main', meta('first'), datasetOf([
      record({ type: 'entry', mark: MARK_A, fields: { word: text('tree') } }),
    ]))

    const role2 = roleBase([V2])
    role2.conversions = new Map([['entry', [CONVERT]]])
    const v2 = new Repository(chunks, refs, role2)

    // the version-1 writer lands while the version-2 writer is between read and swap
    racer = () => {
      const stale = v1.commit('main', meta('old writer'), datasetOf([
        record({ type: 'entry', mark: MARK_A, fields: { word: text('tree') } }),
        record({ type: 'entry', mark: MARK_B, fields: { word: text('sea') } }),
      ]))

      expect(stale.ok).toBe(true)
    }

    // the version-2 writer's commit is rebased onto the moved head: B arrives from the
    // old writer with `word`, and converts rather than blocking the rebase
    const rebased = v2.commit('main', meta('new writer'), datasetOf([
      record({ type: 'entry', mark: MARK_A, fields: { headword: text('tree'), weight: integer(0) } }),
    ]))
    expect(rebased.ok).toBe(true)
    expect(racer).toBeUndefined()

    const head = v2.checkoutBranch('main')
    expect(head.get(MARK_A)?.fields.get('headword')).toEqual(text('tree'))
    expect(head.get(MARK_B)?.fields.get('headword')).toEqual(text('sea'))
    expect(head.get(MARK_B)?.fields.has('word')).toBe(false)
  })
})
