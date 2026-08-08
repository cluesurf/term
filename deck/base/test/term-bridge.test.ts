// The bridge from milled term-lang (@term/make) to base forms and records. Fixtures are hand-built
// AST nodes (the make AST is a type-only import), so this suite needs no compiler at runtime. The
// real parse -> mill -> lift path is exercised separately; here the concern is the translation.

import { describe, it, expect } from 'vitest'
import type {
  TermExpression,
  TermProgram,
  TermType,
} from '@term/base/code/bridge/term-ast'
import {
  liftForm,
  liftProgram,
  liftRecord,
  type LiftOptions,
} from '@term/base/code/bridge/from-term'
import type { Form } from '@term/base/code/form/form'
import { form, property, hold } from '@term/base/code/form/form'

const str = (value: string): TermExpression => ({ form: 'string', value })
const int = (value: bigint): TermExpression => ({ form: 'integer', value })
const bool = (value: boolean): TermExpression => ({ form: 'boolean', value })

const named = (name: string): TermType => ({ kind: 'named', name })
const fnType = (): TermType => ({ kind: 'function' })

describe('liftForm', () => {
  it('lifts a data-only form and marks the note-id field as identity', () => {
    const lifted = liftForm({
      name: 'language-string',
      functionFree: true,
      fields: [
        { name: 'id', type: named('uuid'), identity: true },
        { name: 'text', type: named('text') },
        { name: 'count', type: named('integer') },
      ],
    })

    expect(lifted).toBeDefined()
    expect(lifted!.name).toBe('language-string')

    const id = lifted!.properties.find(p => p.name === 'id')!
    expect(id.like).toEqual({ base: 'uuid' })
    expect(id.constraints.some(c => c.kind === 'mark')).toBe(true)

    const textProp = lifted!.properties.find(p => p.name === 'text')!
    expect(textProp.like).toEqual({ base: 'text' })
    expect(textProp.constraints.some(c => c.kind === 'mark')).toBe(false)

    const count = lifted!.properties.find(p => p.name === 'count')!
    expect(count.like).toEqual({ base: 'integer' })
  })

  it('maps a named type with no base to a reference', () => {
    const lifted = liftForm({
      name: 'word',
      functionFree: true,
      fields: [{ name: 'language', type: named('language') }],
    })

    expect(lifted!.properties[0]!.like).toEqual({ ref: 'language' })
  })

  it('lifts an array field as a collection', () => {
    const lifted = liftForm({
      name: 'list-thing',
      functionFree: true,
      fields: [
        { name: 'items', type: { kind: 'array', element: named('text') } },
      ],
    })

    const items = lifted!.properties[0]!
    expect(items.like).toEqual({ base: 'text' })
    expect(items.collection).toBe('list')
  })

  it('refuses a form that carries a function field', () => {
    const lifted = liftForm({
      name: 'handler',
      functionFree: false,
      fields: [{ name: 'run', type: fnType() }],
    })

    expect(lifted).toBeUndefined()
  })
})

