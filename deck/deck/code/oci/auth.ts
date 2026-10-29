// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/oci/auth.ts's exports, with
// their shapes, answered by deck/deck/code/oci/registry-credentials.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-oci-auth.
import * as port from '@term/deck/code/oci/registry-credentials'

const p = port as unknown as Record<
  string,
  (...args: unknown[]) => unknown
>

export type OciCredentials =
  | { kind: 'basic'; username: string; password: string }
  | { kind: 'identity'; token: string }
export type Challenge = {
  scheme: 'bearer' | 'basic'
  realm?: string
  service?: string
  scope?: string
}

export const credentialsFor = (input: {
  host: string
  env?: NodeJS.ProcessEnv
  home?: string
}): Promise<OciCredentials | undefined> =>
  p.credentialsFor!(input.host, input.env, input.home) as Promise<
    OciCredentials | undefined
  >

export const parseChallenge = (
  header: string | null,
): Challenge | undefined =>
  p.parseChallenge!(header) as Challenge | undefined

export const basicHeader = (credentials: {
  username: string
  password: string
}): string => p.basicHeader!(credentials) as string
