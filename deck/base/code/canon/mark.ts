// Marks between their text rendering and their 16 canonical bytes.
//
// A mark is 128 bits. Every text form of it is presentation. The canonical form
// stores the raw bytes, so the choice of alphabet never affects a hash.
//
// The platform rendering is the TONE CODE: the alphabet `mndbtkhsfvzxcwlr`, one
// letter per nibble, dashed 8-8-8-8. Consonant-only, so codes never accidentally
// spell words and stay easy to dictate. See the platform tone-code encoder.
//
//   mndbtkhs-fvzxcwlr-btkhsfvz-xcwlrmnd     35 characters, 32 letters + 3 dashes
//
// Hyphenated hex (8-4-4-4-12) is also accepted on input, because ids arrive from
// runtimes that mint UUIDs, and hex is the INTERNAL form that decoding returns.
// Tone is applied at the presentation boundary, never as an internal key.
//
// See note/library/base/20-serialization-and-wire-format.md.

import type { Mark } from '@term/base/code/base/type'

// Ordering is the tone alphabet: index is the nibble value.
export const TONE_ALPHABET = 'mndbtkhsfvzxcwlr'

const TONE_TO_NIBBLE = new Map<string, number>(
  TONE_ALPHABET.split('').map((letter, index) => [letter, index]),
)

const HEX = '0123456789abcdef'

export const MARK_BYTE_LENGTH = 16

// One extension per format, lowercase. An object key names its content, so the same
// format must never appear under two spellings: `jpeg` and `jpg` would otherwise be two
// keys for one thing and defeat deduplication at the naming layer.
//
// These match the platform's upload policy, which already maps `image/jpeg` to `jpg`.
// Keep the two in step.
const CANONICAL_EXTENSION: Record<string, string> = {
  jpeg: 'jpg',
  jpe: 'jpg',
  tif: 'tiff',
  htm: 'html',
  yml: 'yaml',
  mpeg: 'mp3',
  mpg: 'mp4',
  qt: 'mov',
  markdown: 'md',
  text: 'txt',
  svgz: 'svg',
}

// Normalize an extension: lowercase, no leading dot, and one spelling per format.
export function canonicalExtension(extension: string): string {
  const bare = extension.trim().toLowerCase().replace(/^\.+/, '')

  return CANONICAL_EXTENSION[bare] ?? bare
}

// Re-letter ANY hex run through the tone alphabet, length preserved, and group it in
// EIGHTS. A mark is 32 hex characters, so four groups; a sha256 is 64, so eight. One
// rule at both lengths, which is what makes an object key and a mark read the same way.
export function toneOfHex(hex: string): string {
  let flat = ''

  for (const character of hex.toLowerCase()) {
    const nibble = HEX.indexOf(character)

    if (nibble < 0) {
      throw new Error(`invalid hex character: ${character}`)
    }

    flat += TONE_ALPHABET[nibble]
  }

  return (flat.match(/.{1,8}/g) ?? [flat]).join('-')
}

// The dash layout disambiguates the two accepted text forms without relying on
// the alphabets, which overlap on b, c, d and f:
//   3 dashes, groups of 8       tone code
//   4 dashes, 8-4-4-4-12        hyphenated hex
const TONE_PATTERN = new RegExp(
  `^[${TONE_ALPHABET}]{8}-[${TONE_ALPHABET}]{8}-[${TONE_ALPHABET}]{8}-[${TONE_ALPHABET}]{8}$`,
)

const HEX_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const FLAT_TONE_PATTERN = new RegExp(`^[${TONE_ALPHABET}]{32}$`)
const FLAT_HEX_PATTERN = /^[0-9a-f]{32}$/i

export function isToneMark(value: string): boolean {
  return TONE_PATTERN.test(value) || FLAT_TONE_PATTERN.test(value)
}

export function isHexMark(value: string): boolean {
  return HEX_PATTERN.test(value) || FLAT_HEX_PATTERN.test(value)
}

