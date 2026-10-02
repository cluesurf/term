// An OCI image layout on disk, as a registry and as Term's local object store.
//
//   <dir>/oci-layout              {"imageLayoutVersion":"1.0.0"}
//   <dir>/index.json              one descriptor per tagged manifest, named by `org.opencontainers.image.ref.name`
//   <dir>/blobs/sha256/<hex>      every blob, manifest and object, by digest
//
// Because a Term object id IS a sha256 digest, the object store and the blob store are one directory: an installed
// object, a pack, a config and a manifest all sit in `blobs/sha256/`. That is what lets `term load --offline` read
// the store as a registry, and `oras cp --from-oci-layout <dir>@sha256:<digest>` copy a version straight out of it.
//
// A blob is verified before it is written and written atomically, to a unique temporary name and renamed into
// place, so a crash or two concurrent installs can never leave a partial or wrong blob under a digest. `index.json`
// is rewritten under a lock file, because two installs racing on a read-modify-write would lose a tag.
//
// A layout holds tags for many repositories, so a tag's ref name is `<prefix><repository>:<tag>`, the full name
// containerd also writes. A layout that `oras cp --to-oci-layout` wrote holds bare tags, and `bare: true` reads one.

import { randomUUID } from 'crypto'
import fs from 'fs/promises'
import path from 'path'

import type { ObjectStore } from '../object/store'
import { assertDigest, assertTag, isDigest } from './reference'
import {
  assertRepository,
  isDescriptor,
  OciError,
  sha256Digest,
  verifyDigest,
  type Descriptor,
  type OciTransport,
} from './transport'

const REF_NAME = 'org.opencontainers.image.ref.name'
const LAYOUT_FILE = JSON.stringify({ imageLayoutVersion: '1.0.0' })

type Index = {
  schemaVersion: 2
  mediaType: 'application/vnd.oci.image.index.v1+json'
  manifests: Descriptor[]
}

function blobPath(dir: string, digest: string): string {
  assertDigest(digest)

  return path.join(dir, 'blobs', 'sha256', digest.slice('sha256:'.length))
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)

    return true
  } catch {
    return false
  }
}

/** Create the layout's skeleton if it is not there. Safe to call any number of times, from any number of processes. */
export async function initLayout(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, 'blobs', 'sha256'), { recursive: true })

  if (!(await exists(path.join(dir, 'oci-layout')))) {
    await writeAtomic(path.join(dir, 'oci-layout'), Buffer.from(LAYOUT_FILE))
  }

  if (!(await exists(path.join(dir, 'index.json')))) {
    const empty: Index = { schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [] }

    await writeAtomic(path.join(dir, 'index.json'), Buffer.from(JSON.stringify(empty, null, 2)))
  }
}

async function writeAtomic(file: string, bytes: Buffer): Promise<void> {
  const tmp = `${file}.tmp-${randomUUID()}`

  try {
    await fs.writeFile(tmp, bytes, { flag: 'wx', mode: 0o644 })
    await fs.rename(tmp, file)
  } catch (error) {
    await fs.unlink(tmp).catch(() => {})
    throw error
  }
}

async function readBlobFile(dir: string, digest: string, limit: number): Promise<Buffer | undefined> {
  const file = blobPath(dir, digest)
  let handle: fs.FileHandle

  try {
    handle = await fs.open(file, 'r')
  } catch {
    return undefined
  }

  try {
    const { size } = await handle.stat()

    if (size > limit) {
      throw new OciError(`blob ${digest} is ${size} bytes, over the ${limit} byte limit`)
    }

    const bytes = await handle.readFile()
    verifyDigest({ digest, bytes, what: `stored blob ${digest}` })

    return bytes
  } finally {
    await handle.close()
  }
}

async function writeBlobFile(dir: string, digest: string, bytes: Buffer): Promise<boolean> {
  verifyDigest({ digest, bytes, what: `blob ${digest}` })
  const file = blobPath(dir, digest)

  if (await exists(file)) {
    return false
  }

  await fs.mkdir(path.dirname(file), { recursive: true })
  await writeAtomic(file, bytes)

  return true
}

