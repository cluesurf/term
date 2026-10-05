// A TOOLCHAIN RELEASE in an OCI registry: `@term/code`, the `term` command, one payload per platform
// (note/term/plan/term-load-install.md, note/term/self-host/09-distribution.md items R1 and R2).
//
// A package version (artifact.ts) is a commit of source files in packs, and a release is not: it is a built payload
// for ONE platform, installed whole and never checked out file by file. So it has its own shape:
//
//   tag <version>   an OCI image INDEX, one entry per platform, each with the `platform` field (os, architecture)
//     manifest      artifactType application/vnd.cluesurf.term.release.v1
//       config      who released what: package, version, platform, the layer's digest, the key, the signature
//       layer 0     the payload, a .tar.gz, title `term-<platform>.tar.gz`
//
// THE LAYER DIGEST IS THE TARBALL'S SHA-256, so the shell loader and the Homebrew cask check a download against the
// registry's own digest and need no second checksum file. The signature is what a digest cannot give: that the
// scope's key set stands behind the bytes. It covers `term.release.v1 <package> <version> <platform> <layer digest>`,
// every field an installer acts on, so none can be swapped without the key: not the platform (a linux payload offered
// to a mac), not the version (an old payload under a new tag), not the package.

import { makeDefaultFetchConfig } from '../fetch'
import { signId, verifyId, type Keypair } from '../object/sign'
import { ociRouteOf, type OciRoute } from './client'
import { INDEX_MEDIA_TYPE, MANIFEST_MEDIA_TYPE, OciError, sha256Digest, type OciTransport } from './transport'

export const RELEASE_ARTIFACT_TYPE = 'application/vnd.cluesurf.term.release.v1'
export const RELEASE_CONFIG_MEDIA_TYPE = 'application/vnd.cluesurf.term.release.config.v1+json'
export const RELEASE_LAYER_MEDIA_TYPE = 'application/vnd.cluesurf.term.release.v1.tar+gzip'

const TITLE = 'org.opencontainers.image.title'

// what a reader accepts for a release config, so a hostile registry cannot make it allocate without bound
const CONFIG_LIMIT = 64 * 1024

// The platforms a release may carry, in 09's names, with the OCI `platform` each maps to. OCI says `amd64` where Node
// and 09 say `x64`, and `windows` where Node says `win32`
export const RELEASE_PLATFORMS: Record<string, { os: string; architecture: string }> = {
  'darwin-arm64': { os: 'darwin', architecture: 'arm64' },
  'darwin-x64': { os: 'darwin', architecture: 'amd64' },
  'linux-x64': { os: 'linux', architecture: 'amd64' },
  'linux-arm64': { os: 'linux', architecture: 'arm64' },
  'windows-x64': { os: 'windows', architecture: 'amd64' },
  'windows-arm64': { os: 'windows', architecture: 'arm64' },
}

// Node's `process.platform` in 09's names
const RELEASE_OS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'darwin', linux: 'linux', win32: 'windows' }

export type ReleaseConfig = {
  v: 1
  package: string
  version: string
  platform: string
  // the payload layer's digest, `sha256:<hex>`
  layer: string
  key: string
  sig: string
}

export type ReleaseEntry = {
  platform: string
  // the manifest's digest and size, as the index lists them
  manifest: string
  size: number
}

/**
 * Where a release lives: its scope's route, `ghcr.io/cluesurf/term/code` for `@term/code`.
 *
 * `TERM_RELEASE_REGISTRY=oci://<host>/<namespace>` moves it, for publishing to and installing from a registry other
 * than the scope's own: a staging namespace, or the loopback registry the end-to-end test runs. The one switch, read by
 * `pnpm term:release` and by `term self` alike, so the two never disagree about where a release is.
 */
