// DEPENDENT MATCHING, the pieces well-founded induction needed (math-foundations-0005, seed.tree relation/well-founded):
// a match on a plain form whose result mentions the subject (`sift n` returning `box n`) uses the form's dependent
// eliminator; a match on an indexed family whose index is constructor-headed (`below m (succ p)`) teaches each branch
// that index's arguments (`next k` has p = k) even with no branch impossible; a function is checked against a type that
// COMPUTES to a pi; and a claim's proof the kernel refuses is `unverified-proof`, which does not hide a looping proof
// beside it. Each acceptance sits beside a refusal of the same shape. The inversion that omits an impossible branch is
// test/check/dependent-match.ts. Run: npx tsx test/check/dependent-elimination.ts

import { compile } from '@term/make/code/compile/compile'

let pass = 0
let fail = 0

function expect(name: string, source: string, want: string[]): void {
  const result = compile({ file: 'd.tree', text: source }, { leanOf: () => true })
  const codes = result.ok ? [] : result.diagnostics.map(d => d.name)
  const good = want.length === 0 ? result.ok : !result.ok && want.every(code => codes.includes(code))

  if (good) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  (ok=${result.ok}, ${result.ok ? '' : result.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | ')})`)
  }
}

const FORMS = `form natural
  case zero
  case succ
    link prior, like natural

form box
  head n, like natural
  case hold
    link at, like natural
    head
      read at

form below
  head m, like natural
  head n, like natural

  case next
    link k, like natural
    head
      read k
    head
      make succ
        bind prior, k

  case further
    link x, like natural
    link y, like natural
    link nearer, like below
      head
        read x
      head
        read y
    head
      read x
    head
      make succ
        bind prior, y
`

const BOX_EVERYWHERE = `
rule box-everywhere
  take n, like natural
  like box
    head
      read n
`

expect(
  'a match on a plain natural whose result mentions it',
  `${FORMS}${BOX_EVERYWHERE}
task box-everywhere
  take n
  sift n
    case zero
      back
        make hold
          bind at, make zero
    case succ
      back
        make hold
          bind at
            make succ
              bind prior, prior
`,
  [],
)

expect(
  'and a branch at the wrong constructor is refused',
  `${FORMS}${BOX_EVERYWHERE}
task box-everywhere
  take n
  sift n
    case zero
      back
        make hold
          bind at, make zero
    case succ
      back
        make hold
          bind at, prior
`,
  ['unverified-proof'],
)

const LEARNED = `
rule learned
  take j, like natural
  take m, like natural
  take evidence
    like below
      head
        read m
      head
        make succ
          bind prior, j
  like task
    take from
      like box
        head
          read j
    like box
      head
        read m
`

expect(
  'a constructor-headed index teaches every branch, and a function result computes to a pi',
  `${FORMS}${LEARNED}
task learned
  take j
  take m
  take evidence
  sift evidence
    case next
      back
        task
          take from
            like box
              head
                read k
          like box
            head
              read k
          back from
    case further
      back
        task
          take from
            like box
              head
                read y
          like box
            head
              read x
          back
            make hold
              bind at, x
`,
  [],
)

expect(
  'and the branch cannot claim what it did not learn',
  `${FORMS}${LEARNED}
task learned
  take j
  take m
  take evidence
  sift evidence
    case next
      back
        task
          take from
            like box
              head
                read k
          like box
            head
              read k
          back from
    case further
      back
        task
          take from
            like box
              head
                read y
          like box
            head
              read x
          back from
`,
  ['unverified-proof'],
)

expect(
  'a looping proof is reported beside one the kernel refused',
  `${FORMS}
rule looping
  take n, like natural
  like box
    head
      read n

task looping
  take n
  back looping(n)

rule mistyped
  take n, like natural
  like box
    head
      read n

task mistyped
  take n
  back
    make hold
      bind at, make zero
`,
  ['unverified-proof', 'looping-proof'],
)

console.log(`dependent-elimination: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
