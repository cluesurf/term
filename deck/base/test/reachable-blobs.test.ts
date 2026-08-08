// Blob reachability: which content-addressed byte hashes a dataset's records keep alive, so a blob
// sweep can reclaim the rest. Blobs are found on fields, inside collections, and in nested records.

import { describe, it, expect } from 'vitest'
import { datasetOf } from '@term/base/code/diff/change'
import { blob, item, list, nested, record, text } from '@term/base/code/base/make'
import { reachableBlobs, unreachableBlobs } from '@term/base/code/gc/blobs'

describe('reachableBlobs', () => {
  it('finds blob hashes on fields, in collections, and in nested records', () => {
    const dataset = datasetOf([
      // a plain field blob
      record({
        mark: 'm1',
        type: 'font_file',
        fields: { blob: blob('sha256:aaa'), name: text('Inter') },
      }),
      // a blob inside a collection
      record({
        mark: 'm2',
        type: 'gallery',
        fields: {
          images: list([item(blob('sha256:bbb')), item(blob('sha256:ccc'))]),
        },
      }),
      // a blob inside a nested record
      record({
        mark: 'm3',
        type: 'page',
        fields: {
          hero: nested(
            record({ type: 'image', fields: { blob: blob('sha256:ddd') } }),
          ),
        },
      }),
      // no blobs at all
      record({ mark: 'm4', type: 'word', fields: { text: text('agua') } }),
    ])

    expect(reachableBlobs(dataset)).toEqual(
      new Set(['sha256:aaa', 'sha256:bbb', 'sha256:ccc', 'sha256:ddd']),
    )
  })

  it('is empty for a dataset with no blobs', () => {
    const dataset = datasetOf([
      record({ mark: 'm1', type: 'word', fields: { text: text('x') } }),
    ])

    expect(reachableBlobs(dataset).size).toBe(0)
  })

  it('deduplicates a hash referenced by more than one record', () => {
    const dataset = datasetOf([
      record({ mark: 'm1', type: 'a', fields: { blob: blob('sha256:shared') } }),
      record({ mark: 'm2', type: 'b', fields: { blob: blob('sha256:shared') } }),
    ])

    expect(reachableBlobs(dataset)).toEqual(new Set(['sha256:shared']))
  })
})

describe('unreachableBlobs', () => {
  it('returns the present hashes that no live record references', () => {
    const reachable = new Set(['sha256:keep'])
    const present = ['sha256:keep', 'sha256:orphan-1', 'sha256:orphan-2']

    expect(unreachableBlobs(present, reachable)).toEqual([
      'sha256:orphan-1',
      'sha256:orphan-2',
    ])
  })
})
