// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/object/build.ts's exports, with
// their shapes, answered by deck/deck/code/object/object-building.tree. The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-object-build.
// The port takes every parameter: the defaults the original filled in are filled here.
import * as port from '@term/deck/code/object/object-building'
import * as chunking from '@term/deck/code/object/content-chunking'
import * as shape from '@term/deck/code/object/object-shape'


type ChunkParams = { min: number; avg: number; max: number }
type TreeParams = { avgFanout: number; min: number; max: number }

export const buildBlob = (input: { filePath: string; store: unknown; params?: ChunkParams }): Promise<string> =>
  port.buildBlob(input.filePath, input.store, input.params ?? chunking.defaultChunkParams())

export const buildTree = (input: { dir: string; store: unknown; params?: ChunkParams; treeParams?: TreeParams; exclude?: Set<string> }): Promise<string> =>
  port.buildTree(input.dir, input.store, input.params ?? chunking.defaultChunkParams(), input.treeParams ?? shape.defaultTreeParams(), input.exclude ? [...input.exclude] : port.defaultBuildExclude())

export const buildCommit = (input: {
  dir: string
  package: string
  deps: Record<string, string>
  author: string
  time: string
  message?: string
  parents?: string[]
  store: unknown
  params?: ChunkParams
  treeParams?: TreeParams
}): Promise<{ commitId: string; commit: never }> =>
  port.buildCommit(input.dir, input.package, input.deps, input.author, input.time, input.message ?? '', input.parents ?? [], input.store, input.params ?? chunking.defaultChunkParams(), input.treeParams ?? shape.defaultTreeParams()) as never
