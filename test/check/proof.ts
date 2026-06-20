// Explicit proofs: `hold <name>` carries a proposition and a proof tree whose heads are the allowed 4-letter
// words. v1 tactics: `melt`/`calm` (definitional equality) and `cite` (a previously proven, named lemma).
// Run: npx tsx test/check/proof.ts

import { compile } from '@/code/compile/compile'

let pass = 0
let fail = 0

// a hold with a working proof emits no unproven / unchecked / invalid-proof diagnostic
function expectProved(name: string, source: string): void {
  const result = compile({ file: 'p.tree', text: source })
  const bad = result.ok
    ? result.warnings.filter(d => d.name === 'unchecked-hold')
    : result.diagnostics
  if (result.ok && bad.length === 0) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (ok=${result.ok}, ${(result.ok
        ? bad
        : result.diagnostics
      )
        .map(d => d.name)
        .join(',')})`,
    )
  }
}

function expectInvalidProof(name: string, source: string): void {
  const result = compile({ file: 'p.tree', text: source })
  if (
    !result.ok &&
    result.diagnostics.some(d => d.name === 'invalid-proof')
  ) {
    pass++
    console.log(
      `ok    ${name}  (${
        result.diagnostics.find(d => d.name === 'invalid-proof')!
          .message
      })`,
    )
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (ok=${result.ok}, ${
        result.ok ? '' : result.diagnostics.map(d => d.name).join(',')
      })`,
    )
  }
}

const DOUBLE = `task double
  take n, like number
  like number
  send back
    call add
      loan n
      loan n
`

const TWICE = `task twice
  take n, like number
  like number
  send back
    call add
      loan n
      loan n
`

function main(): void {
  // `melt both`: a non-linear equality discharged by definitional equality (double is transparent, so it unfolds)
  expectProved(
    'melt both proves a definitional equality',
    `${DOUBLE}
task use-it
  take n, like number
  like number
  hold
    call is-equal
      call double
        loan n
      call add
        loan n
        loan n
    melt both
  send back n
`,
  )

  // `cite`: prove a named lemma, then cite it for another hold of the same statement
  expectProved(
    'cite reuses a named lemma',
    `${DOUBLE}
task use-it
  take n, like number
  like number
  hold double-fact
    call is-equal
      call double
        loan n
      call add
        loan n
        loan n
    melt both
  hold
    call is-equal
      call double
        loan n
      call add
        loan n
        loan n
    cite double-fact
  send back n
`,
  )

  // a `melt both` that cannot compute the two sides equal is an invalid proof
  expectInvalidProof(
    'melt both on unequal sides is rejected',
    `task use-it
  take n, like number
  like number
  hold
    call is-equal
      loan n
      mark 5
    melt both
  send back n
`,
  )

  // citing a lemma that was never proven is an invalid proof
  expectInvalidProof(
    'cite of an unknown lemma is rejected',
    `task use-it
  take n, like number
  like number
  hold
    call is-equal
      loan n
      loan n
    cite no-such-lemma
  send back n
`,
  )

  // `turn`: symmetry, proving a == b from a cited reversed lemma b == a
  expectProved(
    'turn proves an equality by symmetry of a lemma',
    `${DOUBLE}
task use-turn
  take n, like number
  like number
  hold rev
    call is-equal
      call add
        loan n
        loan n
      call double
        loan n
    melt both
  hold
    call is-equal
      call double
        loan n
      call add
        loan n
        loan n
    turn rev
  send back n
`,
  )

  // `link`: transitivity, chaining two lemmas double n == add n n and add n n == twice n
  expectProved(
    'link proves an equality by chaining two lemmas',
    `${DOUBLE}${TWICE}
task use-link
  take n, like number
  like number
  hold step-one
    call is-equal
      call double
        loan n
      call add
        loan n
        loan n
    melt both
  hold step-two
    call is-equal
      call add
        loan n
        loan n
      call twice
        loan n
    melt both
  hold
    call is-equal
      call double
        loan n
      call twice
        loan n
    link
      cite step-one
      cite step-two
  send back n
`,
  )

  console.log(`\nproof: ${pass} pass, ${fail} fail`)
}

main()
