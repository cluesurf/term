// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/oci/index-ping.ts's exports, with
// their shapes, answered by deck/deck/code/oci/index-announcing.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-oci-index-ping.
import * as port from '@term/deck/code/oci/index-announcing'

export type IndexPing =
  | { form: 'sent'; outcome: string; publisher?: string }
  | { form: 'skipped'; reason: string }
  | { form: 'failed'; reason: string }

export const publishStatement = (input: {
  reference: string
  time: string
}): string =>
  port.publishStatement(input.reference, input.time)
export const pingIndex = (input: {
  repository: unknown
  digest: string
  token?: string
  keypair?: unknown
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  now?: () => Date
}): Promise<IndexPing> =>
  port.pingIndex(
    input.repository,
    input.digest,
    input.token,
    input.keypair,
    input.env ?? process.env,
    input.fetch ?? fetch,
    input.now ?? (() => new Date()),
  ) as Promise<IndexPing>
