// Lifting ordinary data into base records.
//
// The on-ramp. Without it the only ways into a repository are hand-written `.tree` files or
// TypeScript, which is the difference between a system somebody else can use and one only
// its author can.
//
// The parser tests are the cases a small delimited parser gets wrong, because each of those
// TRUNCATES data rather than failing, and silently wrong data is the worst outcome an
// importer has.
//
// The mark tests are the reason this is more than a parser: a second import of the same
// file must update the same records rather than duplicate every one of them.

import { describe, it, expect } from 'vitest'
import {
  BadRow,
  parseDelimited,
  parseJsonRows,
  recordsFrom,
} from '@term/base/code/bridge/from-data'
import { text } from '@term/base/code/base/make'
import type { Dataset } from '@term/base/code/diff/change'

const csv = (text: string) => parseDelimited({ text, delimiter: ',' })

describe('parsing delimited text', () => {
  it('reads a header and its rows', () => {
    expect(csv('word,gloss\nhello,greeting\n')).toEqual([
      { word: 'hello', gloss: 'greeting' },
    ])
  })

  it('keeps a delimiter inside a quoted field', () => {
    // The classic truncation. Splitting on the delimiter would give three columns and lose
    // half the gloss, with no error anywhere.
    expect(csv('word,gloss\nhello,"a greeting, warmly"\n')).toEqual([
      { word: 'hello', gloss: 'a greeting, warmly' },
    ])
  })

  it('keeps a newline inside a quoted field', () => {
    expect(csv('word,gloss\nhello,"two\nlines"\n')).toEqual([
      { word: 'hello', gloss: 'two\nlines' },
    ])
  })

  it('reads an escaped quote written as two quotes', () => {
    expect(csv('word,gloss\nhello,"he said ""hi"""\n')).toEqual([
      { word: 'hello', gloss: 'he said "hi"' },
    ])
  })

  it('handles CRLF without leaving a carriage return on the last column', () => {
    // Invisible, and it makes every comparison against that column fail.
    expect(csv('word,gloss\r\nhello,greeting\r\n')).toEqual([
      { word: 'hello', gloss: 'greeting' },
    ])
  })

  it('strips a byte order mark rather than putting it in the first column NAME', () => {
    // Otherwise every lookup of that column silently misses.
    expect(csv('﻿word,gloss\nhello,greeting\n')).toEqual([
      { word: 'hello', gloss: 'greeting' },
    ])
  })

  it('treats an empty cell as absence rather than an empty string', () => {
    // A delimited source cannot tell them apart, and absence is the reading that lets the
    // column be nullable rather than full of blanks.
    expect(csv('word,gloss\nhello,\n')).toEqual([{ word: 'hello' }])
  })

  it('ignores a trailing newline instead of making an empty record', () => {
    expect(csv('word\na\nb\n')).toHaveLength(2)
  })

  it('reads tab separated with the same rules', () => {
    expect(
      parseDelimited({ text: 'word\tgloss\nhello\ta, b\n', delimiter: '\t' }),
    ).toEqual([{ word: 'hello', gloss: 'a, b' }])
  })

  it('is empty for an empty file', () => {
    expect(csv('')).toEqual([])
  })
})

