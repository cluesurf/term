// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/object/checkout.ts's exports, with
// their shapes, answered by deck/deck/code/object/tree-checkout.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-object-checkout.
import * as port from '@term/deck/code/object/tree-checkout'

export const reassembleBlob = (input: {
  blobId: string
  store: unknown
}): Promise<Buffer> =>
  port.reassembleBlob(input.blobId, input.store) as Promise<Buffer>
export const checkoutTree = (input: {
  treeId: string
  dest: string
  store: unknown
}): Promise<void> =>
  port.checkoutTree(input.treeId, input.dest, input.store)
export const checkoutCommit = (input: {
  commitId: string
  dest: string
  store: unknown
}): Promise<never> =>
  port.checkoutCommit(
    input.commitId,
    input.dest,
    input.store,
  ) as Promise<never>
