// `fold` on ORDER goals: Peano induction over comparisons (and conjunctions of them) about a base-at-zero recursive
// function, each case closed by the product prover (check/induct.ts checkFoldOrder). Run: npx tsx test/check/fold-order.ts
//
// Every refusal sits beside a statement that must still be proven, so a checker that refused everything fails here.
// The cases are the doubling sequence of space/hyperbolic/archimedes.tree, cosh 2^k a.

import { compile } from '@term/make/code/compile/compile'

let pass = 0
let fail = 0

function expect(name: string, source: string, want: string): void {
  const result = compile({ file: 's.tree', text: source })
  const codes = result.ok ? [] : result.diagnostics.map(d => d.name)
  const good = want === 'ok' ? result.ok : !result.ok && codes.includes(want)

  if (good) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  (ok=${result.ok}, codes=${codes.join(',')}, wanted ${want})`)
  }
}

const TASK = `task doubled-cosh
  take p, like integer
  take k, like integer
  like integer
  send back
    fork test
      hook test
        call is-equal
          read k
          code 0
      hook hold
        read p
      hook miss
        call subtract
          call multiply
            code 2
            call multiply
              call doubled-cosh
                read p
                call subtract
                  read k
                  code 1
              call doubled-cosh
                read p
                call subtract
                  read k
                  code 1
          code 1
`

expect(
  'the growth of the doubling sequence is proven',
  TASK + `
rule doubling-grows-at-least-linearly
  mark p, like integer
  mark k, like integer
  have p-is-a-cosh
    call is-minimum
      read p
      code 1
  have k-is-a-count
    call is-minimum
      read k
      code 0
  show hold
    meet and
      call is-minimum
        call subtract
          call doubled-cosh
            read p
            read k
          code 1
        call multiply
          call add
            read k
            code 1
          call subtract
            read p
            code 1
      call is-minimum
        call doubled-cosh
          read p
          read k
        code 1
  fold k
`,
  'ok',
)

expect(
  'a bound passed by an explicit witness is proven',
  TASK + `
rule doubling-passes-every-bound
  mark p, like integer
  mark m, like integer
  have p-is-at-least-two
    call is-minimum
      read p
      code 2
  have m-is-a-count
    call is-minimum
      read m
      code 0
  show hold
    call is-minimum
      call doubled-cosh
        read p
        read m
      call add
        read m
        code 2
  fold m
`,
  'ok',
)

expect(
  'a step that fails is refused',
  TASK + `
rule control-a-step-that-fails
  mark p, like integer
  mark k, like integer
  have p-is-a-cosh
    call is-minimum
      read p
      code 1
  have k-is-a-count
    call is-minimum
      read k
      code 0
  show hold
    call is-maximum
      call doubled-cosh
        read p
        read k
      read p
  fold k
`,
  'invalid-proof',
)

expect(
  'a base that fails is refused',
  TASK + `
rule control-a-base-that-fails
  mark p, like integer
  mark k, like integer
  have p-is-a-cosh
    call is-minimum
      read p
      code 1
  have k-is-a-count
    call is-minimum
      read k
      code 0
  show hold
    call is-minimum
      call subtract
        call doubled-cosh
          read p
          read k
        code 1
      call multiply
        code 2
        call multiply
          call add
            read k
            code 1
          call subtract
            read p
            code 1
  fold k
`,
  'invalid-proof',
)

expect(
  'a conjunction missing a hypothesis is refused',
  TASK + `
rule control-growth-without-a-cosh
  mark p, like integer
  mark k, like integer
  have k-is-a-count
    call is-minimum
      read k
      code 0
  show hold
    meet and
      call is-minimum
        call subtract
          call doubled-cosh
            read p
            read k
          code 1
        call multiply
          call add
            read k
            code 1
          call subtract
            read p
            code 1
      call is-minimum
        call doubled-cosh
          read p
          read k
        code 1
  fold k
`,
  'invalid-proof',
)

expect(
  'one past the witness is refused',
  TASK + `
rule control-passing-one-more
  mark p, like integer
  mark m, like integer
  have p-is-at-least-two
    call is-minimum
      read p
      code 2
  have m-is-a-count
    call is-minimum
      read m
      code 0
  show hold
    call is-minimum
      call doubled-cosh
        read p
        read m
      call add
        read m
        code 3
  fold m
`,
  'invalid-proof',
)

expect(
  'a hypothesis about the counter is refused',
  TASK + `
rule control-a-hypothesis-about-the-counter
  mark p, like integer
  mark k, like integer
  have p-is-a-cosh
    call is-minimum
      read p
      code 1
  have k-is-a-count
    call is-minimum
      read k
      code 0
  have k-is-small
    call is-maximum
      read k
      code 5
  show hold
    call is-minimum
      call doubled-cosh
        read p
        read k
      code 1
  fold k
`,
  'invalid-proof',
)

console.log(`\nfold-order: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
