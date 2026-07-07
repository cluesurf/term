/**
 * Tests for the content-addressed object registry: the object core
 * (chunked blobs, prolly-tree directories, commits, round-trip, dedup)
 * and the transfer protocol (delta publish and install, branches,
 * signing). These lock in the design proofs from
 * note/term/registry/*.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'

import { localObjectStore } from '../code/object/store'
import { buildCommit } from '../code/object/build'
import { checkoutTree } from '../code/object/checkout'
import { memoryRefStore } from '../code/object/refs'
import { directRegistry } from '../code/object/registry'
import { generateKeypair } from '../code/object/sign'
import { publishPackage } from '../code/object/publish'
import { installPackage } from '../code/object/install'
import { serveRegistry } from '../code/object/serve'
import { httpRegistry } from '../code/object/http'
import type { AddressInfo } from 'net'

const CHUNK = { min: 1024, avg: 2048, max: 8192 }
const TREE = { avgFanout: 8, min: 2, max: 32 }

async function countObjects(root: string): Promise<number> {
  let count = 0
  async function walk(dir: string): Promise<void> {
    let entries: import('fs').Dirent[] = []
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.isFile() && !e.name.includes('.tmp-')) count += 1
    }
  }
  await walk(root)
  return count
}

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = []
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await listFiles(full, base)))
    else out.push(path.relative(base, full))
  }
  return out.sort()
}

function prngBytes(n: number, seed: number): Buffer {
  const out = Buffer.alloc(n)
  let s = seed >>> 0
  for (let i = 0; i < n; i += 1) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    out[i] = (s >>> 24) & 0xff
  }
  return out
}

let tmp: string

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'term-obj-test-'))
})

afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true })
})

describe('object core', () => {
  it('round-trips text, nested dirs, and a large binary byte-identically', async () => {
    const dir = path.join(tmp, 'rt-pkg')
    const storeRoot = path.join(tmp, 'rt-store')
    const out = path.join(tmp, 'rt-out')
    await fsp.mkdir(path.join(dir, 'code'), { recursive: true })
    await fsp.writeFile(path.join(dir, 'deck.tree'), 'deck @term/demo\n  mark <0.0.2>\n')
    await fsp.writeFile(path.join(dir, 'readme.md'), '# demo\n')
    await fsp.writeFile(path.join(dir, 'code', 'video.bin'), prngBytes(120 * 1024, 42))

    const store = localObjectStore({ root: storeRoot })
    const { commit } = await buildCommit({
      dir,
      package: '@term/demo',
      deps: {},
      author: 'user:test',
      time: '2026-07-07T00:00:00Z',
      store,
      params: CHUNK,
      treeParams: TREE,
    })
    await checkoutTree({ treeId: commit.tree, dest: out, store })

    const src = await listFiles(dir)
    const dst = await listFiles(out)
    expect(dst).toEqual(src)
    for (const rel of src) {
      const a = await fsp.readFile(path.join(dir, rel))
      const b = await fsp.readFile(path.join(out, rel))
      expect(a.equals(b)).toBe(true)
    }
  })

  it('a one-byte change to a large binary stores only a few objects', async () => {
    const dir = path.join(tmp, 'bin-pkg')
    const storeRoot = path.join(tmp, 'bin-store')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, 'deck.tree'), 'deck @term/demo\n  mark <0.0.2>\n')
    const bin = path.join(dir, 'big.bin')
    await fsp.writeFile(bin, prngBytes(120 * 1024, 7))

    const store = localObjectStore({ root: storeRoot })
    const build = () =>
      buildCommit({
        dir,
        package: '@term/demo',
        deps: {},
        author: 'user:test',
        time: '2026-07-07T00:00:00Z',
        store,
        params: CHUNK,
        treeParams: TREE,
      })
    await build()
    const before = await countObjects(storeRoot)
    const data = await fsp.readFile(bin)
    data[60 * 1024] = data[60 * 1024]! ^ 0xff
    await fsp.writeFile(bin, data)
    await build()
    const added = (await countObjects(storeRoot)) - before

    const wholeFile = Math.round((120 * 1024) / CHUNK.avg)
    expect(added).toBeGreaterThan(0)
    expect(added).toBeLessThan(wholeFile / 2)
  })

  it('editing one of many files in a wide directory stores only a few nodes (prolly tree)', async () => {
    const dir = path.join(tmp, 'wide-pkg')
    const storeRoot = path.join(tmp, 'wide-store')
    await fsp.mkdir(path.join(dir, 'words'), { recursive: true })
    await fsp.writeFile(path.join(dir, 'deck.tree'), 'deck @term/demo\n  mark <0.0.2>\n')
    for (let i = 0; i < 400; i += 1) {
      await fsp.writeFile(
        path.join(dir, 'words', `w${String(i).padStart(4, '0')}.tree`),
        `word ${i}\n  gloss <m ${i}>\n`,
      )
    }
    const store = localObjectStore({ root: storeRoot })
    const build = () =>
      buildCommit({
        dir,
        package: '@term/demo',
        deps: {},
        author: 'user:test',
        time: '2026-07-07T00:00:00Z',
        store,
        params: CHUNK,
        treeParams: TREE,
      })
    await build()
    const before = await countObjects(storeRoot)
    await fsp.writeFile(path.join(dir, 'words', 'w0200.tree'), 'word 200\n  gloss <edited>\n')
    await build()
    const added = (await countObjects(storeRoot)) - before

    expect(added).toBeGreaterThan(0)
    expect(added).toBeLessThan(40) // not ~400
  })
})

describe('transfer protocol', () => {
  it('delta publish, delta install, branches, and signature enforcement', async () => {
    const pkgDir = path.join(tmp, 'reg-pkg')
    await fsp.mkdir(path.join(pkgDir, 'words'), { recursive: true })
    await fsp.writeFile(path.join(pkgDir, 'deck.tree'), 'deck @term/lang\n  mark <0.0.2>\n')
    for (let i = 0; i < 300; i += 1) {
      await fsp.writeFile(
        path.join(pkgDir, 'words', `w${String(i).padStart(4, '0')}.tree`),
        `word ${i}\n  gloss <m ${i}>\n`,
      )
    }

    const keypair = generateKeypair()
    const badKeypair = generateKeypair()
    const serverStore = localObjectStore({ root: path.join(tmp, 'reg-server') })
    const refs = memoryRefStore()
    const registry = directRegistry({
      store: serverStore,
      refs,
      scopeKeys: async scope => (scope === '@term' ? [keypair.publicKey] : []),
    })
    const clientA = localObjectStore({ root: path.join(tmp, 'reg-a') })
    const clientB = localObjectStore({ root: path.join(tmp, 'reg-b') })

    const p1 = await publishPackage({
      dir: pkgDir,
      package: '@term/lang',
      target: { kind: 'version', version: '0.0.2' },
      local: clientA,
      registry,
      keypair,
      author: 'user:lp',
      time: '2026-07-07T00:00:00Z',
    })
    expect(p1.uploaded).toBeGreaterThan(100)

    const outB = path.join(tmp, 'reg-outB')
    await installPackage({
      package: '@term/lang',
      ref: { kind: 'version', version: '0.0.2' },
      dest: outB,
      local: clientB,
      registry,
    })
    expect(await listFiles(outB)).toEqual(await listFiles(pkgDir))

    // edit one word, publish v0.0.4 as a delta
    await fsp.writeFile(path.join(pkgDir, 'words', 'w0150.tree'), 'word 150\n  gloss <edited>\n')
    await fsp.writeFile(path.join(pkgDir, 'deck.tree'), 'deck @term/lang\n  mark <0.0.4>\n')
    const p2 = await publishPackage({
      dir: pkgDir,
      package: '@term/lang',
      target: { kind: 'version', version: '0.0.4' },
      local: clientA,
      registry,
      keypair,
      author: 'user:lp',
      time: '2026-07-07T00:00:01Z',
      parents: [p1.commitId],
    })
    expect(p2.uploaded).toBeGreaterThan(0)
    expect(p2.uploaded).toBeLessThan(p1.uploaded / 5)

    // delta install of v0.0.4 onto client B (already has v0.0.2)
    const outB2 = path.join(tmp, 'reg-outB2')
    const before = await countObjects(path.join(tmp, 'reg-b'))
    await installPackage({
      package: '@term/lang',
      ref: { kind: 'version', version: '0.0.4' },
      dest: outB2,
      local: clientB,
      registry,
    })
    const fetched = (await countObjects(path.join(tmp, 'reg-b'))) - before
    expect(await listFiles(outB2)).toEqual(await listFiles(pkgDir))
    expect(fetched).toBeGreaterThan(0)
    expect(fetched).toBeLessThan(40)

    // branch draft resolves to the published commit
    const pb = await publishPackage({
      dir: pkgDir,
      package: '@term/lang',
      target: { kind: 'branch', branch: 'main' },
      local: clientA,
      registry,
      keypair,
      author: 'user:lp',
      time: '2026-07-07T00:00:02Z',
      parents: [p2.commitId],
    })
    const head = await registry.resolve({
      package: '@term/lang',
      ref: { kind: 'branch', branch: 'main' },
    })
    expect(head).toBe(pb.commitId)

    // a wrong key is rejected
    await expect(
      publishPackage({
        dir: pkgDir,
        package: '@term/lang',
        target: { kind: 'version', version: '0.0.6' },
        local: clientA,
        registry,
        keypair: badKeypair,
        author: 'user:evil',
        time: '2026-07-07T00:00:03Z',
      }),
    ).rejects.toThrow()
  })

  it('delta publish and install over real HTTP', async () => {
    const pkgDir = path.join(tmp, 'http-pkg')
    await fsp.mkdir(path.join(pkgDir, 'words'), { recursive: true })
    await fsp.writeFile(path.join(pkgDir, 'deck.tree'), 'deck @term/lang\n  mark <0.0.2>\n')
    for (let i = 0; i < 200; i += 1) {
      await fsp.writeFile(
        path.join(pkgDir, 'words', `w${String(i).padStart(4, '0')}.tree`),
        `word ${i}\n  gloss <m ${i}>\n`,
      )
    }

    const keypair = generateKeypair()
    const serverStore = localObjectStore({ root: path.join(tmp, 'http-server') })
    const refs = memoryRefStore()
    const server = serveRegistry({
      store: serverStore,
      refs,
      scopeKeys: async s => (s === '@term' ? [keypair.publicKey] : []),
    })
    await new Promise<void>(resolve => server.listen(0, resolve))
    const port = (server.address() as AddressInfo).port
    const registry = httpRegistry({ baseUrl: `http://127.0.0.1:${port}` })

    try {
      const clientA = localObjectStore({ root: path.join(tmp, 'http-a') })
      const clientB = localObjectStore({ root: path.join(tmp, 'http-b') })

      const p1 = await publishPackage({
        dir: pkgDir,
        package: '@term/lang',
        target: { kind: 'version', version: '0.0.2' },
        local: clientA,
        registry,
        keypair,
        author: 'user:lp',
        time: '2026-07-07T00:00:00Z',
      })

      const outB = path.join(tmp, 'http-outB')
      await installPackage({
        package: '@term/lang',
        ref: { kind: 'version', version: '0.0.2' },
        dest: outB,
        local: clientB,
        registry,
      })
      expect(await listFiles(outB)).toEqual(await listFiles(pkgDir))

      await fsp.writeFile(path.join(pkgDir, 'words', 'w0100.tree'), 'word 100\n  gloss <edited>\n')
      await fsp.writeFile(path.join(pkgDir, 'deck.tree'), 'deck @term/lang\n  mark <0.0.4>\n')
      const p2 = await publishPackage({
        dir: pkgDir,
        package: '@term/lang',
        target: { kind: 'version', version: '0.0.4' },
        local: clientA,
        registry,
        keypair,
        author: 'user:lp',
        time: '2026-07-07T00:00:01Z',
        parents: [p1.commitId],
      })
      expect(p2.uploaded).toBeLessThan(p1.uploaded / 5)

      const outB2 = path.join(tmp, 'http-outB2')
      await installPackage({
        package: '@term/lang',
        ref: { kind: 'version', version: '0.0.4' },
        dest: outB2,
        local: clientB,
        registry,
      })
      expect(await listFiles(outB2)).toEqual(await listFiles(pkgDir))

      const manifest = await registry.manifest({
        package: '@term/lang',
        ref: { kind: 'version', version: '0.0.4' },
      })
      expect(manifest.files.length).toBe(201)
    } finally {
      server.close()
    }
  })
})
