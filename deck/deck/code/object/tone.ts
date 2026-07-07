/**
 * Tone-encoded, dash-grouped storage paths for object ids.
 *
 * An object id is `sha256:<64 hex>`. Rather than lay it on disk (and in
 * R2) as a raw hex run, we re-letter the hex through the "tone" consonant
 * alphabet and group it in fours, so a stored object reads as
 *   mndb-tkhs-fvzx-…   (16 groups of 4)
 * which is far easier to scan and dictate than a hex blob. This mirrors
 * the tone code used across the platform (mesh/deck/belt/code/tool/tone.ts,
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
// Must match `CODE` in mesh/deck/belt/code/tool/tone.ts exactly.
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

/** Group a string into dash-separated runs of 4 (`abcd-efgh-…`). */
export function dashInFours(flat: string): string {
  const groups = flat.match(/.{1,4}/g)

  return groups ? groups.join('-') : flat
}

/** The dashed tone form of an object id, e.g. `mndb-tkhs-…` (16 groups). */
export function toneOfId(id: string): string {
  return dashInFours(hexToTone(idHex(id)))
}

/**
 * The storage sub-path for an object id: a two-tone-character shard
 * directory (256 buckets) plus the full dashed tone name. Used for both
 * the local on-disk store and the R2 key, so both read the same way.
 */
export function tonePath(id: string): string {
  const tone = hexToTone(idHex(id))
  const shard = tone.slice(0, 2)

  return `${shard}/${dashInFours(tone)}`
}
