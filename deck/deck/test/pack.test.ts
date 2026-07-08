/**
 * Tests for the object packing format (note/term/registry/17), the basis of
 * packed-at-rest storage (Phase 2). These lock in the invariants the registry
 * server depends on:
 *
 *   - `buildPacks` groups packable blobs and reports each one's placement
 *     (which pack, at what `site` offset, of what `size`).
 *   - `openPack` round-trips a sealed pack: its TOC and body reproduce every
 *     contained object, and `slicePack(open, site, size)` returns the exact
 *     original bytes. This is the same slice math the server's placement-aware
 *     `store.get` uses to serve a packed object.
 *   - a pack is content-addressed by `hashObject({ kind: 'pack', bytes })`,
 *     the id the server records as the object's `pack__id`, so client and
 *     server agree on the pack's identity.
 *   - `isPackable` keeps binaries and large text loose.
 */

import { describe, it, expect } from 'vitest'

import {
  buildPacks,
  openPack,
  slicePack,
  isPackable,
  type PackInput,
  type PackParams,
} from '../code/object/pack'
import { hashObject } from '../code/object/hash'

// Small bounds so a handful of tiny blobs form several packs deterministically,
// instead of the 256 KB - 1 MB production packs.
const TEST_PARAMS: PackParams = {
  looseThreshold: 1024,
  minPack: 120,
  maxPack: 400,
  boundaryAvg: 2,
}

// A packable blob keyed by real content address, so dedup + placement behave
// exactly as in production.
function blob(path: string, text: string): PackInput {
  const bytes = Buffer.from(text, 'utf8')

  return { id: hashObject({ kind: 'blob', bytes }), path, bytes }
}

describe('pack', () => {
  it('round-trips every object through openPack + slicePack', () => {
    const blobs: PackInput[] = [
      blob('a/one.tree', 'zone one\n  text <alpha>\n'.repeat(4)),
      blob('a/two.tree', 'zone two\n  text <beta>\n'.repeat(5)),
      blob('b/three.tree', 'zone three\n  text <gamma>\n'.repeat(6)),
      blob('b/four.tree', 'zone four\n  text <delta>\n'.repeat(3)),
      blob('c/five.tree', 'zone five\n  text <epsilon>\n'.repeat(7)),
      blob('c/six.tree', 'zone six\n  text <zeta>\n'.repeat(2)),
    ]

    const { packs, placement } = buildPacks({
      blobs,
      params: TEST_PARAMS,
    })

    // every blob placed into some pack
    expect(placement.size).toBe(blobs.length)
    expect(packs.length).toBeGreaterThan(0)

    const byId = new Map(blobs.map(b => [b.id, b]))

    for (const pack of packs) {
      const open = openPack(pack.bytes)

      // the pack is content-addressed exactly as the server records it
      expect(pack.id).toBe(hashObject({ kind: 'pack', bytes: pack.bytes }))

      for (const entry of open.toc) {
        const original = byId.get(entry.id)
        expect(original).toBeDefined()

        // the slice the server's `store.get` returns for a packed object
        const sliced = slicePack(open, entry.site, entry.size)
        expect(Buffer.compare(sliced, original!.bytes)).toBe(0)

        // placement recorded for this object matches the pack + offsets
        const place = placement.get(entry.id)
        expect(place).toEqual({
          kind: 'pack',
          pack: pack.id,
          site: entry.site,
          size: entry.size,
        })
      }
    }

    // union of all packs' TOCs covers every blob exactly once
    const packedIds = packs.flatMap(p => openPack(p.bytes).toc.map(e => e.id))
    expect(new Set(packedIds).size).toBe(blobs.length)
  })

  it('dedups identical content across paths into one placement', () => {
    const bytes = Buffer.from('zone dup\n  text <same>\n', 'utf8')
    const id = hashObject({ kind: 'blob', bytes })

    const { placement } = buildPacks({
      blobs: [
        { id, path: 'x/a.tree', bytes },
        { id, path: 'y/b.tree', bytes },
      ],
      params: TEST_PARAMS,
    })

    // one entry despite two paths (same content packs once)
    expect(placement.size).toBe(1)
    expect(placement.get(id)?.kind).toBe('pack')
  })

  it('keeps binaries and large text loose', () => {
    const small = Buffer.from('zone tiny\n  text <ok>\n', 'utf8')

    expect(
      isPackable({ path: 'a/small.tree', size: small.length, bytes: small }),
    ).toBe(true)

    // a png extension is binary regardless of bytes
    expect(
      isPackable({ path: 'a/logo.png', size: small.length, bytes: small }),
    ).toBe(false)

    // a large text blob (>= the 64 KB default looseThreshold) stays loose
    const large = Buffer.alloc(128 * 1024, 0x61)
    expect(
      isPackable({ path: 'a/big.tree', size: large.length, bytes: large }),
    ).toBe(false)
  })
})
