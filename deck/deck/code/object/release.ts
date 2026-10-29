// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/object/release.ts's exports, with
// their shapes, answered by deck/deck/code/object/release-building.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-object-release.
import * as port from '@term/deck/code/object/release-building'
import { defaultChunkParams } from '@term/deck/code/object/content-chunking'
import { defaultVersionExclude } from '@term/deck/code/object/package-version'

export type Release = {
  commit: string
  root: string
  files: any[]
  closure: string[]
  chunks: any
}

export const RELEASE_BRANCH = port.releaseBranch()

export const buildRelease = (input: {
  dir: string
  store: unknown
  meta: unknown
  params?: unknown
  exclude?: Set<string>
  include?: string[]
}): Promise<Release> =>
  port.buildRelease(
    input.dir,
    input.store,
    input.meta,
    input.params ?? defaultChunkParams(),
    input.exclude ? [...input.exclude] : defaultVersionExclude(),
    input.include ?? [],
  ) as Promise<Release>
export const closureOf = (input: {
  commit: string
  chunks: unknown
  files: any[]
}): string[] =>
  port.closureOf(input.commit, input.chunks, input.files)
export const reachableFromCommit = (input: {
  commitId: string
  store: unknown
}): Promise<Set<string>> =>
  port.reachableFromCommit(input.commitId, input.store) as Promise<
    Set<string>
  >
