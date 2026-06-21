/**
 * Symmetry reduction: the state-space collapse from interchangeable
 * components. Run:
 *   npx tsx deck/test/code/demo-symmetry.ts
 *
 * N processes each cycle idle(0) -> wait(1) -> critical(2) -> idle, with
 * a process entering critical only if no other is there. Full
 * exploration visits every ordering of process states; symmetry
 * reduction (sort the tuple) visits one representative per multiset.
 * Both prove the same safety property (at most one in critical), but the
 * reduced state count is dramatically smaller. Deterministic, no deps.
 */

import { reach, sortedCanon, unsafeIn } from './symmetry'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
  else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
}

/** Successors: any process advances; enter critical only if none in critical. */
function succ(s: number[]): number[][] {
  const out: number[][] = []
  const inCritical = s.filter(v => v === 2).length
  for (let i = 0; i < s.length; i++) {
    const t = s.slice()
    if (s[i] === 0) t[i] = 1 // idle -> wait
    else if (s[i] === 1) { if (inCritical === 0) t[i] = 2; else continue } // wait -> critical (guarded)
    else t[i] = 0 // critical -> idle
    out.push(t)
  }
  return out
}

const bad = (s: number[]) => s.filter(v => v === 2).length > 1
const key = (s: number[]) => s.join(',')
const parse = (k: string) => k.split(',').map(Number)

for (const N of [3, 4, 5]) {
  const init = new Array<number>(N).fill(0)

  const full = reach({ init, succ, key, canon: x => x })
  const sym = reach({ init, succ, key, canon: sortedCanon })

  const fullSafe = !unsafeIn(full.states, parse, bad)
  const symSafe = !unsafeIn(sym.states, parse, bad)

  ok(`N=${N}: same safety verdict (full vs symmetry-reduced)`, fullSafe === symSafe && fullSafe,
    `full=${full.states.size} states, reduced=${sym.states.size} states (${(full.states.size / sym.states.size).toFixed(1)}x smaller)`)
}

console.log(`\nseed-verify symmetry demo: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
