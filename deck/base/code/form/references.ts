import type { Mark, RecordNode, Value } from '@/base/type'
import type { Dataset } from '@/diff/change'
import type { Diagnostic } from '@/form/validate'
import type { Severity } from '@/form/form'
import { isOffHistoryRef, offHistoryId, type OffHistoryStore } from '@/offhistory/store'

// Referential integrity across the whole record graph, independent of any form. This
// catches the dangling references that the `dangle` referential action and off-history
// deletion deliberately leave behind, so a projection or a reviewer can surface them.
// It walks every ref, including refs inside collections and nested records, and (given
// the side store) checks that off-history content still exists.
//
// See note/library/base/design/identity-lifecycle.md and
// note/library/base/design/deletion-and-legal-removal.md.

export type ReferenceOptions = {
  // severity of a dangling reference; defaults to `want` (a warning), since a dangle
  // action leaves references on purpose and should not block a commit
  severity?: Severity
  // if provided, off-history references are checked for present content
  offHistory?: OffHistoryStore
}

function walkValue(
  value: Value,
  owner: Mark | undefined,
  field: string,
  dataset: Dataset,
  opts: ReferenceOptions,
  out: Array<Diagnostic>,
): void {
  const severity = opts.severity ?? 'want'
  if (value.kind === 'ref') {
    if (!dataset.has(value.target)) {
      out.push({
        severity,
        mark: owner,
        field,
        message: `reference ${value.target} is dangling`,
      })
    }
    return
  }
  if (isOffHistoryRef(value)) {
    if (opts.offHistory !== undefined) {
      const id = offHistoryId(value)!
      if (!opts.offHistory.has(id)) {
        out.push({
          severity,
          mark: owner,
          field,
          message: `off-history content ${id} is absent`,
        })
      }
    }
    return
  }
  if (value.kind === 'collection') {
    for (const it of value.items) {
      walkValue(it.value, owner, field, dataset, opts, out)
    }
    return
  }
  if (value.kind === 'record') {
    walkRecord(value.record, owner ?? value.record.mark, dataset, opts, out)
  }
}

function walkRecord(
  node: RecordNode,
  owner: Mark | undefined,
  dataset: Dataset,
  opts: ReferenceOptions,
  out: Array<Diagnostic>,
): void {
  for (const [field, value] of node.fields) {
    walkValue(value, owner, field, dataset, opts, out)
  }
}

export function validateReferences(
  dataset: Dataset,
  opts: ReferenceOptions = {},
): Array<Diagnostic> {
  const out: Array<Diagnostic> = []
  for (const node of dataset.values()) {
    walkRecord(node, node.mark, dataset, opts, out)
  }
  return out
}
