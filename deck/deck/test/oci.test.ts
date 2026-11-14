// The OCI registry path, end to end against an in-process registry (./oci-server.ts) and an on-disk layout.
// Each test names the attack or failure it holds the client to. OCI artifact format v2 (item term-self-host-001-1043,
// decision 129 section 2, decisions 154 and 158): one gzip ustar archive layer signed in the config, versions only, no
// object store, packs, files layer or signature referrer, and an installed folder that carries the `.term-digest`
// marker, left out when a tree is compared.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

import { generateKeypair, signId } from '../code/object/sign'
import * as versionFiles from '@term/deck/code/oci/version-files'
import { credentialsFor, parseChallenge } from '../code/oci/auth'
import { checkArchiveLayer, deckStatement, parseDeckManifest, type DeckConfig } from '../code/oci/artifact'
import { installOciVersion, listOciVersions, readOciVersion } from '../code/oci/install'
import { keySetStatement, rotateKeys, trustedKeys, KEYS_ARTIFACT_TYPE, KEYS_CONFIG_MEDIA_TYPE } from '../code/oci/keys'
import { layoutTransport } from '../code/oci/layout'
import { publishToOci } from '../code/oci/publish'
import {
  parseOciRegistry,
  parsePinnedReference,
  pinnedReference,
  repositoryOf,
  tagOfVersion,
  versionOfTag,
} from '../code/oci/reference'
import { httpTransport, sha256Digest, type OciTransport } from '../code/oci/transport'
import { parseLockfile, writeLockfile } from '../code/package/lock'
import { startOciServer, type OciServer } from './oci-server'

const walk = versionFiles as unknown as {
  defaultVersionExclude: () => string[]
  readVersionFiles: (dir: string, exclude: string[], include: string[]) => Promise<{ path: string; kind: string }[]>
}

async function scratch(name: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `term-oci-${name}-`))
}

async function writePackage(dir: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [at, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, at)), { recursive: true })
    await fs.writeFile(path.join(dir, at), body)
  }
}

async function readTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}

  const walk = async (at: string): Promise<void> => {
    for (const entry of await fs.readdir(path.join(dir, at), { withFileTypes: true })) {
      const rel = path.join(at, entry.name)

      // the install's marker at the top of a version folder is the installer's, never a file of the package
      if (rel === '.term-digest') {
        continue
      }

      if (entry.isDirectory()) {
        await walk(rel)
      } else {
        out[rel] = (await fs.readFile(path.join(dir, rel))).toString('base64')
      }
    }
  }

  await walk('')

  return out
}

const FILES = {
  'readme.md': '# demo\n',
  'code/one.ts': 'export const one = 1\n',
  'code/two.ts': 'export const two = 2\n',
  'font/glyph.bin': Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 37) % 256)),
  'data/big.txt': 'x'.repeat(70 * 1024),
}

describe('OCI references', () => {
  it('maps Term names to repositories, one to one', () => {
    const registry = parseOciRegistry('oci://ghcr.io/cluesurf/term')

    expect(repositoryOf({ package: '@term/bind', registry }).name).toBe('cluesurf/term/bind')
    expect(repositoryOf({ package: '@cluesurf/@wordsurf/x', registry: parseOciRegistry('oci://ghcr.io/cluesurf/cluesurf') }).name).toBe(
      'cluesurf/cluesurf/wordsurf/x',
    )
    // a bare segment before another one would let two names claim one repository
    expect(() => repositoryOf({ package: '@cluesurf/wordsurf/x', registry })).toThrow()
    expect(() => repositoryOf({ package: '@term/Bind', registry })).toThrow()
    expect(() => parseOciRegistry('oci://user@ghcr.io/x')).toThrow()
  })

  it('round trips versions through tags, and pins through references', () => {
    expect(tagOfVersion('1.2.3+build.4')).toBe('1.2.3_build.4')
    expect(versionOfTag('1.2.3_build.4')).toBe('1.2.3+build.4')
    expect(versionOfTag('keys')).toBeUndefined()
    expect(versionOfTag('branch.main')).toBeUndefined()

    const digest = sha256Digest(Buffer.from('x'))
    const pinned = pinnedReference({ repository: { host: 'ghcr.io', namespace: 'cluesurf/term', name: 'cluesurf/term/bind' }, digest })

    expect(parsePinnedReference(pinned)).toEqual({ repository: { host: 'ghcr.io', namespace: '', name: 'cluesurf/term/bind' }, digest })
  })
})

