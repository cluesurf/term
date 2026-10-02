// `term load` from an OCI registry.
//
// Resolving reads one manifest and one small config per version, verifies both, and asks the trust policy whether
// the signer may publish the scope. Installing then fetches only what the local store lacks: a pack is skipped when
// every object it holds is already local, which is the normal case for a near-identical version, since an unchanged
// run of objects packs to the same digest. Every object is re-hashed before it enters the store, every pack is
// opened under a decompression limit and must hold exactly what the files layer placed in it, and the checkout
// writes nowhere outside its destination (`safeJoin`, object/restore.ts).
//
// What a lockfile pins, and what each pin defends against:
//
//   hash   the manifest digest. A tag moved to other bytes fails the install, loudly, instead of installing them
//   key    the signer's public key. A version re-signed by another key fails, even one the scope's key set allows,
//          because a key the set gained after the lock was written is a key nobody reviewed for this lock

import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'

import { installPackage } from '../object/install'
import type { ObjectStore } from '../object/store'
import type { Registry } from '../object/registry'
import {
  LIMITS,
  openRemotePack,
  parseDeckConfig,
  parseDeckManifest,
  parseFilesLayer,
  verifyDeckConfig,
  type DeckConfig,
  type FilesLayer,
  type ParsedManifest,
} from './artifact'
import { trustedKeys, type TrustedKeys } from './keys'
import { isDigest, versionOfTag } from './reference'
import { OciError, sha256Digest, type OciTransport } from './transport'

export type OciVersion = {
  digest: string
  manifest: ParsedManifest
  manifestBytes: Buffer
  config: DeckConfig
  configBytes: Buffer
  trust: TrustedKeys | undefined
}

/** Every version a repository's tags carry, in the order the registry listed them. */
export async function listOciVersions(input: { transport: OciTransport; repository: string }): Promise<string[]> {
  const tags = await input.transport.listTags({ repository: input.repository })

  return tags.map(versionOfTag).filter((version): version is string => version !== undefined)
}

/**
 * Read and verify one version: the manifest (against the pinned digest when there is one), the config, its
 * signature, and the signer against the lockfile's key pin and the scope's key set.
 */
export async function readOciVersion(input: {
  transport: OciTransport
  repository: string
  package: string
  // a tag, or a digest
  reference: string
  scope: string
  keysRepository: string
  host: string
  trustDir: string
  expect?: { digest?: string; key?: string; version?: string }
  env?: NodeJS.ProcessEnv
  warn?: (message: string) => void
}): Promise<OciVersion> {
  const fetched = await input.transport.getManifest({ repository: input.repository, reference: input.reference })

  if (!fetched) {
    throw new OciError(`${input.package}: ${input.transport.label}/${input.repository} has no ${input.reference}`, 404)
  }

  if (input.expect?.digest && fetched.digest !== input.expect.digest) {
    throw new OciError(
      `${input.package}@${input.reference} has moved: lock.tree pins ${input.expect.digest}, the registry now serves ${fetched.digest}. ` +
        'A published version must never change. If this is expected, delete the entry from lock.tree and load again',
    )
  }

  const manifest = parseDeckManifest(fetched.bytes)
  const configBytes = await input.transport.getBlob({
    repository: input.repository,
    digest: manifest.config.digest,
    size: manifest.config.size,
    limit: LIMITS.config,
  })
  const config = parseDeckConfig(configBytes)

  verifyDeckConfig({
    config,
    manifest,
    package: input.package,
    tag: isDigest(input.reference) ? undefined : input.reference,
    version: input.expect?.version,
  })

  if (input.expect?.key && config.key !== input.expect.key) {
    throw new OciError(
      `${input.package}@${config.version} is signed by a different key than lock.tree pins. ` +
        'If the scope rotated its keys on purpose, delete the entry from lock.tree and load again',
    )
  }

  const trust = await trustedKeys({
    transport: input.transport,
    repository: input.keysRepository,
    scope: input.scope,
    host: input.host,
    trustDir: input.trustDir,
    env: input.env,
  })

  if (trust && !trust.keys.includes(config.key)) {
    throw new OciError(`${input.package}@${config.version} is signed by a key outside the key set of ${input.scope} (${trust.source})`)
  }

  if (!trust && !input.expect?.key) {
    input.warn?.(`${input.scope} publishes no key set: trusting the signer of ${input.package}@${config.version} on first use, pinned in lock.tree`)
  }

  return { digest: fetched.digest, manifest, manifestBytes: fetched.bytes, config, configBytes, trust }
}

async function pool<T>(items: T[], width: number, work: (item: T, at: number) => Promise<void>): Promise<void> {
  let next = 0

  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      for (;;) {
        const at = next
        next += 1

        if (at >= items.length) {
          return
        }

        await work(items[at]!, at)
      }
    }),
  )
}

