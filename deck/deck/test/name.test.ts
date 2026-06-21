import { describe, it, expect } from 'vitest'
import { toRegistryName, toTreeName, parseScope } from '../code/name'

describe('toRegistryName', () => {
  it('adds .tree suffix', () => {
    expect(toRegistryName({ name: '@cluesurf/deck' })).toBe(
      '@cluesurf/deck.tree',
    )
  })

  it('does not double-suffix', () => {
    expect(toRegistryName({ name: '@cluesurf/deck.tree' })).toBe(
      '@cluesurf/deck.tree',
    )
  })
})

describe('toTreeName', () => {
  it('removes .tree suffix', () => {
    expect(toTreeName({ name: '@cluesurf/deck.tree' })).toBe(
      '@cluesurf/deck',
    )
  })

  it('does not modify name without suffix', () => {
    expect(toTreeName({ name: '@cluesurf/deck' })).toBe(
      '@cluesurf/deck',
    )
  })
})

describe('parseScope', () => {
  it('parses scoped name', () => {
    expect(parseScope({ name: '@cluesurf/deck' })).toEqual({
      scope: '@cluesurf',
      base: 'deck',
    })
  })

  it('parses unscoped name', () => {
    expect(parseScope({ name: 'deck' })).toEqual({
      scope: '',
      base: 'deck',
    })
  })
})