describe('the signed statement', () => {
  it('is byte for byte what the package index verifies', () => {
    // the server side reader, mesh/deck/back/code/resource/package/oci.test.ts, holds the v1 literal until it moves
    // (log.md, 1043). The archive's fields come out of order: the statement writes digest, size, media type
    expect(
      deckStatement({
        package: '@term/demo',
        version: '1.0.0',
        tag: '1.0.0',
        link: [
          { deck: '@term/z', code: '1.x.x' },
          { deck: '@term/base', code: '0.0.x' },
        ],
        archive: { mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', size: 1234, digest: `sha256:${'a'.repeat(64)}` },
      }),
    ).toBe(
      `{"type":"application/vnd.cluesurf.term.deck.v2","package":"@term/demo","version":"1.0.0","tag":"1.0.0","link":[["@term/base","0.0.x"],["@term/z","1.x.x"]],"archive":{"digest":"sha256:${'a'.repeat(64)}","size":1234,"mediaType":"application/vnd.oci.image.layer.v1.tar+gzip"}}`,
    )
  })
})

describe('OCI credentials', () => {
  it('parses a challenge whose scope holds a comma', () => {
    expect(parseChallenge('Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:a/b:pull,push"')).toEqual({
      scheme: 'bearer',
      realm: 'https://ghcr.io/token',
      service: 'ghcr.io',
      scope: 'repository:a/b:pull,push',
    })
  })

  it('binds an environment token to one host, so it never reaches another registry', async () => {
    const home = await scratch('home')
    const env = { TERM_OCI_TOKEN: 'tok', DOCKER_CONFIG: path.join(home, 'none') }

    expect(await credentialsFor({ host: 'ghcr.io', env })).toEqual({ kind: 'basic', username: 'term', password: 'tok' })
    expect(await credentialsFor({ host: 'evil.example', env })).toBeUndefined()
    expect(await credentialsFor({ host: 'evil.example', env: { GHCR_TOKEN: 'g', DOCKER_CONFIG: env.DOCKER_CONFIG } })).toBeUndefined()
  })

  it('reads the docker config oras login writes', async () => {
    const home = await scratch('docker')
    await fs.writeFile(
      path.join(home, 'config.json'),
      JSON.stringify({ auths: { 'localhost:5000': { auth: Buffer.from('ada:pw').toString('base64') } } }),
    )

    expect(await credentialsFor({ host: 'localhost:5000', env: { DOCKER_CONFIG: home } })).toEqual({ kind: 'basic', username: 'ada', password: 'pw' })
  })
})

describe('OCI transport', () => {
  let server: OciServer
  let transport: OciTransport

  beforeAll(async () => {
    server = await startOciServer({ pageSize: 2 })
    transport = httpTransport({
      host: server.host,
      credentials: async () => ({ kind: 'basic', username: 'tester', password: 'secret' }),
      chunkSize: 1024,
      retries: 0,
    })
  })

  afterAll(() => server.close())

  it('uploads monolithic and chunked, and never forwards the token to blob storage', async () => {
    const small = Buffer.from('small blob')
    const large = Buffer.alloc(5000, 7)

    expect(await transport.putBlob({ repository: 't/a', digest: sha256Digest(small), bytes: small })).toBe('uploaded')
    expect(await transport.putBlob({ repository: 't/a', digest: sha256Digest(large), bytes: large })).toBe('uploaded')
    expect(await transport.putBlob({ repository: 't/a', digest: sha256Digest(small), bytes: small })).toBe('present')
    expect(server.requests.some(request => request.method === 'PATCH')).toBe(true)

    expect(await transport.getBlob({ repository: 't/a', digest: sha256Digest(large), limit: 1 << 20 })).toEqual(large)
    expect(server.leakedAuth).toEqual([])
  })

  // GHCR refuses a PATCH chunk over 4 MiB, and the 17.4 MB windows-x64 payload of @term/code 2.7.4 failed on exactly
  // that while the chunk was 16 MiB. With the defaults a blob up to 16 MiB goes up in one PUT, and a larger one in
  // chunks of 4 MiB, so 17 MB is five
  it('uploads a blob over 16 MiB in chunks of at most 4 MiB, the most GHCR takes', async () => {
    const defaults = httpTransport({ host: server.host, credentials: async () => ({ kind: 'basic', username: 'tester', password: 'secret' }), retries: 0 })
    const payload = Buffer.alloc(17 * 1000 * 1000, 3)
    const before = server.requests.filter(request => request.method === 'PATCH').length

    expect(await defaults.putBlob({ repository: 't/big', digest: sha256Digest(payload), bytes: payload })).toBe('uploaded')
    expect(server.requests.filter(request => request.method === 'PATCH').length - before).toBe(5)
    // compared as bytes: `toEqual` on 17 MB walks it key by key and runs the worker out of memory
    expect((await defaults.getBlob({ repository: 't/big', digest: sha256Digest(payload), limit: 32 << 20 })).equals(payload)).toBe(true)

    const below = Buffer.alloc(15 * 1000 * 1000, 4)
    const patches = server.requests.filter(request => request.method === 'PATCH').length

    expect(await defaults.putBlob({ repository: 't/big', digest: sha256Digest(below), bytes: below })).toBe('uploaded')
    expect(server.requests.filter(request => request.method === 'PATCH').length).toBe(patches)
  })

  it('mounts across repositories without sending bytes', async () => {
    const bytes = Buffer.from('mount me')
    await transport.putBlob({ repository: 't/a', digest: sha256Digest(bytes), bytes })

    expect(await transport.putBlob({ repository: 't/b', digest: sha256Digest(bytes), bytes, mountFrom: 't/a' })).toBe('mounted')
  })

  it('refuses a blob whose bytes do not match, and one over its limit', async () => {
    const bytes = Buffer.from('honest bytes')
    const digest = sha256Digest(bytes)
    await transport.putBlob({ repository: 't/a', digest, bytes })
    server.tamperBlob(digest, Buffer.from('forged bytes'))

    await expect(transport.getBlob({ repository: 't/a', digest, limit: 1 << 20 })).rejects.toThrow(/verification/)
    await expect(transport.getBlob({ repository: 't/a', digest: sha256Digest(Buffer.alloc(5000, 7)), limit: 100 })).rejects.toThrow(/limit/)
  })

  it('refuses an anonymous push, and allows an anonymous pull', async () => {
    const anonymous = httpTransport({ host: server.host, retries: 0 })
    const bytes = Buffer.from('anon')

    await expect(anonymous.putBlob({ repository: 't/a', digest: sha256Digest(bytes), bytes })).rejects.toThrow()
    expect(await anonymous.hasBlob({ repository: 't/a', digest: sha256Digest(Buffer.from('small blob')) })).toBe(true)
  })

  it('reads anonymously when its credential is refused, and never pushes so', async () => {
    // a stale `docker login` for the host: GHCR answers it with 403 where no credential at all would read
    const stale = httpTransport({
      host: server.host,
      credentials: async () => ({ kind: 'basic', username: 'tester', password: 'expired' }),
      retries: 0,
    })
    const bytes = Buffer.from('stale')

    expect(await stale.hasBlob({ repository: 't/a', digest: sha256Digest(Buffer.from('small blob')) })).toBe(true)
    await expect(stale.putBlob({ repository: 't/a', digest: sha256Digest(bytes), bytes })).rejects.toThrow(/token request .* failed: 401/)
  })

  it('pages the tag list', async () => {
    const config = Buffer.from('{}')
    await transport.putBlob({ repository: 't/tags', digest: sha256Digest(config), bytes: config })
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: sha256Digest(config), size: 2 },
        layers: [],
      }),
    )

    for (const tag of ['1.0.0', '1.0.2', '1.1.0', '2.0.0', 'keys']) {
      await transport.putManifest({ repository: 't/tags', reference: tag, bytes: manifest, mediaType: 'application/vnd.oci.image.manifest.v1+json' })
    }

    expect((await transport.listTags({ repository: 't/tags' })).sort()).toEqual(['1.0.0', '1.0.2', '1.1.0', '2.0.0', 'keys'])
    expect((await listOciVersions({ transport, repository: 't/tags' })).sort()).toEqual(['1.0.0', '1.0.2', '1.1.0', '2.0.0'])
  })
})