// A Registry over the local store alone. By the time it is used every object of the closure has been fetched and
// verified, so a miss here is an incomplete closure, and it says so.
function storeRegistry(local: ObjectStore, commit: string): Registry {
  const refuse = (): never => {
    throw new OciError('the local store is read-only during a checkout')
  }

  return {
    findMissing: ids => local.missing(ids),
    putObject: refuse,
    putPack: refuse,
    getObject: async id => {
      if (!(await local.has(id))) {
        throw new OciError(`closure incomplete: object ${id} is in no layer of the artifact`)
      }

      return local.get(id)
    },
    hasObject: id => local.has(id),
    resolve: async () => commit,
    publishCommit: refuse,
    manifest: refuse,
  }
}

/**
 * Fetch a verified version's objects into the local store and check it out at `dest`. The checkout goes to a
 * fresh directory beside `dest` and is renamed into place, so a failed install never leaves half a package.
 */
export async function installOciVersion(input: {
  transport: OciTransport
  repository: string
  version: OciVersion
  dest: string
  local: ObjectStore
  // the store read as a registry, to keep the manifest and its tag for an offline install. Omitted when the
  // transport already IS the store
  cache?: OciTransport
  concurrency?: number
}): Promise<{ packsFetched: number; packsSkipped: number; looseFetched: number; bytes: number; files: FilesLayer }> {
  const { manifest, config } = input.version
  const width = input.concurrency ?? 8
  let bytes = 0

  const filesBytes = await input.transport.getBlob({
    repository: input.repository,
    digest: manifest.files.digest,
    size: manifest.files.size,
    limit: LIMITS.files,
  })
  const files = parseFilesLayer({ bytes: filesBytes, manifest, config })
  bytes += filesBytes.length

  let packsFetched = 0
  let packsSkipped = 0

  await pool(manifest.packs, width, async (pack, at) => {
    const placed = files.packs[at]!.objects
    const missing = await input.local.missing(placed.map(([id]) => id))

    if (missing.length === 0) {
      packsSkipped += 1

      return
    }

    const packBytes = await input.transport.getBlob({ repository: input.repository, digest: pack.digest, size: pack.size, limit: LIMITS.pack })
    const open = openRemotePack({ bytes: packBytes, expect: placed })
    const wanted = new Set(missing)

    for (const entry of open.toc) {
      if (!wanted.has(entry.id)) {
        continue
      }

      const object = Buffer.from(open.body.subarray(entry.site, entry.site + entry.size))

      if (sha256Digest(object) !== entry.id) {
        throw new OciError(`pack ${pack.digest} holds bytes that do not hash to ${entry.id}`)
      }

      await input.local.put({ id: entry.id, bytes: object })
    }

    // the pack itself is kept too, so the store is a complete layout `oras cp` can copy from
    await input.local.put({ id: pack.digest, bytes: packBytes })
    packsFetched += 1
    bytes += packBytes.length
  })

  let looseFetched = 0

  await pool(manifest.loose, width, async layer => {
    if (await input.local.has(layer.digest)) {
      return
    }

    const object = await input.transport.getBlob({ repository: input.repository, digest: layer.digest, size: layer.size, limit: LIMITS.object })
    await input.local.put({ id: layer.digest, bytes: object })
    looseFetched += 1
    bytes += object.length
  })

  // the commit must name the tree root the signed config names, or the signature covered a different tree
  const commitBytes = await input.local.get(config.commit).catch(() => {
    throw new OciError(`closure incomplete: the commit ${config.commit} is in no layer of the artifact`)
  })
  const root = (JSON.parse(commitBytes.toString('utf8')) as { root?: string }).root

  if (root !== config.root) {
    throw new OciError(`commit ${config.commit} names root ${root ?? 'none'}, the signed config names ${config.root}`)
  }

  // keep what an offline install needs: the config, the files layer and the tagged manifest
  if (input.cache) {
    await input.local.put({ id: manifest.config.digest, bytes: input.version.configBytes })
    await input.local.put({ id: manifest.files.digest, bytes: filesBytes })
    await input.cache.putManifest({
      repository: input.repository,
      reference: config.tag,
      bytes: input.version.manifestBytes,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
    })
  }

  const staging = `${input.dest}.tmp-${randomUUID()}`

  try {
    await installPackage({
      package: config.package,
      ref: { kind: 'commit', commit: config.commit },
      dest: staging,
      local: input.local,
      registry: storeRegistry(input.local, config.commit),
    })

    await fs.mkdir(path.dirname(input.dest), { recursive: true })
    await fs.rm(input.dest, { recursive: true, force: true })
    await fs.rename(staging, input.dest)
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
    throw error
  }

  return { packsFetched, packsSkipped, looseFetched, bytes, files }
}
