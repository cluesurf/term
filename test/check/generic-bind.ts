// A HOST BIND THAT NAMES A TYPE PARAMETER TAKES IT FRESH AT EACH CALL, as a generic task does (item
// term-self-host-001-0804). The grammar read `head t` under a bind, and the program dropped it: `t` was then an undeclared
// name, one inference variable the signature kept, so the first call pinned it for the whole program. The answers on all four
// toolchains are held by test/compile/meaning-native/generic-bind.tree. Held here: what is still refused, a bound, a form
// of the parameter's name, and a bind reached through another module.
//
// Run: npx tsx test/check/generic-bind.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stdlibResolver } from '@term/make/code/resolve'
import { compile } from '@term/make/code/compile/compile'
import type { Source } from '@term/make/code/compile/load'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

function build(main: string, files: Record<string, string> = {}) {
  const stdlib = stdlibResolver()!
  const resolve = (path: string): Source | undefined =>
    files[path] !== undefined
      ? {
          file: `${path.slice('@app/'.length)}.tree`,
          text: files[path]!,
        }
      : stdlib(path)

  return compile({ file: 'main.tree', text: main }, {
    resolve,
    env: 'node',
  } as never)
}

const said = (result: ReturnType<typeof build>): string =>
  result.ok ? 'built' : result.diagnostics.map(d => d.message).join(' | ')

const FIRST_OF = `bind first-of
  head t
  take items, like list, like t
  take count, like number
  like list, like t
  case node
    text <$items.slice(0, $count)>
`

const LISTS = `task texts
  like list, like text
  back make list

task numbers
  like list, like number
  back make list
`

const twice = build(`${FIRST_OF}
${LISTS}
task run
  like number
  save a, first-of(texts(), 1)
  save b, first-of(numbers(), 1)
  back add(a/length, b/length)
`)
ok('two calls with two element types build', twice.ok, said(twice))

const carried = build(`${FIRST_OF}
${LISTS}
task run
  like number
  save a, first-of(texts(), 1)
  back a/0
`)
ok(
  'the result is the element a call handed in: a text is no number',
  !carried.ok && /text/.test(said(carried)),
  said(carried),
)

const clash = build(`bind pair-of
  head t
  take left, like t
  take right, like t
  like t
  case node
    text <$left>

task run
  like text
  back pair-of(<a>, 1)
`)
ok(
  'one call still fits its arguments to one another',
  !clash.ok,
  said(clash),
)

const MASK = `mask sized
  task size-of
    take self
    like number

form box
  link n, like number
  wear sized
    task size-of
      take self
      back 1

form other
  link n, like number

bind sized-of
  head t, need sized
  take value, like t
  like number
  case node
    text <0>
`

const met = build(`${MASK}
task run
  like number
  save b
    make box
      bind n, 1
  back sized-of(b)
`)
ok('a bound on a bind a call meets', met.ok, said(met))

const unmet = build(`${MASK}
task run
  like number
  save b
    make other
      bind n, 1
  back sized-of(b)
`)
ok(
  'a bound on a bind a call does not meet',
  !unmet.ok && /no "sized" instance for/.test(said(unmet)),
  said(unmet),
)

// the four-backend fixture itself, which that harness compiles without reading its refusals
const fixture = build(
  readFileSync(
    join(import.meta.dirname, '../compile/meaning-native/generic-bind.tree'),
    'utf8',
  ),
)
ok('generic-bind.tree builds', fixture.ok, said(fixture))

const shadow = build(`form t
  link n, like number

${FIRST_OF}
${LISTS}
task run
  like number
  save a, first-of(texts(), 1)
  save b, first-of(numbers(), 1)
  back add(a/length, b/length)
`)
ok(
  'a type parameter shadows a form of its name',
  shadow.ok,
  said(shadow),
)

const across = build(
  `load @app/lib
  find first-of

${LISTS}
task run
  like number
  save a, first-of(texts(), 1)
  save b, first-of(numbers(), 1)
  back add(a/length, b/length)
`,
  { '@app/lib': FIRST_OF },
)
ok('a bind in another module', across.ok, said(across))

const plain = build(`bind size-of
  take items, like list
  like number
  case node
    text <$items.length>

${LISTS}
task run
  like number
  save a, size-of(texts())
  save b, size-of(numbers())
  back add(a, b)
`)
ok(
  'a bind naming no type parameter keeps its one element, as a task does',
  !plain.ok,
  said(plain),
)

console.log(`\ngeneric-bind: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
