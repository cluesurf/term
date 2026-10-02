// Integer exactness in the provers. JavaScript numbers are exact integers only up to 2^53 - 1. Before 2026-10-02 a
// literal past that was read with Number() in the mill, and coefficients were combined in doubles, so
// `x * 9007199254740993 == x * 9007199254740992` was PROVEN. Run: npx tsx test/check/exact.ts
//
// Every layer is held here: the ring normalizer declines a coefficient past the safe range, the linear certificate
// checker refuses a step whose numbers rounded, and true identities inside the range still prove.

import type { Expression } from '@term/make/code/compile/node'
import { checkRefutation } from '@term/make/code/check/certificate'
import { nonNegativeDifference, ringEqual, ringEqualModulo } from '@term/make/code/check/ring'
import { linear } from '@term/make/code/check/refine'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}`)
  }
}

const span = { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } }
const x = { form: 'variable', name: 'x', span } as unknown as Expression
const int = (value: number | bigint) => ({ form: 'integer', value, span }) as unknown as Expression
const times = (left: Expression, right: Expression) =>
  ({ form: 'binary', op: '*', left, right, span }) as unknown as Expression

// the probe that was proven: 2^53 + 1 against 2^53, as the mill now delivers them (an exact bigint past the range)
ok('2^53 + 1 is not 2^53', !ringEqual(times(x, int(9007199254740993n)), times(x, int(9007199254740992n))))

// a product that leaves the range: (2^27 + 1)^2 = 2^54 + 2^28 + 1, not 2^54 + 2^28
ok(
  'a product past 2^53 is declined, not rounded',
  !ringEqual(times(times(x, int(134217729)), int(134217729)), times(x, int(18014398777917440n))),
)

// and the TRUE version is declined too, which is the price of exactness until coefficients are BigInt: declining is
// sound, accepting a rounded identity is not
ok(
  'the true identity past 2^53 is declined, not proven by rounding',
  !ringEqual(times(times(x, int(134217729)), int(134217729)), times(x, int(18014398777917441n))),
)

// inside the range, identities still prove
ok('(2^20 + 1)^2 x == (2^40 + 2^21 + 1) x', ringEqual(times(times(x, int(1048577)), int(1048577)), times(x, int(1099513724929))))
ok('modulo hypotheses still declines past the range', !ringEqualModulo(times(x, int(9007199254740993n)), times(x, int(9007199254740992n)), [[x, int(1)]]))
ok('non-negativity declines past the range', !nonNegativeDifference(times(times(x, x), int(9007199254740993n)), int(0)))
ok('non-negativity still proves inside it', nonNegativeDifference(times(times(x, x), int(9007199254740991)), int(0)))

// the linear certificate checker refuses a derivation whose numbers rounded
const big = 2 ** 53
ok(
  'a refutation over a non-safe input does not replay',
  !checkRefutation([{ linear: linear({ x: big }, 1), strict: false }, { linear: linear({ x: -big }, 0), strict: false }], {
    by: 'sum',
    first: { by: 'input', at: 0 },
    second: { by: 'input', at: 1 },
    a: 1,
    b: 1,
  }),
)

console.log(`\nexact: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
