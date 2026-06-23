// Nonlinear real positivity, end to end through the compiler. The CAD decision (Sturm in one variable, cylindrical
// algebraic decomposition in two) is wired into the proof prover as a route for polynomial inequality goals:
//   - a UNIVARIATE goal `E > 0` / `E >= 0` is discharged when `E` is a one-variable polynomial that is strictly positive
//     (for `>`) or non-negative (for `>=`) for all reals -- including the touching-zero non-negative cases.
//   - a BIVARIATE goal `E >= 0` is discharged when `E` is a two-variable polynomial non-negative for all reals -- which
//     reaches the MOTZKIN polynomial, non-negative yet not a sum of squares.
// It stays sound: any polynomial that dips below zero is never certified. Run: npx tsx test/check/cad-prove.ts

import { compile } from '@cluesurf/make/code/compile/compile'

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

// proven = compiles AND no `unchecked-hold` / `unproven` warning is left for the goal (so a silently unverified
// nonlinear hold counts as NOT proven, the same discipline as positivity.ts).
function proves(source: string): boolean {
  const result = compile({ file: 'p.tree', text: source })

  if (!result.ok) {
    return false
  }

  return !result.warnings.some(
    w => w.name === 'unchecked-hold' || w.name === 'unproven',
  )
}

// ----- a tiny generator for correctly-indented Seed arithmetic expressions -----
type E =
  | { k: 'lit'; n: number }
  | { k: 'var'; name: string }
  | { k: 'op'; op: 'add' | 'subtract' | 'multiply'; a: E; b: E }

const lit = (n: number): E => ({ k: 'lit', n })
const x: E = { k: 'var', name: 'x' }
const y: E = { k: 'var', name: 'y' }
const z: E = { k: 'var', name: 'z' }
const mul = (a: E, b: E): E => ({ k: 'op', op: 'multiply', a, b })
const add = (a: E, b: E): E => ({ k: 'op', op: 'add', a, b })
const sub = (a: E, b: E): E => ({ k: 'op', op: 'subtract', a, b })

function render(e: E, indent: number): string {
  const pad = ' '.repeat(indent)

  if (e.k === 'lit') {
    return `${pad}mark ${e.n}`
  }

  if (e.k === 'var') {
    return `${pad}read ${e.name}`
  }

  return `${pad}call ${e.op}\n${render(e.a, indent + 2)}\n${render(e.b, indent + 2)}`
}

// a `hold` comparing `lhs <cmp> 0` over the given integer variables, proven with `calm hold`
function goal(
  rule: string,
  vars: string[],
  cmp: 'is-above' | 'is-minimum',
  lhs: E,
): string {
  const decls = vars.map(v => `  mark ${v}, like integer`).join('\n')

  return `rule ${rule}\n${decls}\n  show hold\n    call ${cmp}\n${render(lhs, 6)}\n      mark 0\n  calm hold\n`
}

const x2 = mul(x, x)
const y2 = mul(y, y)

// 1. the Motzkin-style univariate obstruction `x^4 - 3x^2 + 3 > 0` for all reals: no real root, yet not a sum of square
// monomials, so only the Sturm route proves it.
ok(
  'x^4 - 3x^2 + 3 > 0 for all x (beyond sum-of-squares)',
  proves(goal('quartic_positive', ['x'], 'is-above',
    add(sub(mul(x2, x2), mul(lit(3), x2)), lit(3)))),
)

// 2. the same polynomial as a NON-STRICT goal -- strict positivity implies it.
ok(
  'x^4 - 3x^2 + 3 >= 0 for all x',
  proves(goal('quartic_nonneg', ['x'], 'is-minimum',
    add(sub(mul(x2, x2), mul(lit(3), x2)), lit(3)))),
)

// 3. SOUNDNESS: `x^2 - 1 > 0` is FALSE (negative on (-1, 1)). Sturm finds the real roots and declines.
ok(
  'soundness: x^2 - 1 > 0 is rejected (has real roots)',
  !proves(goal('has_roots', ['x'], 'is-above', sub(x2, lit(1)))),
)

// 4. SOUNDNESS: `x^2 > 0` is FALSE (zero at x = 0).
ok(
  'soundness: x^2 > 0 is rejected (zero at the origin)',
  !proves(goal('square_strict', ['x'], 'is-above', x2)),
)

