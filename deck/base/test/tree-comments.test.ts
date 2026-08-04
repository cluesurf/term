import { describe, it, expect } from 'vitest'
import { parseTree } from '@term/base/code/tree/parse'
import { formatTree } from '@term/base/code/tree/format'
import { hashRecord } from '@term/base/code/canon/hash'

// Comments are content, not trivia. `.tree` is stored as records and regenerated on
// checkout, so anything an author writes has to survive into the record graph or it is
// lost. These tests are the guarantee.

const SOURCE = `# what this record is for
# a second line
word hello
  # the written form
  text hello
  # how many beats
  syllables @integer 2
`

describe('comments survive parsing', () => {
  it('attaches a record comment under the empty key', () => {
    expect(parseTree(SOURCE).comments?.get('')).toEqual([
      'what this record is for',
      'a second line',
    ])
  })

  it('attaches a field comment under that field', () => {
    const record = parseTree(SOURCE)

    expect(record.comments?.get('text')).toEqual(['the written form'])
    expect(record.comments?.get('syllables')).toEqual([
      'how many beats',
    ])
  })

  it('leaves a record without comments undecorated', () => {
    expect(parseTree('word hello\n  text hello\n').comments).toBeUndefined()
  })

  it('keeps a comment above a mark', () => {
    const record = parseTree(
      `word hello\n  # who this is\n  mark <0195f0e6-1c4a-7bd3-9f2e-4a1b8c7d6e5f>\n  text hello\n`,
    )

    expect(record.comments?.get('mark')).toEqual(['who this is'])
  })
})

describe('comments survive formatting', () => {
  it('re-emits every comment', () => {
    const out = formatTree(parseTree(SOURCE))

    expect(out).toContain('# what this record is for')
    expect(out).toContain('# a second line')
    expect(out).toContain('# the written form')
    expect(out).toContain('# how many beats')
  })

  it('puts a comment directly above what it annotates', () => {
    const lines = formatTree(parseTree(SOURCE)).split('\n')
    const comment = lines.indexOf('  # how many beats')

    expect(lines[comment + 1]).toContain('syllables')
  })

  it('round-trips stably: formatting canonical text changes nothing', () => {
    const once = formatTree(parseTree(SOURCE))

    expect(formatTree(parseTree(once))).toBe(once)
  })
})

describe('comments are part of the record', () => {
  it('changes the hash, because a record that reads differently is different', () => {
    const withComment = parseTree(SOURCE)
    const without = parseTree(
      'word hello\n  text hello\n  syllables @integer 2\n',
    )

    expect(hashRecord(withComment)).not.toBe(hashRecord(without))
  })

  it('a record with no comments hashes as though comments never existed', () => {
    const bare = parseTree('word hello\n  text hello\n')

    // absent, not empty: the canonical bytes carry no `comments` key at all, so
    // records written before comments existed still hash identically
    expect(bare.comments).toBeUndefined()
    expect(hashRecord(bare)).toBe(
      hashRecord({
        type: 'word',
        label: 'hello',
        fields: new Map(parseTree('word hello\n  text hello\n').fields),
      }),
    )
  })

  it('differing comment text gives differing hashes', () => {
    const a = parseTree('# one\nword hello\n  text hello\n')
    const b = parseTree('# two\nword hello\n  text hello\n')

    expect(hashRecord(a)).not.toBe(hashRecord(b))
  })
})

describe('comments survive the canonical round trip', () => {
  it('come back after encoding and decoding', async () => {
    const { canonicalizeRecord } = await import(
      '@term/base/code/canon/canonicalize'
    )
    const { decodeRecord } = await import('@term/base/code/canon/decode')

    const record = parseTree(SOURCE)
    const back = decodeRecord(canonicalizeRecord(record))

    expect(back.comments?.get('')).toEqual([
      'what this record is for',
      'a second line',
    ])
    expect(back.comments?.get('text')).toEqual(['the written form'])
  })
})
