// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/oci/install.ts's exports, with
// their shapes, answered by deck/deck/code/oci/version-installing.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-oci-install.
import * as port from '@term/deck/code/oci/version-installing'
import { ociErrorOf, type OciTransport } from './transport'
import type { DeckConfig, FilesLayer, ParsedManifest } from './artifact'
import type { TrustedKeys } from './keys'
import type { ObjectStore } from '../object/store'

const p = port as unknown as Record<
  string,
  (...args: unknown[]) => unknown
>

async function liftAsync<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw ociErrorOf(error)
  }
}

export type OciVersion = {
  digest: string
  manifest: ParsedManifest
  manifestBytes: Buffer
  config: DeckConfig
  configBytes: Buffer
  trust: TrustedKeys | undefined
}

export const listOciVersions = (input: {
  transport: OciTransport
  repository: string
}): Promise<string[]> =>
  liftAsync(
    () =>
      p.listOciVersions!(input.transport, input.repository) as Promise<
        string[]
      >,
  )

export const readOciVersion = (input: {
  transport: OciTransport
  repository: string
  package: string
  reference: string
  scope: string
  keysRepository: string
  host: string
  trustDir: string
  expect?: { digest?: string; key?: string; version?: string }
  env?: NodeJS.ProcessEnv
  warn?: (message: string) => void
}): Promise<OciVersion> =>
  liftAsync(
    () =>
      p.readOciVersion!(
        input.transport,
        input.repository,
        input.package,
        input.reference,
        input.scope,
        input.keysRepository,
        input.host,
        input.trustDir,
        input.expect,
        input.env,
        input.warn,
      ) as Promise<OciVersion>,
  )

export const installOciVersion = (input: {
  transport: OciTransport
  repository: string
  version: OciVersion
  dest: string
  local: ObjectStore
  cache?: OciTransport
  concurrency?: number
}): Promise<{
  packsFetched: number
  packsSkipped: number
  looseFetched: number
  bytes: number
  files: FilesLayer
}> =>
  liftAsync(
    () =>
      p.installOciVersion!(
        input.transport,
        input.repository,
        input.version,
        input.dest,
        input.local,
        input.cache,
        input.concurrency,
      ) as Promise<{
        packsFetched: number
        packsSkipped: number
        looseFetched: number
        bytes: number
        files: FilesLayer
      }>,
  )
