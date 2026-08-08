import type { Op } from '@term/base/code/sync/op-sync'
import type { Segment } from '@term/base/code/live/draft'
import type { Canon } from '@term/base/code/canon/json'
import { canonicalString } from '@term/base/code/canon/json'
import { encodeChange, decodeChange } from '@term/base/code/commit/changeset'

// Serialize a live-draft Segment (a batch of coalesced operations plus its predecessor
// hash) to deterministic bytes, so it can be stored as a content-addressed object in the
// same store as every other chunk. Content addressing is what makes an interrupted
// segment append idempotent (identical ops => identical hash) and lets a reconnecting
// client sync a draft by comparing chain tips, exactly like commit sync.
//
// Operation changes reuse the commit changeset codec (which handles bigint integers and
// every value kind), so a segment and a commit describe a change the same way. The HLC
// is stored as [wall, count, node] so operations keep their total order across a
// serialization round trip.
//
// See note/library/base/design/live-drafts.md.

function encodeOp(op: Op): Array<Canon> {
  return [
    [String(op.hlc.wall), String(op.hlc.count), op.hlc.node],
    encodeChange(op.change),
  ]
}

function decodeOp(enc: Array<Canon>): Op {
  const hlc = enc[0] as [string, string, string]
  return {
    hlc: {
      wall: Number(hlc[0]),
      count: Number(hlc[1]),
      node: hlc[2],
    },
    change: decodeChange(enc[1] as Array<Canon>),
  }
}

export function encodeSegment(segment: Segment): string {
  // the empty array means "no predecessor" (a chain root), distinct from any hash
  const previous: Canon =
    segment.previous === undefined ? [] : segment.previous
  return canonicalString([previous, segment.ops.map(encodeOp)] as never)
}

export function decodeSegment(bytes: string): Segment {
  const arr = JSON.parse(bytes) as [Canon, Array<Array<Canon>>]
  const previous = Array.isArray(arr[0]) ? undefined : (arr[0] as string)
  return {
    previous,
    ops: arr[1].map(decodeOp),
  }
}