describe('OCI publish and install', () => {
  let server: OciServer
  let transport: OciTransport
  let work: string
  const registry = parseOciRegistry('oci://127.0.0.1/term')
  const keypair = generateKeypair()

  const route = () => ({
    repository: repositoryOf({ package: '@term/demo', registry: { ...registry, host: server.host } }),
    scope: '@term',
    keysRepository: 'term',
  })

  const publish = (input: { dir: string; version: string; signer?: typeof keypair }) =>
    publishToOci({
      dir: input.dir,
      package: '@term/demo',
      version: input.version,
      link: [{ deck: '@term/base', code: '1.x.x' }],
      transport,
      ...route(),
      keypair: input.signer ?? keypair,
    })

  const read = (input: { reference: string; trustDir: string; expect?: { digest?: string; key?: string; version?: string } }) =>
    readOciVersion({
      transport,
      repository: route().repository.name,
      package: '@term/demo',
      reference: input.reference,
      scope: '@term',
      keysRepository: 'term',
      host: server.host,
      trustDir: input.trustDir,
      expect: input.expect,
      env: {},
    })

  beforeAll(async () => {
    server = await startOciServer()
    transport = httpTransport({
      host: server.host,
      credentials: async () => ({ kind: 'basic', username: 'tester', password: 'secret' }),
      retries: 0,
    })
    work = await scratch('publish')
  })

  afterAll(() => server.close())

  it('publishes, installs byte for byte under the marker, and a second install fetches nothing', async () => {
    const source = path.join(work, 'v1')
    await writePackage(source, FILES)

    const result = await publish({ dir: source, version: '1.0.0' })

    expect(result.unchanged).toBe(false)
    expect(result.keySet).toBe('created')
    expect(result.layers).toBe(1)
    expect(result.artifact.config.type).toBe('application/vnd.cluesurf.term.deck.v2')

    const version = await read({ reference: '1.0.0', trustDir: path.join(work, 'trust') })
    expect(version.config.link).toEqual([{ deck: '@term/base', code: '1.x.x' }])
    expect(version.trust?.source).toBe('first-use')
    expect(version.manifest.archive.digest).toBe(version.config.archive.digest)

    const dest = path.join(work, 'installed')
    const pulled = await installOciVersion({ transport, repository: route().repository.name, version, dest })

    expect(pulled.fetched).toBe(true)
    expect(await readTree(dest)).toEqual(await readTree(source))
    expect(await fs.readFile(path.join(dest, '.term-digest'), 'utf8')).toBe(`${version.digest}\n`)

    // a second install of the same version into the same folder fetches nothing: its marker names the manifest
    const before = server.requests.length
    const again = await installOciVersion({ transport, repository: route().repository.name, version, dest })
    expect(again.fetched).toBe(false)
    expect(server.requests.length).toBe(before)
  })

  // v1 attached a signature referrer on request, which GHCR (lacking the referrers API) listed as a `sha256-<hex>` tag
  // beside every version. v2 has none (decision 158 rule 3), and one gzip ustar layer
  it('writes no signature referrer, and exactly one archive layer', async () => {
    const source = path.join(work, 'plain')
    await writePackage(source, FILES)

    const result = await publish({ dir: source, version: '0.9.0' })
    const referrers = await transport.referrers({ repository: route().repository.name, digest: result.digest })
    const manifest = JSON.parse(result.artifact.manifest.toString('utf8')) as { layers: { mediaType: string }[] }

    expect(referrers ?? []).toEqual([])
    expect(manifest.layers.map(layer => layer.mediaType)).toEqual(['application/vnd.oci.image.layer.v1.tar+gzip'])
  })

  it('treats an identical republish as a no-op, and refuses to overwrite a version', async () => {
    const source = path.join(work, 'v1')
    const same = await publish({ dir: source, version: '1.0.0' })

    expect(same.unchanged).toBe(true)

    await writePackage(source, { 'code/one.ts': 'export const one = 11\n' })
    await expect(publish({ dir: source, version: '1.0.0' })).rejects.toThrow(/write-once/)
  })

  // the files of 0.9.0 under the next version: the archive is the blob already there, only the config goes up
  it('uploads only what changed in the next version', async () => {
    const next = await publish({ dir: path.join(work, 'plain'), version: '1.0.2' })

    expect(next.blobs.present).toBe(1)
    expect(next.blobs.uploaded).toBe(1)
    expect(next.bytes.uploaded).toBeLessThan(next.bytes.total)
  })

  it('fails loudly when a tag moves under a pinned digest', async () => {
    const first = await read({ reference: '1.0.0', trustDir: path.join(work, 'trust') })
    const moved = server.tags.get(route().repository.name)!.get('1.0.2')!
    server.retag({ repository: route().repository.name, tag: '1.0.0', digest: moved })

    await expect(read({ reference: '1.0.0', trustDir: path.join(work, 'trust'), expect: { digest: first.digest } })).rejects.toThrow(/has moved/)
    // and without a pin, the signed statement still refuses a 1.0.2 served as 1.0.0
    await expect(read({ reference: '1.0.0', trustDir: path.join(work, 'trust') })).rejects.toThrow(/signed for tag/)

    server.retag({ repository: route().repository.name, tag: '1.0.0', digest: first.digest })
  })

  it('refuses a version signed by a key the lockfile did not pin', async () => {
    await expect(read({ reference: '1.0.0', trustDir: path.join(work, 'trust'), expect: { key: generateKeypair().publicKey } })).rejects.toThrow(
      /different key/,
    )
  })

  it('refuses a publisher outside the key set, until a member adds it', async () => {
    const stranger = generateKeypair()
    const source = path.join(work, 'v1')

    await expect(publish({ dir: source, version: '1.0.4', signer: stranger })).rejects.toThrow(/not in the key set/)

    const rotated = await rotateKeys({ transport, repository: 'term', scope: '@term', keypair, add: [stranger.publicKey] })
    expect(rotated.sequence).toBe(2)

    await publish({ dir: source, version: '1.0.4', signer: stranger })
    const version = await read({ reference: '1.0.4', trustDir: path.join(work, 'trust') })
    expect(version.trust?.source).toBe('rotated')
  })

  it('refuses a key set rolled back, or replaced rather than rotated', async () => {
    const trust = path.join(work, 'trust')
    const repo = 'term'
    const generation1 = server.tags.get(repo)!.get('keys.1')!
    const generation2 = server.tags.get(repo)!.get('keys')!

    server.retag({ repository: repo, tag: 'keys', digest: generation1 })
    await expect(trustedKeys({ transport, repository: repo, scope: '@term', host: server.host, trustDir: trust, env: {} })).rejects.toThrow(/rollback/)

    // an attacker with registry write access forges a fresh chain of their own
    const attacker = generateKeypair()
    const body = { v: 1 as const, scope: '@term', sequence: 3, keys: [attacker.publicKey], previous: generation1 }
    const forged = { ...body, signer: attacker.publicKey, sig: signId({ id: keySetStatement(body), privateKey: attacker.privateKey }) }
    const bytes = Buffer.from(JSON.stringify(forged))
    const config = { mediaType: KEYS_CONFIG_MEDIA_TYPE, digest: sha256Digest(bytes), size: bytes.length }
    await transport.putBlob({ repository: repo, digest: config.digest, bytes })
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        artifactType: KEYS_ARTIFACT_TYPE,
        config,
        layers: [{ mediaType: 'application/vnd.oci.empty.v1+json', digest: sha256Digest(Buffer.from('{}')), size: 2 }],
      }),
    )
    await transport.putManifest({ repository: repo, reference: 'keys', bytes: manifest, mediaType: 'application/vnd.oci.image.manifest.v1+json' })

    await expect(trustedKeys({ transport, repository: repo, scope: '@term', host: server.host, trustDir: trust, env: {} })).rejects.toThrow(
      /not signed by generation|does not descend/,
    )

    server.retag({ repository: repo, tag: 'keys', digest: generation2 })
  })

  it('refuses an archive the registry has tampered with, and leaves no folder', async () => {
    const version = await read({ reference: '1.0.0', trustDir: path.join(work, 'trust') })
    const archive = version.config.archive
    const original = server.blobs.get(archive.digest)!
    server.tamperBlob(archive.digest, Buffer.from('not the archive'))

    await expect(installOciVersion({ transport, repository: route().repository.name, version, dest: path.join(work, 'tampered') })).rejects.toThrow()

    server.tamperBlob(archive.digest, original)
    await expect(fs.access(path.join(work, 'tampered'))).rejects.toThrow()
  })

  it('refuses a manifest that lists a layer beside the archive', async () => {
    const version = await read({ reference: '1.0.0', trustDir: path.join(work, 'trust') })
    const manifest = JSON.parse(version.manifestBytes.toString('utf8'))
    const doubled = Buffer.from(JSON.stringify({ ...manifest, layers: [...manifest.layers, manifest.layers[0]] }))

    expect(() => parseDeckManifest(doubled)).toThrow(/exactly 1 layer/)
  })

  it('refuses a fetched archive that is not the signed one', () => {
    const config = {
      archive: { digest: sha256Digest(Buffer.from('the archive')), size: 11, mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip' },
    } as DeckConfig

    expect(() => checkArchiveLayer({ bytes: Buffer.from('junk'), config })).toThrow(/the fetched archive is/)
  })

  it('refuses a manifest that is not a Term deck', () => {
    expect(() => parseDeckManifest(Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json' })))).toThrow(
      /not a Term deck/,
    )
  })
})

