import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildVersion } from '../code/object/version'
import { filesOfDataset, markOfPath } from '../code/object/dataset'
import { localObjectStore } from '../code/object/store'
import { readDataset, diffRoots } from '@term/base/code/store/tree'
import { MemoryChunkStore } from '@term/base/code/store/chunk-store'

let root = ''
let store = localObjectStore({ root: '' })

function make(dir: string): void {
  mkdirSync(path.join(dir, 'code/native/node'), { recursive: true })
  mkdirSync(path.join(dir, 'view/empty'), { recursive: true })
  mkdirSync(path.join(dir, 'node_modules/junk'), { recursive: true })
  writeFileSync(path.join(dir, 'code/base.tree'), 'task a\n')
  writeFileSync(path.join(dir, 'code/native/node/f.tree'), 'task b\n')
  writeFileSync(path.join(dir, 'deck.tree'), 'deck @term/probe\n')
  writeFileSync(path.join(dir, 'node_modules/junk/x.js'), 'nope\n')
  writeFileSync(path.join(dir, 'task/run.sh'), '#!/bin/sh\n')
  chmodSync(path.join(dir, 'task/run.sh'), 0o755)
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'version-test-'))
  mkdirSync(path.join(root, 'task'), { recursive: true })
  make(root)
  store = localObjectStore({
    root: mkdtempSync(path.join(tmpdir(), 'version-objects-')),
  })
})

describe('buildVersion', () => {
  it('flattens nested directories into full paths', async () => {
    const built = await buildVersion({ dir: root, store })

    expect(built.files.map(f => f.path)).toContain(
      'code/native/node/f.tree',
    )
  })

  it('keeps an empty directory, which git cannot represent', async () => {
    const built = await buildVersion({ dir: root, store })
    const empty = built.files.find(f => f.path === 'view/empty')

    expect(empty?.mode).toBe('dir')
  })

  it('records the executable bit', async () => {
    const built = await buildVersion({ dir: root, store })

    expect(built.files.find(f => f.path === 'task/run.sh')?.mode).toBe(
      'exec',
    )
  })

  it('excludes node_modules', async () => {
    const built = await buildVersion({ dir: root, store })

    expect(
      built.files.some(f => f.path.startsWith('node_modules')),
    ).toBe(false)
  })

  it('round-trips through the prolly tree', async () => {
    const built = await buildVersion({ dir: root, store })

    expect(
      filesOfDataset(readDataset(built.root, built.treeChunks)),
    ).toEqual(built.files)
  })

  it('is deterministic: the same directory gives the same root', async () => {
    const a = await buildVersion({ dir: root, store })
    const b = await buildVersion({ dir: root, store })

    expect(a.root).toBe(b.root)
  })

  it('a one-file edit changes exactly that record', async () => {
    const before = await buildVersion({ dir: root, store })

    writeFileSync(
      path.join(root, 'code/native/node/f.tree'),
      'task b changed\n',
    )

    const after = await buildVersion({ dir: root, store })

    // both trees into one store so the diff can reach either side
    const chunks = new MemoryChunkStore()

    for (const source of [before.treeChunks, after.treeChunks]) {
      for (const hash of source.keys()) {
        const bytes = source.get(hash)

        if (bytes !== undefined) {
          chunks.put(bytes)
        }
      }
    }

    expect([...diffRoots(before.root, after.root, chunks)]).toEqual([
      markOfPath('code/native/node/f.tree'),
    ])
  })
})
