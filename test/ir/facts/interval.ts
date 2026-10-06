// The interval proof (ir/facts/interval.ts), held both ways: the operations it must prove, and for every rule an
// operation it must NOT prove, because a wrong proof drops an overflow check that should fire. Each case names one
// multiplication by a literal of its own and asks whether that node is proven.
// Run: npx tsx test/ir/facts/interval.ts

import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv } from '@term/make/code/compile/native'
import { gatedTasks, listFacts } from '@term/make/code/compile/backend'
import { provenArithmetic } from '@term/make/code/compile/proven'
import type { Expression } from '@term/make/code/compile/node'

let pass = 0
let fail = 0

function ok(name: string, holds: boolean, detail = ''): void {
  if (holds) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

// whether every `*` by the literal `by` in the program is proven, or undefined when there is none. `op` and `divisor`
// ask instead about every `/` or `%` whose divisor is the variable `divisor`
function proven(text: string, by: number, op = '*', divisor?: string): boolean | undefined {
  const built = compile({ file: 'main.tree', text }, { resolve: withNativeEnv('node', stdlibResolver()!), env: 'node', entryPoints: ['main'] })

  if (!built.ok) {
    throw new Error(built.diagnostics.map(d => d.message).join(' | '))
  }

  const program = built.program
  const masks = new Set(program.flatMap(n => (n.form === 'mask' ? n.methods : [])))
  const { lend, fresh } = listFacts(program, gatedTasks(program, masks))
  const facts = provenArithmetic(program, lend, fresh)
  const found: boolean[] = []
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(visit)

      return
    }

    const node = value as { form?: string; op?: string; right?: { form?: string; value?: unknown; name?: string } }
    const matches = divisor
      ? node.op === op && node.right?.form === 'variable' && node.right.name === divisor
      : node.op === op && node.right?.form === 'integer' && Number(node.right.value) === by

    if (node.form === 'binary' && matches) {
      found.push(facts.has(node as Expression))
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        visit(child)
      }
    }
  }

  visit(program)

  return found.length ? found.every(Boolean) : undefined
}

const lists = `load @term/base/list
  find list
  find push
`

// a record owning a list, built by `make-bag` from `item` and rewritten through its path by `body`
const bag = (item: string, body: string, extra = '', arg = 'read k'): string => `${lists}
form bag
  link id, like number
  link xs, like list, like number

task make-bag
  take k, like number
  like bag
  save xs
    make list
  walk size
    bind base, code 0
    bind head, code 8
    hook next
      take site, name i
      call push
        bind list, read xs
        bind item
${item}
${extra}
  send back
    make bag
      bind id, read k
      bind xs, read xs

task main
  take n, like number
  like number
  save total, code 0
  save bs
    make list
  walk size
    bind base, code 0
    bind head, code 10
    hook next
      take site, name k
      call push
        bind list, read bs
        bind item
          call make-bag
            ${arg}
${body}
  send back, read total
`

const modItem = `          call modulo
            call add
              read k
              read i
            code 1000`

// every slot of the bag rewritten as `(old * 31 + i) % 1000`, then added up
const rewrite = (by: number, extraWrite = ''): string => `  walk size
    bind base, code 0
    bind head, code 10
    hook next
      take site, name k
      walk size
        bind base, code 0
        bind head, code 8
        hook next
          take site, name i
          host old, read bs/{k}/xs/{i}
          save bs/{k}/xs/{i}
            call modulo
              call add
                call multiply
                  read old
                  code ${by}
                read i
              code 1000
${extraWrite}
          save total
            call add
              read total
              read bs/{k}/xs/{i}`

// 1. the elements of an owned list are what is put in: remainders by 1000, so `old * 31` is bounded
ok('an owned list written with remainders bounds its slots', proven(bag(modItem, rewrite(31)), 31) === true)

// 2. the same list also given a parameter through its path: its slots are unknown
ok(
  'a slot written with a parameter is unknown',
  proven(
    bag(
      modItem,
      rewrite(
        37,
        `          save bs/{k}/xs/{i}, read n`,
      ),
    ),
    37,
  ) === false,
)

