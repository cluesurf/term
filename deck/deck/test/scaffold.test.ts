// What `term wake` writes, held against the three things that refused it on 2026-10-02: the formatter, the build's
// manifest detection, and the publish rules. Each was found by running `wake` and then the next verb a guide tells a
// reader to run, which is the only order a new user ever meets them in.
import { describe, it, expect } from 'vitest'
import { format } from '@term/make/code/format/format'
import { BOOT_TREE, DECK_TREE } from '../../call/code/wake-text'
import { manifestName } from '../../call/code/manifest-name'
import { manifestSpellings, parseManifest, validateManifest, writeManifest } from '../code/manifest'
import { bumpCode, showCode } from '../code/code'

describe('the `term wake` scaffold', () => {
  it('writes every .tree in the formatter\'s canonical layout', () => {
    const deck = DECK_TREE('hello')

    expect(format({ file: 'deck.tree', text: deck })).toBe(deck)
    expect(format({ file: 'code/boot.tree', text: BOOT_TREE })).toBe(BOOT_TREE)
  })

  it('keeps a manifest stacked, the way writeManifest writes it', () => {
    const written = writeManifest({ manifest: parseManifest({ text: DECK_TREE('hello') }) })

    expect(format({ file: 'deck.tree', text: written })).toBe(written)
    // a member line has one leaf child and stays on one line
    expect(format({ file: 'deck.tree', text: 'deck @a/b\n  mark <1.0.0>\n  deck ./deck/load\n' })).toBe(
      'deck @a/b\n  mark <1.0.0>\n  deck ./deck/load\n',
    )
  })

  it('keeps the user\'s name unscoped, and the build reads it as the manifest', () => {
    const manifest = parseManifest({ text: DECK_TREE('hello') })

    expect(manifest.host).toBe('')
    expect(manifest.name).toBe('hello')
    expect(manifestName(DECK_TREE('hello'), 'deck.tree')).toBe('hello')
  })

  it('starts at 0.0.1, which `term host` accepts, and bumps by one', async () => {
    const manifest = parseManifest({ text: DECK_TREE('hello') })

    expect(showCode(manifest.mark)).toBe('0.0.1')
    expect(await validateManifest({ manifest })).toEqual([])
    expect(showCode(bumpCode({ code: manifest.mark, level: 3 }))).toBe('0.0.2')
  })

  it('says `mark <0.0.1>` and leaves the default code root unwritten', () => {
    const deck = DECK_TREE('hello')

    expect(deck).toContain('  mark <0.0.1>\n')
    expect(deck).not.toMatch(/^\s+(code|bear) /m)
    expect(parseManifest({ text: deck }).code).toBeUndefined()
    expect(manifestSpellings({ text: deck })).toEqual([])
  })
})

describe('manifestName', () => {
  it('reads a scoped and an unscoped `deck` statement', () => {
    expect(manifestName('deck @term/call\n  mark <0.0.16>\n', 'deck.tree')).toBe('@term/call')
    expect(manifestName('deck hello\n  mark <0.0.2>\n', 'deck.tree')).toBe('hello')
  })

  it('names the package, never a nested member', () => {
    expect(manifestName('deck @a/b\n  deck ./deck/load\n  mark <1.0.0>\n', 'deck.tree')).toBe('@a/b')
  })

  it('is undefined for a code module that only shares the file name', () => {
    expect(manifestName('form deck\n  link name, like text\n', 'deck.tree')).toBeUndefined()
  })
})
