// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/object/serve.ts's exports, with
// their shapes, answered by deck/deck/code/object/registry-server.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-object-serve.
import type http from 'node:http'
import * as port from '@term/deck/code/object/registry-server'

export type WriteAccess = { token: string } | 'open'

export const REGISTRY_TOKEN_VARIABLE: string =
  port.registryTokenVariable()

export const writeAccessFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): WriteAccess => port.writeAccessFromEnv(env) as WriteAccess

export const serveRegistry = (input: {
  store: unknown
  refs: unknown
  scopeKeys: unknown
  write: WriteAccess
}): http.Server =>
  port.serveRegistry(
    input.store,
    input.refs,
    input.scopeKeys,
    input.write,
  ) as http.Server