describe('liftRecord', () => {
  const schema: Form = form('thing', [
    property('id', { base: 'uuid' }, { constraints: [hold('mark')] }),
    property('name', { base: 'text' }),
    property('count', { base: 'integer' }),
    property('ratio', { base: 'decimal' }),
    property('active', { base: 'boolean' }),
    property('lang', { ref: 'language' }),
  ])
  const forms = new Map<string, Form>([['thing', schema]])

  it('coerces each literal to its declared type', () => {
    const rec = liftRecord(
      {
        name: 'thing',
        functionFree: true,
        fields: [
          { name: 'id', value: str('the-key') },
          { name: 'name', value: str('Inter') },
          { name: 'count', value: str('42') },
          { name: 'ratio', value: str('1.5') },
          { name: 'active', value: str('true') },
          { name: 'lang', value: str('lang-mark') },
        ],
      },
      forms,
    )

    expect(rec.type).toBe('thing')
    expect(rec.fields.get('name')).toEqual({ kind: 'text', value: 'Inter' })
    expect(rec.fields.get('count')).toEqual({ kind: 'integer', value: 42n })
    expect(rec.fields.get('ratio')).toEqual({ kind: 'decimal', value: '1.5' })
    expect(rec.fields.get('active')).toEqual({ kind: 'boolean', value: true })
    expect(rec.fields.get('lang')).toEqual({ kind: 'ref', target: 'lang-mark' })
  })

  it('resolves the mark from the natural key via find-or-create', () => {
    const seen: Array<{ form: string; key: string }> = []
    const opts: LiftOptions = {
      resolveMark: (f, key) => {
        seen.push({ form: f, key })
        return `mark-for-${key}`
      },
    }

    const rec = liftRecord(
      {
        name: 'thing',
        functionFree: true,
        fields: [
          { name: 'id', value: str('inter') },
          { name: 'name', value: str('Inter') },
        ],
      },
      forms,
      opts,
    )

    expect(rec.mark).toBe('mark-for-inter')
    expect(seen).toEqual([{ form: 'thing', key: 'inter' }])
  })

  it('stamps source provenance when given a source file', () => {
    const rec = liftRecord(
      { name: 'thing', functionFree: true, fields: [{ name: 'name', value: str('x') }] },
      forms,
      { sourceFile: 'code/fonts.tree' },
    )

    expect(rec.fields.get('~source')).toEqual({ kind: 'text', value: 'code/fonts.tree' })
  })

  it('throws when a literal does not fit its declared integer type', () => {
    expect(() =>
      liftRecord(
        {
          name: 'thing',
          functionFree: true,
          fields: [{ name: 'count', value: str('not-a-number') }],
        },
        forms,
      ),
    ).toThrow(/not an integer/)
  })

  it('carries a literal in its own kind when the form is unknown', () => {
    const rec = liftRecord(
      {
        name: 'unknown-form',
        functionFree: true,
        fields: [
          { name: 'n', value: int(7n) },
          { name: 'b', value: bool(false) },
        ],
      },
      new Map(),
    )

    expect(rec.fields.get('n')).toEqual({ kind: 'integer', value: 7n })
    expect(rec.fields.get('b')).toEqual({ kind: 'boolean', value: false })
  })
})

describe('liftProgram', () => {
  const program: TermProgram = [
    {
      form: 'record-type',
      name: 'font',
      fields: [
        { name: 'slug', type: named('text'), identity: true },
        { name: 'name', type: named('text') },
      ],
      functionFree: true,
    },
    {
      form: 'record-type',
      name: 'handler',
      fields: [{ name: 'run', type: fnType() }],
      functionFree: false,
    },
    {
      form: 'expression',
      expr: {
        form: 'record',
        name: 'font',
        functionFree: true,
        fields: [
          { name: 'slug', value: str('inter') },
          { name: 'name', value: str('Inter') },
        ],
      },
    },
    {
      form: 'let',
      name: 'inter-regular',
      mutable: false,
      init: str('./Inter/Inter-Regular.woff2'),
    },
  ]

  it('lifts forms, records, and host assets, and reports skips', () => {
    const result = liftProgram(program, {
      resolveMark: (f, key) => `${f}:${key}`,
      resolveBlob: path => (path.endsWith('.woff2') ? 'sha-abc' : undefined),
    })

    // the data-only form lifted, the function-carrying one was skipped
    expect(result.forms.map(f => f.name)).toEqual(['font'])
    expect(result.skipped).toContainEqual({
      kind: 'form',
      name: 'handler',
      reason: 'has a function-typed field, so it is code, not data',
    })

    const font = result.records.find(r => r.type === 'font')!
    expect(font.mark).toBe('font:inter')
    expect(font.fields.get('name')).toEqual({ kind: 'text', value: 'Inter' })

    const asset = result.records.find(r => r.type === 'asset')!
    expect(asset.mark).toBe('asset:inter-regular')
    expect(asset.fields.get('blob')).toEqual({ kind: 'blob', hash: 'sha-abc' })
    expect(asset.fields.get('path')).toEqual({
      kind: 'text',
      value: './Inter/Inter-Regular.woff2',
    })
  })

  it('skips a host whose bytes cannot be resolved', () => {
    const result = liftProgram(program, {
      resolveMark: (f, key) => `${f}:${key}`,
      resolveBlob: () => undefined,
    })

    expect(result.records.some(r => r.type === 'asset')).toBe(false)
    expect(result.skipped).toContainEqual({
      kind: 'host',
      name: 'inter-regular',
      reason: 'could not resolve bytes for ./Inter/Inter-Regular.woff2',
    })
  })
})
