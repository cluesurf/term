import { describe, it, expect } from 'vitest'
import {
  parseAddress, printAddress, printSpacePath,
  parseName, printName, resolveHandle,
  slugFault, DEPTH_MAX,
} from '@cluesurf/save/base/address'

// Every accepted form, and what it parses to. Printing the parse gives back the path.
const ROUND_TRIPS: Array<[string, Record<string, unknown>]> = [
  ['/@cluesurf', { spaces: ['cluesurf'] }],
  ['/@cluesurf/@wordsurf/@alice', { spaces: ['cluesurf', 'wordsurf', 'alice'] }],
  ['/@cluesurf/repositories/surf', { spaces: ['cluesurf'], repository: 'surf' }],
  [
    '/@cluesurf/@wordsurf/@alice/repositories/x',
    { spaces: ['cluesurf', 'wordsurf', 'alice'], repository: 'x' },
  ],
  [
    '/@cluesurf/@wordsurf/resources/language/repositories/tune',
    { spaces: ['cluesurf', 'wordsurf'], resource: 'language', repository: 'tune' },
  ],
  [
    '/@cluesurf/resources/glyph-set/repositories/x@1.2.0',
    { spaces: ['cluesurf'], resource: 'glyph-set', repository: 'x', version: '1.2.0' },
  ],
  [
    '/@cluesurf/repositories/x/records/kvmtnhbs-rzdxfwlc-mnbdtkhs-fvzxcwlr',
    { spaces: ['cluesurf'], repository: 'x', mark: 'kvmtnhbs-rzdxfwlc-mnbdtkhs-fvzxcwlr' },
  ],
  [
    '/@cluesurf/repositories/x/branches/main/head',
    { spaces: ['cluesurf'], repository: 'x', rest: ['branches', 'main', 'head'] },
  ],
  [
    '/@cluesurf/repositories/x@2.0.0-rc.1/records/m/history',
    { spaces: ['cluesurf'], repository: 'x', version: '2.0.0-rc.1', mark: 'm', rest: ['history'] },
  ],
  [
    '/@cluesurf/@wordsurf/members/mutate!',
    { spaces: ['cluesurf', 'wordsurf'], rest: ['members', 'mutate!'] },
  ],
  [
    '/@cluesurf/spaces/create!',
    { spaces: ['cluesurf'], rest: ['spaces', 'create!'] },
  ],
  [
    '/@cluesurf/repositories',
    { spaces: ['cluesurf'], rest: ['repositories'] },
  ],
  [
    '/@cluesurf/resources/language/repositories/create!',
    { spaces: ['cluesurf'], resource: 'language', rest: ['repositories', 'create!'] },
  ],
]

describe('parseAddress', () => {
  for (const [path, want] of ROUND_TRIPS) {
    it(`round-trips ${path}`, () => {
      const got = parseAddress(path)
      expect(got.ok).toBe(true)
      if (!got.ok) return
      expect(got.value).toMatchObject(want)
      expect(printAddress(got.value)).toBe(path)
    })
  }

  it('tolerates a trailing slash and a missing leading one', () => {
    const a = parseAddress('@cluesurf/repositories/x/')
    expect(a.ok && printAddress(a.value)).toBe('/@cluesurf/repositories/x')
  })

  it('refuses a path that does not start with a space', () => {
    expect(parseAddress('/repositories/x')).toMatchObject({ ok: false, fault: 'bad-address' })
    expect(parseAddress('/cluesurf/repositories/x')).toMatchObject({ ok: false })
    expect(parseAddress('/')).toMatchObject({ ok: false })
  })

  it('refuses a bad slug in any position', () => {
    expect(parseAddress('/@Clue')).toMatchObject({ ok: false })
    expect(parseAddress('/@-clue')).toMatchObject({ ok: false })
    expect(parseAddress('/@clue/repositories/X')).toMatchObject({ ok: false })
    expect(parseAddress('/@clue/resources/Glyph/repositories/x')).toMatchObject({ ok: false })
    expect(parseAddress(`/@${'a'.repeat(64)}`)).toMatchObject({ ok: false })
  })

  it('refuses a chain deeper than the cap', () => {
    const ok = Array.from({ length: DEPTH_MAX }, (_, i) => `@s${i}`).join('/')
    expect(parseAddress(`/${ok}`).ok).toBe(true)
    expect(parseAddress(`/${ok}/@one-more`)).toMatchObject({ ok: false })
  })

  it('refuses a host word out of place and an @ in a repository slug', () => {
    expect(parseAddress('/@clue/resources/language')).toMatchObject({ ok: false })
    expect(parseAddress('/@clue/resources/language/x')).toMatchObject({ ok: false })
    expect(parseAddress('/@clue/repositories/@x')).toMatchObject({ ok: false })
    expect(parseAddress('/@clue/repositories/a--b')).toMatchObject({ ok: false })
    expect(parseAddress('/@clue/repositories/x@banana')).toMatchObject({ ok: false })
    expect(parseAddress('/@clue/repositories/x/records')).toMatchObject({ ok: false })
  })

  it('lets a repository be named after a host word, since it sits after repositories/', () => {
    const a = parseAddress('/@clue/repositories/resources')
    expect(a.ok && a.value.repository).toBe('resources')
  })

  it('prints a space chain', () => {
    expect(printSpacePath(['cluesurf', 'wordsurf'])).toBe('/@cluesurf/@wordsurf')
  })
})

