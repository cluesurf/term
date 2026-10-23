// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/oci/release.ts's exports, with
// their shapes, answered by deck/deck/code/oci/toolchain-release.tree. The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-oci-release.
import * as port from '@term/deck/code/oci/toolchain-release'
import { ociErrorOf, type OciTransport } from './transport'
import type { Keypair } from '../object/sign'
import type { OciRoute } from './client'


const p = port as unknown as Record<string, (...args: unknown[]) => unknown>

function lift<T>(work: () => T): T {
  try {
    return work()
  } catch (error) {
    throw ociErrorOf(error)
  }
}

async function liftAsync<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw ociErrorOf(error)
  }
}

export const RELEASE_ARTIFACT_TYPE = p.releaseArtifactType!() as string
export const RELEASE_CONFIG_MEDIA_TYPE = p.releaseConfigMediaType!() as string
export const RELEASE_LAYER_MEDIA_TYPE = p.releaseLayerMediaType!() as string
export const RELEASE_PLATFORMS = p.releasePlatforms!() as Record<string, { os: string; architecture: string }>

export type ReleaseConfig = { v: 1; package: string; version: string; platform: string; layer: string; key: string; sig: string }
export type ReleaseEntry = { platform: string; manifest: string; size: number }

export const releaseRoute = (input: { package: string; env?: NodeJS.ProcessEnv }): OciRoute => lift(() => p.releaseRoute!(input.package, input.env) as OciRoute)

export const releaseStatement = (input: { package: string; version: string; platform: string; layer: string }): string =>
  p.releaseStatement!(input.package, input.version, input.platform, input.layer) as string

export const currentPlatform = (): string | undefined => p.currentPlatform!() as string | undefined

export const verifyReleaseConfig = (input: { config: ReleaseConfig; package: string; version: string; platform: string; layer: string }): void =>
  lift(() => p.verifyReleaseConfig!(input.config, input.package, input.version, input.platform, input.layer) as void)

export const publishRelease = (input: {
  transport: OciTransport
  repository: string
  package: string
  version: string
  payloads: { platform: string; bytes: Buffer }[]
  keypair: Keypair
  annotations?: Record<string, string>
  log?: (message: string) => void
}): Promise<{ index: string; entries: (ReleaseEntry & { layer: string })[] }> =>
  liftAsync(
    () =>
      p.publishRelease!(input.transport, input.repository, input.package, input.version, input.payloads, input.keypair, input.annotations, input.log) as Promise<{
        index: string
        entries: (ReleaseEntry & { layer: string })[]
      }>,
  )

export const readReleaseIndex = (input: { transport: OciTransport; repository: string; version: string }): Promise<{ digest: string; platforms: string[] } | undefined> =>
  liftAsync(() => p.readReleaseIndex!(input.transport, input.repository, input.version) as Promise<{ digest: string; platforms: string[] } | undefined>)

export const readRelease = (input: { transport: OciTransport; repository: string; package: string; version: string; platform: string }): Promise<{ config: ReleaseConfig; layer: string; size: number }> =>
  liftAsync(() => p.readRelease!(input.transport, input.repository, input.package, input.version, input.platform) as Promise<{ config: ReleaseConfig; layer: string; size: number }>)
