import { describe, it, expect } from 'vitest'
import { zipBuffer, encodeZip, crc32 } from '@term/base/code/api/zip'

const entry = (path: string, text: string) => ({
  path,
  bytes: Buffer.from(text, 'utf8'),
})

describe('zip encoding', () => {
  it('matches known CRC-32 values', () => {
    expect(crc32(Buffer.from(''))).toBe(0)
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
  })

  it('writes the signatures a reader looks for', () => {
    const zip = zipBuffer([entry('a.tree', 'hello')])

    expect(zip.readUInt32LE(0)).toBe(0x04034b50)
    // the end record is the last 22 bytes when there is no comment
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50)
  })

  it('records the entry count in the end record', () => {
    const zip = zipBuffer([
      entry('a.tree', 'one'),
      entry('b.tree', 'two'),
      entry('c.tree', 'three'),
    ])

    expect(zip.readUInt16LE(zip.length - 22 + 10)).toBe(3)
  })

  it('points the end record at the central directory', () => {
    const zip = zipBuffer([entry('a.tree', 'hello')])
    const size = zip.readUInt32LE(zip.length - 22 + 12)
    const start = zip.readUInt32LE(zip.length - 22 + 16)

    expect(zip.readUInt32LE(start)).toBe(0x02014b50)
    // directory plus end record accounts for everything after the payload
    expect(start + size + 22).toBe(zip.length)
  })

  it('is byte-identical across runs, which the cache key depends on', () => {
    const entries = [entry('a.tree', 'one'), entry('b.tree', 'two')]

    expect(zipBuffer(entries).equals(zipBuffer(entries))).toBe(true)
  })

  it('handles an empty entry and an empty archive', () => {
    const empty = zipBuffer([entry('nothing.tree', '')])
    expect(empty.readUInt16LE(empty.length - 22 + 10)).toBe(1)

    const none = zipBuffer([])
    expect(none.length).toBe(22)
    expect(none.readUInt16LE(none.length - 22 + 10)).toBe(0)
  })

  it('stores utf-8 paths as bytes rather than code units', () => {
    const zip = zipBuffer([entry('日本/naïve.tree', 'x')])
    const nameLength = zip.readUInt16LE(26)

    expect(nameLength).toBe(Buffer.byteLength('日本/naïve.tree', 'utf8'))
    // a path written as code units would be shorter than its byte length
    expect(nameLength).toBeGreaterThan('日本/naïve.tree'.length)
  })

  it('streams without holding the payload', () => {
    const chunks = [...encodeZip([entry('a.tree', 'one'), entry('b.tree', 'two')])]

    // header and payload per entry, then one directory header each, then the end record
    expect(chunks.length).toBe(2 * 2 + 2 + 1)
    expect(Buffer.concat(chunks).length).toBe(
      zipBuffer([entry('a.tree', 'one'), entry('b.tree', 'two')]).length,
    )
  })

  it('stores rather than compresses, so sizes match exactly', () => {
    const text = 'x'.repeat(1000)
    const zip = zipBuffer([entry('big.tree', text)])

    expect(zip.readUInt16LE(8)).toBe(0)
    expect(zip.readUInt32LE(18)).toBe(1000)
    expect(zip.readUInt32LE(22)).toBe(1000)
  })
})
