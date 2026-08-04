import { describe, it, expect } from 'vitest'
import { buildLockfile } from '../code/resolve'

describe('buildLockfile', () => {
  it('converts resolution map to lockfile', () => {
    const resolution = {
      decks: new Map([
        [
          '@cluesurf/seed@1.2.3',
          {
            name: '@cluesurf/seed',
            code: { major: 1, minor: 2, patch: 3 },
            hash: 'sha512-abc',
            site: 'https://registry.npmjs.org/@cluesurf/seed.tree/-/seed.tree-1.2.3.tgz',
            link: new Map([['@cluesurf/base', '1.0.0']]),
          },
        ],
        [
          '@cluesurf/base@1.0.0',
          {
            name: '@cluesurf/base',
            code: { major: 1, minor: 0, patch: 0 },
            hash: 'sha512-def',
            site: 'https://registry.npmjs.org/@cluesurf/base.tree/-/base.tree-1.0.0.tgz',
            link: new Map(),
          },
        ],
      ]),
    }

    const lockfile = buildLockfile({ resolution })

    expect(lockfile.version).toBe(1)
    expect(lockfile.decks).toHaveLength(2)

    const seed = lockfile.decks.find(d => d.name === '@cluesurf/seed')
    expect(seed).toBeDefined()
    expect(seed!.code).toEqual({ major: 1, minor: 2, patch: 3 })
    expect(seed!.link).toEqual([
      { name: '@cluesurf/base', code: '1.0.0' },
    ])

    const base = lockfile.decks.find(d => d.name === '@cluesurf/base')
    expect(base).toBeDefined()
    expect(base!.link).toEqual([])
  })
})
