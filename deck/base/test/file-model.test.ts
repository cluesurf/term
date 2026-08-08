// The folder and file tree modelled as records: directory/file records, the parent index, and path
// resolution. A file's identity is its mark, so a move updates only its parent and its path follows.

import { describe, it, expect } from 'vitest'
import { datasetOf, type Dataset } from '@term/base/code/diff/change'
import { moveRecord } from '@term/base/code/identity/tree'
import {
  blobOf,
  directoryRecord,
  fileKindOf,
  fileRecord,
  isDirectory,
  isFile,
  listDirectory,
  parentIndex,
  pathOf,
  resolvePath,
} from '@term/base/code/file/model'

const ROOT = '00000000-0000-4000-8000-000000000001'
const INTER = '00000000-0000-4000-8000-000000000002'
const REGULAR = '00000000-0000-4000-8000-000000000003'
const DECK = '00000000-0000-4000-8000-000000000004'

function tree(): Dataset {
  return datasetOf([
    directoryRecord({ mark: ROOT, name: 'fonts' }),
    directoryRecord({ mark: INTER, name: 'Inter', parent: ROOT }),
    fileRecord({
      mark: REGULAR,
      name: 'Inter-Regular.woff2',
      kind: 'binary',
      parent: INTER,
      blob: 'sha-abc',
    }),
    fileRecord({ mark: DECK, name: 'deck.tree', kind: 'tree', parent: ROOT }),
  ])
}

describe('directory and file records', () => {
  it('build with the right type, label, kind, and blob', () => {
    const data = tree()
    const dir = data.get(INTER)!
    const file = data.get(REGULAR)!
    const treeFile = data.get(DECK)!

    expect(isDirectory(dir)).toBe(true)
    expect(dir.label).toBe('Inter')

    expect(isFile(file)).toBe(true)
    expect(fileKindOf(file)).toBe('binary')
    expect(blobOf(file)).toBe('sha-abc')

    expect(fileKindOf(treeFile)).toBe('tree')
    expect(blobOf(treeFile)).toBeUndefined()
  })
})

describe('parent index and listing', () => {
  it('lists a directory by its children', () => {
    const data = tree()
    const index = parentIndex(data)

    expect(listDirectory(data, ROOT, index)).toEqual([DECK, INTER].sort())
    expect(listDirectory(data, INTER, index)).toEqual([REGULAR])
    expect(listDirectory(data, undefined, index)).toEqual([ROOT])
  })

  it('lists identically with and without the index', () => {
    const data = tree()
    const index = parentIndex(data)

    for (const parent of [undefined, ROOT, INTER]) {
      expect(listDirectory(data, parent, index)).toEqual(
        listDirectory(data, parent),
      )
    }
  })
})

describe('path resolution', () => {
  it('resolves a path from the root to a mark', () => {
    const data = tree()

    expect(resolvePath(data, 'fonts/Inter/Inter-Regular.woff2')).toBe(REGULAR)
    expect(resolvePath(data, 'fonts/Inter')).toBe(INTER)
    expect(resolvePath(data, 'fonts')).toBe(ROOT)
    expect(resolvePath(data, 'fonts/missing')).toBeUndefined()
  })

  it('builds the path of a mark', () => {
    const data = tree()

    expect(pathOf(data, REGULAR)).toBe('fonts/Inter/Inter-Regular.woff2')
    expect(pathOf(data, INTER)).toBe('fonts/Inter')
    expect(pathOf(data, ROOT)).toBe('fonts')
  })

  it('follows a move: the mark is stable, the path changes', () => {
    const moved = moveRecord(tree(), REGULAR, ROOT)

    // the record kept its mark and content
    expect(moved.get(REGULAR)!.mark).toBe(REGULAR)
    expect(blobOf(moved.get(REGULAR)!)).toBe('sha-abc')

    // the path now reflects the new parent
    expect(pathOf(moved, REGULAR)).toBe('fonts/Inter-Regular.woff2')
    expect(resolvePath(moved, 'fonts/Inter-Regular.woff2')).toBe(REGULAR)
    expect(resolvePath(moved, 'fonts/Inter/Inter-Regular.woff2')).toBeUndefined()
  })
})
