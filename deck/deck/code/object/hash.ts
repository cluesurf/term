/**
 * The content-address primitive for the object registry.
 *
 * Every object (chunk, blob, tree, release) is addressed by
 *   H(kind, bytes) = "sha256:" + hex(SHA256(kind + " " + len + "\0" + bytes))
 *
 * The `"<kind> <len>\0"` prefix is domain separation (git's trick): two
 * objects of different kinds can never share an address even if their
 * payload bytes coincide, and hashing the length closes off
 * length-extension games. This exact construction is the contract the
 * client and server both implement (see note/term/registry/12).
 */

import { createHash } from 'crypto'

/**
 * The object kinds that get their own domain-separated address space.
 * `pack` is a storage/transport container (a solid-compressed bundle of
 * many small blobs, see note/term/registry/17); it is content-addressed by
 * its compressed bytes but is not part of the Merkle DAG.
 */
export type ObjectKind = 'chunk' | 'blob' | 'tree' | 'commit' | 'pack'

const ID_PREFIX = 'sha256:'

/** Address arbitrary bytes as an object of the given kind. */
export function hashObject(input: {
  kind: ObjectKind
  bytes: Buffer
}): string {
  const header = Buffer.from(
    `${input.kind} ${input.bytes.length}\0`,
    'utf8',
  )
  const digest = createHash('sha256')
    .update(header)
    .update(input.bytes)
    .digest('hex')

  return `${ID_PREFIX}${digest}`
}

/** Address a UTF-8 string as an object (blobs/trees/releases serialize to JSON text). */
export function hashObjectText(input: {
  kind: ObjectKind
  text: string
}): string {
  return hashObject({ kind: input.kind, bytes: Buffer.from(input.text, 'utf8') })
}

/** True if a string is a well-formed object id. */
export function isObjectId(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value)
}

/** The two-hex-character shard prefix used for on-disk and R2 fan-out. */
export function idShard(id: string): string {
  return id.slice(ID_PREFIX.length, ID_PREFIX.length + 2)
}

/** The bare hex digest, without the `sha256:` scheme prefix. */
export function idHex(id: string): string {
  return id.slice(ID_PREFIX.length)
}
