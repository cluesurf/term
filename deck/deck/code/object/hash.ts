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

import {
  HASH_FUNCTION,
  hashCanonicalBytes,
} from '@term/base/code/canon/hash'
import { createHash } from 'crypto'

/**
 * The object kinds that get their own domain-separated address space.
 * `pack` is a storage/transport container (a solid-compressed bundle of
 * many small blobs, see note/term/registry/17); it is content-addressed by
 * its compressed bytes but is not part of the Merkle DAG.
 */
export type ObjectKind = 'chunk' | 'blob' | 'tree' | 'commit' | 'pack'

// The hash function comes from @term/base so there is ONE definition of it. The
// SHAPE differs deliberately: base addresses records by their canonical bytes, while
// an object id here is kinded, hashing `<kind> <length>\0` before the bytes exactly as
// git does. That is what the registry spec means by `H(pack, bytes)`, and it stops a
// blob and a tree with identical bytes from colliding.
const ID_PREFIX = `${HASH_FUNCTION}:`

/**
 * Address bytes as an object.
 *
 * ONE addressing scheme, base's: the digest of the raw bytes. An earlier version
 * prefixed a git-style `<kind> <length>\0` header so a blob and a tree with identical
 * bytes could not collide, but that made deck's ids and @term/base's ids two different
 * functions producing the same `sha256:<hex>` SHAPE. A tree node written by base and
 * verified by deck then failed as a hash mismatch, and nothing in the format said why.
 *
 * The kind is kept in the signature because callers read better for it, and because a
 * future scheme may reintroduce typing. It no longer changes the address.
 */
export function hashObject(input: {
  kind: ObjectKind
  bytes: Buffer
}): string {
  return hashCanonicalBytes(new Uint8Array(input.bytes))
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
  return new RegExp(`^${HASH_FUNCTION}:[0-9a-f]{64}$`).test(value)
}

/** The two-hex-character shard prefix used for on-disk and R2 fan-out. */
export function idShard(id: string): string {
  return id.slice(ID_PREFIX.length, ID_PREFIX.length + 2)
}

/** The bare hex digest, without the `sha256:` scheme prefix. */
export function idHex(id: string): string {
  return id.slice(ID_PREFIX.length)
}
