// A project's toolchain request (note/term/plan/term-versions.md): `need` in deck.tree, its pin in lock.tree, both read
// by the mill grammar and by the hand reference reader alike, written back unchanged, and resolved against a registry
// the way `term load` resolves it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { codeMatch, parseCode, showCode } from '../code/code'
import { parseLockfile, parseLockfileByHand, writeLockfile } from '../code/lock'
import { parseManifest, parseManifestByHand, writeManifest } from '../code/manifest'
import { generateKeypair } from '../code/object/sign'
import { newestMatching, pinNeed, pinSatisfies, releasedVersions } from '../code/oci/need'
import { publishRelease } from '../code/oci/release'
import { httpTransport, type OciTransport } from '../code/oci/transport'
import { startOciServer, type OciServer } from './oci-server'

const MANIFEST = `deck @alice/app
  mark <1.0.0>
  need @term/code, mark <2.6.x>
`

const LOCK = `lock <1>

need @term/code
  code <2.6.4>
  hash <sha256:${'a'.repeat(64)}>
`

describe('need in deck.tree', () => {
  it('reads through the mill and the hand reader alike', () => {
    for (const read of [parseManifest, parseManifestByHand]) {
      const manifest = read({ text: MANIFEST })

      expect(manifest.need?.name).toBe('@term/code')
      expect(codeMatch(parseCode('2.6.4'), manifest.need!.mark)).toBe(true)
      expect(codeMatch(parseCode('2.7.0'), manifest.need!.mark)).toBe(false)
    }
  })

  it('is absent when the manifest names none', () => {
    expect(parseManifest({ text: 'deck @alice/app\n  mark <1.0.0>\n' }).need).toBeUndefined()
  })

  it('survives a write and a read, so no dependency verb deletes it', () => {
    const written = writeManifest({ manifest: parseManifest({ text: MANIFEST }) })

    expect(written).toContain('need @term/code, mark <2.6.x>')
    expect(parseManifest({ text: written }).need).toEqual(parseManifest({ text: MANIFEST }).need)
  })
})

describe('need in lock.tree', () => {
  it('reads through the mill and the hand reader alike', () => {
    for (const read of [parseLockfile, parseLockfileByHand]) {
      const lock = read({ text: LOCK })

      expect(lock.need?.name).toBe('@term/code')
      expect(showCode(lock.need!.code)).toBe('2.6.4')
      expect(lock.need?.hash).toBe(`sha256:${'a'.repeat(64)}`)
    }
  })

  it('survives a write and a read', () => {
    const lock = parseLockfile({ text: LOCK })

    expect(parseLockfile({ text: writeLockfile({ lockfile: lock }) })).toEqual(lock)
  })

  it('is absent from a lockfile that pins no toolchain', () => {
    expect(parseLockfile({ text: 'lock <1>\n' }).need).toBeUndefined()
  })
})

describe('pinning a need', () => {
  let server: OciServer
  let transport: OciTransport
  const saved = process.env['TERM_RELEASE_REGISTRY']
  const savedToken = { host: process.env['TERM_OCI_HOST'], user: process.env['TERM_OCI_USERNAME'], token: process.env['TERM_OCI_TOKEN'] }

  beforeAll(async () => {
    server = await startOciServer()
    transport = httpTransport({
      host: server.host,
      credentials: async () => ({ kind: 'basic', username: 'tester', password: 'secret' }),
      retries: 0,
    })

    for (const version of ['2.6.2', '2.6.4', '2.7.0']) {
      await publishRelease({
        transport,
        repository: 'cluesurf/term/code',
        package: '@term/code',
        version,
        payloads: [{ platform: 'linux-x64', bytes: Buffer.from(`payload ${version}`) }],
        keypair: generateKeypair(),
      })
    }

    process.env['TERM_RELEASE_REGISTRY'] = `oci://${server.host}/cluesurf/term`
    process.env['TERM_OCI_HOST'] = server.host
    process.env['TERM_OCI_USERNAME'] = 'tester'
    process.env['TERM_OCI_TOKEN'] = 'secret'
  })

  afterAll(async () => {
    restore('TERM_RELEASE_REGISTRY', saved)
    restore('TERM_OCI_HOST', savedToken.host)
    restore('TERM_OCI_USERNAME', savedToken.user)
    restore('TERM_OCI_TOKEN', savedToken.token)
    await server.close()
  })

  it('lists the released versions newest first, and picks the newest in a range', async () => {
    const versions = await releasedVersions({ transport, repository: 'cluesurf/term/code' })

    expect(versions).toEqual(['2.7.0', '2.6.4', '2.6.2'])
    expect(newestMatching({ versions, hold: parseManifest({ text: MANIFEST }).need!.mark })).toBe('2.6.4')
  })

  it('pins the newest release in range, with its index digest', async () => {
    const need = parseManifest({ text: MANIFEST }).need!
    const pinned = await pinNeed({ need })
    const index = await transport.getManifest({ repository: 'cluesurf/term/code', reference: '2.6.4' })

    expect(pinned.kept).toBe(false)
    expect(showCode(pinned.pin!.code)).toBe('2.6.4')
    expect(pinned.pin!.hash).toBe(index!.digest)
  })

  it('keeps a pin that still satisfies the request, and replaces one that does not', async () => {
    const need = parseManifest({ text: MANIFEST }).need!
    const older = { name: '@term/code', code: parseCode('2.6.2'), hash: `sha256:${'b'.repeat(64)}` }
    const outside = { name: '@term/code', code: parseCode('2.7.0'), hash: `sha256:${'c'.repeat(64)}` }

    expect(pinSatisfies({ need, pin: older })).toBe(true)
    expect(await pinNeed({ need, previous: older })).toEqual({ pin: older, kept: true })
    expect(showCode((await pinNeed({ need, previous: outside })).pin!.code)).toBe('2.6.4')
  })

  it('says why when nothing is released in the range, or the need names another package', async () => {
    const none = await pinNeed({ need: { name: '@term/code', mark: parseManifest({ text: MANIFEST.replace('2.6.x', '3.x.x') }).need!.mark } })
    const other = await pinNeed({ need: { name: '@alice/tool', mark: { form: 'wild', major: 1 } } })

    expect(none.pin).toBeUndefined()
    expect(none.reason).toMatch(/no release in the requested range\. The newest is 2\.7\.0/)
    expect(other.reason).toMatch(/only @term\/code can be needed/)
  })

  it('offline, keeps a satisfying pin and pins nothing new', async () => {
    const need = parseManifest({ text: MANIFEST }).need!

    expect((await pinNeed({ need, offline: true })).pin).toBeUndefined()
  })
})

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}
