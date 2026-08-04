// Hybrid logical clocks. An operation carries an HLC timestamp so base can order
// operations and detect concurrency at scale, with a small fixed size and bounded
// drift. Pure functions over explicit wall-clock inputs, so tests are deterministic.
//
// See note/library/base/design/merge-formal-spec.md (tie-breaking) and
// note/library/base/editing/06-algorithms.md.

export type Hlc = {
  // physical time component (milliseconds)
  wall: number
  // logical counter, bumped when wall time does not advance
  count: number
  // the originating node, to break ties deterministically
  node: string
}

// Advance a local clock at a given wall time.
export function localTick(prev: Hlc | undefined, wall: number): Hlc {
  const node = prev?.node ?? ''
  if (prev && wall <= prev.wall) {
    return { wall: prev.wall, count: prev.count + 1, node }
  }
  return { wall, count: 0, node }
}

// Merge a received clock into the local one at a given wall time.
export function receiveTick(
  local: Hlc,
  remote: Hlc,
  wall: number,
): Hlc {
  const maxWall = Math.max(wall, local.wall, remote.wall)
  let count: number
  if (maxWall === local.wall && maxWall === remote.wall) {
    count = Math.max(local.count, remote.count) + 1
  } else if (maxWall === local.wall) {
    count = local.count + 1
  } else if (maxWall === remote.wall) {
    count = remote.count + 1
  } else {
    count = 0
  }
  return { wall: maxWall, count, node: local.node }
}

// Total order on clocks: wall, then count, then node.
export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.wall !== b.wall) {
    return a.wall < b.wall ? -1 : 1
  }
  if (a.count !== b.count) {
    return a.count < b.count ? -1 : 1
  }
  return a.node < b.node ? -1 : a.node > b.node ? 1 : 0
}

// Two clocks are concurrent when neither is a causal ancestor. With a single total
// order we cannot detect this from timestamps alone, so concurrency is tracked by
// the branch structure; this comparator provides the deterministic tie-break the
// merge needs (HLC, then mark, then content hash).
export function tieBreak(
  aHlc: Hlc | undefined,
  bHlc: Hlc | undefined,
  aKey: string,
  bKey: string,
): number {
  if (aHlc && bHlc) {
    const c = compareHlc(aHlc, bHlc)
    if (c !== 0) {
      return c
    }
  }
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0
}
