import { describe, it, expect } from 'vitest'
import { parseLockfile, writeLockfile } from '../code/lock'

describe('parseLockfile', () => {
  it('parses a lockfile', () => {
    const text = `
lock <1>

deck @cluesurf/seed
  mark <1.2.3>
  hash <sha512-a1b2c3>
  site <https://registry.npmjs.org/@cluesurf/seed.tree/-/seed.tree-1.2.3.tgz>
  link @cluesurf/seed, mark <1.0.0>

deck @cluesurf/seed
  mark <1.0.0>
  hash <sha512-f7e8d9>
  site <https://registry.npmjs.org/@cluesurf/base.tree/-/base.tree-1.0.0.tgz>
`
    const lockfile = parseLockfile({ text })

    expect(lockfile.version).toBe(1)
    expect(lockfile.decks).toHaveLength(2)

    expect(lockfile.decks[0]!.name).toBe('@cluesurf/seed')
    expect(lockfile.decks[0]!.mark).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
    })
    expect(lockfile.decks[0]!.hash).toBe('sha512-a1b2c3')
    expect(lockfile.decks[0]!.link).toHaveLength(1)
    expect(lockfile.decks[0]!.link[0]!.name).toBe('@cluesurf/seed')
    expect(lockfile.decks[0]!.link[0]!.mark).toBe('1.0.0')

    expect(lockfile.decks[1]!.name).toBe('@cluesurf/seed')
  })
})

describe('writeLockfile', () => {
  it('writes and re-parses consistently', () => {
    const lockfile = {
      version: 1,
      decks: [
        {
          name: '@cluesurf/seed',
          mark: { major: 1, minor: 0, patch: 0 },
          hash: 'sha512-abc123',
          site: 'https://registry.npmjs.org/@cluesurf/base.tree/-/base.tree-1.0.0.tgz',
          link: [],
        },
        {
          name: '@cluesurf/seed',
          mark: { major: 1, minor: 2, patch: 3 },
          hash: 'sha512-def456',
          site: 'https://registry.npmjs.org/@cluesurf/seed.tree/-/seed.tree-1.2.3.tgz',
          link: [{ name: '@cluesurf/seed', mark: '1.0.0' }],
        },
      ],
    }

    const text = writeLockfile({ lockfile })
    const reparsed = parseLockfile({ text })

    expect(reparsed.version).toBe(1)
    expect(reparsed.decks).toHaveLength(2)
    // sorted by name
    expect(reparsed.decks[0]!.name).toBe('@cluesurf/seed')
    expect(reparsed.decks[1]!.name).toBe('@cluesurf/seed')
  })
})
