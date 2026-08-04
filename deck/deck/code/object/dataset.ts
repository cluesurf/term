// A package version, as a `@term/base` dataset.
//
// This is the join between the package manager and the substrate. `@term/base` stores
// a DATASET: records keyed by mark, written into a prolly tree by `writeDataset`, and
// diffed by `diffRoots` in time proportional to the CHANGE rather than the dataset
// (measured at 21 to 41 chunk reads for a one-record edit across a 16x size range).
//
// A package version is a set of files. Modelling each file as one record gives the
// package manager that tree, that diff, and base's sync for free, instead of the
// hand-written prolly tree in `tree.ts` and reachability walk in `graph.ts`.
//
// The mapping is deliberately FLAT: one record per file, keyed by a mark derived from
// its path, with no nested directory objects. Nesting bought deduplication of unchanged
// subdirectories, which the prolly tree now does by content, and it cost a second kind
// of tree to maintain. A path is just a field.

import { hashBytes } from '@term/base/code/canon/hash'
import { bytesToMark } from '@term/base/code/canon/mark'
import {
  text,
  integer,
  blob,
  list,
} from '@term/base/code/base/make'
import type {
  Mark,
  RecordNode,
  Value,
} from '@term/base/code/base/type'
import type { Dataset } from '@term/base/code/diff/change'

import type { EntryMode } from './model'

// The form name every file record carries, so a dataset can hold more than files later
// without them colliding.
export const FILE_TYPE = 'file'

// One file in a package version.
//
// A binary or text file is its chunk list. A `.tree` file is not: it is PARSED, and its
// record goes into the dataset directly, so an edit to one field costs one record
// rather than a whole file. `record` and `chunks` are therefore exclusive.
export type PackageFile = {
  path: string
  mode: EntryMode
  size: number
  // content-addressed chunk ids, in order, for binary and text
  chunks: Array<string>
  // the parsed record, for `.tree`
  record?: RecordNode
}

// The form a `.tree` file's own record carries, so a checkout knows to regenerate the
// file from it rather than from chunks.
export const TREE_TYPE = 'tree-file'

// A path's stable identity.
//
// The mark has to be DERIVED, not minted: the same path in two versions must land on
// the same record, or every version would read as a wholesale replacement and the diff
// would report every file as changed. Sixteen bytes of the path's digest, shaped into a
// v4 UUID so it satisfies `isMark`.
export function markOfPath(path: string): Mark {
  const digest = hashBytes(path).split(':')[1] ?? ''
  const bytes = new Uint8Array(16)

  for (let i = 0; i < 16; i++) {
    bytes[i] = Number.parseInt(digest.slice(i * 2, i * 2 + 2), 16)
  }

  // stamp the version and variant nibbles so the result is a well-formed v4 UUID
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80

  return bytesToMark(bytes)
}

export function fileRecord(file: PackageFile): RecordNode {
  const fields = new Map<string, Value>()

  fields.set('path', text(file.path))
  fields.set('mode', text(file.mode))
  fields.set('size', integer(file.size))

  // A `.tree` file carries its parsed record rather than chunks. Nesting it keeps the
  // path and the content in ONE record, so the prolly tree sees a field-level edit to
  // the nested record as a field-level change.
  if (file.record) {
    fields.set('tree', { kind: 'record', record: file.record })

    return {
      mark: markOfPath(file.path),
      type: TREE_TYPE,
      label: file.path,
      fields,
    }
  }

  fields.set(
    'chunks',
    list(file.chunks.map(chunk => ({ value: blob(chunk) }))),
  )

  return {
    mark: markOfPath(file.path),
    type: FILE_TYPE,
    label: file.path,
    fields,
  }
}

// Every file of a version, as a dataset ready for `writeDataset`.
export function datasetOfFiles(
  files: Iterable<PackageFile>,
): Dataset {
  const dataset: Dataset = new Map()

  for (const file of files) {
    const record = fileRecord(file)
    dataset.set(record.mark!, record)
  }

  return dataset
}

// Back the other way, for checkout.
export function fileOfRecord(
  record: RecordNode,
): PackageFile | undefined {
  if (record.type !== FILE_TYPE && record.type !== TREE_TYPE) {
    return undefined
  }

  const path = scalarText(record.fields.get('path'))
  const mode = scalarText(record.fields.get('mode'))
  const size = scalarInteger(record.fields.get('size'))
  const chunks = scalarBlobs(record.fields.get('chunks'))

  if (path === undefined) {
    return undefined
  }

  const file: PackageFile = {
    path,
    mode: (mode ?? 'file') as EntryMode,
    size: size ?? 0,
    chunks,
  }

  const nested = record.fields.get('tree')

  if (nested?.kind === 'record') {
    file.record = nested.record
  }

  return file
}

export function filesOfDataset(
  dataset: Dataset,
): Array<PackageFile> {
  const files: Array<PackageFile> = []

  for (const record of dataset.values()) {
    const file = fileOfRecord(record)

    if (file) {
      files.push(file)
    }
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  return files
}

function scalarText(value: Value | undefined): string | undefined {
  return value?.kind === 'text' ? value.value : undefined
}

function scalarInteger(value: Value | undefined): number | undefined {
  return value?.kind === 'integer' ? Number(value.value) : undefined
}

function scalarBlobs(value: Value | undefined): Array<string> {
  // `list()` builds a COLLECTION whose order is 'list', not a value of kind 'list'.
  // Guarding on `kind === 'list'` never matches and silently yields no chunks.
  if (value?.kind !== 'collection' || value.order !== 'list') {
    return []
  }

  const out: Array<string> = []

  for (const item of value.items) {
    if (item.value.kind === 'blob') {
      out.push(item.value.hash)
    }
  }

  return out
}
