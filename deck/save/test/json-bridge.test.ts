// The law of the JSON bridge: lowering a lift is the identity on JSON, and lifting a
// lowering is value-equal on lifted values. Every other claim about JSON in base rests
// on these two, and before this module existed neither held: a record came back with a
// `type` key it never had and an integer came back as a string.

import { describe, it, expect } from 'vitest'
import {
  liftJson,
  lowerJson,
  OBJECT,
  type Json,
} from '@cluesurf/save/bridge/json'
import { valueEqual } from '@cluesurf/save/base/equal'
import { canonicalizeValue } from '@cluesurf/save/canon/canonicalize'
import { toParam } from '@cluesurf/save/project/sql'
import { form, hold, property, roleBase, union } from '@cluesurf/save/form/form'
import { validateRecord } from '@cluesurf/save/form/validate'
import { text, integer, decimal, nul, list, record } from '@cluesurf/save/base/make'
import { toHexMark } from '@cluesurf/save/canon/mark'

const TONE = 'mndbtkhs-fvzxcwlr-btkhsfvz-xcwlrmnd'
const HEX = toHexMark(TONE)

// A page body of the kind word.surf writes: nested objects, an array, whole and
// fractional numbers, booleans, nulls, strings, and no ids anywhere.
const BODY: Json = [
  { form: 'load', name: 'to_uppercase' },
  { form: 'find', name: 'languages', size: 20 },
  { form: 'host', name: 'ratio', value: 1.75 },
  {
    form: 'heading',
    level: 2,
    is_numbered: false,
    anchor: null,
    children: ['Phonology', { form: 'text', type: 'strong', children: ['now'] }],
  },
  { form: 'paragraph', children: [] },
]

// The content vocabulary, as the forms a translator would register: a union keyed on
// `form`, and each arm declaring `form` with a one-option pick.
const ROLE = roleBase([
  union('content', ['content_heading', 'content_text', 'content_paragraph']),
  form('content_heading', [
    property('form', { base: 'text' }, { constraints: [hold('need'), hold('pick', { options: ['heading'] })] }),
    property('level', { base: 'integer' }, { constraints: [hold('span', { min: 1, max: 6 })] }),
    property('is_numbered', { base: 'boolean' }),
    property('children', { any: [{ base: 'text' }, { record: 'content' }] }, { collection: 'list' }),
  ]),
  form('content_text', [
    property('form', { base: 'text' }, { constraints: [hold('need'), hold('pick', { options: ['text'] })] }),
    property('type', { base: 'text' }),
    property('children', { any: [{ base: 'text' }, { record: 'content' }] }, { collection: 'list' }),
  ]),
  form('content_paragraph', [
    property('form', { base: 'text' }, { constraints: [hold('need'), hold('pick', { options: ['paragraph'] })] }),
    property('children', { any: [{ base: 'text' }, { record: 'content' }] }, { collection: 'list' }),
  ]),
  form('page', [
    property('content', { record: 'content' }, { collection: 'list' }),
    property('ratio', { base: 'decimal' }),
  ]),
])

describe('the law', () => {
  it('lowers a lift back to the same JSON, with no form in hand', () => {
    expect(lowerJson(liftJson(BODY))).toEqual(BODY)
  })

  it('lowers a lift back to the same JSON, with the form in hand', () => {
    const lifted = liftJson(BODY, { like: { record: 'content' }, role: ROLE })
    expect(lowerJson(lifted)).toEqual(BODY)
  })

  it('lifts a lowering back to a value-equal value', () => {
    const v = liftJson(BODY)
    expect(valueEqual(liftJson(lowerJson(v)), v)).toBe(true)
  })

  it('hashes the same JSON the same, and a one-key change differently', () => {
    const a = canonicalizeValue(liftJson(BODY))
    const b = canonicalizeValue(liftJson(JSON.parse(JSON.stringify(BODY)) as Json))
    expect(a).toBe(b)
    const changed = JSON.parse(JSON.stringify(BODY)) as Array<{ [k: string]: Json }>
    changed[3]!.level = 3
    expect(canonicalizeValue(liftJson(changed))).not.toBe(a)
  })
})