// 3. the owned local pushed with a parameter before it is stored: `make-bag` is passed `n`, the entry's own
// parameter, which anything outside may give, so its slots are unknown
ok(
  'a push of an unknown parameter onto the stored local is unknown',
  proven(
    bag(
      modItem,
      rewrite(41),
      `  call push
    bind list, read xs
    bind item, read k`,
      'read n',
    ),
    41,
  ) === false,
)

// 3b. the same push, `make-bag` passed only main's counter from 0 to 9: the parameter is the hull of its arguments
ok(
  'a push of a parameter whose every argument is bounded is bounded',
  proven(
    bag(
      modItem,
      rewrite(43),
      `  call push
    bind list, read xs
    bind item, read k`,
    ),
    43,
  ) === true,
)

const task = (body: string): string => `${lists}
task main
  take n, like number
  like number
  save out, code 0
${body}
  send back, read out
`

// 4. a counter under a literal bound: after the loop it is at most 8, and 8 * m fits where 9 * m does not
const m = 1001000000000000

ok(
  'a counted loop bounds its counter',
  proven(
    task(`  save i, code 0
  walk test
    hook test
      call is-below
        read i
        code 8
    hook hold
      save i
        call add
          read i
          code 1
  save out
    call multiply
      read i
      code ${m}`),
    m,
  ) === true,
)

// 5. the same counter stepped twice in the loop: it reaches 9, so the condition bounds nothing
ok(
  'a counter stepped twice is not bounded by its condition',
  proven(
    task(`  save i, code 0
  walk test
    hook test
      call is-below
        read i
        code 8
    hook hold
      save i
        call add
          read i
          code 1
      save i
        call add
          read i
          code 1
  save out
    call multiply
      read i
      code ${m}`),
    m,
  ) === false,
)

// 6. a counter under a parameter's bound: unknown
ok(
  'a counter bounded by a parameter is unknown',
  proven(
    task(`  walk size
    bind base, code 0
    bind head, read n
    hook next
      take site, name i
      save out
        call multiply
          read i
          code 3`),
    3,
  ) === false,
)

// 7. a local doubled every turn of a bounded loop: it grows past every round of the fixpoint, so it is widened
ok(
  'a local doubled in a loop is widened to unknown',
  proven(
    task(`  save s, code 1
  walk size
    bind base, code 0
    bind head, code 100
    hook next
      take site, name i
      save s
        call multiply
          read s
          code 2
  save out, read s`),
    2,
  ) === false,
)

// 8. a remainder by 1000 times 10^12 fits, times 10^14 does not
const rem = (by: number): string =>
  task(`  save r
    call modulo
      read n
      code 1000
  save out
    call multiply
      read r
      code ${by}`)

ok('a remainder times 10^12 fits', proven(rem(1000000000000), 1000000000000) === true)
ok('a remainder times 10^14 does not', proven(rem(100000000000000), 100000000000000) === false)

// 9. a parameter times a literal: unknown
ok('a parameter is unknown', proven(task(`  save out
    call multiply
      read n
      code 5`), 5) === false)

// 10. a task outside the public surface: its parameter is the hull of what it is passed. 5 * 10^15 fits, and passed
// the entry's parameter as well it does not
const big = 1000000000000000
// a loop, so the simplifier neither inlines the task nor folds its product
const scaled = (also: string): string => `task scale
  take x, like number
  like number
  save y, code 0
  walk size
    bind base, code 0
    bind head, code 2
    hook next
      take site, name i
      save y, read x
  send back
    call multiply
      read y
      code ${big}

task main
  take n, like number
  like number
  host a, call scale(code 3)
  host b, call scale(code 5)
${also}
  send back
    call add
      read a
      read b
`

ok('a parameter passed only literals is their hull', proven(scaled(''), big) === true)
ok('a parameter also passed the entry\'s parameter is unknown', proven(scaled('  host c, call scale(read n)'), big) === false)

// 10b. the same task also handed on as a value: whoever holds it may pass anything, so `x` is unknown
ok(
  'a parameter of a task passed as a value is unknown',
  proven(
    scaled(`  host c
    call twice
      read scale
      read n`).replace(
      'task main',
      `task twice
  take f
    like task
      take v, like number
      like number
  take v, like number
  like number
  send back
    call f
      read v

task main`,
    ),
    big,
  ) === false,
)

