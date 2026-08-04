// Which of the three treatments a file gets.
//
// A repository holds three kinds of file and what makes a change small differs for
// each. See note/library/base/design/content-types.md.
//
//   binary  content-defined chunks over the bytes; a small edit costs the chunks that moved
//   text    chunks, plus a hunk delta against a base the receiver holds
//   tree    parsed into RECORDS, so a small edit costs the changed FIELDS
//
// Classification is a total function of the name and the bytes, decided once at publish
// time, so the same file always takes the same path.

// Extensions that are binary regardless of what the bytes look like. A file may be
// valid UTF-8 by accident and still be binary in intent.
const BINARY_EXTENSIONS = new Set([
  'png',
  'jpg',
  'gif',
  'webp',
  'avif',
  'ico',
  'bmp',
  'tiff',
  'mp3',
  'wav',
  'ogg',
  'flac',
  'mp4',
  'webm',
  'mov',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'pdf',
  'zip',
  'gz',
  'tgz',
  'br',
  'zst',
  'wasm',
  'so',
  'dylib',
  'dll',
  'exe',
  'bin',
  'db',
  'sqlite',
])

export type ContentType = 'binary' | 'text' | 'tree'

/** The extension, lowercased, without its dot. Empty when the name has none. */
export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')

  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/**
 * Is this valid UTF-8 with no NUL?
 *
 * A NUL byte is the oldest and most reliable binary signal, and decoding with a
 * fatal decoder rejects malformed sequences. Together these catch the cases an
 * extension list misses.
 */
export function looksTextual(bytes: Buffer): boolean {
  if (bytes.includes(0)) {
    return false
  }

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)

    return true
  } catch {
    return false
  }
}

/**
 * Classify a file.
 *
 * `.tree` is checked first and by name alone: it is the format the substrate exists
 * for, and a `.tree` file that fails to parse is an error worth surfacing rather than
 * a reason to silently store it as bytes.
 */
export function classify(input: {
  path: string
  bytes: Buffer
}): ContentType {
  const extension = extensionOf(input.path)

  if (extension === 'tree') {
    return 'tree'
  }

  if (BINARY_EXTENSIONS.has(extension)) {
    return 'binary'
  }

  return looksTextual(input.bytes) ? 'text' : 'binary'
}
