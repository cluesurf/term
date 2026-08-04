/**
 * The registry: the server-side operations and the client-facing
 * Registry interface.
 *
 * The server holds an ObjectStore (the global content store) and a
 * RefStore (branches and versions). It exposes: find which of a set of
 * object ids are missing (the FindMissingBlobs handshake), accept a
 * verified object, resolve a ref to a commit, publish a commit (verify
 * its closure is complete and signed, then create a version or move a
 * branch), and read the flat manifest.
 *
 * A `Registry` is what the client talks to. `directRegistry` wraps a
 * server ObjectStore plus RefStore into that interface for in-process use
 * and tests; an HTTP registry implements the same interface over the
 * wire (see note/term/registry/04 and 05).
 */

import { hashObject, isObjectId } from './hash'
import { ObjectStore } from './store'
import { RefStore } from './refs'
import { buildManifest, Manifest } from './graph'
import { reachableFromCommit } from './release'
import { verifyId } from './sign'
import { openPack } from './pack'

/** How a commit is being published: as an immutable version, or onto a branch. */
export type PublishTarget =
  | { kind: 'version'; version: string }
  | { kind: 'branch'; branch: string; expected?: string | null }

/** A resolvable reference to a commit. */
export type Ref =
  | { kind: 'version'; version: string }
  | { kind: 'branch'; branch: string }
  | { kind: 'commit'; commit: string }

/** The client-facing registry surface (local or remote). */
export type Registry = {
  findMissing(ids: string[]): Promise<string[]>
  putObject(input: { id: string; bytes: Buffer }): Promise<void>
  /**
   * Upload a pack: a solid-compressed bundle of many objects (note/term/
   * registry/17). The server unpacks it, verifies each object against its
   * id, and stores it. One request carries hundreds of objects, so a large
   * package publishes in a few hundred pack requests instead of ~90k object
   * PUTs, and one failed pack retries alone instead of aborting the run.
   */
  putPack(input: { id: string; bytes: Buffer }): Promise<void>
  getObject(id: string): Promise<Buffer>
  hasObject(id: string): Promise<boolean>
  resolve(input: { package: string; ref: Ref }): Promise<string>
  publishCommit(input: {
    package: string
    target: PublishTarget
    commit: string
    sig: string
    key: string
  }): Promise<{ ok: true; ref: string }>
  manifest(input: { package: string; ref: Ref }): Promise<Manifest>
}

/**
 * A trusted-key lookup: given a package scope, return the public keys
 * allowed to publish it. In production this is the scope-ownership table;
 * for tests it is a static map.
 */
export type ScopeKeys = (scope: string) => Promise<string[]>

// The object kinds, tried in turn to recover an object's kind from its
// bytes. Domain separation guarantees at most one kind matches a given id.
const KINDS = ['chunk', 'blob', 'tree', 'commit'] as const

/** True if `bytes` hash to `id` under any object kind. */
export function objectMatches(input: { id: string; bytes: Buffer }): boolean {
  for (const kind of KINDS) {
    if (hashObject({ kind, bytes: input.bytes }) === input.id) {
      return true
    }
  }

  return false
}

// Verify an object's bytes hash to its claimed id (under some kind), then
// store it. Rejects a mismatched object outright (self-verifying). The
// kind is inferred, so the wire never has to carry it.
export async function acceptObject(input: {
  store: ObjectStore
  id: string
  bytes: Buffer
}): Promise<void> {
  if (!isObjectId(input.id)) {
    throw new Error(`malformed object id: ${input.id}`)
  }

  if (!objectMatches({ id: input.id, bytes: input.bytes })) {
    throw new Error(`object hash mismatch for ${input.id}`)
  }

  await input.store.put({ id: input.id, bytes: input.bytes })
}

/**
 * Accept a pack: decompress it, then verify and store every object it holds
 * (each still self-verifies against its own id, so the pack is only a
 * container and cannot smuggle a wrong object). This is the server side of
 * the batched pack upload; objects land in the store exactly as if they had
 * been PUT one by one.
 */
export async function acceptPack(input: {
  store: ObjectStore
  bytes: Buffer
}): Promise<number> {
  const open = openPack(input.bytes)

  for (const entry of open.toc) {
    await acceptObject({
      store: input.store,
      id: entry.id,
      bytes: Buffer.from(
        open.body.subarray(entry.site, entry.site + entry.size),
      ),
    })
  }

  return open.toc.length
}