// 5. `x^4 + 1 > 0` for all x -- no real root, beyond the degree-two PSD certificate.
ok(
  'x^4 + 1 > 0 for all x',
  proves(goal('quartic_shift', ['x'], 'is-above', add(mul(x2, x2), lit(1)))),
)

// 6. COMPLETE univariate non-negativity, a touching-zero case: `(x^2 - 1)^2 = x^4 - 2x^2 + 1 >= 0`. Zero at x = +/-1 but
// never negative -- proven by the cell decomposition (the strict `>` would fail here).
ok(
  '(x^2 - 1)^2 >= 0 for all x (touches zero)',
  proves(goal('even_square', ['x'], 'is-minimum',
    add(sub(mul(x2, x2), mul(lit(2), x2)), lit(1)))),
)

// 7. SOUNDNESS of complete non-negativity: `x^2 - 3x + 2 >= 0` is FALSE (dips below zero on (1, 2)).
ok(
  'soundness: x^2 - 3x + 2 >= 0 is rejected (dips negative)',
  !proves(goal('dips_negative', ['x'], 'is-minimum',
    add(sub(x2, mul(lit(3), x)), lit(2)))),
)

// 8. MULTIVARIATE CAD, the showcase: the MOTZKIN polynomial `x^4 y^2 + x^2 y^4 - 3 x^2 y^2 + 1 >= 0` for all x, y. It is
// non-negative everywhere yet provably NOT a sum of squares -- the bivariate cell decomposition proves it where no SOS
// certificate exists.
ok(
  'MOTZKIN x^4 y^2 + x^2 y^4 - 3 x^2 y^2 + 1 >= 0 (not a sum of squares)',
  proves(goal('motzkin', ['x', 'y'], 'is-minimum',
    add(
      sub(
        add(mul(mul(x2, x2), y2), mul(x2, mul(y2, y2))),
        mul(lit(3), mul(x2, y2)),
      ),
      lit(1),
    ))),
)

// 9. SOUNDNESS: drop the +1 -> x^2 y^2 (x^2 + y^2 - 3), NEGATIVE at x = y = 1. The bivariate decision rejects it.
ok(
  'soundness: Motzkin minus its constant is rejected (dips negative)',
  !proves(goal('motzkin_no_const', ['x', 'y'], 'is-minimum',
    sub(
      add(mul(mul(x2, x2), y2), mul(x2, mul(y2, y2))),
      mul(lit(3), mul(x2, y2)),
    ))),
)

// 10. a bivariate square `(x - y)^2 = x^2 - 2xy + y^2 >= 0` (touches zero on the line x = y).
ok(
  '(x - y)^2 >= 0 for all x, y (touches zero on a line)',
  proves(goal('diff_square', ['x', 'y'], 'is-minimum',
    add(sub(x2, mul(lit(2), mul(x, y))), y2))),
)

// 11. SOUNDNESS: `x^2 - y^2 >= 0` is FALSE (a saddle, negative when |y| > |x|).
ok(
  'soundness: x^2 - y^2 >= 0 is rejected (saddle)',
  !proves(goal('saddle', ['x', 'y'], 'is-minimum', sub(x2, y2))),
)

// 12. THREE-VARIABLE CAD: `(xy - z)^2 = x^2 y^2 - 2xyz + z^2 >= 0` for all x, y, z (touches zero on the surface z = xy).
const xyMinusZ = sub(mul(x, y), z)
ok(
  '(xy - z)^2 >= 0 for all x, y, z (trivariate, touches zero on a surface)',
  proves(goal('tri_square', ['x', 'y', 'z'], 'is-minimum', mul(xyMinusZ, xyMinusZ))),
)

// 13. SOUNDNESS: the trivariate saddle `x^2 + y^2 - z^2 >= 0` is FALSE (negative for large z).
ok(
  'soundness: x^2 + y^2 - z^2 >= 0 is rejected (trivariate saddle)',
  !proves(goal('tri_saddle', ['x', 'y', 'z'], 'is-minimum',
    sub(add(x2, mul(y, y)), mul(z, z)))),
)

console.log(`\ncad-prove: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
