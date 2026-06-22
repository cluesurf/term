// Refinement prover tests: the Fourier-Motzkin decision procedure discharges verification conditions.
// Run: npx tsx test/check/refine.ts

import {
  above,
  atLeast,
  atMost,
  below,
  linear,
  proves,
} from '@cluesurf/make/code/check/refine'

const n = linear({ n: 1 })
const i = linear({ i: 1 })
const len = linear({ len: 1 })
const k = (c: number) => linear({}, c)

let pass = 0
let fail = 0

function expect(name: string, got: boolean, want: boolean): void {
  if (got === want) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  (got ${got}, want ${want})`)
  }
}

function main(): void {
  // n >= 0  implies  n + 1 > 0
  expect(
    'n>=0 => n+1>0',
    proves([atLeast(n, k(0))], above(linear({ n: 1 }, 1), k(0))),
    true,
  )

  // n >= 0  does NOT imply  n - 1 >= 0  (n = 0 is a counterexample)
  expect(
    'n>=0 =/=> n-1>=0',
    proves([atLeast(n, k(0))], atLeast(linear({ n: 1 }, -1), k(0))),
    false,
  )

  // n > 0  implies  n - 1 >= 0   over integers (n > 0 means n >= 1). The prover tightens strict inequalities, so it
  // reasons over the integers, not the rationals: this is now valid.
  expect(
    'n>0 => n-1>=0 (integers)',
    proves([above(n, k(0))], atLeast(linear({ n: 1 }, -1), k(0))),
    true,
  )
  // and the integer tightening is real: n > 0 proves n >= 1
  expect(
    'n>0 => n>=1 (integers)',
    proves([above(n, k(0))], atLeast(n, k(1))),
    true,
  )

  // index safety: 0 <= i AND i < len  implies  i < len
  expect(
    'bounds => i<len',
    proves([atLeast(i, k(0)), below(i, len)], below(i, len)),
    true,
  )

  // index safety: 0 <= i AND i < len  implies  i >= 0
  expect(
    'bounds => i>=0',
    proves([atLeast(i, k(0)), below(i, len)], atLeast(i, k(0))),
    true,
  )

  // transitivity: a <= b AND b <= c  implies  a <= c
  const a = linear({ a: 1 })
  const b = linear({ b: 1 })
  const c = linear({ c: 1 })
  expect(
    'a<=b, b<=c => a<=c',
    proves([atMost(a, b), atMost(b, c)], atMost(a, c)),
    true,
  )

  // unsound goal rejected: a <= b does NOT imply b <= a
  expect('a<=b =/=> b<=a', proves([atMost(a, b)], atMost(b, a)), false)

  // contradiction in assumptions proves anything (ex falso): n >= 5 AND n <= 0
  expect(
    'contradiction proves anything',
    proves([atLeast(n, k(5)), atMost(n, k(0))], atMost(n, k(-100))),
    true,
  )

  console.log(`\nrefine: ${pass} pass, ${fail} fail`)
}

main()
