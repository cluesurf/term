import type { Mark, RecordNode, Value } from '@/base/type'
import type { Dataset } from '@/diff/change'

// Identity lifecycle beyond creation: two records that are one (merge to a redirect),
// one record that was two (split), and what happens to references when a record is
// removed (referential actions). A merge never deletes: the losing mark becomes a
// redirect to the winner, so old citations and references still resolve, the way
// Wikidata handles item merges.
//
// See note/library/base/design/identity-lifecycle.md.

const REDIRECT = '~redirect'
const SPLIT = '~split'

// --- reference scanning -----------------------------------------------------

function valueRefsTo(value: Value, mark: Mark): boolean {
  if (value.kind === 'ref') {
    return value.target === mark
  }
  if (value.kind === 'collection') {
    return value.items.some(it => valueRefsTo(it.value, mark))
  }
  if (value.kind === 'record') {
    return recordRefsTo(value.record, mark)
  }
  return false
}

function recordRefsTo(node: RecordNode, mark: Mark): boolean {
  for (const v of node.fields.values()) {
    if (valueRefsTo(v, mark)) {
      return true
    }
  }
  return false
}

// The marks of records that reference a given mark.
export function referrers(dataset: Dataset, mark: Mark): Array<Mark> {
  const out: Array<Mark> = []
  for (const [m, node] of dataset) {
    if (m !== mark && recordRefsTo(node, mark)) {
      out.push(m)
    }
  }
  return out
}

function rewriteValue(value: Value, from: Mark, to: Mark): Value {
  if (value.kind === 'ref' && value.target === from) {
    return { kind: 'ref', target: to }
  }
  if (value.kind === 'collection') {
    return {
      kind: 'collection',
      order: value.order,
      items: value.items.map(it => ({ ...it, value: rewriteValue(it.value, from, to) })),
    }
  }
  if (value.kind === 'record') {
    return { kind: 'record', record: rewriteRecord(value.record, from, to) }
  }
  return value
}

function rewriteRecord(node: RecordNode, from: Mark, to: Mark): RecordNode {
  const fields = new Map<string, Value>()
  for (const [name, v] of node.fields) {
    fields.set(name, rewriteValue(v, from, to))
  }
  return { ...node, fields }
}

// --- redirect ---------------------------------------------------------------

export function isRedirect(node: RecordNode): boolean {
  return node.fields.has(REDIRECT)
}

export function redirectTarget(node: RecordNode): Mark | undefined {
  const v = node.fields.get(REDIRECT)
  return v !== undefined && v.kind === 'ref' ? v.target : undefined
}

// Follow a redirect chain to the final live mark.
export function resolveMark(dataset: Dataset, mark: Mark): Mark {
  let cur = mark
  const seen = new Set<Mark>()
  for (;;) {
    const node = dataset.get(cur)
    if (node === undefined || !isRedirect(node)) {
      return cur
    }
    const next = redirectTarget(node)
    if (next === undefined || seen.has(next)) {
      return cur
    }
    seen.add(cur)
    cur = next
  }
}

// --- merge (dedup) ----------------------------------------------------------

// Merge two records that turn out to be the same entity. The winner keeps its
// fields, the loser's extra fields are added, the loser becomes a redirect to the
// winner, and inbound references are rewritten to the winner (unless disabled). No
// data is deleted; every mark still resolves.
export function mergeRecords(
  dataset: Dataset,
  loser: Mark,
  winner: Mark,
  opts: { rewriteRefs?: boolean } = {},
): Dataset {
  const lo = dataset.get(loser)
  const wi = dataset.get(winner)
  if (lo === undefined || wi === undefined || loser === winner) {
    return dataset
  }
  const out: Dataset = new Map(dataset)

  const fields = new Map(wi.fields)
  for (const [k, v] of lo.fields) {
    if (!fields.has(k)) {
      fields.set(k, v)
    }
  }
  out.set(winner, { ...wi, fields })
  out.set(loser, {
    type: lo.type,
    mark: loser,
    fields: new Map([[REDIRECT, { kind: 'ref', target: winner }]]),
  })

  if (opts.rewriteRefs !== false) {
    for (const [m, node] of out) {
      if (m === loser) {
        continue
      }
      const rewritten = rewriteRecord(node, loser, winner)
      out.set(m, rewritten)
    }
  }
  return out
}

// --- split ------------------------------------------------------------------

// Split one record into several. The parts get new marks, and the source becomes a
// split marker pointing at them, so its history and inbound references remain.
export function splitRecord(
  dataset: Dataset,
  source: Mark,
  parts: Array<RecordNode>,
): Dataset {
  const src = dataset.get(source)
  if (src === undefined) {
    return dataset
  }
  const out: Dataset = new Map(dataset)
  for (const p of parts) {
    if (p.mark === undefined) {
      throw new Error('split parts must be marked')
    }
    out.set(p.mark, p)
  }
  out.set(source, {
    type: src.type,
    mark: source,
    fields: new Map<string, Value>([
      [
        SPLIT,
        {
          kind: 'collection',
          order: 'set',
          items: parts.map(p => ({ value: { kind: 'ref', target: p.mark! } })),
        },
      ],
    ]),
  })
  return out
}

// --- referential actions ----------------------------------------------------

export type RefAction = 'restrict' | 'cascade' | 'dangle'

export type RemoveResult =
  | { ok: true; dataset: Dataset }
  | { ok: false; blockedBy: Array<Mark> }

// Remove a record, applying the referential action for its referrers. `restrict`
// refuses if anything references it, `cascade` removes the referrers too (one level),
// and `dangle` removes it and leaves the references to be flagged by validation. A
// caller holding a maintained reverse-reference index can pass its referrers to skip
// the full-dataset scan.
export function removeWithAction(
  dataset: Dataset,
  mark: Mark,
  action: RefAction,
  knownReferrers?: Array<Mark>,
): RemoveResult {
  const refs = knownReferrers ?? referrers(dataset, mark)
  if (action === 'restrict' && refs.length > 0) {
    return { ok: false, blockedBy: refs }
  }
  const out: Dataset = new Map(dataset)
  out.delete(mark)
  if (action === 'cascade') {
    for (const r of refs) {
      out.delete(r)
    }
  }
  return { ok: true, dataset: out }
}
