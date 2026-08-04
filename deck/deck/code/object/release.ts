// A release: one published version of a package, committed on `@term/base`.
//
// This replaces `build.ts`'s `buildCommit` and `graph.ts`'s `commitClosure`. A version
// is a base `Dataset` of file records (`dataset.ts`), built by `version.ts`, and
// committed through base's `Repository`. That brings history, branches, tags, reflog
// and merge with it, none of which the hand-written commit object had.
//
// The closure is the set of chunk ids a receiver needs in order to reach the release:
// the tree's own nodes, plus every chunk of every file. It is what gets negotiated
// against the registry with `findMissing`, so only what is absent moves.

import { Repository } from '@term/base/code/repo/repo'
import { MemoryChunkStore } from '@term/base/code/store/chunk-store'
import { treeNodeRefs } from '@term/base/code/store/tree'
import { MemoryRefStore } from '@term/base/code/store/ref-store'
import type { CommitMeta } from '@term/base/code/repo/repo'

import { datasetOfFiles } from './dataset'
import type { PackageFile } from './dataset'
import { buildVersion } from './version'
import type { ChunkParams } from './chunk'
import type { ObjectStore } from './store'

export type Release = {
  // the base commit naming this release
  commit: string
  // the prolly-tree root of its file set
  root: string
  files: Array<PackageFile>
  // every chunk id a receiver needs to reach this release
  closure: Array<string>
  // the tree and commit chunks, held in memory until they are shipped
  chunks: MemoryChunkStore
}

// The branch a package's releases are committed on. One line of history per package.
export const RELEASE_BRANCH = 'main'

// Build a release from a directory: walk, chunk, write the tree, commit.
export async function buildRelease(input: {
  dir: string
  store: ObjectStore
  meta: CommitMeta
  params?: ChunkParams
  exclude?: Set<string>
}): Promise<Release> {
  const built = await buildVersion({
    dir: input.dir,
    store: input.store,
    params: input.params,
    exclude: input.exclude,
  })

  // commit the version through base, which owns history. The stores are in memory: a
  // publish computes locally and then ships, so nothing here needs to await.
  const chunks = built.treeChunks
  const repo = new Repository(chunks, new MemoryRefStore())
  const result = repo.commit(
    RELEASE_BRANCH,
    input.meta,
    datasetOfFiles(built.files),
  )

  if (!result.ok) {
    const first = result.diagnostics?.[0]

    throw new Error(
      `could not commit release${first ? `: ${first.message}` : ''}`,
    )
  }

  return {
    commit: result.commit,
    root: built.root,
    files: built.files,
    closure: closureOf({ commit: result.commit, chunks, files: built.files }),
    chunks,
  }
}

// Every chunk id needed to reach a release.
//
// The tree's nodes come from the store the tree was written into; the file bytes come
// from each record's chunk list. Both are content-addressed, so a receiver that already
// holds an id holds its whole subtree, which is what makes the transfer O(change).
export function closureOf(input: {
  commit: string
  chunks: MemoryChunkStore
  files: Array<PackageFile>
}): Array<string> {
  const ids = new Set<string>(input.chunks.keys())

  ids.add(input.commit)

  for (const file of input.files) {
    for (const chunk of file.chunks) {
      ids.add(chunk)
    }
  }

  return [...ids].sort()
}

// The closure of a release already IN a store, walked over the base prolly tree.
//
// The server side needs this to check that a publish is complete before it moves a ref:
// every node and every record chunk the commit reaches must be present, or the release
// would be a dangling reference.
export async function reachableFromCommit(input: {
  commitId: string
  store: ObjectStore
}): Promise<Set<string>> {
  const ids = new Set<string>([input.commitId])

  const bytes = await input.store.get(input.commitId)
  const commit = JSON.parse(bytes.toString('utf8')) as { root: string }

  const walk = async (id: string): Promise<void> => {
    if (ids.has(id)) {
      return
    }

    ids.add(id)

    const node = await input.store.get(id)
    const { leaf, refs } = treeNodeRefs(node.toString('utf8'))

    for (const ref of refs) {
      if (leaf) {
        // a leaf's refs are record chunks, which are terminal
        ids.add(ref)
        continue
      }

      await walk(ref)
    }
  }

  await walk(commit.root)

  return ids
}
