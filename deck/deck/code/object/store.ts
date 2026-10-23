// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/object/store.ts's exports, with
// their shapes, answered by deck/deck/code/object/local-store.tree. The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-object-store.
import * as port from '@term/deck/code/object/local-store'
import { liftRecord } from '../oci/transport'

export type ObjectStore = {
  has(id: string): Promise<boolean>
  get(id: string): Promise<Buffer>
  put(input: { id: string; bytes: Buffer }): Promise<void>
  missing(ids: string[]): Promise<string[]>
}

export const verifyObject = (input: { id: string; kind: string; bytes: Buffer }): boolean => port.verifyObject(input.id, input.kind, input.bytes)

// the user's store is an OCI image layout (oci-routing.tree's local-store), whose refusals are oci-failure: lifted to
// the original's OciError for a TypeScript caller
export const localObjectStore = (input?: { root: string }): ObjectStore =>
  (input ? port.rootedObjectStore(input.root) : liftRecord(port.localObjectStore() as object)) as ObjectStore