// The 16 canonical bytes of a mark, from either accepted text form.
export function markToBytes(mark: Mark): Uint8Array {
  const flat = mark.replace(/-/g, '')
  if (flat.length !== 32) {
    throw new Error(`invalid mark, expected 32 characters: ${mark}`)
  }

  const nibbles = new Array<number>(32)
  // A FLAT (unhyphenated) mark made only of the letters the tone and hex alphabets
  // share ({b,c,d,f}) is valid as BOTH, and the two readings give different bytes —
  // so silently preferring tone would mis-decode a flat hex id to the wrong identity.
  // Reject it; the caller must use the hyphenated form (which is unambiguous: tone is
  // 8-8-8-8, hex is 8-4-4-4-12). Hyphenated marks never reach this branch ambiguously.
  if (FLAT_TONE_PATTERN.test(mark) && FLAT_HEX_PATTERN.test(mark)) {
    throw new Error(
      `ambiguous flat mark valid as both tone and hex; use the hyphenated form: ${mark}`,
    )
  }
  // Prefer the tone reading, since that is the platform form. Fall back to hex
  // so ids minted as UUIDs are accepted unchanged.
  if (isToneMark(mark)) {
    for (let i = 0; i < 32; i++) {
      nibbles[i] = TONE_TO_NIBBLE.get(flat[i]!)!
    }
  } else if (isHexMark(mark)) {
    for (let i = 0; i < 32; i++) {
      nibbles[i] = parseInt(flat[i]!, 16)
    }
  } else {
    throw new Error(`invalid mark, unrecognized alphabet: ${mark}`)
  }

  const out = new Uint8Array(MARK_BYTE_LENGTH)
  for (let i = 0; i < MARK_BYTE_LENGTH; i++) {
    out[i] = (nibbles[i * 2]! << 4) | nibbles[i * 2 + 1]!
  }
  return out
}

// The INTERNAL text rendering, hyphenated hex. Decoding returns this so a mark
// round-trips through canonical bytes unchanged, which matters because datasets
// and indexes are keyed by the mark string: if decode returned a different
// spelling of the same identity, one identity would occupy two keys.
//
// The tone code is a PRESENTATION rendering, applied at the .tree, JSON, and URL
// boundaries by `bytesToToneMark` / `toToneMark`. It never appears in canonical
// bytes and never becomes an internal key.
export function bytesToMark(bytes: Uint8Array): Mark {
  return bytesToHexMark(bytes)
}

// The tone-code rendering, dashed 8-8-8-8, for display and external surfaces.
export function bytesToToneMark(bytes: Uint8Array): Mark {
  if (bytes.length !== MARK_BYTE_LENGTH) {
    throw new Error(
      `invalid mark bytes, expected ${MARK_BYTE_LENGTH}, got ${bytes.length}`,
    )
  }
  let flat = ''
  for (const byte of bytes) {
    flat += TONE_ALPHABET[byte >> 4]
    flat += TONE_ALPHABET[byte & 0x0f]
  }
  return [
    flat.slice(0, 8),
    flat.slice(8, 16),
    flat.slice(16, 24),
    flat.slice(24, 32),
  ].join('-')
}

// The hex rendering, for PostgreSQL and any consumer that wants a UUID literal.
// Every dash in the 8-8-8-8 tone form sits at a multiple of four hex digits, so
// the hex form below is valid `uuid` input.
export function bytesToHexMark(bytes: Uint8Array): string {
  if (bytes.length !== MARK_BYTE_LENGTH) {
    throw new Error(`invalid mark bytes: ${bytes.length}`)
  }
  let flat = ''
  for (const byte of bytes) {
    flat += HEX[byte >> 4]
    flat += HEX[byte & 0x0f]
  }
  return [
    flat.slice(0, 8),
    flat.slice(8, 12),
    flat.slice(12, 16),
    flat.slice(16, 20),
    flat.slice(20, 32),
  ].join('-')
}

// Round-trip helpers, for callers holding text on both sides.
export function toToneMark(mark: Mark): Mark {
  return bytesToToneMark(markToBytes(mark))
}

export function toHexMark(mark: Mark): string {
  return bytesToHexMark(markToBytes(mark))
}
