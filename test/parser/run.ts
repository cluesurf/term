// Parser conformance tests. Each case is a source string and the expected canonical expanded tree.
// Run: npx tsx test/parser/run.ts

import { parse, printTree } from '@cluesurf/make/code/parser/tree'
import { render } from '@cluesurf/make/code/parser/diagnostic'

let pass = 0
let fail = 0

function check(name: string, source: string, expected: string): void {
  const result = parse({ file: 'test.tree', text: source })
  if (!result.ok) {
    fail++
    const lines = source.split('\n')
    console.log(`FAIL  ${name}  (unexpected diagnostics)`)
    for (const d of result.diagnostics)
      console.log(render(d, lines, false))
    return
  }
  const got = printTree(result.tree)
  if (got.trim() === expected.trim()) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}`)
    console.log(`--- got ---\n${got}\n--- want ---\n${expected}`)
  }
}

function checkError(
  name: string,
  source: string,
  expectedName: string,
): void {
  const result = parse({ file: 'test.tree', text: source })
  if (result.ok) {
    fail++
    console.log(`FAIL  ${name}  (expected an error, parsed cleanly)`)
    return
  }
  const got = result.diagnostics[0]?.name
  if (got === expectedName) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  (got ${got}, want ${expectedName})`)
  }
}

function main(): void {
  // basic nesting via space
  check('space nesting', `a b c`, `a\n  b\n    c`)

  // nesting via indentation, children attach to the line head
  check('indent attaches to head', `a b c\n  d`, `a\n  b\n    c\n  d`)

  // pure indentation chain
  check('indent chain', `a\n  b\n    c`, `a\n  b\n    c`)

  // comma siblings under the head
  check('comma siblings', `a b, c, d`, `a\n  b\n  c\n  d`)

  // a path stays one node
  check('path', `deck @termsurf/wolf`, `deck\n  @termsurf/wolf`)

  // an integer value
  check('integer value', `add 1, 2`, `add\n  1\n  2`)

  // a decimal value
  check('decimal value', `add 3.14`, `add\n  3.14`)

  // a text literal
  check('text literal', `write <hello world>`, `write\n  <hello world>`)

  // deeper nesting
  // the indent-2 line `j` attaches to `h`, the head of the indent-1 line, alongside `i`
  check(
    'deep nest',
    `a b c d e f g\n  h i\n    j`,
    `a\n  b\n    c\n      d\n        e\n          f\n            g\n  h\n    i\n    j`,
  )

  // errors
  checkError(
    'invalid indentation',
    `foo\n    bar`,
    'invalid-indentation',
  )
  checkError('number as head', `123 term`, 'invalid-nesting')
  checkError('number then node', `foo 123 bar`, 'invalid-nesting')

  console.log(`\nparser: ${pass} pass, ${fail} fail`)
}

main()
