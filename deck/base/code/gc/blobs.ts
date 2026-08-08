import type { RecordNode, Value } from '@term/base/code/base/type'
import type { Dataset } from '@term/base/code/diff/change'

// The blob hashes reachable from a dataset's records.
//
// A blob is binary content (a font, an image) stored once, globally, in a content-addressed object
// store, and referenced from a record by hash. Records live in the chunk store and are swept by
// `reachableChunks`; blobs live in a separate object store, so reclaiming unreferenced bytes needs
// its OWN reachability. A blob is live exactly when some live record references its hash, here or
// inside a collection or a nested record. This produces the set a blob sweep keeps.
//
// The object store is content-addressed and may be shared across repositories, so a real sweep
// unions the reachable set of every repository that shares the store before deleting anything. This
// function computes one repository's contribution.
//
// See note/library/base/design/asset-repositories-and-font-projection.md (hardening: blob sweep).

function walkValue(value: Value, out: Set<string>): void {
  switch (value.kind) {
    case 'blob':
      out.add(value.hash)
      return
    case 'collection':
      for (const item of value.items) {
        walkValue(item.value, out)
      }
      return
    case 'record':
      walkRecord(value.record, out)
      return
    default:
      return
  }
}

function walkRecord(node: RecordNode, out: Set<string>): void {
  for (const value of node.fields.values()) {
    walkValue(value, out)
  }
}

/** Every blob hash referenced by a record in the dataset, including nested and collected values. */
export function reachableBlobs(dataset: Dataset): Set<string> {
  const out = new Set<string>()

  for (const node of dataset.values()) {
    walkRecord(node, out)
  }

  return out
}

/** The blob hashes present in the object store but referenced by no live record: the sweep set. */
export function unreachableBlobs(
  present: Iterable<string>,
  reachable: Set<string>,
): Array<string> {
  const out: Array<string> = []

  for (const hash of present) {
    if (!reachable.has(hash)) {
      out.push(hash)
    }
  }

  return out
}
