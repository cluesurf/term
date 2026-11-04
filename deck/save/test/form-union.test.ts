// A union like, a union form, and a snake_case form name. The three things a schema
// written for JSON needs from the form layer and did not have.

import { describe, it, expect } from 'vitest'
import { form, hold, property, roleBase, union, armOf } from '@cluesurf/save/form/form'
import { validateDataset, validateRecord } from '@cluesurf/save/form/validate'
import { checkFormName } from '@cluesurf/save/api/form'
import { datasetOf } from '@cluesurf/save/diff/change'
import { text, integer, boolean, list, nested, record } from '@cluesurf/save/base/make'

const MARK = '11111111-1111-4111-8111-111111111111'

const ROLE = roleBase([
  union('node', ['leaf', 'branch']),
  form('leaf', [
    property('form', { base: 'text' }, { constraints: [hold('need'), hold('pick', { options: ['leaf'] })] }),
    property('text', { base: 'text' }, { constraints: [hold('need')] }),
  ]),
  form('branch', [
    property('form', { base: 'text' }, { constraints: [hold('need'), hold('pick', { options: ['branch'] })] }),
    property('children', { record: 'node' }, { collection: 'list' }),
  ]),
  form('slot', [
    property('value', { any: [{ base: 'text' }, { base: 'integer' }, { record: 'node' }] }),
  ]),
])

describe('a union like', () => {
  it('accepts any arm and refuses what no arm accepts', () => {
    const slot = ROLE.forms.get('slot')!
    const ok = (v: Parameters<typeof validateRecord>[0]['fields'] extends Map<string, infer V> ? V : never) =>
      validateRecord(record({ type: 'slot', mark: MARK, fields: { value: v } }), slot, { role: ROLE })

    expect(ok(text('a'))).toEqual([])
    expect(ok(integer(1))).toEqual([])
    expect(ok(nested(record({ type: 'leaf', fields: { form: text('leaf'), text: text('x') } })))).toEqual([])

    const refused = ok(boolean(true))
    expect(refused).toHaveLength(1)
    expect(refused[0]!.message).toBe('expected one of text, integer, record node, got boolean')
  })

  it('validates the record arm it picked against that arm\'s form', () => {
    const slot = ROLE.forms.get('slot')!
    // a leaf with its required `text` missing
    const misses = validateRecord(
      record({ type: 'slot', mark: MARK, fields: { value: nested(record({ type: 'leaf', fields: { form: text('leaf') } })) } }),
      slot,
      { role: ROLE },
    )
    expect(misses.some(m => m.field === 'text' && m.message === 'missing required property')).toBe(true)
  })
})

describe('a union form', () => {
  it('accepts a record whose type is an arm and refuses one whose type is not', () => {
    const branch = ROLE.forms.get('branch')!
    const good = record({
      type: 'branch',
      mark: MARK,
      fields: {
        form: text('branch'),
        children: list([{ value: nested(record({ type: 'leaf', fields: { form: text('leaf'), text: text('x') } })) }]),
      },
    })
    expect(validateRecord(good, branch, { role: ROLE })).toEqual([])

    const stray = record({
      type: 'branch',
      mark: MARK,
      fields: {
        form: text('branch'),
        children: list([{ value: nested(record({ type: 'twig', fields: {} })) }]),
      },
    })
    const misses = validateRecord(stray, branch, { role: ROLE })
    expect(misses).toHaveLength(1)
    expect(misses[0]!.message).toBe('collection member: expected record node, got record twig')
  })

  it('recurses into the arm, so a bad leaf three levels down is reported', () => {
    const branch = ROLE.forms.get('branch')!
    const deep = record({
      type: 'branch',
      mark: MARK,
      fields: {
        form: text('branch'),
        children: list([
          {
            value: nested(
              record({
                type: 'branch',
                fields: {
                  form: text('branch'),
                  children: list([{ value: nested(record({ type: 'leaf', fields: { form: text('leaf'), text: integer(4) } })) }]),
                },
              }),
            ),
          },
        ]),
      },
    })
    const misses = validateRecord(deep, branch, { role: ROLE })
    expect(misses.some(m => m.field === 'text' && m.message === 'expected text, got integer')).toBe(true)
  })

  it('is never a top-level record\'s own form', () => {
    // a record typed after the union rather than an arm has no form
    const misses = validateDataset(
      datasetOf([record({ type: 'node', mark: MARK, fields: { form: text('leaf') } })]),
      ROLE,
    )
    expect(misses.some(m => m.message === 'no base form for type node')).toBe(true)
  })

  it('names the arm a discriminant picks, for a lifter', () => {
    const node = ROLE.forms.get('node')!
    expect(armOf(ROLE, node, 'leaf')?.name).toBe('leaf')
    expect(armOf(ROLE, node, 'branch')?.name).toBe('branch')
    expect(armOf(ROLE, node, 'twig')).toBeUndefined()
  })
})

describe('a reference across repositories', () => {
  const OTHER = '22222222-2222-4222-8222-222222222222'

  it('is not resolved here when the role does not hold the form it points at', () => {
    // one repository per form: a page's workspace lives elsewhere, and this role has no
    // `workspace` form, so the reference is that repository's fact
    const role = roleBase([
      form('page', [property('workspace__id', { ref: 'workspace' }, { constraints: [hold('need')] })]),
    ])
    const page = record({ type: 'page', mark: MARK, fields: { workspace__id: { kind: 'ref', target: OTHER } } })
    expect(validateDataset(datasetOf([page]), role)).toEqual([])
  })

  it('is still resolved when the role holds the form', () => {
    const role = roleBase([
      form('branch', [property('root', { ref: 'leaf' })]),
      form('leaf', [property('form', { base: 'text' })]),
    ])
    const branch = record({ type: 'branch', mark: MARK, fields: { root: { kind: 'ref', target: OTHER } } })
    const misses = validateDataset(datasetOf([branch]), role)
    expect(misses.some(m => /does not resolve/.test(m.message))).toBe(true)
  })
})

describe('a form name', () => {
  it('accepts snake_case, which is what every platform form is called', () => {
    expect(checkFormName('content_heading')).toBeUndefined()
    expect(checkFormName('language_symbol')).toBeUndefined()
    expect(checkFormName('page')).toBeUndefined()
  })

  it('still refuses what no path can carry', () => {
    expect(checkFormName('ContentHeading')).toEqual({ fault: 'bad-name', name: 'ContentHeading' })
    expect(checkFormName('_leading')).toEqual({ fault: 'bad-name', name: '_leading' })
    expect(checkFormName('has space')).toEqual({ fault: 'bad-name', name: 'has space' })
  })
})
