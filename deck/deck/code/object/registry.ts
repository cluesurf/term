// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/object/registry.ts's exports, with
// their shapes, answered by deck/deck/code/object/registry-operations.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-object-registry.
import * as port from '@term/deck/code/object/registry-operations'

export type PublishTarget = { kind: 'version'; version: string } | { kind: 'branch'; branch: string; expected?: string | null }
export type Ref = { kind: 'version'; version: string } | { kind: 'branch'; branch: string } | { kind: 'commit'; commit: string }
export type Registry = {
  findMissing(ids: string[]): Promise<string[]>
  putObject(input: { id: string; bytes: Buffer }): Promise<void>
  putPack(input: { id: string; bytes: Buffer }): Promise<void>
  getObject(id: string): Promise<Buffer>
  hasObject(id: string): Promise<boolean>
  resolve(input: { package: string; ref: Ref }): Promise<string>
  publishCommit(input: { package: string; target: PublishTarget; commit: string; sig: string; key: string }): Promise<{ ok: true; ref: string }>
  manifest(input: { package: string; ref: Ref }): Promise<any>
}
export type ScopeKeys = (scope: string) => Promise<string[]>

export const objectMatches = (input: { id: string; bytes: Buffer }): boolean => port.objectMatches(input.id, input.bytes) as boolean
export const acceptObject = (input: { store: unknown; id: string; bytes: Buffer }): Promise<void> =>
  port.acceptObject(input.store, input.id, input.bytes) as Promise<void>
export const acceptPack = (input: { store: unknown; bytes: Buffer }): Promise<number> => port.acceptPack(input.store, input.bytes) as Promise<number>
export const resolveRef = (input: { refs: unknown; package: string; ref: Ref }): Promise<string> =>
  port.resolveRef(input.refs, input.package, input.ref) as Promise<string>
export const publishCommit = (input: { store: unknown; refs: unknown; scopeKeys: ScopeKeys; package: string; target: PublishTarget; commit: string; sig: string; key: string }): Promise<{ ok: true; ref: string }> =>
  port.publishCommit(input.store, input.refs, input.scopeKeys, input.package, input.target, input.commit, input.sig, input.key) as Promise<{ ok: true; ref: string }>
export const scopeOf = (pkg: string): string => port.scopeOf(pkg) as string
export const directRegistry = (input: { store: unknown; refs: unknown; scopeKeys: ScopeKeys }): Registry =>
  port.directRegistry(input.store, input.refs, input.scopeKeys) as unknown as Registry
