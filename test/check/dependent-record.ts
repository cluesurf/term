// Dependent records (a Sigma-type as a one-constructor datatype): a NON-indexed family whose later field's TYPE depends
// on the VALUE of an earlier field. `dpair` pairs `a : nat` with `b : vecnat a` -- a vector whose length is the first
// component. This needs the non-indexed datatype encoding to lower a field type with the preceding fields in scope
// (the same scope indexed families already use for `vecnat`'s `rest : vecnat count`). It type-checks, the dependency is
// ENFORCED (a vector of the wrong length is rejected), and projection COMPUTES. Run: npx tsx test/check/dependent-record.ts

import { compile } from '@cluesurf/make/code/compile/compile'

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

const PRELUDE = `form nat
  case zero
  case succ
    link prior, like nat

form vecnat
  head n, like nat
  case vnil
    head
      make zero
  case vcons
    link count, like nat
    link item, like nat
    link rest, like vecnat
      head
        read count
    head
      make succ
        bind prior
          read count

form dpair
  case mkpair
    link a, like nat
    link b
      like vecnat
        head
          read a

task fst
  take p, like dpair
  like nat
  fork case, read p
    case mkpair
      link a
      link b
      send back
        read a
`

// 1. a dependent pair with a length-matching vector PROJECTS its first component: fst (mkpair 0 vnil) == 0. The field
// `b : vecnat a` is well-typed because the vector has length 0 = a, and projection reduces.
ok(
  'dependent record projects: fst (mkpair 0 nil) == 0',
  compiles(`${PRELUDE}
rule fst-zero
  show hold
    call is-equal
      call fst
        make mkpair
          bind a
            make zero
          bind b
            make vnil
      make zero
  calm hold
`),
)

// 2. a length-1 pair: fst (mkpair 1 [x]) == 1.
ok(
  'dependent record projects: fst (mkpair 1 [x]) == 1',
  compiles(`${PRELUDE}
rule fst-one
  show hold
    call is-equal
      call fst
        make mkpair
          bind a
            make succ
              bind prior
                make zero
          bind b
            make vcons
              bind count
                make zero
              bind item
                make zero
              bind rest
                make vnil
      make succ
        bind prior
          make zero
  calm hold
`),
)

// 3. SOUNDNESS CONTROL (the dependency is ENFORCED): `mkpair 1 vnil` is ill-typed -- `vnil : vecnat 0` but the field
// `b` must be `vecnat 1`. Must be rejected.
ok(
  'mismatched dependent field is rejected (mkpair 1 nil : vnil is vecnat 0, not vecnat 1)',
  !compiles(`${PRELUDE}
task mk-bad
  like dpair
  send back
    make mkpair
      bind a
        make succ
          bind prior
            make zero
      bind b
        make vnil
`),
)

// 4. SOUNDNESS CONTROL: fst (mkpair 0 nil) is 0, not 1. Projection must compute the RIGHT value.
ok(
  'wrong projection value is rejected (fst (mkpair 0 nil) != 1)',
  !compiles(`${PRELUDE}
rule fst-wrong
  show hold
    call is-equal
      call fst
        make mkpair
          bind a
            make zero
          bind b
            make vnil
      make succ
        bind prior
          make zero
  calm hold
`),
)

console.log(`\ndependent-record: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
