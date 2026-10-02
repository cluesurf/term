import { describe, it, expect } from 'vitest'
import { toRegistryName, toTreeName, parseScope, resolveRegistry, rootScope } from '../code/name'

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

  it('parses a nested space path as the scope', () => {
    expect(parseScope({ name: '@cluesurf/@wordsurf/@alice/x' })).toEqual({
      scope: '@cluesurf/@wordsurf/@alice',
      base: 'x',
    })
    expect(parseScope({ name: '@cluesurf/@wordsurf/language~tune' })).toEqual({
      scope: '@cluesurf/@wordsurf',
      base: 'language~tune',
    })
    expect(parseScope({ name: '@cluesurf' })).toEqual({ scope: '@cluesurf', base: '' })
  })
})

describe('resolveRegistry', () => {
  it('routes a nested scope by its root space', () => {
    expect(rootScope('@cluesurf/@wordsurf')).toBe('@cluesurf')
    expect(rootScope('@cluesurf')).toBe('@cluesurf')
    const scopeRegistries = { '@term': 'https://tool.base.surf', '@term/@lab': 'https://lab.example' }
    expect(resolveRegistry({ name: '@term/@wordsurf/x', registry: 'npm', scopeRegistries })).toBe('https://tool.base.surf')
    expect(resolveRegistry({ name: '@term/@lab/x', registry: 'npm', scopeRegistries })).toBe('https://lab.example')
    // a scope nobody names comes from ghcr.io/<scope>, and an unscoped name from the fallback registry
    expect(resolveRegistry({ name: '@other/x', registry: 'npm', scopeRegistries })).toBe('oci://ghcr.io/other')
    expect(resolveRegistry({ name: 'left-pad', registry: 'npm', scopeRegistries })).toBe('npm')
    // a base line writes a bare host and path, which is an OCI registry
    expect(resolveRegistry({ name: '@alice/x', registry: 'npm', scopeRegistries: { '@alice': 'ghcr.io/alice-gh/term' } })).toBe(
      'oci://ghcr.io/alice-gh/term',
    )
  })
})