export function releaseRoute(input: { package: string; env?: NodeJS.ProcessEnv }): OciRoute {
  const config = makeDefaultFetchConfig()
  const override = (input.env ?? process.env)['TERM_RELEASE_REGISTRY']?.trim()
  const scope = input.package.split('/')[0] ?? input.package

  if (override) {
    config.scopeRegistries = { ...config.scopeRegistries, [scope]: override }
  }

  const route = ociRouteOf({ name: input.package, config })

  if (!route) {
    throw new OciError(`${input.package} does not route to an OCI registry`)
  }

  return route
}

/** The exact string a release signature covers. */
export function releaseStatement(input: { package: string; version: string; platform: string; layer: string }): string {
  return `term.release.v1 ${input.package} ${input.version} ${input.platform} ${input.layer}`
}

/** This machine's platform in 09's names, or undefined when no release is built for it. */
export function currentPlatform(): string | undefined {
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : undefined
  const os = RELEASE_OS[process.platform]
  const name = os && arch ? `${os}-${arch}` : undefined

  return name && RELEASE_PLATFORMS[name] ? name : undefined
}

/** Is this a signed config for this release, this platform and these bytes? Throws, naming what does not match. */
export function verifyReleaseConfig(input: {
  config: ReleaseConfig
  package: string
  version: string
  platform: string
  layer: string
}): void {
  const { config } = input

  if (config.v !== 1 || config.package !== input.package || config.version !== input.version || config.platform !== input.platform) {
    throw new OciError(
      `the release config says ${config.package}@${config.version} for ${config.platform}, not ${input.package}@${input.version} for ${input.platform}`,
    )
  }

  if (config.layer !== input.layer) {
    throw new OciError(`the release config signs layer ${config.layer}, and the manifest carries ${input.layer}`)
  }

  if (!verifyId({ id: releaseStatement(config), sig: config.sig, publicKey: config.key })) {
    throw new OciError(`the signature on ${input.package}@${input.version} for ${input.platform} does not verify`)
  }
}

/**
 * Publish one release: every platform's layer, config and manifest by digest, then the index under the version tag.
 * WRITE-ONCE, like every version: a tag that already names an index is a refusal, so a release is never replaced.
 */
export async function publishRelease(input: {
  transport: OciTransport
  // `cluesurf/term/code`
  repository: string
  package: string
  version: string
  payloads: { platform: string; bytes: Buffer }[]
  keypair: Keypair
  // the index's annotations: source, licenses, description
  annotations?: Record<string, string>
  log?: (message: string) => void
}): Promise<{ index: string; entries: (ReleaseEntry & { layer: string })[] }> {
  const log = input.log ?? (() => {})

  if (await input.transport.getManifest({ repository: input.repository, reference: input.version })) {
    throw new OciError(`${input.package}@${input.version} is already released. Releases are write-once: raise the version`)
  }

  const entries: (ReleaseEntry & { layer: string })[] = []

  for (const payload of input.payloads) {
    if (!RELEASE_PLATFORMS[payload.platform]) {
      throw new OciError(`no OCI platform is known for ${payload.platform}`)
    }

    const layer = sha256Digest(payload.bytes)
    const unsigned = { package: input.package, version: input.version, platform: payload.platform, layer }
    const config: ReleaseConfig = {
      v: 1,
      ...unsigned,
      key: input.keypair.publicKey,
      sig: signId({ id: releaseStatement(unsigned), privateKey: input.keypair.privateKey }),
    }
    const configBytes = Buffer.from(JSON.stringify(config))
    const configDigest = sha256Digest(configBytes)

    await input.transport.putBlob({ repository: input.repository, digest: layer, bytes: payload.bytes })
    await input.transport.putBlob({ repository: input.repository, digest: configDigest, bytes: configBytes })

    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: MANIFEST_MEDIA_TYPE,
        artifactType: RELEASE_ARTIFACT_TYPE,
        config: { mediaType: RELEASE_CONFIG_MEDIA_TYPE, digest: configDigest, size: configBytes.length },
        layers: [
          {
            mediaType: RELEASE_LAYER_MEDIA_TYPE,
            digest: layer,
            size: payload.bytes.length,
            annotations: { [TITLE]: `term-${payload.platform}.tar.gz` },
          },
        ],
        annotations: { [TITLE]: input.package, 'org.opencontainers.image.version': input.version },
      }),
    )
    const pushed = await input.transport.putManifest({
      repository: input.repository,
      reference: sha256Digest(manifest),
      bytes: manifest,
      mediaType: MANIFEST_MEDIA_TYPE,
    })

    entries.push({ platform: payload.platform, manifest: pushed.digest, size: manifest.length, layer })
    log(`${payload.platform}: layer ${layer}, manifest ${pushed.digest}`)
  }

  const index = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: INDEX_MEDIA_TYPE,
      artifactType: RELEASE_ARTIFACT_TYPE,
      manifests: entries.map(entry => ({
        mediaType: MANIFEST_MEDIA_TYPE,
        digest: entry.manifest,
        size: entry.size,
        platform: RELEASE_PLATFORMS[entry.platform],
        annotations: { [TITLE]: `term-${entry.platform}.tar.gz` },
      })),
      annotations: {
        ...input.annotations,
        [TITLE]: input.package,
        'org.opencontainers.image.version': input.version,
      },
    }),
  )
  const tagged = await input.transport.putManifest({
    repository: input.repository,
    reference: input.version,
    bytes: index,
    mediaType: INDEX_MEDIA_TYPE,
  })

  return { index: tagged.digest, entries }
}

