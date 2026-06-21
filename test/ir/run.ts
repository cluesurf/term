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

  console.log(`\nir: ${pass} pass, ${fail} fail`)
}

main()
