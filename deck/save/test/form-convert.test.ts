import { describe, it, expect } from 'vitest'
import { castValue, convertDataset } from '@cluesurf/save/form/convert'
import type { Conversion } from '@cluesurf/save/form/convert'
import { registerForm } from '@cluesurf/save/api/form'
import type { FormStore, FormVersion, RecordSeam } from '@cluesurf/save/api/form'
import { datasetOf } from '@cluesurf/save/diff/change'
import type { Change, Dataset } from '@cluesurf/save/diff/change'
import { applyChanges } from '@cluesurf/save/patch/patch'
import {
  boolean,
  date,
  decimal,
  integer,
  item,
  list,
  record,
  text,
} from '@cluesurf/save/base/make'
import { hold, property } from '@cluesurf/save/form/form'
import type { Property } from '@cluesurf/save/form/form'

const MARK_A = '11111111-1111-4111-8111-111111111111'
const MARK_B = '22222222-2222-4222-8222-222222222222'

function store(): FormStore {
  const rows: Array<FormVersion> = []

  return {
    async forms(repository) {
      return rows.filter(row => row.repository === repository)
    },
    async versions(input) {
      return rows
        .filter(row => row.repository === input.repository && row.name === input.name)
        .sort((a, b) => b.version - a.version)
    },
    async putForm(form) {
      rows.push(form)
    },
  }
}

/** A branch in memory: what it holds, and the commits written to it. */
function branch(dataset: Dataset, refuse?: string) {
  const commits: Array<Array<Change>> = []
  const seam: RecordSeam = {
    branch: 'main',
    async read() {
      return dataset
    },
    async write(changes) {
      if (refuse !== undefined) {
        return { ok: false, why: refuse }
      }

      commits.push(changes)
      dataset = applyChanges(dataset, changes)

      return { ok: true, commit: `c${commits.length}` }
    },
  }

  return { seam, commits, head: () => dataset }
}

const entry = (mark: string, fields: Record<string, ReturnType<typeof text>>) =>
  record({ type: 'entry', mark, fields })

const props = (...names: Array<string>): Array<Property> =>
  names.map(name => property(name, { base: 'text' }))

describe('castValue', () => {
  it('parses text into every scalar kind by the canonical grammar', () => {
    expect(castValue(text('42'), 'integer')).toEqual({ ok: true, value: integer(42n) })
    expect(castValue(text('-3.5'), 'decimal')).toEqual({ ok: true, value: decimal('-3.5') })
    expect(castValue(text('true'), 'boolean')).toEqual({ ok: true, value: boolean(true) })
    expect(castValue(text('2026-09-09'), 'date')).toEqual({
      ok: true,
      value: date('2026-09-09'),
    })
  })

  it('refuses text that does not parse rather than guessing', () => {
    expect(castValue(text('forty two'), 'integer').ok).toBe(false)
    expect(castValue(text('yes'), 'boolean').ok).toBe(false)
    expect(castValue(text('tomorrow'), 'date').ok).toBe(false)
  })

  it('spells every scalar as text and widens an integer to a decimal', () => {
    expect(castValue(integer(7n), 'text')).toEqual({ ok: true, value: text('7') })
    expect(castValue(integer(7n), 'decimal')).toEqual({ ok: true, value: decimal('7') })
    expect(castValue(boolean(false), 'text')).toEqual({ ok: true, value: text('false') })
    expect(castValue(decimal('2.0'), 'integer')).toEqual({ ok: true, value: integer(2n) })
    expect(castValue(decimal('2.5'), 'integer').ok).toBe(false)
  })

  it('leaves a null alone and refuses a collection', () => {
    expect(castValue({ kind: 'null' }, 'integer')).toEqual({ ok: true, value: { kind: 'null' } })
    expect(castValue(list([item(text('a'))]), 'text').ok).toBe(false)
  })
})

