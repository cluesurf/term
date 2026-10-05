// A toolchain release over OCI (code/oci/release.ts): published as an image index with one signed manifest per
// platform, read back per platform, refused when anything an installer acts on is swapped, and write-once.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { generateKeypair, signId } from '../code/object/sign'
import {
  RELEASE_PLATFORMS,
  publishRelease,
  readRelease,
  releaseStatement,
  verifyReleaseConfig,
  type ReleaseConfig,
} from '../code/oci/release'
import { httpTransport, sha256Digest, type OciTransport } from '../code/oci/transport'
import { startOciServer, type OciServer } from './oci-server'

const PACKAGE = '@term/code'
const REPOSITORY = 'cluesurf/term/code'

describe('toolchain release', () => {
  let server: OciServer
  let transport: OciTransport
  const keypair = generateKeypair()
  const payloads = [
    { platform: 'darwin-arm64', bytes: Buffer.from('a darwin arm64 payload') },
    { platform: 'linux-x64', bytes: Buffer.from('a linux x64 payload') },
  ]

  beforeAll(async () => {
    server = await startOciServer()
    transport = httpTransport({
      host: server.host,
      credentials: async () => ({ kind: 'basic', username: 'tester', password: 'secret' }),
      retries: 0,
    })

    await publishRelease({ transport, repository: REPOSITORY, package: PACKAGE, version: '1.0.0', payloads, keypair })
  })

  afterAll(async () => {
    await server.close()
  })

  it('tags the version with an image index, one entry per platform, in OCI platform terms', async () => {
    const index = await transport.getManifest({ repository: REPOSITORY, reference: '1.0.0' })
    const body = JSON.parse(index!.bytes.toString('utf8')) as { mediaType: string; manifests: { platform: unknown }[] }

    expect(body.mediaType).toBe('application/vnd.oci.image.index.v1+json')
    expect(body.manifests.map(one => one.platform)).toEqual([RELEASE_PLATFORMS['darwin-arm64'], RELEASE_PLATFORMS['linux-x64']])
    expect(RELEASE_PLATFORMS['linux-x64']).toEqual({ os: 'linux', architecture: 'amd64' })
  })

  it('reads each platform back, the layer digest being the payload sha256 and the signature verifying', async () => {
    for (const payload of payloads) {
      const read = await readRelease({ transport, repository: REPOSITORY, package: PACKAGE, version: '1.0.0', platform: payload.platform })

      expect(read.layer).toBe(sha256Digest(payload.bytes))
      expect(read.config.key).toBe(keypair.publicKey)
      expect(await transport.getBlob({ repository: REPOSITORY, digest: read.layer, limit: 1024 })).toEqual(payload.bytes)
    }
  })

  it('refuses a platform the release does not carry, and a version never released', async () => {
    await expect(
      readRelease({ transport, repository: REPOSITORY, package: PACKAGE, version: '1.0.0', platform: 'darwin-x64' }),
    ).rejects.toThrow(/no release for darwin-x64/)
    await expect(
      readRelease({ transport, repository: REPOSITORY, package: PACKAGE, version: '9.9.9', platform: 'linux-x64' }),
    ).rejects.toThrow(/not released/)
  })

  it('is write-once', async () => {
    await expect(
      publishRelease({ transport, repository: REPOSITORY, package: PACKAGE, version: '1.0.0', payloads, keypair }),
    ).rejects.toThrow(/write-once/)
  })

  it('refuses a config whose signed fields were swapped: the platform, the version, the layer, or the signer', () => {
    const layer = sha256Digest(Buffer.from('bytes'))
    const unsigned = { package: PACKAGE, version: '1.0.0', platform: 'linux-x64', layer }
    const config: ReleaseConfig = { v: 1, ...unsigned, key: keypair.publicKey, sig: '' }
    const signed = { ...config, sig: signId({ id: releaseStatement(unsigned), privateKey: keypair.privateKey }) }
    const check = (over: Partial<ReleaseConfig>, against = unsigned) => () =>
      verifyReleaseConfig({ config: { ...signed, ...over }, ...against })

    expect(check({})).not.toThrow()
    // a linux payload relabelled for a mac: the fields no longer match the signature
    expect(check({ platform: 'darwin-arm64' }, { ...unsigned, platform: 'darwin-arm64' })).toThrow(/does not verify/)
    expect(check({ version: '2.0.0' }, { ...unsigned, version: '2.0.0' })).toThrow(/does not verify/)
    // the manifest carries different bytes than the config signed
    expect(check({}, { ...unsigned, layer: sha256Digest(Buffer.from('other')) })).toThrow(/signs layer/)
    // a stranger's key over the same statement
    expect(check({ key: generateKeypair().publicKey })).toThrow(/does not verify/)
  })
})
