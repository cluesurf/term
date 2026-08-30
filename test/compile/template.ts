// Template (tree/fuse) expansion tests. Run: npx tsx test/compile/template.ts

import { parse, printTree } from '@term/make/code/parser/tree'
import { expandTemplates } from '@term/make/code/compile/template'
import { compile } from '@term/make/code/compile/compile'

let pass = 0
let fail = 0

function expectContains(
  name: string,
  source: string,
  needle: string,
): void {
  const parsed = parse({ file: 't.tree', text: source })

  if (!parsed.ok) {
    fail++
    console.log(`FAIL  ${name}  (did not parse)`)

    return
  }

  const expanded = expandTemplates(parsed.tree)
  const text = printTree(expanded)

  if (text.includes(needle)) {
    pass++
    console.log(`ok    ${name}  (has "${needle}")`)
  } else {
    fail++
    console.log(`FAIL  ${name}  (no "${needle}" in:\n${text})`)
  }
}

function expectAbsent(
  name: string,
  source: string,
  needle: string,
): void {
  const parsed = parse({ file: 't.tree', text: source })
  const expanded = parsed.ok
    ? expandTemplates(parsed.tree)
    : { kind: 'root' as const, nodes: [] }

  const text = printTree(expanded)

  if (!text.includes(needle)) {
    pass++
    console.log(`ok    ${name}  (no "${needle}", as expected)`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ("${needle}" should be gone)`)
  }
}

const DOUBLER = `tree doubler
  take name
  hook fuse
    task double-{name}
      take n, like u64
      send back
        call multiply
          loan n
          code 2

fuse doubler
  bind name, int
`

const ACCESSOR = `tree accessor
  take name
  take type
  hook fuse
    task get-{name}
      like {type}
    task set-{name}
      take value, like {type}

fuse accessor
  bind name, age
  bind type, u64
`

const SLOTTED = `tree wrapper
  take name
  hook fuse
    form {name}
      site fields

fuse wrapper
  bind name, point
  beam fields
    link x, like u64
    link y, like u64
`

function main(): void {
  // the doubler template instantiates with the bound name
  expectContains('doubler -> double-int', DOUBLER, 'double-int')
  // the template body is fully expanded (the call survives)
  expectContains('doubler body expanded', DOUBLER, 'multiply')
  // the template definition itself is removed after expansion
  expectAbsent('tree def removed', DOUBLER, 'doubler')

  // multiple parameters
  expectContains('accessor get-age', ACCESSOR, 'get-age')
  expectContains('accessor set-age', ACCESSOR, 'set-age')
  // the type parameter is substituted
  expectContains('accessor type u64', ACCESSOR, 'u64')

  // site/beam: the beamed fields are injected at the site, inside the substituted form name
  expectContains('site/beam form name', SLOTTED, 'point')
  expectContains('site/beam injects fields', SLOTTED, 'link')
  expectContains('site/beam injects x', SLOTTED, 'x')
  expectAbsent('site keyword gone', SLOTTED, 'site fields')

  // injected template code flows through the full compile (expand -> mill -> resolve -> CHECK -> emit)
  const cleanFuse = `tree make-adder
  take suffix
  hook fuse
    task add-{suffix}
      take n, like u64
      send back
        call add
          loan n
          code 1

fuse make-adder
  bind suffix, one
`

  const cleanResult = compile({ file: 'tmpl.tree', text: cleanFuse })

  if (cleanResult.ok && cleanResult.typescript.includes('addOne')) {
    pass++
    console.log(
      'ok    fused code compiles + names the expansion (addOne)',
    )
  } else {
    fail++
    console.log(
      `FAIL  clean fuse compile (${
        cleanResult.ok
          ? cleanResult.typescript
          : cleanResult.diagnostics.map(d => d.message).join(';')
      })`,
    )
  }

  // compile-time meta-loop: a fuse over a `host` enumeration generates one definition per item (dynamic `fuse read`
  // resolves the inner template name from a parameter, and `{name}` substitutes the item)
  const metaLoop = `host suit
  term hearts
  term spades

tree make-flag
  take name
  hook bind
    task is-{name}
      like boolean

tree each
  take items
  take maker
  hook fuse
    walk list, read items
      hook step
        take item
        fuse read maker
          read item

fuse each, read suit
  read make-flag
`

  const metaResult = compile({ file: 'meta.tree', text: metaLoop })

  if (
    metaResult.ok &&
    metaResult.typescript.includes('isHearts') &&
    metaResult.typescript.includes('isSpades')
  ) {
    pass++
    console.log(
      'ok    meta-loop unrolls a fuse over a host enumeration (isHearts, isSpades)',
    )
  } else {
    fail++
    console.log(
      `FAIL  meta-loop (${
        metaResult.ok
          ? metaResult.typescript
          : metaResult.diagnostics.map(d => d.message).join(';')
      })`,
    )
  }

  // a fuse whose expanded body has a type error must be caught by the checker (proves injected code is checked)
  const badFuse = `tree bad-tmpl
  take x
  hook fuse
    task bad-{x}
      take n, like u64
      save s, text <hi>
      send back
        call add
          loan n
          loan s

fuse bad-tmpl
  bind x, one
`

  const badResult = compile({ file: 'tmpl.tree', text: badFuse })

  if (
    !badResult.ok &&
    badResult.diagnostics.some(d => d.name === 'type-mismatch')
  ) {
    pass++
    console.log('ok    type error inside a fused template is caught')
  } else {
    fail++
    console.log(
      `FAIL  bad fuse should be a type error (ok=${badResult.ok})`,
    )
  }

  // `read <param>` inside a template body substitutes the BOUND VALUE (compiler-hygiene-0013): a numeric bind
  // rides in as the literal, so the fused task computes with it rather than reading the bound group's head as a
  // variable that does not exist
  const readParam = `tree adder
  take amount
  hook fuse
    task add-{amount}
      take x, like number
      like number
      send back
        call add
          read x
          read amount

fuse adder, bind amount, 5

task probe
  like number
  send back
    call add-5
      code 1
`
  const readResult = compile({ file: 'tmpl.tree', text: readParam })

  if (
    readResult.ok &&
    readResult.typescript.includes('x + 5')
  ) {
    pass++
    console.log('ok    read <param> substitutes the bound value')
  } else {
    fail++
    console.log(
      `FAIL  read <param> should substitute the bound value (ok=${readResult.ok})`,
    )
  }

  console.log(`\ntemplate: ${pass} pass, ${fail} fail`)
}

main()