describe('parsing json rows', () => {
  it('reads an array of objects', () => {
    expect(parseJsonRows('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }])
  })

  it('reads a single object as one row', () => {
    expect(parseJsonRows('{"a":1}')).toEqual([{ a: 1 }])
  })

  it('reads one object per line', () => {
    expect(parseJsonRows('{"a":1}\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }])
  })

  it('names the line when a line-delimited file has a bad line', () => {
    // Pointing at the file is useless for a million-line export.
    try {
      parseJsonRows('{"a":1}\nnot json\n')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(BadRow)
      expect((error as BadRow).at).toBe(2)
    }
  })

  it('refuses an array of scalars, which has no fields', () => {
    expect(() => parseJsonRows('[1,2]')).toThrow(BadRow)
  })
})

describe('where a mark comes from', () => {
  const rows = [
    { slug: 'hello', gloss: 'greeting' },
    { slug: 'world', gloss: 'the earth' },
  ]

  it('takes a column that already holds a uuid version 4', () => {
    const { records } = recordsFrom({
      rows: [{ id: '8f2b1c30-4d5e-4a71-b3c6-9e0f2a7d4415', slug: 'hello' }],
      form: 'word',
      mark: { kind: 'column', column: 'id' },
    })

    expect(records[0]?.mark).toBe('8f2b1c30-4d5e-4a71-b3c6-9e0f2a7d4415')
  })

  it('refuses a mark column that is not a uuid version 4, and says what to do', () => {
    // The common case: a source with an integer id. Accepting it would put a mark in the
    // store that nothing else in the system considers valid.
    try {
      recordsFrom({
        rows: [{ id: '17', slug: 'hello' }],
        form: 'word',
        mark: { kind: 'column', column: 'id' },
      })
      expect.unreachable()
    } catch (error) {
      expect((error as Error).message).toContain('not a uuid version 4')
      expect((error as Error).message).toContain('--key')
    }
  })

  it('mints a fresh mark per row on a first import by key', () => {
    let n = 0
    const { records, minted, reused } = recordsFrom({
      rows,
      form: 'word',
      mark: { kind: 'key', column: 'slug' },
      mint: () => `minted-${++n}`,
    })

    expect(records.map(one => one.mark)).toEqual(['minted-1', 'minted-2'])
    expect(minted).toBe(2)
    expect(reused).toBe(0)
  })

  it('REUSES the mark on a second import, so a re-import updates rather than duplicates', () => {
    // The property the whole design turns on. Without it, running an import twice gives two
    // copies of every record and nothing says so.
    const existing: Dataset = new Map([
      [
        'already-there',
        { mark: 'already-there', type: 'word', fields: new Map([['slug', text('hello')]]) },
      ],
    ])

    const { records, reused, minted } = recordsFrom({
      rows,
      form: 'word',
      mark: { kind: 'key', column: 'slug' },
      existing,
      mint: () => 'fresh',
    })

    expect(records[0]?.mark).toBe('already-there')
    expect(records[1]?.mark).toBe('fresh')
    expect(reused).toBe(1)
    expect(minted).toBe(1)
  })

  it('gives two rows sharing a key ONE mark within a single import', () => {
    // Otherwise the second mints its own and the two fight over the same natural key on
    // every subsequent import.
    const { records } = recordsFrom({
      rows: [
        { slug: 'hello', gloss: 'one' },
        { slug: 'hello', gloss: 'two' },
      ],
      form: 'word',
      mark: { kind: 'key', column: 'slug' },
      mint: (() => {
        let n = 0
        return () => `minted-${++n}`
      })(),
    })

    expect(records[0]?.mark).toBe(records[1]?.mark)
  })

  it('does not match a record of a DIFFERENT form that shares the key', () => {
    const existing: Dataset = new Map([
      [
        'a-script',
        { mark: 'a-script', type: 'script', fields: new Map([['slug', text('hello')]]) },
      ],
    ])

    const { records, reused } = recordsFrom({
      rows: [{ slug: 'hello' }],
      form: 'word',
      mark: { kind: 'key', column: 'slug' },
      existing,
      mint: () => 'fresh',
    })

    expect(records[0]?.mark).toBe('fresh')
    expect(reused).toBe(0)
  })

  it('names the row when the mark column is missing or empty', () => {
    try {
      recordsFrom({
        rows: [{ slug: 'hello' }, { gloss: 'no slug here' }],
        form: 'word',
        mark: { kind: 'key', column: 'slug' },
      })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(BadRow)
      expect((error as BadRow).at).toBe(2)
    }
  })
})

describe('the fields a record gets', () => {
  it('keeps every column, including the key', () => {
    // The key is data as well as an identifier, and dropping it would make the record
    // unable to say what it is.
    const { records } = recordsFrom({
      rows: [{ slug: 'hello', gloss: 'greeting' }],
      form: 'word',
      mark: { kind: 'key', column: 'slug' },
      mint: () => 'm',
    })

    expect([...records[0]!.fields.keys()].sort()).toEqual(['gloss', 'slug'])
  })

  it('omits a field whose value carries nothing', () => {
    const { records } = recordsFrom({
      rows: [{ slug: 'hello', gloss: null }],
      form: 'word',
      mark: { kind: 'key', column: 'slug' },
      mint: () => 'm',
    })

    expect(records[0]?.fields.has('gloss')).toBe(false)
  })

  it('keeps json types, which is why a typed source should be json', () => {
    const { records } = recordsFrom({
      rows: [{ slug: 'hello', count: 3, ok: true }],
      form: 'word',
      mark: { kind: 'key', column: 'slug' },
      mint: () => 'm',
    })

    expect(records[0]?.fields.get('count')).toEqual({ kind: 'integer', value: 3n })
    expect(records[0]?.fields.get('ok')).toEqual({ kind: 'boolean', value: true })
  })
})
