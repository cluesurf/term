// `term load` end to end over OCI: a project whose deck.tree routes a third-party scope to its own registry with a
// `host` group, installed through `install()` exactly as the CLI runs it, then again offline from the store alone.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

import { install, hostScopeRegistries } from '../code/install'
import { loadLockfile } from '../code/lock'
import { parseManifest, writeManifest } from '../code/manifest'
import { ociRouteOf } from '../code/oci/client'
import { generateKeypair } from '../code/object/sign'
import { layoutObjectStore } from '../code/oci/layout'
import { publishToOci } from '../code/oci/publish'
import { httpTransport } from '../code/oci/transport'
import { startOciServer, type OciServer } from './oci-server'

describe('term load over OCI', () => {
  let server: OciServer
  let work: string
  const saved = { store: process.env['TERM_STORE'], trust: process.env['TERM_TRUST_DIR'] }

  beforeAll(async () => {
    server = await startOciServer()
    work = await fs.mkdtemp(path.join(os.tmpdir(), 'term-oci-load-'))
    process.env['TERM_STORE'] = path.join(work, 'store')
    process.env['TERM_TRUST_DIR'] = path.join(work, 'trust')

    const source = path.join(work, 'demo')
    await fs.mkdir(path.join(source, 'code'), { recursive: true })
    await fs.writeFile(path.join(source, 'code', 'demo.ts'), 'export const demo = 1\n')

    await publishToOci({
      dir: source,
      package: '@alice/demo',
      version: '1.0.2',
      target: { kind: 'version', version: '1.0.2' },
      link: [],
      transport: httpTransport({
        host: server.host,
        credentials: async () => ({ kind: 'basic', username: 'tester', password: 'secret' }),
        retries: 0,
      }),
      repository: { host: server.host, namespace: 'alice', name: 'alice/demo' },
      scope: '@alice',
      keysRepository: 'alice/keys',
      local: layoutObjectStore({ dir: path.join(work, 'publisher') }),
      keypair: generateKeypair(),
      author: 'alice',
      time: '2026-01-01T00:00:00.000Z',
    })
  })

  afterAll(async () => {
    process.env['TERM_STORE'] = saved.store
    process.env['TERM_TRUST_DIR'] = saved.trust

    if (saved.store === undefined) {
      delete process.env['TERM_STORE']
    }

    if (saved.trust === undefined) {
      delete process.env['TERM_TRUST_DIR']
    }

    await server.close()
  })

  const project = async (): Promise<string> => {
    const dir = path.join(work, 'app')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'deck.tree'),
      `deck @alice/app\n  code <1.0.0>\n  base alice, <${server.host}/alice>\n  link @alice/demo, code <1.0.x>\n`,
    )

    return dir
  }

  it('routes a base line, installs, and pins the digest and the key in lock.tree', async () => {
    const dir = await project()

    await install({ root: dir })

    const installed = path.join(dir, 'link', '@alice', 'demo', 'code', 'demo.ts')
    expect(await fs.readFile(installed, 'utf8')).toBe('export const demo = 1\n')

    const lock = await loadLockfile({ dir: dir })
    const entry = lock!.decks.find(deck => deck.name === '@alice/demo')!

    expect(entry.site).toBe(`oci://${server.host}/alice/demo@${entry.hash}`)
    expect(entry.key).toMatch(/^[A-Za-z0-9+/]+=*$/)
  })

  it('installs again offline, from the store alone', async () => {
    const dir = await project()
    await fs.rm(path.join(dir, 'link'), { recursive: true, force: true })
    const before = server.requests.length

    await install({ root: dir, offline: true })

    expect(await fs.readFile(path.join(dir, 'link', '@alice', 'demo', 'code', 'demo.ts'), 'utf8')).toBe('export const demo = 1\n')
    expect(server.requests.length).toBe(before)
  })

  it('reads, routes and writes back a base line, and defaults a scope without one to ghcr.io', () => {
    const text = 'deck @term/foo\n  code <1.0.0>\n  base alice, <ghcr.io/alice-gh/term>\n  base @bob, <ghcr.io/bobs-place/something>\n  link @alice/foo, code <1.0.x>\n  link @bob/foo, code <1.0.x>\n  link @carol/foo, code <1.0.x>\n'
    const manifest = parseManifest({ text })

    expect(manifest.base).toEqual([
      { scope: '@alice', registry: 'ghcr.io/alice-gh/term' },
      { scope: '@bob', registry: 'ghcr.io/bobs-place/something' },
    ])
    expect(parseManifest({ text: writeManifest({ manifest }) }).base).toEqual(manifest.base)

    const config = { registry: 'https://registry.npmjs.org', scopeRegistries: hostScopeRegistries({ manifest }) }

    expect(ociRouteOf({ name: '@alice/foo', config })!.repository.name).toBe('alice-gh/term/foo')
    expect(ociRouteOf({ name: '@bob/foo', config })!.repository.name).toBe('bobs-place/something/foo')
    expect(ociRouteOf({ name: '@carol/foo', config })).toMatchObject({
      registry: { host: 'ghcr.io', namespace: 'carol' },
      repository: { name: 'carol/foo' },
      keysRepository: 'carol/keys',
    })
    expect(ociRouteOf({ name: 'left-pad', config })).toBeUndefined()
    expect(() => ociRouteOf({ name: '@carol/keys', config })).toThrow(/reserved/)
  })

  it('refuses one scope routed to two registries', () => {
    const manifest = parseManifest({
      text: 'deck @me/app\n  code <1.0.0>\n  host <oci://a.example/x>\n    link @alice/one, code <1.0.x>\n  host <oci://b.example/y>\n    link @alice/two, code <1.0.x>\n',
    })

    expect(() => hostScopeRegistries({ manifest })).toThrow(/two registries/)
  })
})
