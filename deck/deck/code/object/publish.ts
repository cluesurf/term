/**
 * Client publish: build a commit locally, upload only the objects the
 * registry is missing, then create the version or move the branch.
 *
 * This is the delta-publish flow: after building the commit into the local
 * store, the client asks the registry which of the commit's object ids it
 * lacks (FindMissingBlobs), uploads exactly those, signs the commit id,
 * and commits. A one-line change to a big package uploads a handful of
 * objects (see note/term/registry/04).
 */

import { buildCommit } from './build'
import { commitClosure } from './graph'
import { ObjectStore } from './store'
import { Registry, PublishTarget } from './registry'
import { signId, Keypair } from './sign'
import { ChunkParams } from './chunk'
import { TreeParams } from './model'

export async function publishPackage(input: {
  dir: string
  package: string
  target: PublishTarget
  local: ObjectStore
  registry: Registry
  keypair: Keypair
  author: string
  time: string
  message?: string
  parents?: string[]
  deps?: Record<string, string>
  params?: ChunkParams
  treeParams?: TreeParams
}): Promise<{ commitId: string; ref: string; uploaded: number }> {
  // 1. build the commit into the local content store
  const { commitId } = await buildCommit({
    dir: input.dir,
    package: input.package,
    deps: input.deps ?? {},
    author: input.author,
    time: input.time,
    message: input.message,
    parents: input.parents,
    store: input.local,
    params: input.params,
    treeParams: input.treeParams,
  })

  // 2. compute the commit's full object closure
  const closure = await commitClosure({ commitId, store: input.local })
  const ids = Array.from(closure)

  // 3. negotiate: ask the registry which objects it is missing
  const missing = await input.registry.findMissing(ids)

  // 4. upload only the missing objects
  for (const id of missing) {
    const bytes = await input.local.get(id)
    await input.registry.putObject({ id, bytes })
  }

  // 5. sign the commit id and publish (create version or move branch)
  const sig = signId({ id: commitId, privateKey: input.keypair.privateKey })
  const res = await input.registry.publishCommit({
    package: input.package,
    target: input.target,
    commit: commitId,
    sig,
    key: input.keypair.publicKey,
  })

  return { commitId, ref: res.ref, uploaded: missing.length }
}
