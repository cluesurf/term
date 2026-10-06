// A `take`, `link` or `slot` has one type. A second `like` beside the first was read by nothing, so the element type
// the author wrote went nowhere in silence. It is refused by name, and the two spellings that mean what it meant,
// nested and on one line, compile and type the element. Run: npx tsx test/compile/sibling-like.ts

import { compile } from '@term/make/code/compile/compile'

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

const NAMED = 'a second `like` beside the first'

function messages(result: ReturnType<typeof compile>): string[] {
  return result.ok ? [] : result.diagnostics.map(d => d.message ?? '')
}

const TAKE = `task first-of
  take names
    like list
    like text

  like text

  send back, read names/0
`

const take = compile({ file: 't.tree', text: TAKE })
ok(
  'a second like under a take is refused by name',
  !take.ok && messages(take).filter(m => m.includes(NAMED)).length === 1,
  messages(take).join(' | ') || 'compiled',
)

const LINK = `form shelf
  link names
    like list
    like text
`

const link = compile({ file: 'l.tree', text: LINK })
ok(
  'a second like under a link is refused by name',
  !link.ok && messages(link).some(m => m.includes(NAMED)),
  messages(link).join(' | ') || 'compiled',
)

const NESTED = `task first-of
  take names
    like list
      like text

  like text

  send back, read names/0
`

const nested = compile({ file: 'n.tree', text: NESTED })
ok('the nested spelling compiles', nested.ok, messages(nested).join(' | '))

const LINE = `task first-of
  take names, like list, like text

  like text

  send back, read names/0
`

const line = compile({ file: 'o.tree', text: LINE })
ok('the one-line spelling compiles', line.ok, messages(line).join(' | '))

// the element type is READ: a number where the nested spelling says text is a type error, which it never was when
// the second like was dropped
const WRONG = `task first-of
  take names
    like list
      like text

  like number

  send back, read names/0
`

const wrong = compile({ file: 'w.tree', text: WRONG })
ok('the nested element type reaches the checker', !wrong.ok, 'compiled')

const ARGS = `form pair
  head k
  head v
  link key, like k
  link value, like v

task key-of
  take entry
    like pair
      like text
      like number

  like text

  send back, read entry/key
`

const args = compile({ file: 'a.tree', text: ARGS })
ok('two type arguments under one like still compile', args.ok, messages(args).join(' | '))

// beside `like task` the second `like` IS read, as the function's result, and stays legal on a take and a link
const RESULT = `task apply
  take step
    like task
    take n, like number
    like number
  take n, like number

  like number

  send back
    call step, read n

form stepper
  link step
    like task
    take n, like number
    like number
`

const result = compile({ file: 'r.tree', text: RESULT })
ok('a function result beside like task still compiles', result.ok, messages(result).join(' | '))

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
