import { describe, it, expect } from 'vitest'
import { record, text, integer, ref, set, item } from '@term/base/code/base/make'
import { datasetOf } from '@term/base/code/diff/change'
import {
  form,
  property,
  hold,
  want,
  roleBase,
} from '@term/base/code/form/form'
import { validateRecord, validateDataset, errors } from '@term/base/code/form/validate'

const M1 = '11111111-1111-4111-8111-111111111111'
const M2 = '22222222-2222-4222-8222-222222222222'

const wordForm = form('word', [
  property('term', { base: 'text' }, { constraints: [hold('need')] }),
  property('count', { base: 'integer' }, {
    constraints: [hold('span', { min: 0, max: 100 })],
  }),
  property('lang', { ref: 'language' }),
])

describe('validation', () => {
  it('passes a valid record', () => {
    const r = record({
      type: 'word',
      mark: M1,
      fields: { term: text('foo'), count: integer(5) },
    })
    const diags = validateRecord(r, wordForm, { isBaseForm: true })
    expect(errors(diags)).toEqual([])
  })

  it('flags a missing required property as a hold error', () => {
    const r = record({ type: 'word', mark: M1, fields: { count: integer(5) } })
    const diags = validateRecord(r, wordForm, { isBaseForm: true })
    expect(errors(diags).some(d => d.field === 'term')).toBe(true)
  })

  it('flags a base-form instance with no mark', () => {
    const r = record({ type: 'word', fields: { term: text('foo') } })
    const diags = validateRecord(r, wordForm, { isBaseForm: true })
    expect(
      errors(diags).some(d => d.message.includes('must have a mark')),
    ).toBe(true)
  })

  it('flags a type mismatch', () => {
    const r = record({
      type: 'word',
      mark: M1,
      fields: { term: integer(5), count: integer(5) },
    })
    const diags = validateRecord(r, wordForm, { isBaseForm: true })
    expect(errors(diags).some(d => d.field === 'term')).toBe(true)
  })

  it('flags a span violation', () => {
    const r = record({
      type: 'word',
      mark: M1,
      fields: { term: text('x'), count: integer(999) },
    })
    const diags = validateRecord(r, wordForm, { isBaseForm: true })
    expect(errors(diags).some(d => d.field === 'count')).toBe(true)
  })

  it('separates hold errors from want warnings', () => {
    const softForm = form('word', [
      property('term', { base: 'text' }, { constraints: [want('need')] }),
    ])
    const r = record({ type: 'word', mark: M1, fields: {} })
    const diags = validateRecord(r, softForm, { isBaseForm: true })
    expect(errors(diags)).toEqual([])
    expect(diags.some(d => d.severity === 'want')).toBe(true)
  })

  it('flags an unresolved reference across a dataset', () => {
    const role = roleBase([wordForm])
    const ds = datasetOf([
      record({
        type: 'word',
        mark: M1,
        fields: { term: text('foo'), lang: ref(M2) },
      }),
    ])
    const diags = validateDataset(ds, role)
    expect(
      errors(diags).some(d => d.message.includes('does not resolve')),
    ).toBe(true)
  })

  it('flags a uniqueness violation across a dataset', () => {
    const soleForm = form('tag', [
      property('name', { base: 'text' }, {
        constraints: [hold('sole', { scope: 'global' })],
      }),
    ])
    const role = roleBase([soleForm])
    const ds = datasetOf([
      record({ type: 'tag', mark: M1, fields: { name: text('dup') } }),
      record({ type: 'tag', mark: M2, fields: { name: text('dup') } }),
    ])
    const diags = validateDataset(ds, role)
    expect(errors(diags).some(d => d.message.includes('uniqueness'))).toBe(true)
  })

  it('enforces marked collection members', () => {
    const markForm = form('word', [
      property('senses', { record: 'sense' }, {
        collection: 'list',
        constraints: [hold('mark')],
      }),
    ])
    const r = record({
      type: 'word',
      mark: M1,
      fields: { senses: set([item(text('a'))]) },
    })
    const diags = validateRecord(r, markForm, { isBaseForm: true })
    expect(
      errors(diags).some(d => d.message.includes('not marked')),
    ).toBe(true)
  })
})
