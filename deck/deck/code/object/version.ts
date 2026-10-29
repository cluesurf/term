// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/object/version.ts's exports, with
// their shapes, answered by deck/deck/code/object/package-version.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-object-version.
// The port takes every parameter: the defaults the original filled in are filled here.
import * as port from '@term/deck/code/object/package-version'
import * as chunking from '@term/deck/code/object/content-chunking'

type ChunkParams = { min: number; avg: number; max: number }

type VersionInput = {
  dir: string
  store: unknown
  params?: ChunkParams
  exclude?: Set<string>
  include?: string[]
}

export type BuiltVersion = {
  root: string
  files: never[]
  treeChunks: never
}

const argumentsOf = (
  input: VersionInput,
): [string, never, ChunkParams, string[], string[]] => [
  input.dir,
  input.store as never,
  input.params ?? chunking.defaultChunkParams(),
  input.exclude ? [...input.exclude] : port.defaultVersionExclude(),
  input.include ?? [],
]

export const readVersionFiles = (
  input: VersionInput,
): Promise<never[]> =>
  port.readVersionFiles(...argumentsOf(input)) as Promise<never[]>
export const buildVersion = (
  input: VersionInput,
): Promise<BuiltVersion> =>
  port.buildVersion(...argumentsOf(input)) as Promise<BuiltVersion>
