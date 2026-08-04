import { describe, it, expect } from 'vitest'
import {
  datasetOfFiles,
  filesOfDataset,
  fileRecord,
  fileOfRecord,
  markOfPath,
  FILE_TYPE,
} from '../code/object/dataset'
import type { PackageFile } from '../code/object/dataset'
import {
  writeDataset,
  readDataset,
  diffRoots,
} from '@term/base/code/store/tree'
import { MemoryChunkStore } from '@term/base/code/store/chunk-store'
import { isMark } from '@term/base/code/base/mark'

function files(count: number, edit?: number): Array<PackageFile> {
  return Array.from({ length: count }, (_, i) => ({
    path: `code/mod-${i}.ts`,
    mode: 'file' as const,
    size: 100 + i,
    chunks: [
      `sha256:${String(i === edit ? 9999 : i).padStart(64, '0')}`,
    ],
  }))
}

describe('markOfPath', () => {
  it('is derived, so the same path is the same record across versions', () => {
    expect(markOfPath('code/x.ts')).toBe(markOfPath('code/x.ts'))
  })

  it('separates different paths', () => {
    expect(markOfPath('code/x.ts')).not.toBe(markOfPath('code/y.ts'))
  })

  it('produces a well-formed mark', () => {
    expect(isMark(markOfPath('code/x.ts'))).toBe(true)
  })
})

describe('fileRecord', () => {
  it('round-trips every field, chunks included', () => {
    const file: PackageFile = {
      path: 'code/a.ts',
      mode: 'exec',
      size: 42,
      chunks: [`sha256:${'a'.repeat(64)}`, `sha256:${'b'.repeat(64)}`],
    }

    const back = fileOfRecord(fileRecord(file))

    expect(back).toEqual(file)
  })

  it('carries the file form name', () => {
    expect(fileRecord(files(1)[0]!).type).toBe(FILE_TYPE)
  })

  it('ignores a record of another form', () => {
    const record = fileRecord(files(1)[0]!)

    expect(fileOfRecord({ ...record, type: 'other' })).toBeUndefined()
  })
})

describe('a package version as a dataset', () => {
  it('round-trips through the prolly tree', () => {
    const store = new MemoryChunkStore()
    const root = writeDataset(datasetOfFiles(files(500)), store)

    // `filesOfDataset` returns path order, which is deterministic and is what a
    // checkout wants. The fixture is generated in numeric order, so sort to compare.
    const byPath = (a: PackageFile, b: PackageFile) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0

    expect(filesOfDataset(readDataset(root, store))).toEqual(
      [...files(500)].sort(byPath),
    )
  })

  it('reports exactly the file that changed', () => {
    const store = new MemoryChunkStore()
    const before = writeDataset(datasetOfFiles(files(500)), store)
    const after = writeDataset(
      datasetOfFiles(files(500, 250)),
      store,
    )

    const changed = diffRoots(before, after, store)

    expect([...changed]).toEqual([markOfPath('code/mod-250.ts')])
  })

  it('reports an added file and nothing else', () => {
    const store = new MemoryChunkStore()
    const before = writeDataset(datasetOfFiles(files(100)), store)
    const after = writeDataset(
      datasetOfFiles([
        ...files(100),
        {
          path: 'code/new.ts',
          mode: 'file',
          size: 1,
          chunks: [],
        },
      ]),
      store,
    )

    expect([...diffRoots(before, after, store)]).toEqual([
      markOfPath('code/new.ts'),
    ])
  })

  it('an identical version has an identical root and reads nothing', () => {
    const store = new MemoryChunkStore()
    const a = writeDataset(datasetOfFiles(files(100)), store)
    const b = writeDataset(datasetOfFiles(files(100)), store)

    expect(a).toBe(b)
    expect(diffRoots(a, b, store).size).toBe(0)
  })
})
