// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/object/refs.ts's exports, with
// their shapes, answered by deck/deck/code/object/ref-store.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-object-refs.
// store already has the original's RefStore shape.
import * as port from '@term/deck/code/object/ref-store'

export type RefError =
  | { kind: 'version-exists' }
  | { kind: 'branch-moved'; current: string | null }
  | null

export type RefStore = {
  getVersion(input: { package: string; version: string }): Promise<string | null>
  createVersion(input: { package: string; version: string; commit: string }): Promise<RefError>
  listVersions(pkg: string): Promise<{ version: string; commit: string }[]>
  getBranch(input: { package: string; branch: string }): Promise<string | null>
  setBranch(input: { package: string; branch: string; commit: string; expected?: string | null }): Promise<RefError>
  listBranches(pkg: string): Promise<{ branch: string; commit: string }[]>
}

export const memoryRefStore = (): RefStore => port.memoryRefStore() as unknown as RefStore
