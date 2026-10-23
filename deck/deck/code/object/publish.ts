// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/object/publish.ts's exports, with
// their shapes, answered by deck/deck/code/object/package-publishing.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-object-publish.
import * as port from '@term/deck/code/object/package-publishing'
import { defaultChunkParams } from '@term/deck/code/object/content-chunking'

export const publishPackage = (input: {
  dir: string
  package: string
  target: unknown
  local: unknown
  registry: unknown
  keypair: { publicKey: string; privateKey: string }
  author: string
  time: string
  message?: string
  parents?: string[]
  deps?: Record<string, string>
  params?: unknown
}): Promise<{ commitId: string; ref: string; uploaded: number; packs: number }> =>
  port.publishPackage(input.dir, input.package, input.target, input.local, input.registry, input.keypair, input.author, input.time, input.message ?? '', input.params ?? defaultChunkParams()) as Promise<{ commitId: string; ref: string; uploaded: number; packs: number }>