describe('convertDataset', () => {
  it('renames when the source is gone from the new version, copies when it stays', () => {
    const dataset = datasetOf([entry(MARK_A, { word: text('tree') })])

    const renamed = convertDataset({
      dataset,
      form: 'entry',
      properties: props('headword'),
      convert: { headword: { from: 'word' } },
    })
    expect(renamed.faults).toEqual([])
    expect(renamed.changes.map(one => one.type)).toEqual(['field.set', 'field.remove'])

    const copied = convertDataset({
      dataset,
      form: 'entry',
      properties: props('word', 'headword'),
      convert: { headword: { from: 'word' } },
    })
    expect(copied.changes.map(one => one.type)).toEqual(['field.set'])
  })

  it('wraps a value into a one-member collection and unwraps one back', () => {
    const wrapped = convertDataset({
      dataset: datasetOf([entry(MARK_A, { sense: text('a tall plant') })]),
      form: 'entry',
      properties: props('sense'),
      convert: { sense: { wrap: 'list' } },
    })
    const change = wrapped.changes[0]
    expect(change?.type === 'field.set' && change.after).toEqual(
      list([item(text('a tall plant'))]),
    )

    const unwrapped = convertDataset({
      dataset: datasetOf([
        record({
          type: 'entry',
          mark: MARK_A,
          fields: { sense: list([item(text('first')), item(text('second'))]) },
        }),
        record({ type: 'entry', mark: MARK_B, fields: { sense: list([]) } }),
      ]),
      form: 'entry',
      properties: props('sense'),
      convert: { sense: { unwrap: true } },
    })
    expect(unwrapped.changes).toEqual([
      {
        type: 'field.set',
        mark: MARK_A,
        field: 'sense',
        before: list([item(text('first')), item(text('second'))]),
        after: text('first'),
      },
      // an empty collection unwraps to absence
      { type: 'field.remove', mark: MARK_B, field: 'sense', before: list([]) },
    ])
  })

  it('fills a default only where the value is missing after the other moves', () => {
    const made = convertDataset({
      dataset: datasetOf([
        entry(MARK_A, { pos: text('noun') }),
        entry(MARK_B, {}),
      ]),
      form: 'entry',
      properties: props('pos'),
      convert: { pos: { default: 'unknown' } },
    })
    expect(made.changes).toEqual([
      { type: 'field.set', mark: MARK_B, field: 'pos', before: undefined, after: text('unknown') },
    ])
  })

  it('casts, and a record that cannot be cast contributes no change at all', () => {
    const made = convertDataset({
      dataset: datasetOf([
        entry(MARK_A, { weight: text('12'), pos: text('noun') }),
        entry(MARK_B, { weight: text('heavy'), pos: text('verb') }),
      ]),
      form: 'entry',
      properties: props('weight', 'kind'),
      convert: { weight: { cast: 'integer' }, kind: { from: 'pos' } },
    })
    expect(made.faults).toEqual([
      { mark: MARK_B, property: 'weight', why: 'text "heavy" is not an integer' },
    ])
    expect(made.changes.every(one => one.mark === MARK_A)).toBe(true)
    expect(made.changes.map(one => one.type)).toEqual(['field.set', 'field.set', 'field.remove'])
  })

  it('touches only records of the named form and emits nothing for an unchanged value', () => {
    const made = convertDataset({
      dataset: datasetOf([
        entry(MARK_A, { pos: text('noun') }),
        record({ type: 'sense', mark: MARK_B, fields: { pos: text('x') } }),
      ]),
      form: 'entry',
      properties: props('pos'),
      convert: { pos: { cast: 'text', default: 'unknown' } },
    })
    expect(made.changes).toEqual([])
    expect(made.faults).toEqual([])
  })
})

