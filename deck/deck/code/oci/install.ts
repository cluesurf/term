// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/oci/install.ts's exports, with
// their shapes, answered by deck/deck/code/oci/version-installing.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-oci-install.
// Artifact format v2 (decision 129 section 2 of the self-host change, decisions 154 and 158, item
// term-self-host-001-1043): one archive layer, unpacked under the `.term-digest` marker, no object store.
import * as port from '@term/deck/code/oci/version-installing'
import { ociErrorOf, type OciTransport } from './transport'
import type { DeckConfig, ParsedManifest } from './artifact'
import type { TrustedKeys } from './keys'

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

// a verified version unpacked at `dest`, skipped with nothing fetched when `dest/.term-digest` already reads its
// manifest digest. `fetched` says whether the archive was fetched, `bytes` its size, `files` the entries unpacked
export const installOciVersion = (input: {
  transport: OciTransport
  repository: string
  version: OciVersion
  dest: string
  cache?: OciTransport
}): Promise<{
  fetched: boolean
  bytes: number
  files: number
}> =>
  liftAsync(
    () =>
      p.installOciVersion!(
        input.transport,
        input.repository,
        input.version,
        input.dest,
        input.cache,
      ) as Promise<{
        fetched: boolean
        bytes: number
        files: number
      }>,
  )
