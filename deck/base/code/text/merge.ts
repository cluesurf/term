import {
  changeHunks,
  tokenize,
  detokenize,
  type Granularity,
} from '@/text/diff'

// Three-way text merge (diff3) at line, word, or character granularity. Two branches
// that edit disjoint regions of the same text merge cleanly, even inside a single
// string field, which line-level tools cannot do at word granularity. Only genuinely
// overlapping edits conflict, and the conflict carries all three sides. This is the
// text counterpart to the record-level semantic merge in code/merge.
//
// See note/library/base/design/merge-formal-spec.md.

export type MergeRegion<T> =
  | { ok: Array<T> }
  | { conflict: { a: Array<T>; o: Array<T>; b: Array<T> } }

function eq(x: Array<string>, y: Array<string>): boolean {
  if (x.length !== y.length) {
    return false
  }
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) {
      return false
    }
  }
  return true
}

// Merge token sequences `a` and `b` against common base `o`, region by region.
export function merge3Tokens(
  o: Array<string>,
  a: Array<string>,
  b: Array<string>,
): Array<MergeRegion<string>> {
  const A = changeHunks(o, a)
  const B = changeHunks(o, b)
  const out: Array<MergeRegion<string>> = []
  let oi = 0
  let i = 0
  let j = 0

  const sideView = (
    lo: number,
    hi: number,
    hunks: Array<{ start: number; length: number; content: Array<string> }>,
  ): Array<string> => {
    const view: Array<string> = []
    let cur = lo
    for (const h of hunks) {
      view.push(...o.slice(cur, h.start))
      view.push(...h.content)
      cur = h.start + h.length
    }
    view.push(...o.slice(cur, hi))
    return view
  }

  while (i < A.length || j < B.length) {
    const aStart = i < A.length ? A[i]!.start : Infinity
    const bStart = j < B.length ? B[j]!.start : Infinity
    const lo = Math.min(aStart, bStart)
    // stable region before the next change
    if (lo > oi) {
      out.push({ ok: o.slice(oi, lo) })
      oi = lo
    }
    // grow a cluster over all hunks that overlap the region (adjacent, non-overlapping
    // hunks are kept separate so disjoint edits both apply)
    let hi = lo
    const aCluster: Array<{ start: number; length: number; content: Array<string> }> = []
    const bCluster: typeof aCluster = []
    let grew = true
    while (grew) {
      grew = false
      while (i < A.length && (A[i]!.start === lo || A[i]!.start < hi)) {
        hi = Math.max(hi, A[i]!.start + A[i]!.length)
        aCluster.push(A[i]!)
        i++
        grew = true
      }
      while (j < B.length && (B[j]!.start === lo || B[j]!.start < hi)) {
        hi = Math.max(hi, B[j]!.start + B[j]!.length)
        bCluster.push(B[j]!)
        j++
        grew = true
      }
    }

    const oRange = o.slice(lo, hi)
    const aView = sideView(lo, hi, aCluster)
    const bView = sideView(lo, hi, bCluster)

    if (aCluster.length === 0) {
      out.push({ ok: bView })
    } else if (bCluster.length === 0) {
      out.push({ ok: aView })
    } else if (eq(aView, bView)) {
      out.push({ ok: aView }) // same edit on both sides
    } else if (eq(aView, oRange)) {
      out.push({ ok: bView }) // only b changed this region
    } else if (eq(bView, oRange)) {
      out.push({ ok: aView }) // only a changed this region
    } else {
      out.push({ conflict: { a: aView, o: oRange, b: bView } })
    }
    oi = hi
  }
  if (oi < o.length) {
    out.push({ ok: o.slice(oi) })
  }
  return out
}

export type TextMerge = {
  // true when no region conflicted
  clean: boolean
  // the merged text; conflicting regions are wrapped in git-style markers
  text: string
  // number of conflicting regions
  conflicts: number
  // the structured regions, for callers that render conflicts themselves
  regions: Array<MergeRegion<string>>
}

// Merge two edited versions of a text against their common base.
export function merge3Text(
  base: string,
  a: string,
  b: string,
  granularity: Granularity = 'line',
): TextMerge {
  const regions = merge3Tokens(
    tokenize(base, granularity),
    tokenize(a, granularity),
    tokenize(b, granularity),
  )
  const sep = granularity === 'line' ? '\n' : ''
  const parts: Array<string> = []
  let conflicts = 0
  for (const r of regions) {
    if ('ok' in r) {
      parts.push(detokenize(r.ok, granularity))
    } else {
      conflicts++
      const aSide = detokenize(r.conflict.a, granularity)
      const bSide = detokenize(r.conflict.b, granularity)
      parts.push(`<<<<<<< a${sep}${aSide}${sep}=======${sep}${bSide}${sep}>>>>>>> b`)
    }
  }
  return {
    clean: conflicts === 0,
    text: parts.join(sep),
    conflicts,
    regions,
  }
}
