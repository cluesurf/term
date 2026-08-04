import type { Mark, RecordNode } from '@term/base/code/base/type'
import type { Dataset } from '@term/base/code/diff/change'

// Redaction: removing content from an immutable history. A redaction replaces a
// record's content with a signed tombstone, recorded as a commit, so the hashes
// along its path change as a normal, auditable transition rather than corruption,
// and it propagates to replicas through sync like any other change. The mark and its
// history position remain, so citations and references still resolve to a redacted
// record rather than dangling.
//
// See note/library/base/design/deletion-and-legal-removal.md.

const REDACTED_FIELD = 'redacted'

// A tombstone keeps the mark and type but clears the content, recording who redacted
// it, why, and when. It is the record's new, legitimate state.
export function makeTombstone(
  node: RecordNode,
  opts: { reason: string; by: string; time: number },
): RecordNode {
  const fields = new Map<string, import('@term/base/code/base/type').Value>()
  fields.set(REDACTED_FIELD, { kind: 'boolean', value: true })
  fields.set('reason', { kind: 'text', value: opts.reason })
  fields.set('by', { kind: 'text', value: opts.by })
  fields.set('time', { kind: 'integer', value: BigInt(opts.time) })
  const out: RecordNode = { type: node.type, fields }
  if (node.mark !== undefined) {
    out.mark = node.mark
  }
  return out
}

export function isRedacted(node: RecordNode): boolean {
  const v = node.fields.get(REDACTED_FIELD)
  return v !== undefined && v.kind === 'boolean' && v.value === true
}

// Produce a new dataset with the record at `mark` replaced by its tombstone.
export function redactInDataset(
  dataset: Dataset,
  mark: Mark,
  opts: { reason: string; by: string; time: number },
): Dataset {
  const node = dataset.get(mark)
  if (node === undefined) {
    return dataset
  }
  const out: Dataset = new Map(dataset)
  out.set(mark, makeTombstone(node, opts))
  return out
}
