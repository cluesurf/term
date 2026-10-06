// A photo of a size no camera makes, for putting in a device's library and finding again (device-layer-0025), and
// the reader that checks a copy of it: a 24-bit BMP of a gradient written here, made a JPEG by the Mac's own `sips`.
// A helper, not a suite: shared/ is not walked by the runner. Used by test/compile/device-features.ts and
// test/compile/photos-prompt.ts.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const SAMPLE = { width: 321, height: 123 }

// the JPEG at `<a new folder>/<name>`, its path
export function makePhoto(name: string): string {
  const { width, height } = SAMPLE
  const row = Math.ceil((width * 3) / 4) * 4
  const bmp = Buffer.alloc(54 + row * height)
  bmp.write('BM', 0, 'ascii')
  bmp.writeUInt32LE(bmp.length, 2)
  bmp.writeUInt32LE(54, 10)
  bmp.writeUInt32LE(40, 14)
  bmp.writeInt32LE(width, 18)
  bmp.writeInt32LE(height, 22)
  bmp.writeUInt16LE(1, 26)
  bmp.writeUInt16LE(24, 28)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) bmp.writeUIntLE((Math.floor((x * 255) / width) << 16) | (Math.floor((y * 255) / height) << 8) | 128, 54 + y * row + x * 3, 3)
  }

  const dir = mkdtempSync(join(tmpdir(), 'term-photo-'))
  writeFileSync(join(dir, 'photo.bmp'), bmp)
  const photo = join(dir, name)
  spawnSync('sips', ['-s', 'format', 'jpeg', join(dir, 'photo.bmp'), '--out', photo])

  return photo
}

// a JPEG's size from its first frame header (SOF0 to SOF2), or undefined when the bytes are not a JPEG
export function jpegSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined

  let at = 2

  while (at + 9 < bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1]!

    if (marker >= 0xc0 && marker <= 0xc2) return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) }

    at += 2 + bytes.readUInt16BE(at + 2)
  }

  return undefined
}