/**
 * Read one platform's release and check it: the index under the version tag, the platform's manifest, its config,
 * and the signature over the layer the manifest names. Does NOT check the signer against the key set; the caller
 * does that with `trustedKeys`, the way package installs do.
 */
export async function readRelease(input: {
  transport: OciTransport
  repository: string
  package: string
  version: string
  platform: string
}): Promise<{ config: ReleaseConfig; layer: string; size: number }> {
  const indexed = await input.transport.getManifest({ repository: input.repository, reference: input.version })

  if (!indexed) {
    throw new OciError(`${input.package}@${input.version} is not released`)
  }

  const index = JSON.parse(indexed.bytes.toString('utf8')) as {
    manifests?: { digest: string; platform?: { os?: string; architecture?: string } }[]
  }
  const want = RELEASE_PLATFORMS[input.platform]
  const entry = index.manifests?.find(one => one.platform?.os === want?.os && one.platform?.architecture === want?.architecture)

  if (!want || !entry) {
    throw new OciError(`${input.package}@${input.version} has no release for ${input.platform}`)
  }

  const fetched = await input.transport.getManifest({ repository: input.repository, reference: entry.digest })

  if (!fetched || fetched.digest !== entry.digest) {
    throw new OciError(`the ${input.platform} manifest of ${input.package}@${input.version} is missing or moved`)
  }

  const manifest = JSON.parse(fetched.bytes.toString('utf8')) as {
    artifactType?: string
    config?: { digest: string; mediaType: string; size: number }
    layers?: { digest: string; mediaType: string; size: number }[]
  }
  const layer = manifest.layers?.[0]

  if (
    manifest.artifactType !== RELEASE_ARTIFACT_TYPE ||
    manifest.config?.mediaType !== RELEASE_CONFIG_MEDIA_TYPE ||
    manifest.config.size > CONFIG_LIMIT ||
    !layer ||
    layer.mediaType !== RELEASE_LAYER_MEDIA_TYPE
  ) {
    throw new OciError(`the ${input.platform} manifest of ${input.package}@${input.version} is not a Term release`)
  }

  const configBytes = await input.transport.getBlob({
    repository: input.repository,
    digest: manifest.config.digest,
    size: manifest.config.size,
    limit: CONFIG_LIMIT,
  })
  const config = JSON.parse(configBytes.toString('utf8')) as ReleaseConfig

  verifyReleaseConfig({ config, package: input.package, version: input.version, platform: input.platform, layer: layer.digest })

  return { config, layer: layer.digest, size: layer.size }
}