describe('parseName', () => {
  const NAMES: Array<[string, Record<string, unknown>]> = [
    ['@term/base', { spaces: ['term'], repository: 'base' }],
    ['@cluesurf/@wordsurf/@alice/x', { spaces: ['cluesurf', 'wordsurf', 'alice'], repository: 'x' }],
    ['@cluesurf/@wordsurf/language~tune', { spaces: ['cluesurf', 'wordsurf'], resource: 'language', repository: 'tune' }],
    ['@cluesurf/x@1.2.0', { spaces: ['cluesurf'], repository: 'x', version: '1.2.0' }],
    ['@cluesurf/language~tune@0.1.0', { spaces: ['cluesurf'], resource: 'language', repository: 'tune', version: '0.1.0' }],
  ]

  for (const [name, want] of NAMES) {
    it(`round-trips ${name}`, () => {
      const got = parseName(name)
      expect(got.ok).toBe(true)
      if (!got.ok) return
      expect(got.value).toMatchObject(want)
      expect(printName(got.value)).toBe(name)
    })
  }

  it('is the same address as the host path', () => {
    const name = parseName('@cluesurf/@wordsurf/language~tune@1.0.0')
    const path = parseAddress('/@cluesurf/@wordsurf/resources/language/repositories/tune@1.0.0')
    expect(name.ok && path.ok && name.value).toEqual(path.ok && path.value)
  })

  it('refuses an unscoped name, a name ending in a space, and a bad key', () => {
    expect(parseName('base')).toMatchObject({ ok: false })
    expect(parseName('@cluesurf')).toMatchObject({ ok: false })
    expect(parseName('@cluesurf/@wordsurf')).toMatchObject({ ok: false })
    expect(parseName('@cluesurf/Language~x')).toMatchObject({ ok: false })
    expect(parseName('@cluesurf/x@nope')).toMatchObject({ ok: false })
  })
})

describe('resolveHandle', () => {
  const mount = ['cluesurf', 'wordsurf']
  const children = ['alice', 'bob']

  it('finds a child first', () => {
    expect(resolveHandle({ mount, children, handle: 'alice' })).toEqual(['cluesurf', 'wordsurf', 'alice'])
  })

  it('then an ancestor', () => {
    expect(resolveHandle({ mount, children, handle: 'cluesurf' })).toEqual(['cluesurf'])
    expect(resolveHandle({ mount, children, handle: 'wordsurf' })).toEqual(['cluesurf', 'wordsurf'])
  })

  it('and nothing else', () => {
    expect(resolveHandle({ mount, children, handle: 'carol' })).toBeUndefined()
  })
})

describe('slugFault', () => {
  it('names the reason', () => {
    expect(slugFault('ok-slug')).toBeUndefined()
    expect(slugFault('')).toBe('empty')
    expect(slugFault('a'.repeat(64))).toContain('63')
    expect(slugFault('A')).toContain('lowercase')
  })
})