// A cross-process lock on the layout's index: an exclusive create of `index.json.lock`, retried, and broken when it
// is older than any honest holder would be. Within one process the queue below serializes first, so the file lock
// only ever arbitrates between processes.
const queues = new Map<string, Promise<unknown>>()

async function withIndexLock<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const key = path.resolve(dir)
  const before = queues.get(key) ?? Promise.resolve()
  const run = before.catch(() => {}).then(() => withFileLock(dir, work))

  queues.set(key, run)

  try {
    return await run
  } finally {
    if (queues.get(key) === run) {
      queues.delete(key)
    }
  }
}

async function withFileLock<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const lock = path.join(dir, 'index.json.lock')
  const started = Date.now()

  for (;;) {
    try {
      const handle = await fs.open(lock, 'wx')
      await handle.close()
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }

      const stat = await fs.stat(lock).catch(() => undefined)

      if (stat && Date.now() - stat.mtimeMs > 30_000) {
        await fs.unlink(lock).catch(() => {})
        continue
      }

      if (Date.now() - started > 60_000) {
        throw new OciError(`timed out waiting for the lock on ${lock}`)
      }

      await new Promise(resolve => setTimeout(resolve, 25 + Math.random() * 50))
    }
  }

  try {
    return await work()
  } finally {
    await fs.unlink(lock).catch(() => {})
  }
}

async function readIndex(dir: string): Promise<Index> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8')) as Partial<Index>

    return {
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: (parsed.manifests ?? []).filter(isDescriptor),
    }
  } catch {
    return { schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [] }
  }
}

