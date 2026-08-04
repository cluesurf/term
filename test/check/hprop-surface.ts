// hProp surface syntax: a `form` marked `mark prop` is a PROPOSITIONAL TRUNCATION -- any two of its inhabitants are
// equal (proof irrelevance), so `make hold-true p == make hold-true q` discharges by `calm` regardless of the evidence.
// The constructor is kept rigid (no computing def) and registered, so the kernel's irrelevance rule fires. Soundness:
// an ordinary (non-`prop`) form stays proof-RELEVANT, so distinct evidence is NOT equated.
// Run: npx tsx test/check/hprop-surface.ts

import { compile } from '@term/make/code/compile/compile'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${detail}`)
  }
}

function compiles(source: string): boolean {
  return compile({ file: 'p.tree', text: source }).ok
}

const BIT = `form bit
  case off
  case on
`

// 1. a `mark prop` truncation is proof-irrelevant: any two inhabitants are equal.
ok(
  'mark prop truncation is proof-irrelevant',
  compiles(`${BIT}
form truth
  mark prop
  case hold-true
    link proof, like bit

rule truth-irrelevant
  mark p, like bit
  mark q, like bit
  show hold
    call is-equal
      make hold-true
        bind proof
          read p
      make hold-true
        bind proof
          read q
  calm hold
`),
)

// 2. SOUNDNESS CONTROL: an ordinary form is proof-RELEVANT -- distinct evidence must NOT be equated.
ok(
  'ordinary form stays proof-relevant',
  !compiles(`${BIT}
form box
  case wrap
    link held, like bit

rule box-relevant
  show hold
    call is-equal
      make wrap
        bind held
          make off
      make wrap
        bind held
          make on
  calm hold
`),
)

console.log(`\nhprop surface: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
