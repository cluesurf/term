// Reference counting, as an accelerator over reachability.
//
// The count answers "is this a CANDIDATE for deletion", cheaply, for the common case.
// Reachability confirms it before anything is removed. That asymmetry is the whole design
// and it is not a compromise: refcounts drift, and the two failure modes are not equal.
//
//   a lost decrement leaks     -> costs money, loses nothing, repaired by the next walk
//   a lost increment deletes   -> unrecoverable, silent until a read fails months later
//
// So a count is never allowed to authorize a delete on its own. Anything that does is one
// lost increment away from destroying data that something still points at.
//
// See note/library/base/design/reference-counting.md.

export type Counts = Map<string, number>

/** A referrer and what it points at, so "why is this still here" is answerable. */
export type Link = { object: string; referrer: string }

export function countsOf(links: Iterable<Link>): Counts {
  const counts: Counts = new Map()

  for (const link of links) {
    counts.set(link.object, (counts.get(link.object) ?? 0) + 1)
  }

  return counts
}

export type Candidate = {
  object: string
  count: number
  // when the count first reached zero, so a grace period can be applied
  since: number
}

/**
 * Objects whose count says they may be collectable.
 *
 * Deliberately named CANDIDATE. Nothing here is safe to delete yet, and a caller that
 * treats this list as a delete list has skipped the only step that makes refcounting
 * safe.
 */
export function candidates(input: {
  counts: Counts
  known: Iterable<string>
  now: number
}): Array<Candidate> {
  const out: Array<Candidate> = []

  for (const object of input.known) {
    const count = input.counts.get(object) ?? 0

    if (count === 0) {
      out.push({ object, count, since: input.now })
    }
  }

  return out
}

// How long an object sits at zero before it may be removed. A publish that arrives moments
// after a collector observed zero re-references the object, and the grace period is what
// makes that race benign rather than fatal.
export const GRACE_MS = 24 * 60 * 60 * 1000

export function ripe(input: {
  candidates: Array<Candidate>
  now: number
  grace?: number
}): Array<Candidate> {
  const grace = input.grace ?? GRACE_MS

  return input.candidates.filter(
    candidate => input.now - candidate.since >= grace,
  )
}

export type Sweep = {
  deleted: Array<string>
  // counted zero but still reachable, so the count was wrong and has been repaired
  spared: Array<string>
}

/**
 * Delete the candidates that reachability agrees are dead.
 *
 * The verification is the point. A candidate that turns out to be reachable is SPARED and
 * reported, which turns a lost increment from silent data loss into a repaired count and
 * a log line.
 */
export function sweep(input: {
  candidates: Array<Candidate>
  reachable: Set<string>
  remove: (object: string) => void
}): Sweep {
  const deleted: Array<string> = []
  const spared: Array<string> = []

  for (const candidate of input.candidates) {
    if (input.reachable.has(candidate.object)) {
      spared.push(candidate.object)
      continue
    }

    input.remove(candidate.object)
    deleted.push(candidate.object)
  }

  return { deleted, spared }
}

/**
 * Repair counts from the authoritative link set.
 *
 * Drift is expected rather than exceptional, so it is corrected on a schedule instead of
 * being prevented by care. Returns what changed, because a count that repairs constantly
 * is reporting a bug somewhere upstream.
 */
export function repair(input: {
  counts: Counts
  links: Iterable<Link>
}): { counts: Counts; corrected: Array<{ object: string; was: number; now: number }> } {
  const truth = countsOf(input.links)
  const corrected: Array<{ object: string; was: number; now: number }> = []

  for (const [object, now] of truth) {
    const was = input.counts.get(object) ?? 0

    if (was !== now) {
      corrected.push({ object, was, now })
    }
  }

  for (const [object, was] of input.counts) {
    if (!truth.has(object) && was !== 0) {
      corrected.push({ object, was, now: 0 })
    }
  }

  return { counts: truth, corrected }
}

/**
 * Whether a pack may be removed.
 *
 * A pack is one stored object holding many. Deleting one object inside it frees nothing,
 * so a pack is removable only when EVERY object in it is unreferenced. That makes packing
 * a decision about collection granularity as much as about transfer cost.
 */
export function packRemovable(input: {
  contents: Array<string>
  counts: Counts
}): boolean {
  return input.contents.every(object => (input.counts.get(object) ?? 0) === 0)
}
