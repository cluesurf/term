// Soundness: false statements the checker used to PROVE, each beside the true statement that must still pass.
// Run: npx tsx test/check/soundness.ts
//
// Every case here compiled clean before 2026-10-02 (proof-by-default-0001 to 0004). The cause was one defect in two
// places: path facts are equations over NAMES, and a name is not a mathematical variable. `save` gives it a new value,
// a branch or a loop may have, a closure may at any call, a call may write through a record, and two calls to an
// impure task may answer differently. check/facts.ts holds the rules both provers now share, and a proof (a claim's
// fill) must be verified by the kernel, terminate, and be pure. See note/term/proof-by-default/readme.md.
//
// A suite of false statements is only half a test: a checker that refused everything would pass it. So every refusal
// sits beside a control that must still be PROVEN.

import { compile } from '@term/make/code/compile/compile'

let pass = 0
let fail = 0

function expect(
  name: string,
  source: string,
  want: { ok: true } | { ok: false; code: string },
): void {
  const result = compile({ file: 's.tree', text: source })
  const codes = result.ok
    ? result.warnings.map(d => d.name)
    : result.diagnostics.map(d => d.name)

  const good = want.ok
    ? result.ok
    : !result.ok && codes.includes(want.code)

  if (good) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (ok=${result.ok}, codes=${codes.join(',')}, wanted ${want.ok ? 'ok' : want.code})`,
    )
  }
}

const proven = { ok: true } as const
const refused = (code: string) => ({ ok: false, code }) as const

function main(): void {
  // ---- reassignment ----

  expect(
    'reassigned: the old value is not a fact',
    `task a
  save x, code 0
  save x, code 5
  hold
    call is-equal
      read x
      code 0
`,
    refused('unproven'),
  )

  expect(
    'control: the new value is a fact',
    `task a
  save x, code 0
  save x, code 5
  hold
    call is-equal
      read x
      code 5
`,
    proven,
  )

  expect(
    'control: an immutable binding is a fact',
    `task a
  host x, code 0
  hold
    call is-equal
      read x
      code 0
`,
    proven,
  )

  // ---- conditions outlived by a write ----

  expect(
    'a branch condition is not a fact after the branch writes its variable',
    `task b
  take n, like natural-number
  save m, read n
  fork test
    hook test
      call is-above
        read m
        code 0
    hook hold
      save m
        call subtract
          read m
          code 5
      hold
        call is-above
          read m
          code 0
`,
    refused('unproven'),
  )

  expect(
    'control: a branch condition is a fact inside the branch',
    `task b
  take n, like natural-number
  save m, read n
  fork test
    hook test
      call is-above
        read m
        code 0
    hook hold
      hold
        call is-above
          read m
          code 0
`,
    proven,
  )

  expect(
    'a loop condition is not a fact after the body writes its variable',
    `task c
  take n, like natural-number
  save m, read n
  walk test
    hook test
      call is-above
        read m
        code 0
    hook hold
      save m
        call subtract
          read m
          code 5
      hold
        call is-above
          read m
          code 0
`,
    refused('unproven'),
  )

  // ---- facts after a compound statement ----

  expect(
    'a fact is gone after a branch that may have written it',
    `task d
  take c, like boolean
  save x, code 0
  fork test
    hook test
      read c
    hook hold
      save x, code 5
  hold
    call is-equal
      read x
      code 0
`,
    refused('unproven'),
  )

  expect(
    'a fact is gone after a loop that may have written it',
    `task e
  take n, like natural-number
  save x, code 0
  walk test
    hook test
      call is-below
        read x
        read n
    hook hold
      save x
        call add
          read x
          code 1
  hold
    call is-equal
      read x
      code 0
`,
    refused('unproven'),
  )

  expect(
    'control: a fact about a name the branch does not write survives it',
    `task d
  take c, like boolean
  host y, code 3
  save x, code 0
  fork test
    hook test
      read c
    hook hold
      save x, code 5
  hold
    call is-equal
      read y
      code 3
`,
    proven,
  )

  // ---- holds nobody checked ----

  expect(
    'a hold inside a note unsafe guard is checked',
    `task f
  take n, like natural-number
  note unsafe
    hold
      call is-below
        read n
        code 0
  halt take
    take e
`,
    refused('unproven'),
  )

  expect(
    'a hold inside a closure is checked',
    `task g
  take n, like natural-number
  host f
    task
      hold
        call is-below
          read n
          code 0
`,
    refused('unproven'),
  )

  // ---- writes through a record ----

  expect(
    'a copy of a field is not equal to the field after the field is saved',
    `form box
  link size, like number

task h
  take b, like box
  host s, read b/size
  save b/size, code 9
  hold
    call is-equal
      read s
      read b/size
`,
    refused('unchecked-hold'),
  )

  // ---- impure calls ----

  expect(
    'two calls to a task with no body are not equal',
    `task roll
  like number

task i
  hold
    call is-equal
      call roll
      call roll
`,
    refused('unchecked-hold'),
  )

  expect(
    'a value is not equal to a second call of the task that made it',
    `task roll
  like number

task i
  host a
    call roll
  hold
    call is-equal
      read a
      call roll
`,
    refused('unchecked-hold'),
  )

  // a task that only calls the function it is handed is as pure as that function, so the USE SITE answers for it
  expect(
    'an impure task passed as a value makes the call impure',
    `task roll
  like number

task apply
  take f
    like task
      like number
  like number
  send back
    call f

task i
  hold
    call is-equal
      call apply
        read roll
      call apply
        read roll
`,
    refused('unchecked-hold'),
  )

  expect(
    'control: two calls to a pure task are equal',
    `task twice
  take n, like number
  like number
  send back
    call add
      read n
      read n

task i
  take k, like number
  hold
    call is-equal
      call twice
        read k
      call twice
        read k
`,
    proven,
  )

  // ---- equality is a family over its two values ----

  // Until 2026-10-02 the stdlib's `equal` took `x` and `y` as FIELDS, a use wrote `like equal a x y`, and the checker
  // dropped the two extra type arguments, so the kernel proved "any x equals any y". `equal` is an indexed family now,
  // and the kernel reads every type as written wherever the surface checker's seeding lost something.
  const EQUAL = `form equal
  head a
  head x, like a
  head y, like a
  case refl
    link c, like a
    head
      read c
    head
      read c
`

  expect(
    'any x does not equal any y',
    `${EQUAL}
rule everything
  head a
  take x, like a
  take y, like a
  like equal a
    head
      read x
    head
      read y

task everything
  take x
  take y
  send back
    make equal/refl
      bind c, read x
`,
    refused('type-mismatch'),
  )

  expect(
    'x == y does not give x == z',
    `${EQUAL}
rule bogus
  head a
  take x, like a
  take y, like a
  take z, like a
  take proof
    like equal a
      head
        read x
      head
        read y
  like equal a
    head
      read x
    head
      read z

task bogus
  take x
  take y
  take z
  take proof
  send back, read proof
`,
    refused('type-mismatch'),
  )

  expect(
    'control: symmetry is proven',
    `${EQUAL}
rule symmetry
  head a
  take x, like a
  take y, like a
  take proof
    like equal a
      head
        read x
      head
        read y
  like equal a
    head
      read y
    head
      read x

task symmetry
  take x
  take y
  take proof
  fork case, read proof
    case refl
      link c
      send back
        make equal/refl
          bind c, read c
`,
    proven,
  )

  // a type family applied to values: without the equality, p x is not p y
  expect(
    'a predicate at x does not hold at y without x == y',
    `${EQUAL}
rule forged
  head a
  take p
    like task
      take value, like a
      like type
  take x, like a
  take y, like a
  take px
    like p
      head
        read x
  like p
    head
      read y

task forged
  take p
  take x
  take y
  take px
  send back, read px
`,
    refused('type-mismatch'),
  )

  // ---- lists that change between turns ----

  // a length known before a loop is not known at the top of a later turn when the body pushes
  expect(
    'a length is not assumed across turns when the body pushes',
    `task grow
  take n, like natural-number
  save xs, make list
  call xs/push
    code 1
  save i, code 0
  walk test
    hook test
      call is-below
        read i
        read n
    hook hold
      hold
        call is-equal
          read xs/length
          code 1
      call xs/push
        code 2
      save i
        call add
          read i
          code 1
`,
    refused('unproven'),
  )

  expect(
    'control: a lower bound on a length survives pushes',
    `task grow
  take n, like natural-number
  save xs, make list
  call xs/push
    code 1
  save i, code 0
  walk test
    hook test
      call is-below
        read i
        read n
    hook hold
      hold
        call is-minimum
          read xs/length
          code 1
      call xs/push
        code 2
      save i
        call add
          read i
          code 1
`,
    proven,
  )

  expect(
    'control: a push grows the length by one',
    `task grow
  save xs, make list
  call xs/push
    code 1
  call xs/push
    code 2
  hold
    call is-equal
      read xs/length
      code 2
`,
    proven,
  )

  // a relation between two names that step together is not kept when one of them steps only on SOME turns
  expect(
    'a relation is not kept when a push happens on some turns only',
    `task fill
  take n, like natural-number
  take c, like boolean
  save xs, make list
  save i, code 0
  walk test
    hook test
      call is-below
        read i
        read n
    hook hold
      fork test
        hook test
          read c
        hook hold
          call xs/push
            read i
      save i
        call add
          read i
          code 1
  hold
    call is-equal
      read xs/length
      read i
`,
    refused('unproven'),
  )

  // an impure call handed the list itself may change its length, and the fact goes
  expect(
    'a length is not kept across an impure call that is handed the list',
    `task shrink
  take xs, like list, like number
  like number

task use
  save ys, make list
  call ys/push
    code 1
  call shrink
    read ys
  hold
    call is-equal
      read ys/length
      code 1
`,
    refused('unproven'),
  )

  // a task with no body may keep anything in a global, so even handed only a number it may change a list the caller
  // holds. Only a STATE-FREE task (facts.ts) handed scalars is known to leave lists alone.
  expect(
    'a length is not kept across a body-less task, even one handed only a number',
    `task tick
  take n, like number
  like number

task use
  save ys, make list
  call ys/push
    code 1
  call tick
    code 5
  hold
    call is-equal
      read ys/length
      code 1
`,
    refused('unproven'),
  )

  expect(
    'control: a pure call leaves a local length alone',
    `task twice
  take n, like number
  like number
  send back
    call add
      read n
      read n

task use
  save ys, make list
  call ys/push
    code 1
  call twice
    code 5
  hold
    call is-equal
      read ys/length
      code 1
`,
    proven,
  )

  // ---- exact arithmetic in the polynomial provers ----

  // a = 2^30 - 1, b = 2^30, d = 2^30 + 1: the minor a·d - b² is -1, and a floating determinant read it as 0, so this
  // indefinite quadratic was proven non-negative. At x = 2^30, y = -(2^30 - 1) it is -1073741823.
  expect(
    'an indefinite quadratic is not proven non-negative by a rounded determinant',
    `task t
  take x, like number
  take y, like number
  hold
    call is-minimum
      call add
        call add
          call multiply
            code ${2 ** 30 - 1}
            call multiply
              read x
              read x
          call multiply
            code ${2 * 2 ** 30}
            call multiply
              read x
              read y
        call multiply
          code ${2 ** 30 + 1}
          call multiply
            read y
            read y
      code 0
`,
    refused('unchecked-hold'),
  )

  expect(
    'control: a sum of squares is non-negative',
    `task t
  take x, like number
  take y, like number
  hold
    call is-minimum
      call add
        call multiply
          read x
          read x
        call multiply
          read y
          read y
      code 0
`,
    proven,
  )

  // ---- what the backends compute ----

  // every backend truncates, so the remainder of a negative number is negative: -1 % 3 is -1
  expect(
    'a remainder is not assumed non-negative',
    `task t
  take n, like number
  hold
    call is-minimum
      call modulo
        read n
        code 3
      code 0
`,
    refused('unproven'),
  )

  expect(
    'control: a remainder is below its divisor',
    `task t
  take n, like number
  hold
    call is-below
      call modulo
        read n
        code 3
      code 3
`,
    proven,
  )

  // ---- a claim's proof must be a proof ----

  expect(
    'a claim filled by a task that never ends is refused',
    `rule anything
  take x, like number
  take y, like number
  like number

task anything
  take x
  take y
  send back
    call anything
      read x
      read y
`,
    refused('looping-proof'),
  )

  expect(
    'a claim filled by an impure task is refused',
    `task roll
  like number

rule chosen
  like number

task chosen
  send back
    call roll
`,
    refused('impure-proof'),
  )

  expect(
    'a claim stated at a type the kernel cannot read is refused',
    `rule vague
  take x, like nothing-by-this-name
  like nothing-by-this-name

task vague
  take x
  send back, read x
`,
    refused('unverified-proof'),
  )

  expect(
    'a claim filled by a body that never returns a value is refused',
    `rule some-number
  take x, like number
  like number

task some-number
  take x
  save y, code 1
  save y, code 2
`,
    refused('unverified-proof'),
  )

  // `void` is a unit the stdlib constructs (`make void`), so "from a void, anything" is false, and it compiled as
  // proven until fills were held to the kernel. `never`, whose one case needs a `never`, has no values at all.
  expect(
    'absurd over an inhabited type is refused',
    `form void

rule absurd
  head a
  take proof, like void
  like a

task absurd
  take proof
  fork case, read proof
`,
    refused('unverified-proof'),
  )

  expect(
    'control: absurd over a type with no values is proven',
    `form never
  case later
    link next, like never

rule absurd
  head a
  take proof, like never
  like a

task absurd
  take proof
  fork case, read proof
    case later
      send back
        call absurd
          read next
`,
    proven,
  )

  expect(
    'control: a claim filled by a terminating pure task is proven',
    `rule identity
  take x, like number
  like number

task identity
  take x
  send back, read x
`,
    proven,
  )

  // ---- a constant table's length ----

  const table = (handed: string): string => `host table
  code 1
  code 2
  code 3

task grow
  take xs, like list, like number
  call xs/push
    code 9

task sink
  take n, like number
  save out, make list
  call out/push
    read n

task use
${handed}  hold
    call is-equal
      read table/length
      code 3
`

  expect(
    'a table handed whole to a task that pushes onto it has no known length',
    table('  call grow\n    read table\n'),
    refused('unproven'),
  )

  expect(
    'control: one number read out of the table, handed on, leaves its length',
    table('  call sink\n    read table/0\n'),
    proven,
  )

  // ---- a disequality ----

  const otherwise = (value: string, goal: string): string => `task use
  take xs, like list, like number
  fork test
    hook test
      call is-equal
        read xs/length
        code ${value}
    hook hold
      send back, code 0
    hook miss
      hold
        call is-above
          read xs/length
          code ${goal}
  send back, code 0
`

  expect('a length that is not zero is at least one', otherwise('0', '0'), proven)
  expect(
    'a length that is not two is not thereby above two',
    otherwise('2', '2'),
    refused('unproven'),
  )

  console.log(`\nsoundness: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exitCode = 1
  }
}

main()
