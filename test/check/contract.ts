// Contracts and tier 0: `have` / `must` / `down` on a task, `must` / `down` on a walk, and the obligations every task
// owes with nothing written (a list read inside its list, a division by something other than zero).
// Run: npx tsx test/check/contract.ts
//
// Every refusal sits beside a control that must still be PROVEN, because a checker that refused everything would
// pass the refusals. See note/term/proof-by-default/ and check/contract.ts.

import { compile } from '@term/make/code/compile/compile'

let pass = 0
let fail = 0

function expect(
  name: string,
  source: string,
  want: { ok: true } | { ok: false; code: string },
): void {
  const result = compile({ file: 'c.tree', text: source })
  const codes = result.ok
    ? result.warnings.map(d => d.name)
    : result.diagnostics.map(d => `${d.name}: ${d.message}`)

  const good = want.ok
    ? result.ok
    : !result.ok && result.diagnostics.some(d => d.name === want.code)

  if (good) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (ok=${result.ok}, ${codes.join(' | ')}, wanted ${want.ok ? 'ok' : want.code})`,
    )
  }
}

// the tier-0 count of one compile: total, proven, and the messages of the rest
function tally(
  name: string,
  source: string,
  want: { total: number; proven: number },
): void {
  const result = compile({ file: 'c.tree', text: source })

  if (!result.ok) {
    fail++
    console.log(
      `FAIL  ${name}  (did not compile: ${result.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | ')})`,
    )

    return
  }

  const got = result.obligations ?? { total: 0, proven: 0, failed: [] }

  if (got.total === want.total && got.proven === want.proven) {
    pass++
    console.log(`ok    ${name}  (${got.proven} of ${got.total})`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (${got.proven} of ${got.total}, wanted ${want.proven} of ${want.total}: ${got.failed.map(f => f.diagnostic.message).join(' | ')})`,
    )
  }
}

const proven = { ok: true } as const
const refused = (code: string) => ({ ok: false, code }) as const

function main(): void {
  // ---- must: a postcondition ----

  expect(
    'must: a true postcondition is proven',
    `task next
  take n, like natural-number
  like number
  must
    call is-above
      read back
      read n
  send back
    call add
      read n
      code 1
`,
    proven,
  )

  expect(
    'must: a false postcondition is refused',
    `task same
  take n, like natural-number
  like number
  must
    call is-above
      read back
      read n
  send back, read n
`,
    refused('unproven'),
  )

  expect(
    'must: every return is held to it, not only the last',
    `task pick
  take n, like natural-number
  like number
  must
    call is-minimum
      read back
      code 1
  fork test
    hook test
      call is-above
        read n
        code 3
    hook hold
      send back, code 0
  send back, code 2
`,
    refused('unproven'),
  )

  // ---- have: a precondition ----

  expect(
    'have: the body may assume it',
    `task half
  take n, like number
  have
    call is-minimum
      read n
      code 2
  like number
  must
    call is-above
      read back
      code 0
  send back
    call subtract
      read n
      code 1
`,
    proven,
  )

  expect(
    'have: a caller that meets it is proven',
    `task half
  take n, like number
  have
    call is-minimum
      read n
      code 2
  like number
  send back, read n

task use
  like number
  send back
    call half
      code 5
`,
    proven,
  )

  expect(
    'have: a caller that does not meet it is refused',
    `task half
  take n, like number
  have
    call is-minimum
      read n
      code 2
  like number
  send back, read n

task use
  like number
  send back
    call half
      code 1
`,
    refused('unproven'),
  )

  // ---- a walk's must and down ----

  expect(
    'walk must: an invariant that holds is proven, and what follows may use it',
    `task count
  take n, like natural-number
  like number
  must
    call is-equal
      read back
      read n
  save i, code 0
  walk test
    must
      call is-maximum
        read i
        read n
    hook test
      call is-below
        read i
        read n
    hook hold
      save i
        call add
          read i
          code 1
  send back, read i
`,
    proven,
  )

  expect(
    'walk must: an invariant the body breaks is refused',
    `task count
  take n, like natural-number
  like number
  save i, code 0
  walk test
    must
      call is-maximum
        read i
        read n
    hook test
      call is-maximum
        read i
        read n
    hook hold
      save i
        call add
          read i
          code 1
  send back, read i
`,
    refused('unproven'),
  )

  expect(
    'walk down: a measure that falls is proven',
    `task count
  take n, like natural-number
  like number
  save i, code 0
  walk test
    down
      call subtract
        read n
        read i
    hook test
      call is-below
        read i
        read n
    hook hold
      save i
        call add
          read i
          code 1
  send back, read i
`,
    proven,
  )

  expect(
    'walk down: a measure that does not fall is refused',
    `task count
  take n, like natural-number
  like number
  save i, code 0
  walk test
    down
      call subtract
        read n
        read i
    hook test
      call is-below
        read i
        read n
    hook hold
      save i, read i
  send back, read i
`,
    refused('unproven'),
  )

  // ---- tier 0: nothing written ----

  tally(
    'tier 0: a read guarded by its bounds is proven',
    `task first
  take items, like list, like number
  like number
  fork test
    hook test
      call is-above
        read items/length
        code 0
    hook hold
      send back, read items/0
  send back, code 0
`,
    { total: 1, proven: 1 },
  )

  tally(
    'tier 0: an unguarded read is counted as not proven',
    `task first
  take items, like list, like number
  like number
  send back, read items/0
`,
    { total: 1, proven: 0 },
  )

  tally(
    'tier 0: a counted walk over a list reads inside it',
    `task total
  take items, like list, like number
  like number
  save sum, code 0
  save i, code 0
  walk test
    hook test
      call is-below
        read i
        read items/length
    hook hold
      save sum
        call add
          read sum
          read items/{i}
      save i
        call add
          read i
          code 1
  send back, read sum
`,
    // the read, and the walk's inferred measure `length - i` (a natural number at the top, falling each turn)
    { total: 3, proven: 3 },
  )

  tally(
    'tier 0: a division by a checked divisor is proven, an unchecked one is not',
    `task ratio
  take a, like number
  take b, like number
  like number
  fork test
    hook test
      call is-above
        read b
        code 0
    hook hold
      send back
        call divide
          read a
          read b
  send back
    call divide
      read a
      read b
`,
    { total: 2, proven: 1 },
  )

  // a counter and the list it fills step together, so `length - i` is fixed and every read below `i` is inside
  tally(
    'tier 0: a list filled by a counted walk is read inside its bounds afterwards',
    `task fill
  take n, like natural-number
  like number
  save xs, make list
  save i, code 0
  walk test
    hook test
      call is-below
        read i
        read n
    hook hold
      call xs/push
        read i
      save i
        call add
          read i
          code 1
  fork test
    hook test
      call is-above
        read n
        code 0
    hook hold
      send back
        read xs/0
  send back, code 0
`,
    // the read, and the walk's inferred measure `n - i`
    { total: 3, proven: 3 },
  )

  // TERMINATION BY DEFAULT: a walk with no `down` owes one inferred from its condition
  tally(
    'tier 0: a walk whose condition is `true` is not shown to end',
    `task serve
  save i, code 0
  walk test
    hook test
      true
    hook hold
      save i
        call add
          read i
          code 1
`,
    { total: 1, proven: 0 },
  )

  tally(
    'tier 0: a walk whose counter never moves is not shown to end',
    `task stuck
  take n, like natural-number
  save i, code 0
  walk test
    hook test
      call is-below
        read i
        read n
    hook hold
      save i, read i
`,
    // the measure is natural at the top of every turn, and does not fall
    { total: 2, proven: 1 },
  )

  // ---- a caller is owed its callee's `must` ----

  expect(
    "must at the call: a caller may use what the callee promises",
    `task bump
  take n, like natural-number
  like number
  must
    call is-above
      read back
      read n
  send back
    call add
      read n
      code 1

task use
  take k, like natural-number
  like number
  save m
    call bump
      read k
  hold
    call is-above
      read m
      code 0
  send back, read m
`,
    proven,
  )

  expect(
    'must at the call: no more than the callee promises',
    `task bump
  take n, like natural-number
  like number
  must
    call is-above
      read back
      read n
  send back
    call add
      read n
      code 1

task use
  take k, like natural-number
  like number
  save m
    call bump
      read k
  hold
    call is-above
      read m
      code 5
  send back, read m
`,
    refused('unproven'),
  )

  const bump = `task bump
  take n, like natural-number
  like number
  must
    call is-above
      read back
      read n
  send back
    call add
      read n
      code 1
`

  expect(
    'must at the call: an assignment is owed the promise too',
    `${bump}
task use
  take k, like natural-number
  like number
  save m, code 0
  save m
    call bump
      read k
  hold
    call is-above
      read m
      read k
  send back, read m
`,
    proven,
  )

  expect(
    'must at the call: a promise about the value the assignment replaced is not kept',
    `${bump}
task use
  take k, like natural-number
  like number
  save m, read k
  save m
    call bump
      read m
  hold
    call is-above
      read m
      read m
  send back, read m
`,
    refused('unproven'),
  )

  // a promise sits in line, so a walk around the call keeps its fixed steps and ends
  tally(
    'must at the call: a walk around a promising call still ends',
    `${bump}
task use
  take k, like natural-number
  save i, code 0
  walk test
    hook test
      call is-below
        read i
        code 10
    hook hold
      save m
        call bump
          read k
      save i, call increment(read i)
`,
    { total: 2, proven: 2 },
  )

  // `note roam`: a task meant to run forever owes no termination for its walks
  tally(
    'tier 0: a walk in a task marked `note roam` owes no termination',
    `task serve
  note roam
  save i, code 0
  walk test
    hook test
      true
    hook hold
      save i
        call add
          read i
          code 1
`,
    { total: 0, proven: 0 },
  )

  // and a roaming task is never a function, so no claim may be proven by one
  expect(
    'a claim filled by a task that calls a roaming task is refused',
    `task serve
  note roam
  like number
  send back, code 1

rule some-number
  like number

task some-number
  send back
    call serve
`,
    refused('impure-proof'),
  )

  // ---- lengths across nested walks, writes into a list, and calls ----

  const fill = `task fill
  take box, like list, like number
  like list
    like number
  must
    call is-equal
      read back/length
      code 16
  save out, make list
  save c, code 0
  walk test
    hook test
      call is-below
        read c
        code 4
    hook hold
      save r, code 0
      walk test
        hook test
          call is-below
            read r
            code 4
        hook hold
          call out/push
            read c
          save r, call increment(read r)
      save c, call increment(read c)
  send back, read out
`

  expect('a 4 x 4 walk fills a list of exactly 16', fill, proven)

  expect(
    'an inner walk whose counter is not reset each turn is not counted',
    fill
      .replace(`    hook hold\n      save r, code 0\n      walk test`, `    hook hold\n      walk test`)
      .replace(`  save c, code 0\n`, `  save c, code 0\n  save r, code 0\n`),
    refused('unproven'),
  )

  expect(
    'an inner push under a branch is not a fixed step',
    fill.replace(
      `          call out/push\n            read c`,
      `          fork test\n            hook test\n              call is-above\n                read c\n                code 1\n            hook hold\n              call out/push\n                read c`,
    ),
    refused('unproven'),
  )

  const lengthTwo = (body: string): string => `${body}
task use
  take xs, like list, like number
  have
    call is-equal
      read xs/length
      code 2
  call change
    read xs
  hold
    call is-equal
      read xs/length
      code 2
`

  expect(
    'a callee that only sets inside a list keeps its length',
    lengthTwo(`task change
  take xs, like list, like number
  call xs/set
    code 0
    code 9
`),
    proven,
  )

  expect(
    'a callee that pushes onto its parameter does not',
    lengthTwo(`task change
  take xs, like list, like number
  call xs/push
    code 9
`),
    refused('unproven'),
  )

  expect(
    'a callee that pushes through a second name for its parameter does not',
    lengthTwo(`task change
  take xs, like list, like number
  save s, read xs
  call s/push
    code 9
`),
    refused('unproven'),
  )

  expect(
    'a set on a list of lists does not keep the replaced element length',
    `task use
  take xs, like list, like list, like number
  take row, like list, like number
  have
    call is-equal
      read xs/0/length
      code 2
  have
    call is-equal
      read xs/length
      code 1
  call xs/set
    code 0
    read row
  hold
    call is-equal
      read xs/0/length
      code 2
`,
    refused('unproven'),
  )

  expect(
    'a set in a walk keeps a parameter length across turns',
    `task fold
  take xs, like list, like number
  have
    call is-equal
      read xs/length
      code 16
  save c, code 0
  walk test
    hook test
      call is-below
        read c
        code 16
    hook hold
      call xs/set
        read c
        code 0
      save c, call increment(read c)
  hold
    call is-equal
      read xs/length
      code 16
`,
    proven,
  )

  const twoLists = (second: string): string => `task use
  save a, make list
  call a/push
    code 1
  save b, ${second}
  call b/push
    code 2
  hold
    call is-equal
      read a/length
      code 1
`

  const paramAndFresh = (rebind: string): string => `task use
  take xs, like list, like number
  have
    call is-equal
      read xs/length
      code 2
  save m, make list
${rebind}  call m/push
    code 1
  hold
    call is-equal
      read xs/length
      code 2
`

  expect('a push to a fresh list keeps a parameter length', paramAndFresh(''), proven)
  expect(
    'not once the parameter is rebound to that list',
    paramAndFresh('  save xs, read m\n'),
    refused('unproven'),
  )

  expect(
    'a reset counter leaves what it pinned: len - i == 0 and i == 3 give len == 3',
    `task use
  save xs, make list
  save i, code 0
  walk test
    hook test
      call is-below
        read i
        code 3
    hook hold
      call xs/push
        read i
      save i, call increment(read i)
  save i, code 0
  hold
    call is-equal
      read xs/length
      code 3
`,
    proven,
  )

  expect('a push to one fresh list keeps another fresh list length', twoLists('make list'), proven)
  expect('a push through a second name for the same list does not', twoLists('read a'), refused('unproven'))

  tally(
    'tier 0: a set owes its index like a read',
    `task poke
  take xs, like list, like number
  call xs/set
    code 5
    code 1
`,
    { total: 1, proven: 0 },
  )

  tally(
    'tier 0: a set inside the known length is proven',
    `task poke
  take xs, like list, like number
  have
    call is-minimum
      read xs/length
      code 6
  call xs/set
    code 5
    code 1
`,
    { total: 1, proven: 1 },
  )

  console.log(`\ncontract: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exitCode = 1
  }
}

main()