describe('OCI image layout', () => {
  const layoutPublish = (input: {
    dir: string
    transport: OciTransport
    repository: { host: string; namespace: string; name: string }
    keypair: ReturnType<typeof generateKeypair>
  }) =>
    publishToOci({
      dir: input.dir,
      package: '@term/demo',
      version: '1.0.0',
      link: [],
      transport: input.transport,
      repository: input.repository,
      scope: '@term',
      keysRepository: 'term',
      keypair: input.keypair,
    })

  it('publishes into a layout and installs from it, as a registry that is a directory', async () => {
    const work = await scratch('layout')
    const source = path.join(work, 'src')
    await writePackage(source, FILES)

    const transport = layoutTransport({ dir: path.join(work, 'mirror'), prefix: 'mirror.local' })
    const repository = { host: 'mirror.local', namespace: 'term', name: 'term/demo' }
    const result = await layoutPublish({ dir: source, transport, repository, keypair: generateKeypair() })

    const index = JSON.parse(await fs.readFile(path.join(work, 'mirror', 'index.json'), 'utf8'))
    expect(index.manifests.some((entry: { digest: string }) => entry.digest === result.digest)).toBe(true)
    expect(await fs.readFile(path.join(work, 'mirror', 'oci-layout'), 'utf8')).toContain('1.0.0')

    const version = await readOciVersion({
      transport,
      repository: 'term/demo',
      package: '@term/demo',
      reference: '1.0.0',
      scope: '@term',
      keysRepository: 'term',
      host: 'mirror.local',
      trustDir: path.join(work, 'trust'),
      env: {},
    })
    const dest = path.join(work, 'dest')
    await installOciVersion({ transport, repository: 'term/demo', version, dest })

    expect(await readTree(dest)).toEqual(await readTree(source))
  })

  // A `.tree` file is stored as a record only when the record gives the file back. Term source is not a record: the
  // data grammar read its first top-level node and dropped the rest, and every installed `.tree` file came back cut
  // to its first line or block (object/version.ts `recordOf`, 2026-10-05). v2 archives every file as its bytes, and
  // this holds it: several top-level nodes, comments, blank lines and a lean file, each byte for byte
  it('installs Term source byte for byte', async () => {
    const work = await scratch('source')
    const source = path.join(work, 'src')
    const term = {
      'code/list.tree': 'load @term/base/list\n  find get\n\n# the first item, or none\ntask first\n  take items, like list\n\n  back get(items, 0)\n\ntask second\n  take items, like list\n\n  back get(items, 1)\n',
      'code/form.tree': 'form point\n  link x, like number\n  link y, like number\n\nform line\n  link from, like point\n  link to, like point\n',
      'code/role.tree': 'role code\nmark lean\n',
      'deck.tree': 'deck @term/demo\n  mark <1.0.0>\n',
    }

    await writePackage(source, term)

    const transport = layoutTransport({ dir: path.join(work, 'mirror'), prefix: 'mirror.local' })
    const repository = { host: 'mirror.local', namespace: 'term', name: 'term/demo' }

    await layoutPublish({ dir: source, transport, repository, keypair: generateKeypair() })

    const version = await readOciVersion({ transport, repository: 'term/demo', package: '@term/demo', reference: '1.0.0', scope: '@term', keysRepository: 'term', host: 'mirror.local', trustDir: path.join(work, 'trust'), env: {} })
    const dest = path.join(work, 'dest')

    await installOciVersion({ transport, repository: 'term/demo', version, dest })

    expect(await readTree(dest)).toEqual(await readTree(source))
  })

  it('reads and writes the bare tags of a single-repository layout, the shape oras --oci-layout uses', async () => {
    const work = await scratch('bare')
    const source = path.join(work, 'src')
    await writePackage(source, FILES)
    const dir = path.join(work, 'layout')
    const transport = layoutTransport({ dir, bare: true })
    const keypair = generateKeypair()

    await layoutPublish({ dir: source, transport, repository: { host: 'layout', namespace: 'term', name: 'term/demo' }, keypair })

    const index = JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8')) as {
      manifests: { annotations?: Record<string, string> }[]
    }
    const names = index.manifests.map(entry => entry.annotations?.['org.opencontainers.image.ref.name']).filter(Boolean)
    expect(names).toContain('1.0.0')

    const version = await readOciVersion({
      transport,
      repository: 'term/demo',
      package: '@term/demo',
      reference: '1.0.0',
      scope: '@term',
      keysRepository: 'term',
      host: 'layout',
      trustDir: path.join(work, 'trust'),
      env: { TERM_TRUSTED_KEYS: `@term=${keypair.publicKey}` },
    })
    expect(version.trust?.source).toBe('env')

    const dest = path.join(work, 'dest')
    await installOciVersion({ transport, repository: 'term/demo', version, dest })
    expect(await readTree(dest)).toEqual(await readTree(source))
  })

  it('ships an empty .tree file, and never the installed dependencies under the top-level link/', async () => {
    const work = await scratch('edges')
    const source = path.join(work, 'src')
    await writePackage(source, {
      'code/empty.tree': '',
      'code/link/kept.ts': 'export const kept = 1\n',
      'link/@term/base/leak.ts': 'export const leak = 1\n',
    })
    const transport = layoutTransport({ dir: path.join(work, 'layout'), bare: true })

    await layoutPublish({ dir: source, transport, repository: { host: 'layout', namespace: 'term', name: 'term/demo' }, keypair: generateKeypair() })

    const version = await readOciVersion({
      transport,
      repository: 'term/demo',
      package: '@term/demo',
      reference: '1.0.0',
      scope: '@term',
      keysRepository: 'term',
      host: 'layout',
      trustDir: path.join(work, 'trust'),
      env: {},
    })
    const dest = path.join(work, 'dest')
    await installOciVersion({ transport, repository: 'term/demo', version, dest })

    expect(Object.keys(await readTree(dest)).sort()).toEqual(['code/empty.tree', 'code/link/kept.ts'])
    expect(await fs.readFile(path.join(dest, 'code/empty.tree'), 'utf8')).toBe('')
  })

  // the version walk (oci/version-files.tree, decision 154 section 2) keeps an included built folder and nothing else
  // of host/
  it('ships an included built directory and nothing else from host/', async () => {
    const work = await scratch('include')
    await writePackage(work, {
      'code/line/base.tree': 'hook run\n',
      'host/line/run.mjs': 'export {}\n',
      'host/line/app.mjs': 'export {}\n',
      'host/other.js': 'leak\n',
      'host/cache/x.js': 'leak\n',
    })

    const entries = await walk.readVersionFiles(work, walk.defaultVersionExclude(), ['host/line'])

    expect(entries.filter(entry => entry.kind === 'file').map(entry => entry.path)).toEqual(['code/line/base.tree', 'host/line/app.mjs', 'host/line/run.mjs'])
  })

  it('never stores a blob under the wrong digest', async () => {
    const transport = layoutTransport({ dir: await scratch('verify'), bare: true })

    await expect(transport.putBlob({ repository: 'term/demo', digest: sha256Digest(Buffer.from('a')), bytes: Buffer.from('b') })).rejects.toThrow(/verification/)
  })
})

describe('lockfile key pin', () => {
  it('round trips the signer key', () => {
    const key = generateKeypair().publicKey
    const digest = sha256Digest(Buffer.from('m'))
    const text = writeLockfile({
      lockfile: {
        version: 1,
        decks: [
          {
            name: '@term/demo',
            code: { major: 1, minor: 0, patch: 0 },
            hash: digest,
            site: `oci://ghcr.io/cluesurf/term/demo@${digest}`,
            key,
            link: [],
          },
        ],
      },
    })

    expect(parseLockfile({ text }).decks[0]).toMatchObject({ hash: digest, key })
  })
})
