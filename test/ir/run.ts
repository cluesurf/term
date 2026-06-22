// IR simplify pass tests: constant folding and algebraic identities. Run: npx tsx test/ir/run.ts

import { compile } from '@cluesurf/make/code/compile/compile'
import { render } from '@cluesurf/make/code/parser/diagnostic'

let pass = 0
let fail = 0

function expectContains(
  name: string,
  source: string,
  needle: string,
): void {
  const result = compile({ file: 'ir.tree', text: source })

  if (!result.ok) {
    fail++

    for (const d of result.diagnostics)
      {console.log(render(d, source.split('\n'), false))}

    console.log(`FAIL  ${name}  (did not compile)`)

    return
  }

  if (result.typescript.includes(needle)) {
    pass++
    console.log(`ok    ${name}  (emitted "${needle.trim()}")`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (expected "${needle}" in:\n${result.typescript})`,
    )
  }
}

function expectExcludes(
  name: string,
  source: string,
  needle: string,
): void {
  const result = compile({ file: 'ir.tree', text: source })

  if (!result.ok) {
    fail++
    console.log(`FAIL  ${name}  (did not compile)`)

    return
  }

  if (!result.typescript.includes(needle)) {
    pass++
    console.log(`ok    ${name}  (no "${needle.trim()}")`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (unexpected "${needle}" in:\n${result.typescript})`,
    )
  }
}

