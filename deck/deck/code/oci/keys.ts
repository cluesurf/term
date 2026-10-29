// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/oci/keys.ts's exports, with
// their shapes, answered by deck/deck/code/oci/key-trust.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-oci-keys.
import * as port from '@term/deck/code/oci/key-trust'
import { ociErrorOf, type OciTransport } from './transport'
import type { Keypair } from '../object/sign'

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

export const KEYS_ARTIFACT_TYPE = p.keysArtifactType!() as string
export const KEYS_CONFIG_MEDIA_TYPE = p.keysConfigMediaType!() as string
export const KEYS_TAG = p.keysTag!() as string

export type KeySet = {
  v: 1
  scope: string
  sequence: number
  keys: string[]
  previous: string | null
  signer: string
  sig: string
}
export type TrustedKeys = {
  keys: string[]
  source: 'env' | 'pinned' | 'first-use' | 'rotated'
  sequence?: number
}

export const keySetStatement = (
  set: Omit<KeySet, 'sig' | 'signer'>,
): string => p.keySetStatement!(set) as string

export const trustedKeys = (input: {
  transport: OciTransport
  repository: string
  scope: string
  host: string
  trustDir: string
  env?: NodeJS.ProcessEnv
}): Promise<TrustedKeys | undefined> =>
  liftAsync(
    () =>
      p.trustedKeys!(
        input.transport,
        input.repository,
        input.scope,
        input.host,
        input.trustDir,
        input.env,
      ) as Promise<TrustedKeys | undefined>,
  )

export const ensurePublisher = (input: {
  transport: OciTransport
  repository: string
  scope: string
  keypair: Keypair
}): Promise<{ created: boolean; sequence: number }> =>
  liftAsync(
    () =>
      p.ensurePublisher!(
        input.transport,
        input.repository,
        input.scope,
        input.keypair,
      ) as Promise<{ created: boolean; sequence: number }>,
  )

export const rotateKeys = (input: {
  transport: OciTransport
  repository: string
  scope: string
  keypair: Keypair
  add?: string[]
  remove?: string[]
}): Promise<{ sequence: number; keys: string[] }> =>
  liftAsync(
    () =>
      p.rotateKeys!(
        input.transport,
        input.repository,
        input.scope,
        input.keypair,
        input.add,
        input.remove,
      ) as Promise<{ sequence: number; keys: string[] }>,
  )