// 11. the entry itself, called again from inside with a literal: anything outside may call it, so `n` stays unknown
ok(
  'the entry\'s parameter is unknown however it calls itself',
  proven(
    `task main
  take n, like number
  like number
  fork test
    hook test
      call is-equal
        read n
        code 0
    hook hold
      send back, code 0
  host inner, call main(code 0)
  send back
    call add
      read inner
      call multiply
        read n
        code 7
`,
    7,
  ) === false,
)

// 12. a step by an amount that is not negative, `k = k + i` under `k <= 100` with `i` in [1, 10]: k is at most 110
const stepBy = (amount: string, by: number): string =>
  task(`  walk size
    bind base, code 1
    bind head, code 10
    hook next
      take site, name i
      save d
        call subtract
          read i
          code 5
      save k
        call add
          read i
          read i
      walk test
        hook test
          call is-maximum
            read k
            code 100
        hook hold
          save k
            call add
              read k
              read ${amount}
      save out
        call multiply
          read k
          code ${by}`)

ok('a step by an amount that is not negative is bounded by its condition', proven(stepBy('i', 10000000000000), 10000000000000) === true)
ok('a step by an amount that may be negative is not', proven(stepBy('d', 10000000000001), 10000000000001) === false)

// 13. a quotient and a remainder by a parameter whose every argument excludes zero cannot fail; one also passed 0 can
const divided = (second: number, first = 4): string => `task split
  take x, like number
  take d, like number
  like number
  save q, code 0
  walk size
    bind base, code 0
    bind head, code 2
    hook next
      take site, name i
      save q
        call add
          call divide
            read x
            read d
          call modulo
            read x
            read d
  send back, read q

task main
  take n, like number
  like number
  host a, call split(read(n), code ${first})
  host b, call split(read(n), code ${second})
  send back
    call add
      read a
      read b
`

ok('a quotient by a divisor that excludes zero is proven', proven(divided(7), 0, '/', 'd') === true)
ok('a remainder by a divisor that excludes zero is proven', proven(divided(7), 0, '%', 'd') === true)
ok('a quotient by a divisor that may be zero is not', proven(divided(0), 0, '/', 'd') === false)
ok('a remainder by a divisor that may be zero is not', proven(divided(0), 0, '%', 'd') === false)
// d in [-2, -1] excludes zero, but the minimum divided by -1 overflows and the dividend is the entry's own
ok('a quotient of an unknown by a divisor that may be -1 is not', proven(divided(-1, -2), 0, '/', 'd') === false)

// 14. branch facts. The entry's own `n`, unknown, after two branches that leave when it is outside [0, 100]
const early = (low: boolean, by: number): string => `task main
  take n, like number
  like number
${
  low
    ? `  fork test
    hook test
      call is-below
        read n
        code 0
    hook hold
      send back, code 0
`
    : ''
}  fork test
    hook test
      call is-above
        read n
        code 100
    hook hold
      send back, code 0
  send back
    call multiply
      read n
      code ${by}
`

ok('a name past two branches that leave outside [0, 100] is bounded', proven(early(true, 10000000000000), 10000000000000) === true)
ok('one branch bounds one side only', proven(early(false, 10000000000001), 10000000000001) === false)

// a recursion that stops at a column: `c` is 0, or `c + 1` where `c` is not `stop`, so it settles at [0, stop]
const columns = (stop: number): string => `task depth
  take c, like number
  like number
  save total, code 0
  walk size
    bind base, code 0
    bind head, code 2
    hook next
      take site, name i
      save total
        call add
          read total
          read i
  fork test
    hook test
      call is-equal
        read c
        code ${stop}
    hook hold
      send back
        call multiply
          read c
          code 1001000000000000
  send back
    call add
      call multiply
        read c
        code 1001000000000000
      call depth
        call add
          read c
          code 1

task main
  take n, like number
  like number
  send back, call depth(code 0)
`

