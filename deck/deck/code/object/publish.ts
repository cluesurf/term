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

import { buildRelease } from './release'
import { ObjectStore } from './store'
import { Registry, PublishTarget } from './registry'
import { signId, Keypair } from './sign'
import { ChunkParams } from './chunk'
import { buildPacks, Pack, PackInput } from './pack'

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

/**
 * Upload one pack, retrying on transient network failure with exponential
 * backoff. A large publish is many packs; retrying per pack means one flaky
 * request re-sends a single pack, never aborting the whole run (the failure
 * mode that kept the ~90k-object bind publish from ever completing).
 */
async function uploadPack(
  registry: Registry,
  pack: Pack,
  tries = 5,
): Promise<void> {
  let lastError: unknown

  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      await registry.putPack({ id: pack.id, bytes: pack.bytes })

      return
    } catch (error) {
      lastError = error
      await sleep(300 * 2 ** attempt)
    }
  }

  throw lastError
}

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
}): Promise<{
  commitId: string
  ref: string
  uploaded: number
  packs: number
}> {
  // 1. build the commit into the local content store
  const t0 = Date.now()
  const since = (): string => `${((Date.now() - t0) / 1000).toFixed(1)}s`
  const log = (message: string): void =>
    console.error(`  [publish ${input.package}] ${message} (${since()})`)

  // The version is a @term/base dataset of file records, committed through base's
  // Repository, so a release carries history rather than a bare commit object. The
  // tree is computed in memory and its chunks are shipped below.
  const release = await buildRelease({
    dir: input.dir,
    store: input.local,
    meta: {
      author: input.author,
      time: Date.parse(input.time) || 0,
      message: input.message ?? '',
    },
    params: input.params,
  })

  const commitId = release.commit
  log(`built release, ${release.files.length} files`)

  // 2. the closure: the tree's nodes plus every chunk of every file. Content-addressed
  // throughout, so holding an id means holding its whole subtree.
  const ids = release.closure
  log(`closure = ${ids.length} objects`)

  // 3. negotiate: ask the registry which objects it is missing
  const missing = await input.registry.findMissing(ids)
  log(`${missing.length} missing on registry`)

  // 4. bundle the missing objects into content-defined packs and upload each
  // pack in one request (hundreds of objects), retried independently. Sorting
  // by id makes the pack cuts content-defined, so unchanged regions produce
  // identical packs the registry already has and never re-sends. This is the
  // fix for large packages: ~90k object PUTs become a few hundred pack POSTs
  // (see note/term/registry/17).
  const packInputs: PackInput[] = []

  for (const id of missing) {
    // a tree or commit chunk is still in memory; a file chunk is already in the store
    const inMemory = release.chunks.get(id)
    const bytes =
      inMemory === undefined
        ? await input.local.get(id)
        : Buffer.from(inMemory, 'utf8')

    packInputs.push({ id, path: id, bytes })
  }

  packInputs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const { packs } = buildPacks({ blobs: packInputs })
  const packBytes = packs.reduce((sum, pack) => sum + pack.bytes.length, 0)
  log(
    `packed into ${packs.length} packs, ${(packBytes / 1024 / 1024).toFixed(1)} MB gzipped`,
  )

  const CONCURRENCY = 12

  for (let i = 0; i < packs.length; i += CONCURRENCY) {
    const batch = packs.slice(i, i + CONCURRENCY)
    await Promise.all(batch.map(pack => uploadPack(input.registry, pack)))
    log(`uploaded ${Math.min(i + CONCURRENCY, packs.length)}/${packs.length} packs`)
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

  return {
    commitId,
    ref: res.ref,
    uploaded: missing.length,
    packs: packs.length,
  }
}
