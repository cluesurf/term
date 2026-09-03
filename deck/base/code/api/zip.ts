// A zip encoder for exports.
//
// `export.ts` yields entries and stays transport-free. This turns them into a zip, which is
// the format a person expects when they click download.
//
// STORE only, no deflate. That is a deliberate limit rather than an unfinished one: entries
// are `.tree` text that compresses well at the transport layer anyway, and a stored zip is
// written in one pass with no compressor state, so a large repository streams without
// buffering. If deflate is ever wanted it belongs behind the same interface.
//
// See note/library/base/design/export-and-dump.md.

import type { Entry, WalkEntries } from '@term/base/code/api/export'

// The CRC-32 table, built once at module load rather than per call.
const TABLE = (() => {
  const table = new Uint32Array(256)

  for (let n = 0; n < 256; n++) {
    let c = n

    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }

    table[n] = c >>> 0
  }

  return table
})()

export function crc32(bytes: Buffer): number {
  let c = 0xffffffff

  for (const byte of bytes) {
    c = TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  }

  return (c ^ 0xffffffff) >>> 0
}

/**
 * A zip timestamp.
 *
 * Fixed at 1980-01-01, the earliest a zip can express. Using the current time would make
 * two exports of one commit differ byte for byte, which breaks the content-addressed
 * caching in `archiveKey`: the key says the bytes are determined by the commit, so they
 * have to be.
 */
const DOS_TIME = 0
const DOS_DATE = 0x0021

type Placed = {
  entry: Entry
  offset: number
  crc: number
}

function localHeader(entry: Entry, crc: number): Buffer {
  const name = Buffer.from(entry.path, 'utf8')
  const head = Buffer.alloc(30)

  head.writeUInt32LE(0x04034b50, 0)
  head.writeUInt16LE(20, 4) // version needed
  head.writeUInt16LE(0, 6) // flags
  head.writeUInt16LE(0, 8) // method: stored
  head.writeUInt16LE(DOS_TIME, 10)
  head.writeUInt16LE(DOS_DATE, 12)
  head.writeUInt32LE(crc, 14)
  head.writeUInt32LE(entry.bytes.length, 18)
  head.writeUInt32LE(entry.bytes.length, 22)
  head.writeUInt16LE(name.length, 26)
  head.writeUInt16LE(0, 28)

  return Buffer.concat([head, name])
}

function centralHeader(placed: Placed): Buffer {
  const name = Buffer.from(placed.entry.path, 'utf8')
  const head = Buffer.alloc(46)

  head.writeUInt32LE(0x02014b50, 0)
  head.writeUInt16LE(20, 4) // version made by
  head.writeUInt16LE(20, 6) // version needed
  head.writeUInt16LE(0, 8)
  head.writeUInt16LE(0, 10)
  head.writeUInt16LE(DOS_TIME, 12)
  head.writeUInt16LE(DOS_DATE, 14)
  head.writeUInt32LE(placed.crc, 16)
  head.writeUInt32LE(placed.entry.bytes.length, 20)
  head.writeUInt32LE(placed.entry.bytes.length, 24)
  head.writeUInt16LE(name.length, 28)
  head.writeUInt16LE(0, 30) // extra
  head.writeUInt16LE(0, 32) // comment
  head.writeUInt16LE(0, 34) // disk
  head.writeUInt16LE(0, 36) // internal attrs
  head.writeUInt32LE(0o644 << 16, 38) // external attrs
  head.writeUInt32LE(placed.offset, 42)

  return Buffer.concat([head, name])
}

/**
 * Encode entries as a zip, streaming.
 *
 * Chunks are handed to `take` rather than returned as one Buffer, so a repository larger
 * than memory can be written to a socket. Only the central directory accumulates, and
 * that holds one small header per entry rather than any file content.
 *
 * PUSH ON BOTH SIDES (self-hosting-0002). `entries` is a walker rather than an
 * `Iterable`, so the producer streams too and the pair composes without a generator
 * anywhere: `walkZip(t => walkArchive(input, t), chunk => response.write(chunk))`.
 */
export function walkZip(entries: WalkEntries, take: (chunk: Buffer) => void): void {
  const placed: Array<Placed> = []
  let offset = 0

  entries(entry => {
    const crc = crc32(entry.bytes)
    const header = localHeader(entry, crc)

    placed.push({ entry, offset, crc })
    offset += header.length + entry.bytes.length

    take(header)
    take(entry.bytes)
  })

  const start = offset
  let size = 0

  for (const one of placed) {
    const header = centralHeader(one)
    size += header.length

    take(header)
  }

  const end = Buffer.alloc(22)

  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4) // disk
  end.writeUInt16LE(0, 6) // disk with central directory
  end.writeUInt16LE(placed.length, 8)
  end.writeUInt16LE(placed.length, 10)
  end.writeUInt32LE(size, 12)
  end.writeUInt32LE(start, 16)
  end.writeUInt16LE(0, 20) // comment

  take(end)
}

/** The whole zip as one buffer, for callers small enough not to need streaming. */
export function zipBuffer(entries: Iterable<Entry>): Buffer {
  const chunks: Buffer[] = []

  walkZip(
    take => {
      for (const entry of entries) {
        if (take(entry) === false) {
          return
        }
      }
    },
    chunk => chunks.push(chunk),
  )

  return Buffer.concat(chunks)
}
