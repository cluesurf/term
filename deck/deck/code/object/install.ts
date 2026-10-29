// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/object/install.ts's exports, with
// their shapes, answered by deck/deck/code/object/package-installing.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-object-install.
import * as port from '@term/deck/code/object/package-installing'

export const installPackage = (input: {
  package: string
  ref: unknown
  dest: string
  local: unknown
  registry: unknown
}): Promise<{ commitId: string; fetched: number }> =>
  port.installPackage(
    input.package,
    input.ref,
    input.dest,
    input.local,
    input.registry,
  ) as Promise<{ commitId: string; fetched: number }>
