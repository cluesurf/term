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
      console.log(render(d, source.split('\n'), false))
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
  expectContains('constant propagates: x=5; x*2 -> 10', PROP, 'return 10')
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

  console.log(`\nir: ${pass} pass, ${fail} fail`)
}

main()
