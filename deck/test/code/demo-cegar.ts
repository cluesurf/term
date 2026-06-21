/**
 * CEGAR: abstraction-refinement on an INFINITE-state system. Run:
 *   npx tsx deck/test/code/demo-cegar.ts
 *
 * The system: x starts at 0 and steps by +2 forever (x = 0, 2, 4, ...,
 * an infinite state space). Property: x is never 3.
 *   - With only the predicate {x >= 0}, the abstraction is too coarse:
 *     it cannot tell x=3 is unreachable, so it reports a SPURIOUS
 *     counterexample.
 *   - CEGAR refines by adding {x is even}. Now x=3 (odd) is provably
 *     unreachable, and the property is PROVEN over the infinite system
 *     with a tiny finite abstract model.
 *
 * Also: a real bug (x reaches 4) is caught with a concrete trace.
 * Needs z3-solver.
 */

import { cegar, type Concrete, type Predicate } from './cegar'
import { makeSmt } from './smt'

async function main(): Promise<void> {
  let z3
  try {
    z3 = await makeSmt()
  } catch {
    console.log('z3-solver not installed - run `pnpm install`, then re-run.')
    console.log('\nseed-verify cegar demo: skipped (no z3)')
    return
  }

  let pass = 0
  let fail = 0
  function ok(name: string, cond: boolean, info = ''): void {
    if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
    else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
  }

  // x := 0; loop x := x + 2.  Property: x != 3.
  const stepByTwo: Concrete = {
    init: (x) => x.eq(0),
    trans: (x, xn) => xn.eq(x.add(2)),
    bad: (x) => x.eq(3),
  }
  const nonneg: Predicate = (x) => x.ge(0)
  const even: Predicate = (x) => x.mod(2).eq(0)

  // coarse abstraction alone would be spurious; CEGAR refines with `even`.
  const proven = await cegar(stepByTwo, [nonneg], [even], z3)
  ok('CEGAR proves x != 3 on the infinite system (via refinement)',
    'safe' in proven && proven.safe === true,
    'safe' in proven && proven.safe ? `(${proven.predicatesUsed} predicates, ${proven.refinements} refinement)` : JSON.stringify(proven))

  // a real bug: same system, property x != 4 (4 IS reached).
  const buggy: Concrete = {
    init: (x) => x.eq(0),
    trans: (x, xn) => xn.eq(x.add(2)),
    bad: (x) => x.eq(4),
  }
  const found = await cegar(buggy, [nonneg], [even], z3)
  ok('CEGAR finds the real violation x = 4 with a concrete trace',
    'safe' in found && found.safe === false,
    'safe' in found && !found.safe ? `trace: ${found.trace.join(' -> ')}` : JSON.stringify(found))

  console.log(`\nseed-verify cegar demo: ${pass} pass, ${fail} fail`)
  if (fail > 0) process.exit(1)
}

main()
