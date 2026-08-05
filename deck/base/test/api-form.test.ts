import { describe, it, expect } from 'vitest'
import {
  registerForm,
  listForms,
  readForm,
  formHistory,
  removed,
  checkFormName,
  formStatus,
} from '@term/base/code/api/form'
import type { FormStore, FormVersion } from '@term/base/code/api/form'
import type { Property } from '@term/base/code/form/form'
import type { Contract } from '@term/base/code/project/contract'

function store(): FormStore {
  const rows: Array<FormVersion> = []

  return {
    async forms(repository) {
      return rows.filter(row => row.repository === repository)
    },
    async versions(input) {
      return rows
        .filter(
          row =>
            row.repository === input.repository && row.name === input.name,
        )
        .sort((a, b) => b.version - a.version)
    },
    async putForm(form) {
      rows.push(form)
    },
  }
}

const prop = (name: string): Property =>
  ({ name, like: { kind: 'text' } }) as unknown as Property

const reads = (consumer: string, form: string, property: string): Contract => ({
  consumer,
  reads: [{ form, property }],
})

describe('form registration', () => {
  it('assigns versions rather than trusting the caller', async () => {
    const s = store()
    const one = await registerForm(s, {
      repository: 'r',
      name: 'user',
      properties: [prop('name')],
      contracts: [],
      time: 1,
    })
    expect(one.ok && one.value.form.version).toBe(1)

    const two = await registerForm(s, {
      repository: 'r',
      name: 'user',
      properties: [prop('name'), prop('email')],
      contracts: [],
      time: 2,
    })
    expect(two.ok && two.value.form.version).toBe(2)
  })

  it('refuses a change that removes a property a consumer reads', async () => {
    const s = store()
    await registerForm(s, {
      repository: 'r',
      name: 'user',
      properties: [prop('name'), prop('email')],
      contracts: [],
      time: 1,
    })

    const result = await registerForm(s, {
      repository: 'r',
      name: 'user',
      properties: [prop('name')],
      contracts: [reads('search', 'user', 'email')],
      time: 2,
    })

    expect(result.ok).toBe(false)
    expect(!result.ok && result.fault).toBe('breaking')
    expect(!result.ok && result.fault === 'breaking' && result.breaks).toEqual([
      { form: 'user', property: 'email', consumers: ['search'] },
    ])
  })

  it('does not write the refused version', async () => {
    const s = store()
    await registerForm(s, {
      repository: 'r',
      name: 'user',
      properties: [prop('name'), prop('email')],
      contracts: [],
      time: 1,
    })
    await registerForm(s, {
      repository: 'r',
      name: 'user',
      properties: [prop('name')],
      contracts: [reads('search', 'user', 'email')],
      time: 2,
    })

    const history = await formHistory(s, { repository: 'r', name: 'user' })
    expect(history.ok && history.value.length).toBe(1)
  })

  it('allows removing a property nobody reads', async () => {
    const s = store()
    await registerForm(s, {
      repository: 'r',
      name: 'user',
      properties: [prop('name'), prop('email')],
      contracts: [],
      time: 1,
    })

    const result = await registerForm(s, {
      repository: 'r',
      name: 'user',
      properties: [prop('name')],
      contracts: [reads('search', 'user', 'name')],
      time: 2,
    })

    expect(result.ok).toBe(true)
    expect(result.ok && result.value.following).toEqual(['search'])
  })

  it('treats a renamed property as still reachable', async () => {
    const s = store()
    await registerForm(s, {
      repository: 'r',
      name: 'user',
      properties: [prop('email')],
      contracts: [],
      time: 1,
    })

    const result = await registerForm(s, {
      repository: 'r',
      name: 'user',
      properties: [prop('mail')],
      contracts: [reads('search', 'user', 'email')],
      derivation: { renames: [{ form: 'user', from: 'email', to: 'mail' }] },
      time: 2,
    })

    expect(result.ok).toBe(true)
  })

  it('forcing still reports who breaks', async () => {
    const s = store()
    await registerForm(s, {
      repository: 'r',
      name: 'user',
      properties: [prop('name'), prop('email')],
      contracts: [],
      time: 1,
    })

    const result = await registerForm(s, {
      repository: 'r',
      name: 'user',
      properties: [prop('name')],
      contracts: [reads('search', 'user', 'email'), reads('ui', 'user', 'name')],
      time: 2,
      force: true,
    })

    expect(result.ok).toBe(true)
    expect(result.ok && result.value.breaking[0]?.consumers).toEqual(['search'])
    // the unaffected consumer is still following, the broken one is not
    expect(result.ok && result.value.following).toEqual(['ui'])
  })

  it('lists only the newest version of each form', async () => {
    const s = store()
    for (const [name, time] of [
      ['user', 1],
      ['user', 2],
      ['post', 3],
    ] as const) {
      await registerForm(s, {
        repository: 'r',
        name,
        properties: [prop('name')],
        contracts: [],
        time,
      })
    }

    const list = await listForms(s, 'r')
    expect(list.ok && list.value.map(f => `${f.name}@${f.version}`)).toEqual([
      'post@1',
      'user@2',
    ])
  })

  it('reads a pinned version rather than the newest', async () => {
    const s = store()
    await registerForm(s, {
      repository: 'r',
      name: 'user',
      properties: [prop('name')],
      contracts: [],
      time: 1,
    })
    await registerForm(s, {
      repository: 'r',
      name: 'user',
      properties: [prop('name'), prop('email')],
      contracts: [],
      time: 2,
    })

    const pinned = await readForm(s, {
      repository: 'r',
      name: 'user',
      version: 1,
    })
    expect(pinned.ok && pinned.value.properties.length).toBe(1)

    const newest = await readForm(s, { repository: 'r', name: 'user' })
    expect(newest.ok && newest.value.properties.length).toBe(2)
  })

  it('separates repositories that share a form name', async () => {
    const s = store()
    await registerForm(s, {
      repository: 'a',
      name: 'user',
      properties: [prop('name')],
      contracts: [],
      time: 1,
    })
    const other = await registerForm(s, {
      repository: 'b',
      name: 'user',
      properties: [prop('name')],
      contracts: [],
      time: 2,
    })

    // a second repository starts at version 1, it does not inherit a's numbering
    expect(other.ok && other.value.form.version).toBe(1)
  })

  it('rejects a bad name and a missing form', async () => {
    const s = store()
    const bad = await registerForm(s, {
      repository: 'r',
      name: 'User Name',
      properties: [],
      contracts: [],
      time: 1,
    })
    expect(!bad.ok && bad.fault).toBe('bad-name')

    const missing = await readForm(s, { repository: 'r', name: 'nope' })
    expect(!missing.ok && missing.fault).toBe('no-form')
  })

  it('maps faults to distinct statuses', () => {
    expect(formStatus({ ok: true })).toBe(200)
    expect(formStatus({ ok: false, fault: 'no-form' })).toBe(404)
    expect(formStatus({ ok: false, fault: 'breaking' })).toBe(409)
    expect(formStatus({ ok: false, fault: 'bad-name' })).toBe(400)
  })

  it('removed compares by name', () => {
    expect(
      removed({ before: [prop('a'), prop('b')], after: [prop('a')] }),
    ).toEqual(['b'])
    expect(checkFormName('user-name')).toBeUndefined()
    expect(checkFormName('9lives')).toBeDefined()
  })
})
