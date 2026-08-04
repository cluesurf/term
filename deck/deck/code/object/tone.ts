import {
  TONE_ALPHABET,
  canonicalExtension,
} from '@term/base/code/canon/mark'
/**
 * Tone-encoded, dash-grouped storage paths for object ids.
 *
 * An object id is `sha256:<64 hex>`. Rather than lay it on disk (and in
 * R2) as a raw hex run, we re-letter the hex through the "tone" consonant
 * alphabet and group it in fours, so a stored object reads as
 *   mndb-tkhs-fvzx-…   (16 groups of 4)
 * which is far easier to scan and dictate than a hex blob. This mirrors
 * the tone code used across the platform (the platform tone-code encoder,
 * `hexToTone`). The alphabet is duplicated here because the Term client is
 * its own package and cannot import `@cluesurf/belt`; the server uses
 * belt's `hexToTone` directly and both agree because the alphabet is the
 * same fixed 16 characters.
 *
 * The id on the wire and in objects stays `sha256:<hex>` (canonical, and
 * what content addressing hashes). Only the STORAGE PATH is tone-encoded,
 * so readability costs nothing in the protocol.
 */

import { idHex } from './hash'

// The fixed 16-consonant tone alphabet, index i standing for hex digit i.
// Must match `CODE` in the platform tone-code encoder exactly.
const CODE = 'mndbtkhsfvzxcwlr'

const HEX_TO_TONE: Record<string, string> = {}

for (let i = 0; i < 16; i += 1) {
  HEX_TO_TONE[i.toString(16)] = CODE[i]!
}

/** Re-letter a hex string through the tone alphabet, length preserved. */
export function hexToTone(hex: string): string {
  let out = ''

  for (const ch of hex) {
    const tone = HEX_TO_TONE[ch]

    if (tone === undefined) {
      throw new Error(`hexToTone: invalid hex character '${ch}'`)
    }

    out += tone
  }

  return out
}

/**
 * Group a string into dash-separated runs of EIGHT.
 *
 * Eight is the rule everywhere: a base tone mark is 32 hex characters in four
 * groups of eight, and an object id is a sha256, so 64 hex characters in EIGHT
 * groups of eight. One grouping, whatever the length.
 */
export function dashInEights(flat: string): string {
  const groups = flat.match(/.{1,8}/g)

  return groups ? groups.join('-') : flat
}

/** The dashed tone form of an object id: eight groups of eight. */
export function toneOfId(id: string): string {
  return dashInEights(hexToTone(idHex(id)))
}

/**
 * The object store KEY: `<8>-<8>-<8>-<8>-<8>-<8>-<8>-<8>.<ext>`, tone-coded.
 *
 * The store is one FLAT namespace (`land.base.surf/<id>.<ext>`), so a key carries no
 * directories and no package name. The extension lets a fetch be content-typed without
 * a lookup.
 */
export function objectKey(input: {
  id: string
  extension: string
}): string {
  return `${toneOfId(input.id)}.${canonicalExtension(input.extension)}`
}

/**
 * The LOCAL on-disk path. Identical to the remote key: ONE flat namespace, no shard
 * directories. A key names its content and nothing else, so the same id reads the same
 * way wherever it is stored.
 */
export function tonePath(id: string): string {
  return dashInEights(hexToTone(idHex(id)))
}