describe('registerForm with a conversion', () => {
  const v1 = props('word', 'gloss')
  const v2: Array<Property> = [
    property('headword', { base: 'text' }, { constraints: [hold('need')] }),
    property('gloss', { base: 'text' }),
    property('weight', { base: 'integer' }),
  ]
  const convert: Conversion = {
    headword: { from: 'word' },
    weight: { default: 0 },
  }

  async function registered(s: FormStore) {
    return registerForm(s, {
      repository: 'r',
      name: 'entry',
      properties: v1,
      contracts: [],
      time: 1,
    })
  }

  it('writes the version and one conversion commit per branch, records converted', async () => {
    const s = store()
    await registered(s)

    const main = branch(
      datasetOf([
        entry(MARK_A, { word: text('tree'), gloss: text('a plant') }),
        entry(MARK_B, { word: text('sea') }),
      ]),
    )
    const answer = await registerForm(s, {
      repository: 'r',
      name: 'entry',
      properties: v2,
      contracts: [],
      time: 2,
      convert,
      records: [main.seam],
    })

    expect(answer.ok).toBe(true)
    if (!answer.ok) {
      return
    }

    expect(answer.value.form.version).toBe(2)
    expect(answer.value.conversions).toEqual([{ branch: 'main', commit: 'c1', changes: 6 }])

    const head = main.head()
    expect(head.get(MARK_A)?.fields.get('headword')).toEqual(text('tree'))
    expect(head.get(MARK_A)?.fields.has('word')).toBe(false)
    expect(head.get(MARK_B)?.fields.get('weight')).toEqual(integer(0))
  })

  it('refuses the whole registration when a record cannot fit, writing nothing', async () => {
    const s = store()
    await registered(s)

    // MARK_B has no `word`, so `headword` (needed) cannot be filled: the conversion
    // validates against the new version and names the record
    const main = branch(
      datasetOf([entry(MARK_A, { word: text('tree') }), entry(MARK_B, { gloss: text('?') })]),
    )
    const answer = await registerForm(s, {
      repository: 'r',
      name: 'entry',
      properties: v2,
      contracts: [],
      time: 2,
      convert,
      records: [main.seam],
    })

    expect(answer.ok).toBe(false)
    if (answer.ok) {
      return
    }

    expect(answer.fault).toBe('conversion')
    if (answer.fault !== 'conversion') {
      return
    }

    expect(answer.branch).toBe('main')
    expect(answer.diagnostics.map(one => one.mark)).toEqual([MARK_B])
    expect(main.commits).toEqual([])
    expect((await s.versions({ repository: 'r', name: 'entry' })).length).toBe(1)
  })

  it('reports a branch that would not take the commit, with the version that stands', async () => {
    const s = store()
    await registered(s)

    const main = branch(datasetOf([entry(MARK_A, { word: text('tree') })]), 'lost the race')
    const answer = await registerForm(s, {
      repository: 'r',
      name: 'entry',
      properties: v2,
      contracts: [],
      time: 2,
      convert,
      records: [main.seam],
    })

    expect(answer.ok).toBe(false)
    if (answer.ok || answer.fault !== 'unconverted') {
      throw new Error('expected unconverted')
    }

    expect(answer.branch).toBe('main')
    expect(answer.form.version).toBe(2)
  })

  it('records without a conversion is a check: a head that fits passes, one that does not refuses', async () => {
    const s = store()
    await registered(s)

    const fits = branch(datasetOf([entry(MARK_A, { headword: text('tree') })]))
    const ok = await registerForm(s, {
      repository: 'r',
      name: 'entry',
      properties: v2,
      contracts: [],
      time: 2,
      records: [fits.seam],
    })
    expect(ok.ok && ok.value.conversions).toEqual([])

    const misfits = branch(datasetOf([entry(MARK_A, { word: text('tree') })]))
    const refused = await registerForm(s, {
      repository: 'r',
      name: 'entry',
      properties: v2,
      contracts: [],
      time: 3,
      records: [misfits.seam],
    })
    expect(!refused.ok && refused.fault).toBe('conversion')
  })
})
