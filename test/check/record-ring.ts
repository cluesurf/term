// Laws over FORMS WITH FIELDS, decided on the fields: vectors and matrices as records, their operations as tasks.
//
//   1. a task reading `u/x` unfolds with its parameters substituted inside the read (check/unfold.ts). It used to read
//      as closed and keep the callee's names, so one more step (the normalizer reading members) would prove
//      `dot(u, v) == dot(u, u)`. Held below by exactly that law, which must stay refused
//   2. a field read of a name is an unknown of its own (`u/x`), of a construction its value
//   3. two constructions of one form are equal when their fields are (check/ring.ts), and a name of a form with no cases
//      is the construction of its fields (record eta, check/elaborate.ts `etaPair`)
//   4. an inequality naming a task is asked again through the definitions (check/holds.ts): Cauchy-Schwarz
// Run: npx tsx test/check/record-ring.ts

import { compile } from '@term/make/code/compile/compile'

let pass = 0
let fail = 0

function expect(name: string, rule: string, want: 'ok' | 'refused'): void {
  const result = compile({ file: 'r.tree', text: `${PRELUDE}\n${rule}\n` }, { leanOf: () => true })
  const good = want === 'ok' ? result.ok : !result.ok

  if (good) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  (wanted ${want})\n      ${result.ok ? 'accepted' : result.diagnostics.map(d => d.message).join(' | ')}`)
  }
}

const PRELUDE = `form vector-two
  slot x, like integer
  slot y, like integer

task dot
  take u, like vector-two
  take v, like vector-two

  like integer

  back add(multiply(u/x, v/x), multiply(u/y, v/y))

task sum
  take u, like vector-two
  take v, like vector-two

  like vector-two

  back make vector-two(add(u/x, v/x), add(u/y, v/y))

task origin
  like vector-two

  back make vector-two(0, 0)

form matrix-two
  slot xx, like integer
  slot xy, like integer
  slot yx, like integer
  slot yy, like integer

task product
  take m, like matrix-two
  take n, like matrix-two

  like matrix-two

  back
    make matrix-two
      bind xx, add(multiply(m/xx, n/xx), multiply(m/xy, n/yx))
      bind xy, add(multiply(m/xx, n/xy), multiply(m/xy, n/yy))
      bind yx, add(multiply(m/yx, n/xx), multiply(m/yy, n/yx))
      bind yy, add(multiply(m/yx, n/xy), multiply(m/yy, n/yy))

task determinant
  take m, like matrix-two

  like integer

  back subtract(multiply(m/xx, m/yy), multiply(m/xy, m/yx))
`

expect(
  'THE LATENT UNSOUNDNESS: dot(u, v) == dot(u, u), the callee\'s own names, stays refused',
  `rule dangling
  seat u, like vector-two
  seat v, like vector-two
  show hold, is-equal dot(u, v), dot(u, u)`,
  'refused',
)

expect(
  'and renamed: dot(p, q) == dot(q, q) stays refused',
  `rule dangling-renamed
  seat p, like vector-two
  seat q, like vector-two
  show hold, is-equal dot(p, q), dot(q, q)`,
  'refused',
)

expect(
  'dot is symmetric, on the fields',
  `rule dot-is-symmetric
  seat u, like vector-two
  seat v, like vector-two
  show hold, is-equal dot(u, v), dot(v, u)`,
  'ok',
)

expect(
  'a vector is the construction of its fields (record eta): v + 0 = v',
  `rule origin-is-identity
  seat v, like vector-two
  show hold, is-equal sum(v, origin()), v`,
  'ok',
)

expect(
  'but v + v = v is refused',
  `rule doubled-is-itself
  seat v, like vector-two
  show hold, is-equal sum(v, v), v`,
  'refused',
)

expect(
  'two constructions are equal field by field: the product associates',
  `rule product-associates
  seat m, like matrix-two
  seat n, like matrix-two
  seat p, like matrix-two
  show hold, is-equal product(product(m, n), p), product(m, product(n, p))`,
  'ok',
)

expect(
  'and the product does not commute',
  `rule product-commutes
  seat m, like matrix-two
  seat n, like matrix-two
  show hold, is-equal product(m, n), product(n, m)`,
  'refused',
)

expect(
  'the determinant is multiplicative',
  `rule determinant-of-a-product
  seat m, like matrix-two
  seat n, like matrix-two
  show hold, is-equal determinant(product(m, n)), multiply(determinant(m), determinant(n))`,
  'ok',
)

expect(
  'an inequality through the definitions: Cauchy-Schwarz',
  `rule cauchy-schwarz
  seat u, like vector-two
  seat v, like vector-two
  show hold, is-maximum multiply(dot(u, v), dot(u, v)), multiply(dot(u, u), dot(v, v))`,
  'ok',
)

expect(
  'and reversed, refused',
  `rule cauchy-schwarz-reversed
  seat u, like vector-two
  seat v, like vector-two
  show hold, is-minimum multiply(dot(u, v), dot(u, v)), multiply(dot(u, u), dot(v, v))`,
  'refused',
)

// A TASK THAT CALLS ITS PARAMETER unfolds to a call of the argument (check/unfold.ts substitutes the callee too). Before
// 2026-10-05 the callee kept the task's own parameter name, so both sides below unfolded to `f(a)` and were "equal"
{
  const result = compile(
    {
      file: 'r.tree',
      text: `task apply
  take f
    like task
      take x, like integer
      like integer
  take x, like integer

  like integer

  back f(x)

rule every-two-functions-agree
  seat g
    like task
      take x, like integer
      like integer
  seat h
    like task
      take x, like integer
      like integer
  seat a, like integer
  show hold, is-equal apply(g, a), apply(h, a)
`,
    },
    { leanOf: () => true },
  )

  if (!result.ok) {
    pass++
    console.log('ok    a task calling its parameter unfolds to a call of the argument: apply(g, a) == apply(h, a) is refused')
  } else {
    fail++
    console.log('FAIL  apply(g, a) == apply(h, a) was accepted: the unfolding kept the callee\'s parameter name')
  }
}

console.log(`\nrecord-ring: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
