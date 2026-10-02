// `term load` end to end over OCI: a project whose deck.tree routes a third-party scope to its own registry with a
// `host` group, installed through `install()` exactly as the CLI runs it, then again offline from the store alone.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

import { install, hostScopeRegistries } from '../code/install'
import { loadLockfile } from '../code/lock'
import { parseManifest } from '../code/manifest'
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
      keysRepository: 'alice',
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
    const root = path.join(work, 'app')
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(
      path.join(root, 'deck.tree'),
      `deck @alice/app\n  code <1.0.0>\n  host <oci://${server.host}/alice>\n    link @alice/demo, code <1.0.x>\n`,
    )

    return root
  }

  it('routes a host group, installs, and pins the digest and the key in lock.tree', async () => {
    const root = await project()

    await install({ root })

    const installed = path.join(root, 'link', '@alice', 'demo', 'code', 'demo.ts')
    expect(await fs.readFile(installed, 'utf8')).toBe('export const demo = 1\n')

    const lock = await loadLockfile({ dir: root })
    const entry = lock!.decks.find(deck => deck.name === '@alice/demo')!

    expect(entry.site).toBe(`oci://${server.host}/alice/demo@${entry.hash}`)
    expect(entry.key).toMatch(/^[A-Za-z0-9+/]+=*$/)
  })

  it('installs again offline, from the store alone', async () => {
    const root = await project()
    await fs.rm(path.join(root, 'link'), { recursive: true, force: true })
    const before = server.requests.length

    await install({ root, offline: true })

    expect(await fs.readFile(path.join(root, 'link', '@alice', 'demo', 'code', 'demo.ts'), 'utf8')).toBe('export const demo = 1\n')
    expect(server.requests.length).toBe(before)
  })

  it('refuses one scope routed to two registries', () => {
    const manifest = parseManifest({
      text: 'deck @me/app\n  code <1.0.0>\n  host <oci://a.example/x>\n    link @alice/one, code <1.0.x>\n  host <oci://b.example/y>\n    link @alice/two, code <1.0.x>\n',
    })

    expect(() => hostScopeRegistries({ manifest })).toThrow(/two registries/)
  })
})
