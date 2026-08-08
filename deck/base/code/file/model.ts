// The folder and file tree of a repository, modelled as records.
//
// A repository is a tree of folders and files, like a git repository. Every directory and every file
// is a record, linked to its parent by the move-aware `~parent` reference (`code/identity/tree.ts`).
// A file's identity is its mark and its content is its blob hash, so its PATH is neither: moving or
// renaming a folder updates `~parent` only, and nothing that references the file by mark breaks.
//
// A file is one of three kinds. A `tree` file is term-lang source whose content is the records it
// compiles to (it has no blob). A `text` or `binary` file's content is bytes in the global object
// store, referenced by a `@blob` hash.
//
// See note/library/base/design/asset-repositories-and-font-projection.md.

import type { Mark, RecordNode, Value } from '@term/base/code/base/type'
import type { Dataset } from '@term/base/code/diff/change'
import { blob, ref, text } from '@term/base/code/base/make'
import { parentOf } from '@term/base/code/identity/tree'

export const DIRECTORY = 'directory'
export const FILE = 'file'

const PARENT = '~parent'
const KIND = 'kind'
const BLOB = 'blob'

export type FileKind = 'tree' | 'text' | 'binary'

export function isDirectory(node: RecordNode): boolean {
  return node.type === DIRECTORY
}

export function isFile(node: RecordNode): boolean {
  return node.type === FILE
}

/** A directory record. The name is the record's label; the parent (if any) is a `~parent` ref. */
export function directoryRecord(input: {
  mark: Mark
  name: string
  parent?: Mark
}): RecordNode {
  const fields = new Map<string, Value>()
  if (input.parent !== undefined) {
    fields.set(PARENT, ref(input.parent))
  }
  return { mark: input.mark, type: DIRECTORY, label: input.name, fields }
}

/**
 * A file record. `kind` classifies its content. A `text` or `binary` file carries the hash of its
 * bytes as a `@blob`; a `tree` file has no blob, because its content is the records it compiles to.
 */
export function fileRecord(input: {
  mark: Mark
  name: string
  kind: FileKind
  parent?: Mark
  blob?: string
}): RecordNode {
  const fields = new Map<string, Value>()
  if (input.parent !== undefined) {
    fields.set(PARENT, ref(input.parent))
  }
  fields.set(KIND, text(input.kind))
  if (input.blob !== undefined) {
    fields.set(BLOB, blob(input.blob))
  }
  return { mark: input.mark, type: FILE, label: input.name, fields }
}

export function fileKindOf(node: RecordNode): FileKind | undefined {
  const value = node.fields.get(KIND)
  return value !== undefined && value.kind === 'text'
    ? (value.value as FileKind)
    : undefined
}

export function blobOf(node: RecordNode): string | undefined {
  const value = node.fields.get(BLOB)
  return value !== undefined && value.kind === 'blob' ? value.hash : undefined
}

// A children-by-parent index built in one pass, so listing a directory is proportional to its
// children rather than to the whole repository. The root's children sit under the `undefined` key.
export type ParentIndex = Map<Mark | undefined, Array<Mark>>

export function parentIndex(dataset: Dataset): ParentIndex {
  const index: ParentIndex = new Map()
  for (const [mark, node] of dataset) {
    const parent = parentOf(node)
    const bucket = index.get(parent)
    if (bucket === undefined) {
      index.set(parent, [mark])
    } else {
      bucket.push(mark)
    }
  }
  for (const bucket of index.values()) {
    bucket.sort()
  }
  return index
}

/** The children of a directory (or of the root, with `undefined`), by mark, sorted. */
export function listDirectory(
  dataset: Dataset,
  parent: Mark | undefined,
  index?: ParentIndex,
): Array<Mark> {
  if (index) {
    return index.get(parent) ?? []
  }
  const out: Array<Mark> = []
  for (const [mark, node] of dataset) {
    if (parentOf(node) === parent) {
      out.push(mark)
    }
  }
  return out.sort()
}

// The child of a directory with a given name (label), or undefined. Used to walk a path segment.
function childByName(
  dataset: Dataset,
  parent: Mark | undefined,
  name: string,
  index?: ParentIndex,
): Mark | undefined {
  for (const mark of listDirectory(dataset, parent, index)) {
    if (dataset.get(mark)?.label === name) {
      return mark
    }
  }
  return undefined
}

// Split a path into its non-empty segments. Leading, trailing, and doubled slashes are ignored.
function segments(path: string): Array<string> {
  return path.split('/').filter(segment => segment.length > 0)
}

/**
 * The mark at a path, resolved from the root by walking each segment by name. Returns undefined if
 * any segment is missing. `root` is the directory the path is relative to (the repository root when
 * omitted, i.e. the forest root).
 */
export function resolvePath(
  dataset: Dataset,
  path: string,
  opts?: { root?: Mark; index?: ParentIndex },
): Mark | undefined {
  let current: Mark | undefined = opts?.root
  for (const name of segments(path)) {
    const next = childByName(dataset, current, name, opts?.index)
    if (next === undefined) {
      return undefined
    }
    current = next
  }
  return current
}

/**
 * The path of a record, built by walking `~parent` up to the root and joining the labels. A record
 * whose parent chain reaches a missing node stops there, so a partial path is never silently wrong.
 */
export function pathOf(dataset: Dataset, mark: Mark): string | undefined {
  const names: Array<string> = []
  const seen = new Set<Mark>()
  let current: Mark | undefined = mark

  while (current !== undefined) {
    if (seen.has(current)) {
      return undefined // a cycle; the tree CRDT prevents this, but never loop on a corrupt input
    }
    seen.add(current)

    const node = dataset.get(current)
    if (node === undefined || node.label === undefined) {
      return undefined
    }

    names.push(node.label)
    current = parentOf(node)
  }

  return names.reverse().join('/')
}
