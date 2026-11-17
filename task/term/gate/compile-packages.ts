// The packages `separate-diff` and `roll-fast` compile every file of (task/term/separate-diff.ts, roll-fast.ts), and
// how the gate splits them into legs (task/term/test.ts): one leg per package, and a large package in SHARDS legs.
//
// One process over all twelve was killed at the gate's 3600s on 2026-10-20 and again on 10-21, @term/bind still
// running after 40 minutes. Both compile each file of @term/bind whole, 3,091 of them, so its legs are cut by file
// (every SHARDS-th of its sorted list) and the pool runs them side by side.
//
// @term/call is cut in four for the same reason. Its 277 files take about 2,700s to 3,600s on the M3 at the load a
// board runs at, so the one leg was killed at 3600s, alone too, though no file got slower: the same files timed side
// by side on clones of every landing from 2026-11-16 08:48Z to 11-17 03:47Z took the same time within 1%
// (term-self-host-001-1610). A quarter takes under 1,000s at the same load.

import { parentPaths } from '../root'
const TERM = 'deck'

export const COMPILE_PACKAGES = [
  `${TERM}/base`,
  `${TERM}/host`,
  `${TERM}/face`,
  `${TERM}/site`,
  `${TERM}/test`,
  `${TERM}/call`,
  `${TERM}/cask`,
  `${TERM}/deck`,
  `${TERM}/feed`,
  `${TERM}/make`,
  ...parentPaths('deck/zone'),
  // the largest, 3,091 files: the one where a body-reading analysis and tree shaking differ most
  `${TERM}/bind`,
]

// legs per package, where one is not enough
export const COMPILE_SHARDS: Record<string, number> = { [`${TERM}/call`]: 4, [`${TERM}/bind`]: 8 }

// every leg: a package, and `k/n` when it is cut
export function compileLegs(): { pkg: string; shard?: string }[] {
  return COMPILE_PACKAGES.flatMap(pkg => {
    const n = COMPILE_SHARDS[pkg] ?? 1

    return n === 1 ? [{ pkg }] : Array.from({ length: n }, (_, k) => ({ pkg, shard: `${k}/${n}` }))
  })
}