/** An OCI image layout as a registry. Repositories share one blob store, and tags are told apart by ref name. */
export function layoutTransport(input: {
  dir: string
  // prepended to `<repository>:<tag>` in a ref name, so one store can hold tags from several registries
  prefix?: string
  // read and write bare `<tag>` ref names, as a single-repository layout from `oras cp` holds
  bare?: boolean
}): OciTransport {
  const dir = input.dir
  const prefix = input.prefix ? `${input.prefix.replace(/\/+$/, '')}/` : ''

  const refName = (repository: string, tag: string): string =>
    input.bare ? tag : `${prefix}${repository}:${tag}`

  let ready: Promise<void> | undefined
  const init = (): Promise<void> => (ready ??= initLayout(dir))

  return {
    label: `layout:${dir}`,

    async hasBlob(args) {
      return exists(blobPath(dir, args.digest))
    },

    async getBlob(args) {
      const limit = args.size === undefined ? args.limit : Math.min(args.limit, args.size)
      const bytes = await readBlobFile(dir, args.digest, limit)

      if (!bytes) {
        throw new OciError(`blob ${args.digest} is not in ${dir}`, 404)
      }

      if (args.size !== undefined && bytes.length !== args.size) {
        throw new OciError(`blob ${args.digest} is ${bytes.length} bytes, its descriptor says ${args.size}`)
      }

      return bytes
    },

    async putBlob(args) {
      await init()

      return (await writeBlobFile(dir, args.digest, args.bytes)) ? 'uploaded' : 'present'
    },

    async getManifest(args) {
      assertRepository(args.repository)
      let digest = args.reference

      if (!isDigest(args.reference)) {
        assertTag(args.reference)
        const name = refName(args.repository, args.reference)
        const found = (await readIndex(dir)).manifests.find(entry => entry.annotations?.[REF_NAME] === name)

        if (!found) {
          return undefined
        }

        digest = found.digest
      }

      const bytes = await readBlobFile(dir, digest, 4 * 1024 * 1024)

      if (!bytes) {
        return undefined
      }

      const parsed = JSON.parse(bytes.toString('utf8')) as { mediaType?: string }

      return { digest, mediaType: parsed.mediaType ?? 'application/vnd.oci.image.manifest.v1+json', bytes }
    },

    async putManifest(args) {
      assertRepository(args.repository)
      await init()
      const digest = sha256Digest(args.bytes)
      await writeBlobFile(dir, digest, args.bytes)

      const parsed = JSON.parse(args.bytes.toString('utf8')) as { artifactType?: string; subject?: unknown }

      // an untagged referrer is listed in the index without a ref name, which is how a layout keeps it findable
      if (isDigest(args.reference) && parsed.subject) {
        await withIndexLock(dir, async () => {
          const index = await readIndex(dir)

          if (!index.manifests.some(entry => entry.digest === digest)) {
            index.manifests.push({
              mediaType: args.mediaType,
              digest,
              size: args.bytes.length,
              ...(parsed.artifactType ? { artifactType: parsed.artifactType } : {}),
            })
            await writeAtomic(path.join(dir, 'index.json'), Buffer.from(JSON.stringify(index, null, 2)))
          }
        })
      }

      if (!isDigest(args.reference)) {
        assertTag(args.reference)
        const name = refName(args.repository, args.reference)

        await withIndexLock(dir, async () => {
          const index = await readIndex(dir)
          const descriptor: Descriptor = {
            mediaType: args.mediaType,
            digest,
            size: args.bytes.length,
            ...(parsed.artifactType ? { artifactType: parsed.artifactType } : {}),
            annotations: { [REF_NAME]: name },
          }

          index.manifests = [...index.manifests.filter(entry => entry.annotations?.[REF_NAME] !== name), descriptor]
          await writeAtomic(path.join(dir, 'index.json'), Buffer.from(JSON.stringify(index, null, 2)))
        })
      }

      return { digest, subjectAccepted: true }
    },

    async listTags(args) {
      assertRepository(args.repository)
      const lead = input.bare ? '' : `${prefix}${args.repository}:`
      const tags: string[] = []

      for (const entry of (await readIndex(dir)).manifests) {
        const name = entry.annotations?.[REF_NAME]

        if (name?.startsWith(lead) && !name.slice(lead.length).includes(':')) {
          tags.push(name.slice(lead.length))
        }
      }

      return tags
    },

    // A layout keeps a referrer findable by listing it in `index.json` too (the image-layout spec's rule), so the
    // referrers are the indexed manifests whose `subject` is the digest asked about.
    async referrers(args) {
      assertDigest(args.digest)
      const out: Descriptor[] = []

      for (const entry of (await readIndex(dir)).manifests) {
        const bytes = await readBlobFile(dir, entry.digest, 4 * 1024 * 1024).catch(() => undefined)

        if (!bytes) {
          continue
        }

        const manifest = JSON.parse(bytes.toString('utf8')) as { subject?: { digest?: string }; artifactType?: string }

        if (manifest.subject?.digest === args.digest && (!args.artifactType || manifest.artifactType === args.artifactType)) {
          out.push({ mediaType: entry.mediaType, digest: entry.digest, size: entry.size, artifactType: manifest.artifactType })
        }
      }

      return out
    },
  }
}

/**
 * Term's local object store, kept in an OCI layout's blob directory. An object id is its digest, so this is the
 * same `blobs/sha256/<hex>` file a registry transport over the layout reads. Every put is verified and atomic, and
 * every get is re-hashed, so a corrupted file on disk is refused rather than checked out.
 */
export function layoutObjectStore(input: { dir: string }): ObjectStore {
  const dir = input.dir
  let ready: Promise<void> | undefined
  const init = (): Promise<void> => (ready ??= initLayout(dir))

  return {
    has: id => exists(blobPath(dir, id)),

    async get(id) {
      const bytes = await readBlobFile(dir, id, Number.MAX_SAFE_INTEGER)

      if (!bytes) {
        throw new OciError(`object ${id} is not in the store at ${dir}`, 404)
      }

      return bytes
    },

    async put(args) {
      await init()
      await writeBlobFile(dir, args.id, args.bytes)
    },

    async missing(ids) {
      const out: string[] = []
      const width = 64

      for (let i = 0; i < ids.length; i += width) {
        const batch = ids.slice(i, i + width)
        const held = await Promise.all(batch.map(id => exists(blobPath(dir, id))))
        batch.forEach((id, at) => {
          if (!held[at]) {
            out.push(id)
          }
        })
      }

      return out
    },
  }
}
