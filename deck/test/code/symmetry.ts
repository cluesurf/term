/**
 * Symmetry reduction (concepts.md): when components are interchangeable,
 * explore one representative per symmetry (permutation) class instead of
 * all orderings. For N identical processes the reachable-state count
 * collapses from "all tuples" to "all multisets" - a factor up to N!.
 *
 * The mechanism is a canonicalizer: map each state to a canonical form
 * (here, sort the per-process local states) so permutation-equivalent
 * states dedup to one. Reachability over the canonical states explores
 * far fewer states and proves the same safety property.
 */

/** A generic explicit-state reachability, parameterized by a state
 * canonicalizer. `canon = x => x` is full exploration; a real
 * canonicalizer applies the symmetry. */
export function reach<S>(input: {
  init: S
  succ: (s: S) => S[]
  key: (s: S) => string
  canon: (s: S) => S
}): { states: Set<string>; explored: number } {
  const { init, succ, key, canon } = input
  const states = new Set<string>()
  const frontier: S[] = []

  const start = canon(init)
  states.add(key(start))
  frontier.push(start)
  let explored = 0

  while (frontier.length) {
    const s = frontier.shift() as S
    explored++
    for (const t of succ(s)) {
      const c = canon(t)
      const k = key(c)
      if (!states.has(k)) {
        states.add(k)
        frontier.push(c)
      }
    }
  }
  return { states, explored }
}

/** Sort a process-state tuple - the canonical form under process
 * permutation symmetry. */
export function sortedCanon(s: number[]): number[] {
  return s.slice().sort((a, b) => a - b)
}

/** Does any reachable state violate the safety predicate? */
export function unsafeIn(states: Set<string>, parse: (k: string) => number[], bad: (s: number[]) => boolean): boolean {
  for (const k of states) if (bad(parse(k))) return true
  return false
}
