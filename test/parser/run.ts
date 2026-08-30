// Parser conformance tests. Each case is a source string and the expected canonical expanded tree.
// Run: npx tsx test/parser/run.ts

import { parse, printTree } from '@term/make/code/parser/tree'
import { render } from '@term/make/code/parser/diagnostic'

let pass = 0
let fail = 0

function check(name: string, source: string, expected: string): void {
  const result = parse({ file: 'test.tree', text: source })

  if (!result.ok) {
    fail++

    const lines = source.split('\n')
    console.log(`FAIL  ${name}  (unexpected diagnostics)`)

    for (const d of result.diagnostics)
      {console.log(render(d, lines, false))}

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

  // A comma POPS ONE LEVEL: the part after it is a sibling of the part before it. When the previous part is a
  // single token that is the same as returning to the head, which is why these first cases look unchanged.
  check('comma siblings', `a b, c, d`, `a\n  b\n  c\n  d`)
  // ...and when it is not, the difference shows. `read a` nested two deep, so `read b` lands beside `a`, INSIDE
  // `read`, rather than beside `read`. This is why a multi-word argument cannot be followed by a comma: write
  // `call add, read(a), read(b)`, or put the arguments on their own indented lines.
  check('comma after a nested part', `call add, read a, read b`, `call\n  add\n  read\n    a\n    read\n      b`)
  check('comma then an indented child', `foo x, bar\n  foo y bar`, `foo\n  x\n  bar\n  foo\n    y\n      bar`)
  check('comma after a deep part', `link @x, code <1.x.x>, have 1`, `link\n  @x\n  code\n    <1.x.x>\n  have\n    1`)

  // a path stays one node
  check('path', `deck @termsurf/wolf`, `deck\n  @termsurf/wolf`)

  // an integer value
  check('integer value', `add 1, 2`, `add\n  1\n  2`)

  // parentheses: the children of the group whose head they follow. A name directly after `(` or `,` opens a child
  // group, and `)` closes back to the owner. This is the compact spelling of Term data (note/term/host/02-compact.md).
  check('paren name child', `h(x,1)`, `h\n  x\n  1`)
  check('paren nested', `h(x,h(y,123))`, `h\n  x\n  h\n    y\n    123`)
  check(
    'paren siblings after a nested paren',
    `h(x,h(y,h(z,1)),h(w,2))`,
    `h\n  x\n  h\n    y\n    h\n      z\n      1\n  h\n    w\n    2`,
  )
  check('paren list', `l(a,5,6,7)`, `l\n  a\n  5\n  6\n  7`)
  check('paren mesh', `m(h(name,<foo>))`, `m\n  h\n    name\n    <foo>`)
  check('paren text with commas and parens', `h(k,<a, b (c)>)`, `h\n  k\n  <a, b (c)>`)
  // inside a paren the rule is the same: the comma pops one level off `x`, so `2` lands beside `x` inside
  // `read`, not beside `read`. `call add(read(x), 2)` is how to mean two arguments here.
  check('paren in code keeps working', `call add(read x, 2)`, `call\n  add\n    read\n      x\n      2`)
  check('paren spaced', `add (1, 2)`, `add\n  1\n  2`)
  check('two paren lines', `h(1,2)\nh(3,4)`, `h\n  1\n  2\nh\n  3\n  4`)

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
