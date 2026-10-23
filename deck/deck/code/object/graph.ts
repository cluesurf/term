// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/object/graph.ts's exports, with
// their shapes, answered by deck/deck/code/object/object-closure.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-object-graph.
import * as port from '@term/deck/code/object/object-closure'

export type ManifestFile = { path: string; blob: string; size: number; mode: 'file' | 'exec' }
export type Manifest = { package: string; ref: string; files: ManifestFile[] }

export const treeClosure = (input: { treeId: string; store: unknown; into?: Set<string> }): Promise<Set<string>> =>
  port.treeClosure(input.treeId, input.store, input.into ?? new Set<string>()) as Promise<Set<string>>
export const commitClosure = (input: { commitId: string; store: unknown }): Promise<Set<string>> =>
  port.commitClosure(input.commitId, input.store) as Promise<Set<string>>
export const flattenTree = (input: { treeId: string; store: unknown; prefix?: string }): Promise<ManifestFile[]> =>
  port.flattenTree(input.treeId, input.store, input.prefix ?? '') as Promise<ManifestFile[]>
export const buildManifest = (input: { commitId: string; ref: string; package: string; store: unknown }): Promise<Manifest> =>
  port.buildManifest(input.commitId, input.ref, input.package, input.store) as Promise<Manifest>
