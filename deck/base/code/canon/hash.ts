import { createHash } from 'node:crypto'
import type { RecordNode, Value } from '@term/base/code/base/type'
import { canonicalBytes, canonicalValueBytes } from '@term/base/code/canon/canonicalize'

// Content addressing. A hash is computed over the canonical DAG-CBOR bytes,
// never over the .tree text and never over a text rendering of those bytes, so
// reformatting never changes a hash and equivalent records hash identically.
//
// The function is NAMED IN THE ADDRESS rather than assumed. `sha256:<hex>` is
// the textual multihash: a reader can always tell which function produced a
// given address, so moving to another function later is a versioned change
// rather than a format fork.
//
// sha256 is chosen over faster alternatives because the format is meant to be
// implemented by other people, and sha256 is in every standard library while
// blake3 usually is not. The workload is not hash-bound: cost is dominated by
// chunk fetch, and content-defined chunking uses a separate rolling hash.
//
// See note/library/base/20-serialization-and-wire-format.md.

export const HASH_FUNCTION = 'sha256'

// The hash of raw canonical bytes.
export function hashCanonicalBytes(bytes: Uint8Array): string {
  const hex = createHash(HASH_FUNCTION).update(bytes).digest('hex')
  return `${HASH_FUNCTION}:${hex}`
}

// The hash of an opaque payload. Used by the chunk store for blobs and for the
// string-keyed objects the store holds, which are not record graphs.
//
// Takes STRING OR BYTES, and that matters. Content addressing has to be over
// bytes: a caller holding binary content (a font, an image, a compressed pack)
// that decoded it to a string first would hash mangled input, because bytes
// outside valid UTF-8 become U+FFFD on the way in. The address would then name
// content that no longer exists, and nothing would fail loudly. A string is
// still accepted and still encoded as UTF-8, so every existing address is
// unchanged: this widens the domain rather than moving it.
export function hashBytes(bytes: string | Uint8Array): string {
  const hex =
    typeof bytes === 'string'
      ? createHash(HASH_FUNCTION).update(bytes, 'utf8').digest('hex')
      : createHash(HASH_FUNCTION).update(bytes).digest('hex')

  return `${HASH_FUNCTION}:${hex}`
}

// The content hash of a record, over its canonical bytes.
export function hashRecord(node: RecordNode): string {
  return hashCanonicalBytes(canonicalBytes(node))
}

// The content hash of a bare value, over its canonical bytes.
export function hashValue(value: Value): string {
  return hashCanonicalBytes(canonicalValueBytes(value))
}
