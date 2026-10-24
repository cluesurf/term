// A locked deck's own links are RANGES, and a second `term load` keeps what the first one locked. On a lock hit the
// resolver read a declared `0.1.x` as exactly `0.1.0`: the transitive deck locked at `0.1.3` no longer matched its own
// entry, the registry was asked for `0.1.0`, and the lock was rewritten to it with no message. A band range,
// `1.2.0..2.0.0`, did not parse at all. And the graph is resolved in declared order, never in the order the
// registries answer (code/resolve.ts `resolveLinks`). A fake registry, its answers delayed at will, so nothing is
// fetched.
import { beforeEach, describe, expect, it } from 'vitest'

type Published = Record<string, Record<string, Record<string, string>>>

// each deck's versions and, per version, its links; and how long each deck's metadata takes to arrive
const registry: { published: Published; delay: Record<string, number> } = { published: {}, delay: {} }

// The registry answers at the URL the resolution port asks: registry-fetching.tree, which the port loads
// (term-cli-in-term-0233, where it docked the face package/fetch.ts this file used to mock), reads the host's global
// fetch at every call. A deck's metadata arrives after its delay; one not published is a 404 whose status text names it
const realFetch = globalThis.fetch

globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const at = String(url)
  const found = /^https:\/\/registry\.fake\/+(.+)$/.exec(at)

  if (!found) {
    return realFetch(url, init)
  }

  const name = found[1]!

  await new Promise(done => setTimeout(done, registry.delay[name] ?? 0))

  const versions = registry.published[name]

  if (!versions) {
    return new Response('', { status: 404, statusText: `${name} is not published` })
  }

  const meta = {
    name,
    versions: Object.fromEntries(
      Object.entries(versions).map(([version, dependencies]) => [
        version,
        { name, version, dependencies, dist: { tarball: `https://fake/${name}/${version}`, integrity: `sha-${version}`, shasum: '' } },
      ]),
    ),
  }

  return new Response(JSON.stringify(meta), { status: 200 })
}) as typeof fetch

const { resolve, buildLockfile } = await import('../code/package/resolve')
const { makeDefaultFetchConfig } = await import('../code/package/fetch')

// a plain registry for the test's scopes, which the mock above answers: an unmapped scope is an OCI registry's
const config = () => ({
  ...makeDefaultFetchConfig(),
  scopeRegistries: { '@a': 'https://registry.fake/', '@x': 'https://registry.fake/' },
})
const { parseCode, parseCodeHold, showCode } = await import('../code/code')

const project = (links: [string, string][]) =>
  ({ name: '@probe/app', mark: parseCode('0.0.1'), link: links.map(([name, hold]) => ({ name, mark: parseCodeHold(hold) })) }) as never

const versionOf = (resolution: { decks: Map<string, { name: string; code: never }> }, name: string): string | undefined => {
  const deck = [...resolution.decks.values()].find(one => one.name === name)

  return deck ? showCode(deck.code) : undefined
}

// The resolution port keeps registry-fetching.tree's metadata cache (5 minutes) in its own copy, which no TypeScript
// caller can reach to clear, so each test reads the clock 10 minutes later than the one before it and never reads
// another test's registry
const NOW = Date.now.bind(Date)
let shift = 0

beforeEach(() => {
  registry.published = {}
  registry.delay = {}
  shift += 600_000
  Date.now = () => NOW() + shift
})

describe('a second load over a lockfile', () => {
  it('keeps a transitive deck where the first load locked it, under a wild range', async () => {
    registry.published = {
      '@a/top': { '1.0.0': { '@a/leaf': '0.1.x' } },
      '@a/leaf': { '0.1.0': {}, '0.1.3': {} },
    }

    const manifest = project([['@a/top', '1.x.x']])
    const first = await resolve({ manifest, config: config() })

    expect(versionOf(first, '@a/leaf')).toBe('0.1.3')

    // newer versions are published, and the lock still decides
    registry.published['@a/leaf']!['0.1.4'] = {}

    const lockfile = buildLockfile({ resolution: first })
    const second = await resolve({ manifest, config: config(), lockfile })

    expect(versionOf(second, '@a/leaf')).toBe('0.1.3')
    expect(buildLockfile({ resolution: second })).toEqual(lockfile)
  })

  it('keeps one under a band range, which used to throw', async () => {
    registry.published = {
      '@a/top': { '1.0.0': { '@a/leaf': '1.2.0..2.0.0' } },
      '@a/leaf': { '1.2.0': {}, '1.5.0': {} },
    }

    const manifest = project([['@a/top', '1.x.x']])
    const first = await resolve({ manifest, config: config() })

    expect(versionOf(first, '@a/leaf')).toBe('1.5.0')

    registry.published['@a/leaf']!['1.9.0'] = {}

    const second = await resolve({ manifest, config: config(), lockfile: buildLockfile({ resolution: first }) })

    expect(versionOf(second, '@a/leaf')).toBe('1.5.0')
  })

  it('reads a workspace link written as * before links carried their ranges', async () => {
    registry.published = { '@a/top': { '1.0.0': {} }, '@a/leaf': { '0.1.3': {}, '0.2.0': {} } }

    const lockfile = {
      version: 1 as const,
      decks: [
        { name: '@a/top', code: parseCode('1.0.0'), hash: 'h', site: 's', link: [{ name: '@a/leaf', code: '*' }] },
        { name: '@a/leaf', code: parseCode('0.1.3'), hash: 'h', site: 's', link: [] },
      ],
    }
    const resolution = await resolve({ manifest: project([['@a/top', '1.x.x']]), config: config(), lockfile })

    expect(versionOf(resolution, '@a/leaf')).toBe('0.1.3')
  })
})

describe('the order of resolution', () => {
  // `@x/strict` wants the leaf at exactly 0.1.0, `@x/loose` takes any 0.1. The first link to the leaf picks it, and
  // the other is held to the pick: strict first is 0.1.0 and both are content, loose first is 0.1.3 and strict refuses.
  // Declared order says strict, however slowly its registry answers
  const published: Published = {
    '@x/strict': { '1.0.0': { '@x/leaf': '0.1.0' } },
    '@x/loose': { '1.0.0': { '@x/leaf': '0.1.x' } },
    '@x/leaf': { '0.1.0': {}, '0.1.3': {} },
  }
  const manifest = () => project([['@x/strict', '1.x.x'], ['@x/loose', '1.x.x']])

  for (const [slow, fast] of [['@x/strict', '@x/loose'], ['@x/loose', '@x/strict']]) {
    it(`is the declared order when ${slow} answers last`, async () => {
      registry.published = structuredClone(published)
      registry.delay = { [slow!]: 40, [fast!]: 0 }

      const resolution = await resolve({ manifest: manifest(), config: config() })

      expect(versionOf(resolution, '@x/leaf')).toBe('0.1.0')
    })
  }

  it('reports the first failure in declared order, not the first to arrive', async () => {
    registry.published = { '@x/late': { '1.0.0': {} }, '@x/early': { '1.0.0': {} } }
    registry.delay = { '@x/missing-a': 40 }

    await expect(
      resolve({ manifest: project([['@x/missing-a', '1.x.x'], ['@x/missing-b', '1.x.x']]), config: config() }),
    ).rejects.toThrow(/@x\/missing-a is not published/)
  })
})
