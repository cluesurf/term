import { describe, it, expect, beforeEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  existsSync,
  chmodSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildRelease } from '../code/object/release'
import { restoreVersion, safeJoin } from '../code/object/restore'
import { localObjectStore } from '../code/object/store'
import type { ObjectStore } from '../code/object/store'

const META = { author: 'lance', time: 1, message: 'first' }

let dir = ''
let store: ObjectStore

function seed(at: string): void {
  mkdirSync(path.join(at, 'code/deep'), { recursive: true })
  mkdirSync(path.join(at, 'view/empty'), { recursive: true })
  writeFileSync(path.join(at, 'code/deep/a.tree'), 'task a\n')
  writeFileSync(path.join(at, 'deck.tree'), 'deck @term/probe\n')
  writeFileSync(path.join(at, 'run.sh'), '#!/bin/sh\n')
  chmodSync(path.join(at, 'run.sh'), 0o755)
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'release-src-'))
  seed(dir)
  store = localObjectStore({
    root: mkdtempSync(path.join(tmpdir(), 'release-obj-')),
  })
})

describe('buildRelease', () => {
  it('commits through base and names a tree root', async () => {
    const release = await buildRelease({ dir, store, meta: META })

    expect(release.commit).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(release.root).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('is deterministic for the same directory and metadata', async () => {
    const a = await buildRelease({ dir, store, meta: META })
    const b = await buildRelease({ dir, store, meta: META })

    expect(a.commit).toBe(b.commit)
  })

  it('closes over the tree and every file chunk', async () => {
    const release = await buildRelease({ dir, store, meta: META })

    for (const file of release.files) {
      for (const chunk of file.chunks) {
        expect(release.closure).toContain(chunk)
      }
    }

    expect(release.closure).toContain(release.commit)
  })

  it('a one-file edit costs a FLAT number of new objects', async () => {
    const big = mkdtempSync(path.join(tmpdir(), 'release-big-'))
    mkdirSync(path.join(big, 'code'), { recursive: true })

    const counts: Array<number> = []

    for (const size of [50, 200, 800]) {
      for (let i = 0; i < size; i++) {
        writeFileSync(
          path.join(big, `code/m${i}.tree`),
          `task m${i}\n`,
        )
      }

      const before = await buildRelease({ dir: big, store, meta: META })

      writeFileSync(
        path.join(big, `code/m${Math.floor(size / 2)}.tree`),
        'CHANGED\n',
      )

      const after = await buildRelease({
        dir: big,
        store,
        meta: { ...META, time: 2 },
      })

      const had = new Set(before.closure)
      counts.push(after.closure.filter(id => !had.has(id)).length)
    }

    // 16x the files must not cost materially more objects
    for (const count of counts) {
      expect(count).toBeLessThan(30)
    }
  })
})

describe('restoreVersion', () => {
  it('round-trips a release back to disk', async () => {
    const release = await buildRelease({ dir, store, meta: META })
    const dest = mkdtempSync(path.join(tmpdir(), 'release-out-'))

    await restoreVersion({
      root: release.root,
      dest,
      chunks: release.chunks,
      store,
    })

    expect(
      readFileSync(path.join(dest, 'code/deep/a.tree'), 'utf8'),
    ).toBe('task a\n')
  })

  it('recreates an empty directory', async () => {
    const release = await buildRelease({ dir, store, meta: META })
    const dest = mkdtempSync(path.join(tmpdir(), 'release-out-'))

    await restoreVersion({
      root: release.root,
      dest,
      chunks: release.chunks,
      store,
    })

    expect(existsSync(path.join(dest, 'view/empty'))).toBe(true)
  })

  it('restores the executable bit', async () => {
    const release = await buildRelease({ dir, store, meta: META })
    const dest = mkdtempSync(path.join(tmpdir(), 'release-out-'))

    await restoreVersion({
      root: release.root,
      dest,
      chunks: release.chunks,
      store,
    })

    expect(statSync(path.join(dest, 'run.sh')).mode & 0o111).not.toBe(
      0,
    )
  })
})

describe('safeJoin', () => {
  it('blocks a path that escapes the destination', () => {
    expect(() => safeJoin('/tmp/dest', '../escape')).toThrow()
  })

  it('blocks an absolute path', () => {
    expect(() => safeJoin('/tmp/dest', '/etc/passwd')).toThrow()
  })

  it('allows a nested path', () => {
    expect(safeJoin('/tmp/dest', 'code/a.tree')).toBe(
      '/tmp/dest/code/a.tree',
    )
  })
})
