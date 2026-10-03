// The counted-increment proof (ir/facts/range.ts), held both ways: the loops it must prove, and for every rule a loop
// it must NOT prove, because a wrong proof drops an overflow check that should fire.
// Run: npx tsx test/ir/facts/range.ts

import { compile } from '@term/make/code/compile/compile'
import { provenIncrements } from '@term/make/code/ir/facts/range'
import { emitRust } from '@term/make/code/compile/rust'
import type { Expression, Program } from '@term/make/code/compile/node'

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

// how many `+` nodes the program holds, and how many of them are proven
function count(text: string): { adds: number; proven: number; program: Program } {
  const built = compile({ file: 'main.tree', text }, { optimize: false })

  if (!built.ok) {
    throw new Error(built.diagnostics.map(d => d.message).join(' | '))
  }

  const proven = provenIncrements(built.program)
  let adds = 0
  let hits = 0
  const seen = new Set<object>()
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || seen.has(value)) {
      return
    }

    seen.add(value)

    if (Array.isArray(value)) {
      value.forEach(visit)

      return
    }

    const node = value as { form?: string; op?: string }

    if (node.form === 'binary' && node.op === '+') {
      adds++

      if (proven.has(node as Expression)) {
        hits++
      }
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        visit(child)
      }
    }
  }

  visit(built.program)

  return { adds, proven: hits, program: built.program }
}

const task = (body: string): string => `task total
  take n, like number
  like number
  save sum, code 0
${body}
  send back, read sum
`

// 1. a counted walk: its increment is proven, and the sum it feeds is not
const walk = count(
  task(`  walk size
    bind base, code 0
    bind head, read n
    hook next
      take site, name i
      save sum
        call add
          read sum
          read i`),
)
ok('a walk size increment is proven', walk.proven === 1, JSON.stringify(walk))
ok('the sum inside the walk is not', walk.adds === 2, JSON.stringify(walk))
ok('Rust writes the proven step as a plain +', /i \+ 1/.test(emitRust(walk.program)) && /checked_add\(sum, i\)/.test(emitRust(walk.program)), emitRust(walk.program).split('\n').filter(l => /checked_add|\+ 1/.test(l)).join(' | '))

// 2. a hand-written `walk test` of the same shape is proven too
const test = count(
  task(`  save i, code 0
  walk test
    hook test
      call is-below
        read i
        read n
    hook hold
      save i
        call add
          read i
          code 1`),
)
ok('a walk test with i < n and one i = i + 1 is proven', test.proven === 1, JSON.stringify(test))

// 3. counterexample: `<=` lets i reach the bound, and i + 1 may then be past it
const atMost = count(
  task(`  save i, code 0
  walk test
    hook test
      call is-maximum
        read i
        read n
    hook hold
      save i
        call add
          read i
          code 1`),
)
ok('i <= n is NOT proven', atMost.proven === 0, JSON.stringify(atMost))

// 4. counterexample: a second write inside the loop moves i after the test
const twice = count(
  task(`  save i, code 0
  walk test
    hook test
      call is-below
        read i
        read n
    hook hold
      save i
        call add
          read i
          code 5
      save i
        call add
          read i
          code 1`),
)
ok('a loop that writes i twice is NOT proven', twice.proven === 0, JSON.stringify(twice))

// 5. counterexample: the step inside a nested walk runs many times per test of the outer condition
const nested = count(
  task(`  save i, code 0
  walk test
    hook test
      call is-below
        read i
        read n
    hook hold
      walk size
        bind base, code 0
        bind head, code 3
        hook next
          take site, name k
          save i
            call add
              read i
              code 1`),
)
ok('a step inside a nested loop is NOT proven for the outer counter', nested.proven === 1, `${JSON.stringify(nested)} (only the inner k step)`)

// 6. counterexample: a closure that writes the counter
const closure = count(
  task(`  save i, code 0
  host bump
    task
      save i
        call add
          read i
          code 7
  walk test
    hook test
      call is-below
        read i
        read n
    hook hold
      call bump
      save i
        call add
          read i
          code 1`),
)
ok('a counter some closure writes is NOT proven', closure.proven === 0, JSON.stringify(closure))

console.log(`\nrange: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