function main(): void {
  // constant folding: multiply then add a zero -> 42
  expectContains(
    'constant folds 6*7+0',
    `task compute
  send back
    call add
      call multiply
        code 6
        code 7
      code 0
`,
    'return 42',
  )

  // algebraic identity: n + 0 -> n
  expectContains(
    'identity n + 0',
    `task identity
  take n
  send back
    call add
      loan n
      code 0
`,
    'return n',
  )

  // identity: n * 1 -> n
  expectContains(
    'identity n * 1',
    `task identity
  take n
  send back
    call multiply
      loan n
      code 1
`,
    'return n',
  )

  // constant propagation: a constant bound to a name flows into its uses, folds, and the dead binding is dropped
  const PROP = `task compute
  like number
  save x
    code 5
  send back
    call multiply
      read x
      code 2
`

  expectContains(
    'constant propagates: x=5; x*2 -> 10',
    PROP,
    'return 10',
  )
  expectExcludes('the dead const binding is dropped', PROP, 'const x')

  // a reassigned variable is NOT propagated to a stale value (soundness)
  expectContains(
    'reassigned variable is not propagated',
    `task compute
  like number
  save x
    code 5
  save x
    call add
      read x
      code 1
  send back
    read x
`,
    'return x',
  )

  // dead-binding elimination: an unused binding with a pure init is dropped
  expectExcludes(
    'unused pure binding is dropped',
    `task compute
  take z, like number
  like number
  save y
    call add
      read z
      code 1
  send back
    read z
`,
    'const y',
  )

  // dead-code elimination: a statement after a return is unreachable and dropped
  expectExcludes(
    'unreachable code after return is dropped',
    `task compute
  like number
  send back
    code 1
  send back
    code 2
`,
    'return 2',
  )

  // soundness: an unused binding whose init may have effects (a call) is NOT dropped
  expectContains(
    'unused effectful binding is kept',
    `task work
  take n, like number
  like number
  save a
    read n
  send back
    call add
      read a
      read a

task compute
  take z, like number
  like number
  save x
    call work
      read z
  send back
    read z
`,
    'work(z)',
  )

  // boolean identities
  expectExcludes(
    'x && true -> x',
    `task f
  take x, like boolean
  like boolean
  send back
    meet and
      read x
      wave true
`,
    '&&',
  )
  expectExcludes(
    'x || false -> x',
    `task f
  take x, like boolean
  like boolean
  send back
    meet or
      read x
      wave false
`,
    '||',
  )
  expectExcludes(
    'double negation !!x -> x',
    `task f
  take x, like boolean
  like boolean
  send back
    fork lack
      fork lack
        read x
`,
    '!',
  )
  expectContains(
    'negated comparison !(a == b) -> a != b',
    `task f
  take a, like number
  take b, like number
  like boolean
  send back
    fork lack
      call is-equal
        read a
        read b
`,
    'a != b',
  )

  // copy propagation: a binding that aliases a stable variable is replaced by that variable, then dropped
  expectContains(
    'copy propagation: x = p; x + 1 -> p + 1',
    `task f
  take p, like number
  like number
  save x
    read p
  send back
    call add
      read x
      code 1
`,
    'return p + 1',
  )
  // soundness: a copy is NOT propagated when its source is later reassigned
  expectContains(
    'copy of a reassigned source is not propagated',
    `task f
  take p, like number
  like number
  save x
    read p
  save p
    code 9
  send back
    read x
`,
    'return x',
  )

  // boolean comparison against a literal collapses
  expectContains(
    'x == true -> x',
    `task f
  take x, like boolean
  like boolean
  send back
    call is-equal
      read x
      wave true
`,
    'return x',
  )
  expectContains(
    'x == false -> !x',
    `task f
  take x, like boolean
  like boolean
  send back
    call is-equal
      read x
      wave false
`,
    'return !x',
  )

  // e-graph reassociation: scattered constants the greedy peephole pass leaves alone collapse to one. `(n + 2) + 3`
  // has a non-constant left operand, so local folding cannot touch it; equality saturation reassociates to `n + 5`.
  expectContains(
    'reassociates (n + 2) + 3 -> n + 5',
    `task f
  take n, like number
  send back
    call add
      call add
        loan n
        code 2
      code 3
`,
    'return n + 5',
  )

  // multiplicative reassociation: (n * 2) * 4 -> n * 8
  expectContains(
    'reassociates (n * 2) * 4 -> n * 8',
    `task f
  take n, like number
  send back
    call multiply
      call multiply
        loan n
        code 2
      code 4
`,
    'return n * 8',
  )

  // commutative reassociation: (2 + n) + 3 -> n + 5 (the constant on the inner left still collapses)
  expectContains(
    'reassociates (2 + n) + 3 -> n + 5',
    `task f
  take n, like number
  send back
    call add
      call add
        code 2
        loan n
      code 3
`,
    'return n + 5',
  )

  // x - x -> 0 across a self-subtraction the peephole pass has no rule for
  expectContains(
    'folds n - n -> 0',
    `task f
  take n, like number
  send back
    call subtract
      loan n
      loan n
`,
    'return 0',
  )

  // e-graph member leaves: the same reassociation / cancellation works over integer field accesses, not just plain
  // variables. `(p.x + 2) + 3` -> `p.x + 5`.
  expectContains(
    'reassociates a field access: (p.x + 2) + 3 -> p.x + 5',
    `form point
  link x, like number

task f
  take p, like point
  like number
  send back
    call add
      call add
        read p/x
        code 2
      code 3
`,
    'return p.x + 5',
  )

  // member cancellation: p.x - p.x -> 0 (the field read is pure, so this is sound for integers)
  expectContains(
    'cancels a self field subtraction: p.x - p.x -> 0',
    `form point
  link x, like number

task f
  take p, like point
  like number
  send back
    call subtract
      read p/x
      read p/x
`,
    'return 0',
  )

  // soundness: a FLOAT field must not cancel (q.f - q.f could be NaN), exactly like a float variable
  expectContains(
    'float field q.f - q.f is NOT folded to 0',
    `form vec
  link f, like decimal

task f
  take q, like vec
  like decimal
  send back
    call subtract
      read q/f
      read q/f
`,
    'return q.f - q.f',
  )

  // soundness: float arithmetic is non-associative and `f - f` is NaN for Inf/NaN, so a float leaf must NOT be
  // reassociated or cancelled. `f - f` stays `f - f`, never folds to 0.
  expectContains(
    'float f - f is NOT folded to 0 (NaN-safe)',
    `task f
  take x, like decimal
  like decimal
  send back
    call subtract
      loan x
      loan x
`,
    'return x - x',
  )

  // soundness: an irreducible arithmetic expression is returned unchanged (no spurious reordering)
  expectContains(
    'irreducible a + b is preserved',
    `task f
  take a, like number
  take b, like number
  send back
    call add
      loan a
      loan b
`,
    'return a + b',
  )

  // soundness: subtraction is NOT commutative; `a - b` must not become `b - a`
  expectContains(
    'non-commutative a - b is preserved',
    `task f
  take a, like number
  take b, like number
  send back
    call subtract
      loan a
      loan b
`,
    'return a - b',
  )

  // boolean idempotence: x && x -> x, x || x -> x (pure operands)
  expectContains(
    'idempotence: x && x -> x',
    `task f
  take x, like boolean
  like boolean
  send back
    meet and
      read x
      read x
`,
    'return x',
  )
  expectContains(
    'idempotence: x || x -> x',
    `task f
  take x, like boolean
  like boolean
  send back
    meet or
      read x
      read x
`,
    'return x',
  )

  // boolean absorption: x && (x || y) -> x, x || (x && y) -> x
  expectContains(
    'absorption: x && (x || y) -> x',
    `task f
  take x, like boolean
  take y, like boolean
  like boolean
  send back
    meet and
      read x
      meet or
        read x
        read y
`,
    'return x',
  )
  expectContains(
    'absorption: x || (x && y) -> x',
    `task f
  take x, like boolean
  take y, like boolean
  like boolean
  send back
    meet or
      read x
      meet and
        read x
        read y
`,
    'return x',
  )

  // soundness: distinct operands are preserved (no spurious collapse)
  expectContains(
    'x && y is preserved',
    `task f
  take x, like boolean
  take y, like boolean
  like boolean
  send back
    meet and
      read x
      read y
`,
    'return x && y',
  )

  console.log(`\nir: ${pass} pass, ${fail} fail`)
}

main()
