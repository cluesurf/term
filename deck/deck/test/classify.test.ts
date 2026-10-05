import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  classify,
  extensionOf,
  looksTextual,
} from '../code/object/classify'
import { buildVersion } from '../code/object/version'
import { restoreVersion } from '../code/object/restore'
import { localObjectStore } from '../code/object/store'
import type { ObjectStore } from '../code/object/store'
import { diffRecord } from '@cluesurf/save/diff/diff'
import { parseTree } from '@cluesurf/save/tree/parse'

describe('classify', () => {
  it('sends `.tree` down the structured path by name alone', () => {
    expect(
      classify({ path: 'code/base.tree', bytes: Buffer.from('word x\n') }),
    ).toBe('tree')
  })

  it('reads ordinary source as text', () => {
    expect(
      classify({ path: 'code/main.ts', bytes: Buffer.from('const x = 1\n') }),
    ).toBe('text')
  })

  it('trusts a binary extension over the bytes', () => {
    // valid UTF-8, but a png is a png
    expect(
      classify({ path: 'view/logo.png', bytes: Buffer.from('hello') }),
    ).toBe('binary')
  })

  it('catches binary content with no telling extension', () => {
    expect(
      classify({ path: 'weird', bytes: Buffer.from([0x00, 0xff]) }),
    ).toBe('binary')
  })

  it('treats an extensionless text file as text', () => {
    expect(classify({ path: 'LICENSE', bytes: Buffer.from('MIT\n') })).toBe(
      'text',
    )
  })

  it('reads an extension case-insensitively and without the dot', () => {
    expect(extensionOf('a/B.PNG')).toBe('png')
    expect(extensionOf('noext')).toBe('')
    expect(extensionOf('.hidden')).toBe('')
  })

  it('rejects a NUL byte and malformed UTF-8', () => {
    expect(looksTextual(Buffer.from([0x61, 0x00]))).toBe(false)
    expect(looksTextual(Buffer.from([0xff, 0xfe]))).toBe(false)
    expect(looksTextual(Buffer.from('héllo'))).toBe(true)
  })
})

// A data `.tree` in the record grammar's canonical form, which is what the formatter writes back: a record is kept
// only when it gives the file back byte for byte (object/version.ts `recordOf`)
const CANONICAL = '# the corpus\nword hello\n  syllables @integer 2\n  # written form\n  text hello\n'

describe('`.tree` is parsed, not chunked', () => {
  let dir = ''
  let store: ObjectStore

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'classify-src-'))
    mkdirSync(path.join(dir, 'code'), { recursive: true })
    writeFileSync(path.join(dir, 'code/word.tree'), CANONICAL)
    writeFileSync(path.join(dir, 'code/main.ts'), 'export const x = 1\n')
    store = localObjectStore({
      root: mkdtempSync(path.join(tmpdir(), 'classify-obj-')),
    })
  })

  it('carries a record and no chunks', async () => {
    const built = await buildVersion({ dir, store })
    const tree = built.files.find(f => f.path === 'code/word.tree')

    expect(tree?.record).toBeDefined()
    expect(tree?.chunks).toEqual([])
  })

  it('still chunks ordinary text', async () => {
    const built = await buildVersion({ dir, store })
    const text = built.files.find(f => f.path === 'code/main.ts')

    expect(text?.record).toBeUndefined()
    expect(text?.chunks.length).toBeGreaterThan(0)
  })

  it('keeps comments in the record', async () => {
    const built = await buildVersion({ dir, store })
    const tree = built.files.find(f => f.path === 'code/word.tree')

    expect(tree?.record?.comments?.get('')).toEqual(['the corpus'])
    expect(tree?.record?.comments?.get('text')).toEqual(['written form'])
  })

  it('regenerates the file on checkout, comments included', async () => {
    const built = await buildVersion({ dir, store })
    const dest = mkdtempSync(path.join(tmpdir(), 'classify-out-'))

    await restoreVersion({
      root: built.root,
      dest,
      chunks: built.treeChunks,
      store,
    })

    const back = readFileSync(path.join(dest, 'code/word.tree'), 'utf8')

    expect(back).toBe(CANONICAL)
  })

  // the same record with its fields in another order, and Term source with several top-level nodes, which the record
  // grammar would cut to its first: neither comes back as written from a record, so both ship as bytes
  it('ships as bytes a .tree its record would not give back', async () => {
    writeFileSync(path.join(dir, 'code/word.tree'), '# the corpus\nword hello\n  # written form\n  text hello\n  syllables @integer 2\n')
    writeFileSync(path.join(dir, 'code/form.tree'), 'form point\n  link x, like number\n\nform line\n  link from, like point\n')

    const built = await buildVersion({ dir, store })

    for (const at of ['code/word.tree', 'code/form.tree']) {
      const file = built.files.find(f => f.path === at)

      expect(file?.record).toBeUndefined()
      expect(file?.chunks.length).toBeGreaterThan(0)
    }
  })

  it('reports a one-field edit as exactly one change', () => {
    const lines = ['word corpus', '  mark <0195f0e6-1c4a-7bd3-9f2e-4a1b8c7d6e5f>']

    for (let i = 0; i < 400; i++) {
      lines.push(`  field${i} value${i}`)
    }

    const before = parseTree(`${lines.join('\n')}\n`)
    const edited = [...lines]
    edited[edited.indexOf('  field199 value199')] = '  field199 CHANGED'
    const after = parseTree(`${edited.join('\n')}\n`)

    const changes = diffRecord(before.mark!, before, after)

    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      type: 'field.set',
      field: 'field199',
    })
  })
})