describe('an any of plain forms', () => {
  // The content catalogue's slots are `any` lists of PLAIN node forms, each declaring
  // its kind as a one-option pick on `form`. The arm has to be picked by that kind:
  // the first plain arm answered for every object, so a `walk` under a grid lifted as
  // a `content_heading` and the role refused the page as `not one of heading`.
  const role = roleBase([
    form('content_heading', [
      property('form', { base: 'text' }, { constraints: [hold('pick', { options: ['heading'] })] }),
      property('level', { base: 'integer' }),
    ]),
    form('content_walk', [
      property('form', { base: 'text' }, { constraints: [hold('pick', { options: ['walk'] })] }),
      property('item', { base: 'text' }),
    ]),
    form('content_grid', [
      property('form', { base: 'text' }, { constraints: [hold('pick', { options: ['grid'] })] }),
      property(
        'children',
        { any: [{ record: 'content_heading' }, { record: 'content_walk' }] },
        { collection: 'list' },
      ),
    ]),
    form('plain', [property('name', { base: 'text' })]),
  ])

  it('picks the arm whose kind the object carries, whatever the order', () => {
    const v = liftJson(
      { form: 'grid', children: [{ form: 'walk', item: 'entry' }, { form: 'heading', level: 2 }] },
      { like: { record: 'content_grid' }, role },
    )
    expect(v.kind).toBe('record')
    if (v.kind === 'record') {
      const children = v.record.fields.get('children')
      expect(children?.kind).toBe('collection')
      if (children?.kind === 'collection') {
        const types = children.items.map(item =>
          item.value.kind === 'record' ? item.value.record.type : item.value.kind,
        )
        expect(types).toEqual(['content_walk', 'content_heading'])
      }
    }
  })

  it('lifts an object no arm admits as object, and the role then refuses it', () => {
    const v = liftJson(
      { form: 'grid', children: [{ form: 'nonsense' }] },
      { like: { record: 'content_grid' }, role },
    )
    if (v.kind === 'record') {
      const children = v.record.fields.get('children')
      if (children?.kind === 'collection') {
        const first = children.items[0]!.value
        expect(first.kind === 'record' && first.record.type).toBe(OBJECT)
      }
      const problems = validateRecord(v.record, role.forms.get('content_grid')!, { role })
      expect(problems.some(one => one.field === 'children')).toBe(true)
    }
  })

  it('a form with no kind of its own admits any object', () => {
    const v = liftJson({ name: 'x' }, { like: { record: 'plain' }, role })
    expect(v.kind === 'record' && v.record.type).toBe('plain')
  })
})

describe('numbers and null', () => {
  it('keeps a whole number whole and a fraction as a decimal, and both come back as numbers', () => {
    expect(liftJson(20)).toEqual(integer(20))
    expect(liftJson(1.75)).toEqual(decimal('1.75'))
    expect(lowerJson(integer(20))).toBe(20)
    expect(lowerJson(decimal('1.75'))).toBe(1.75)
  })

  it('keeps a whole number a decimal when the form says decimal', () => {
    const v = liftJson({ ratio: 2 }, { like: { record: 'page' }, role: ROLE })
    expect(v.kind).toBe('record')
    if (v.kind === 'record') {
      expect(v.record.fields.get('ratio')).toEqual(decimal('2'))
    }
    expect(lowerJson(v)).toEqual({ ratio: 2 })
  })

  it('keeps an integer past the safe range exact, as text on the way out', () => {
    const big = integer(BigInt('9007199254740993'))
    expect(lowerJson(big)).toBe('9007199254740993')
  })

  it('stores null as a null, not as absence', () => {
    // Before this module `{ a: null }` lowered to `{}`, which is a different document.
    expect(liftJson(null)).toEqual(nul())
    expect(lowerJson(liftJson({ a: null }))).toEqual({ a: null })
  })
})

