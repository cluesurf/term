import { describe, it, expect } from 'vitest'
import { form, property, roleBase } from '@term/base/code/form/form'
import { matchesGlob } from '@term/base/code/file/glob'
import { filePolicy, diffFile, mergeFile } from '@term/base/code/file/policy'

// A .tree site (like a sibling `.tree` site) compiled to build output: the source
// is diffed finely, the generated build/ files and js/css bundles are opaque.
const role = roleBase([form('word', [property('term', { base: 'text' })])], {
  files: {
    opaque: ['build/**', '**/*.js', '**/*.css'],
    diff: [{ match: '**/*.md', granularity: 'word' }],
  },
})

describe('glob matching', () => {
  it('matches directory trees and extensions', () => {
    expect(matchesGlob('build/**', 'build/index.html')).toBe(true)
    expect(matchesGlob('build/**', 'build/assets/app.css')).toBe(true)
    expect(matchesGlob('build/**', 'src/index.tree')).toBe(false)
    expect(matchesGlob('**/*.js', 'app.js')).toBe(true)
    expect(matchesGlob('**/*.js', 'site/home2/app.js')).toBe(true)
    expect(matchesGlob('**/*.js', 'app.tree')).toBe(false)
  })
})

describe('file diff policy', () => {
  it('treats generated build files and bundles as opaque', () => {
    const policy = filePolicy(role)
    expect(policy.isOpaque('build/index.html')).toBe(true)
    expect(policy.isOpaque('site/clue.surf/home2/build/app.js')).toBe(true)
    expect(policy.isOpaque('styles/main.css')).toBe(true)
    // source files are diffed
    expect(policy.isOpaque('site/clue.surf/home2/page.tree')).toBe(false)
    expect(policy.isOpaque('readme.md')).toBe(false)
  })

  it('picks granularity per pattern, defaulting to line', () => {
    const policy = filePolicy(role)
    expect(policy.granularityFor('readme.md')).toBe('word')
    expect(policy.granularityFor('page.tree')).toBe('line')
  })

  it('produces no diff for opaque files, fine diffs for source', () => {
    const policy = filePolicy(role)
    // opaque: no text diff, just "it changed"
    expect(diffFile(policy, 'build/app.js', 'var a=1', 'var a=2')).toBeUndefined()
    // source: word-level diff for markdown
    const hunks = diffFile(policy, 'readme.md', 'the quick fox', 'the slow fox')!
    expect(hunks).toBeDefined()
    expect(hunks.some(h => h.tag === 'del' && h.text.includes('quick'))).toBe(true)
  })
})

describe('file merge policy', () => {
  it('merges source files finely but resolves opaque files whole', () => {
    const policy = filePolicy(role)
    // source markdown: disjoint word edits merge cleanly
    const src = mergeFile(policy, 'notes.md', 'the quick brown fox', 'the slow brown fox', 'the quick brown wolf')
    expect(src.clean).toBe(true)
    expect(src.text).toBe('the slow brown wolf')

    // opaque bundle: a one-sided change is taken whole
    const oneSide = mergeFile(policy, 'build/app.js', 'BASE', 'BASE', 'REBUILT')
    expect(oneSide.clean).toBe(true)
    expect(oneSide.text).toBe('REBUILT')

    // opaque bundle: divergent rebuilds conflict as a whole, not line by line
    const both = mergeFile(policy, 'build/app.js', 'BASE', 'BUILD_A', 'BUILD_B')
    expect(both.clean).toBe(false)
    expect(both.conflicts).toBe(1)
  })
})