/** Resolve a ref to a commit id. */
export async function resolveRef(input: {
  refs: RefStore
  package: string
  ref: Ref
}): Promise<string> {
  const { ref } = input

  if (ref.kind === 'commit') {
    return ref.commit
  }

  if (ref.kind === 'version') {
    const commit = await input.refs.getVersion({
      package: input.package,
      version: ref.version,
    })

    if (!commit) {
      throw new Error(`no such version ${input.package}@${ref.version}`)
    }

    return commit
  }

  const commit = await input.refs.getBranch({
    package: input.package,
    branch: ref.branch,
  })

  if (!commit) {
    throw new Error(`no such branch ${input.package}#${ref.branch}`)
  }

  return commit
}

/**
 * Publish a commit: verify its whole object closure is present, verify the
 * signature against a key authorized for the scope, then either create an
 * immutable version (write-once) or fast-forward a branch. This is the
 * atomic commit step (see note/term/registry/04).
 */
export async function publishCommit(input: {
  store: ObjectStore
  refs: RefStore
  scopeKeys: ScopeKeys
  package: string
  target: PublishTarget
  commit: string
  sig: string
  key: string
}): Promise<{ ok: true; ref: string }> {
  // 1. verify the signature over the commit id against an authorized key
  const scope = scopeOf(input.package)
  const allowed = await input.scopeKeys(scope)

  if (!allowed.includes(input.key)) {
    throw new Error(`key not authorized for scope ${scope}`)
  }

  if (!verifyId({ id: input.commit, sig: input.sig, publicKey: input.key })) {
    throw new Error(`invalid signature for ${input.commit}`)
  }

  // 2. verify the commit's whole closure is present in the store
  const closure = await reachableFromCommit({
    commitId: input.commit,
    store: input.store,
  })

  const missing = await input.store.missing(Array.from(closure))

  if (missing.length > 0) {
    throw new Error(
      `commit ${input.commit} closure incomplete: ${missing.length} objects missing`,
    )
  }

  // 3. create the ref (write-once version, or fast-forward branch)
  if (input.target.kind === 'version') {
    const err = await input.refs.createVersion({
      package: input.package,
      version: input.target.version,
      commit: input.commit,
    })

    if (err) {
      throw new Error(
        `version ${input.package}@${input.target.version} already published`,
      )
    }

    return { ok: true, ref: `version/${input.target.version}` }
  }

  const err = await input.refs.setBranch({
    package: input.package,
    branch: input.target.branch,
    commit: input.commit,
    expected: input.target.expected,
  })

  if (err) {
    throw new Error(
      `branch ${input.package}#${input.target.branch} moved under you (fast-forward required)`,
    )
  }

  return { ok: true, ref: `branch/${input.target.branch}` }
}

/** The scope (`@term`) of a fully-qualified package name (`@term/bind`). */
export function scopeOf(pkg: string): string {
  const slash = pkg.indexOf('/')

  return slash > 0 ? pkg.slice(0, slash) : pkg
}

/**
 * Wrap a server ObjectStore + RefStore into a Registry, for in-process
 * use and tests. An HTTP registry implements the same interface remotely.
 */
export function directRegistry(input: {
  store: ObjectStore
  refs: RefStore
  scopeKeys: ScopeKeys
}): Registry {
  return {
    findMissing: ids => input.store.missing(ids),

    putObject: async obj => {
      await acceptObject({
        store: input.store,
        id: obj.id,
        bytes: obj.bytes,
      })
    },

    putPack: async pack => {
      await acceptPack({ store: input.store, bytes: pack.bytes })
    },

    getObject: id => input.store.get(id),

    hasObject: id => input.store.has(id),

    resolve: args =>
      resolveRef({ refs: input.refs, package: args.package, ref: args.ref }),

    publishCommit: args =>
      publishCommit({
        store: input.store,
        refs: input.refs,
        scopeKeys: input.scopeKeys,
        package: args.package,
        target: args.target,
        commit: args.commit,
        sig: args.sig,
        key: args.key,
      }),

    manifest: async args => {
      const commit = await resolveRef({
        refs: input.refs,
        package: args.package,
        ref: args.ref,
      })

      return buildManifest({
        commitId: commit,
        ref: refLabel(args.ref),
        package: args.package,
        store: input.store,
      })
    },
  }
}

function refLabel(ref: Ref): string {
  if (ref.kind === 'version') {
    return ref.version
  }

  if (ref.kind === 'branch') {
    return ref.branch
  }

  return ref.commit
}