describe('identity is the id field', () => {
  it('reads a tone-coded id as the mark, drops the key, and marks the list item', () => {
    const v = liftJson([{ id: TONE, name: 'x' }])
    expect(v.kind).toBe('collection')
    if (v.kind === 'collection') {
      const item = v.items[0]!
      expect(item.mark).toBe(HEX)
      expect(item.value.kind).toBe('record')
      if (item.value.kind === 'record') {
        expect(item.value.record.mark).toBe(HEX)
        expect(item.value.record.fields.has('id')).toBe(false)
      }
    }
  })

  it('reads a hex id the same way, and lowers either as a tone code', () => {
    expect(lowerJson(liftJson({ id: HEX }))).toEqual({ id: TONE })
    expect(lowerJson(liftJson({ id: TONE }))).toEqual({ id: TONE })
  })

  it('leaves an id that is neither spelling as an ordinary field, and the object positional', () => {
    const v = liftJson({ id: 'row-7', name: 'x' })
    if (v.kind === 'record') {
      expect(v.record.mark).toBeUndefined()
      expect(v.record.fields.get('id')).toEqual(text('row-7'))
    }
    expect(lowerJson(v)).toEqual({ id: 'row-7', name: 'x' })
  })

  it('keeps an id as a field when the form in hand declares one', () => {
    // `content_reference` carries `id` as the id of the record it points at. Two references
    // to the same language are two nodes, so the form's own `id` property wins over the
    // identity rule and the object stays positional.
    const role = roleBase([
      union('content', ['content_reference']),
      form('content_reference', [
        property('form', { base: 'text' }, { constraints: [hold('pick', { options: ['reference'] })] }),
        property('base', { base: 'text' }),
        property('id', { base: 'text' }),
      ]),
    ])
    const twice = [
      { form: 'reference', base: 'language', id: TONE },
      { form: 'reference', base: 'language', id: TONE },
    ]
    const v = liftJson(twice, { like: { record: 'content' }, role })
    expect(v.kind).toBe('collection')
    if (v.kind === 'collection') {
      expect(v.items.map(item => item.mark)).toEqual([undefined, undefined])
      const first = v.items[0]!.value
      expect(first.kind).toBe('record')
      if (first.kind === 'record') {
        expect(first.record.type).toBe('content_reference')
        expect(first.record.mark).toBeUndefined()
        expect(first.record.fields.get('id')).toEqual(text(TONE))
      }
    }
    expect(lowerJson(v)).toEqual(twice)

    // and with no form in hand the same object is a marked record, as the rule says
    const bare = liftJson(twice[0]!)
    if (bare.kind === 'record') {
      expect(bare.record.mark).toBe(HEX)
    }
  })

  it('never invents a mark on an object without an id', () => {
    const v = liftJson([{ form: 'paragraph' }])
    if (v.kind === 'collection') {
      expect(v.items[0]!.mark).toBeUndefined()
    }
  })
})

describe('directed by the form', () => {
  it('picks the union arm by the discriminant and types the record after it', () => {
    const v = liftJson(BODY[3]!, { like: { record: 'content' }, role: ROLE })
    expect(v.kind).toBe('record')
    if (v.kind === 'record') {
      expect(v.record.type).toBe('content_heading')
      // the discriminant stays a field, which is what makes the lowering total
      expect(v.record.fields.get('form')).toEqual(text('heading'))
      const children = v.record.fields.get('children')
      expect(children?.kind).toBe('collection')
      if (children?.kind === 'collection') {
        const nested = children.items[1]!.value
        expect(nested.kind === 'record' && nested.record.type).toBe('content_text')
      }
    }
  })

  it('types an object no form describes as `object`', () => {
    const v = liftJson({ form: 'nothing_declares_this' }, { like: { record: 'content' }, role: ROLE })
    expect(v.kind === 'record' && v.record.type).toBe(OBJECT)
  })

  it('lifts to something the role validates, and refuses what it should', () => {
    const good = liftJson(BODY[3]!, { like: { record: 'content' }, role: ROLE })
    const bad = liftJson({ form: 'heading', level: 'two' }, { like: { record: 'content' }, role: ROLE })
    if (good.kind === 'record' && bad.kind === 'record') {
      const heading = ROLE.forms.get('content_heading')!
      expect(validateRecord(good.record, heading, { role: ROLE })).toEqual([])
      const misses = validateRecord(bad.record, heading, { role: ROLE })
      expect(misses.some(m => m.field === 'level' && /expected integer/.test(m.message))).toBe(true)
    }
  })
})

describe('the projection lowers the same way', () => {
  it('writes a json column as the JSON that was lifted, with no type key and numbers as numbers', () => {
    const v = liftJson(BODY, { like: { record: 'content' }, role: ROLE })
    expect(JSON.parse(toParam(v) as string)).toEqual(BODY)
  })

  it('still lowers a hand-built record without a type key', () => {
    const v = record({ type: 'anything', fields: { a: text('x'), n: integer(3) } })
    expect(lowerJson({ kind: 'record', record: v })).toEqual({ a: 'x', n: 3 })
    expect(lowerJson(list([{ value: text('a') }, { value: nul() }]))).toEqual(['a', null])
  })
})