ok('a recursion that stops at column 7 bounds its column', proven(columns(7), 1001000000000000) === true)
ok('one that stops at column 9 does not fit', proven(columns(9), 1001000000000000) === false)

// a name tested and then assigned: the test says nothing about what it holds afterwards
ok(
  'a name assigned after its test is not narrowed by it',
  proven(
    task(`  save x, code 5
  fork test
    hook test
      call is-below
        read x
        code 10
    hook hold
      save x, read n
      save out
        call multiply
          read x
          code 1000000000000000`),
    1000000000000000,
  ) === false,
)

// 15. a plain record's number field: the hull of what every construction gives it and every path write puts in it
const boxes = (third: string, write = ''): string => `form box
  link size, like number

task area
  take b, like box
  like number
  save total, code 0
  walk size
    bind base, code 0
    bind head, code 2
    hook next
      take site, name i
      save total
        call multiply
          read b/size
          code ${big}
  send back, read total

task main
  take n, like number
  like number
  save a
    make box
      bind size, code 3
  save c
    make box
      bind size, ${third}
${write}
  send back
    call add
      call area(read(a))
      call area(read(c))
`

ok('a field given only 3 and 5 is their hull', proven(boxes('code 5'), big) === true)
ok('a field also given the entry\'s parameter is unknown', proven(boxes('read n'), big) === false)
ok('a field written through a path with the entry\'s parameter is unknown', proven(boxes('code 5', '  save a/size, read n'), big) === false)

// 16. what a task answers: the hull of its returns. `pick` answers 3 or 5, `echo` its argument, `grow` its own answer
// plus one, which climbs every round of the fixpoint and is widened
const answers = (callee: string): string => `task pick
  take x, like number
  like number
  fork test
    hook test
      call is-below
        read x
        code 0
    hook hold
      send back, code 3
  send back, code 5

task echo
  take x, like number
  like number
  send back, read x

task grow
  take x, like number
  like number
  fork test
    hook test
      call is-below
        read x
        code 1
    hook hold
      send back, code 0
  send back
    call add
      call grow
        call subtract
          read x
          code 1
      code 1

task main
  take n, like number
  like number
  host got, call ${callee}(read(n))
  send back
    call multiply
      read got
      code ${big}
`

ok('a task answering 3 or 5 is their hull', proven(answers('pick'), big) === true)
ok('a task answering its unknown argument is unknown', proven(answers('echo'), big) === false)
ok('a task answering its own answer plus one is widened', proven(answers('grow'), big) === false)

// 17. flow: a value at its own point. `x` clamped into [0, 500] by two branches that each assign it (AWFY's Bounce)
const clamp = (both: boolean, by: number): string =>
  task(`  save x
    call add
      read n
      code 0
  fork test
    hook test
      call is-above
        read x
        code 500
    hook hold
      save x, code 500
${
  both
    ? `  fork test
    hook test
      call is-below
        read x
        code 0
    hook hold
      save x, code 0
`
    : ''
}  save out
    call multiply
      read x
      code ${by}`)

ok('a value clamped by two assigning branches is bounded after them', proven(clamp(true, 10000000000000), 10000000000000) === true)
ok('one clamped on one side only is not', proven(clamp(false, 10000000000001), 10000000000001) === false)

// a counter under a large literal leaves its loop bounded: the loop widens, then narrows back to `i <= 1000`
ok(
  'a counter under i < 1000 leaves its loop at most 1000',
  proven(
    task(`  save i, code 0
  walk test
    hook test
      call is-below
        read i
        code 1000
    hook hold
      save i
        call add
          read i
          code 1
  save out
    call multiply
      read i
      code 9000000000000`),
    9000000000000,
  ) === true,
)

// a guard's handler may follow any prefix of its body, so a name the body assigns is unknown there
ok(
  'a handler sees a name its body assigned as unknown',
  proven(
    task(`  save x, code 1
  fork
    mark unsafe
    save x, read n
    save out, code 0
  halt take
    take problem
    save out
      call multiply
        read x
        code 7000000000000`),
    7000000000000,
  ) === false,
)

console.log(`\ninterval: ${pass} pass, ${fail} fail`)

if (fail) {
  process.exit(1)
}
